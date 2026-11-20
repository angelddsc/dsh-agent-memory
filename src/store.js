// remember-store.js - 她所有"记得"的东西，统一放在 D:\remember
//
// 结构：
//   memory/people.json          长期：一本账（谁是谁、聊过什么、互动多少次）
//   memory/shared-chat.jsonl    全量聊天流水（跨会话）
//   memory/long-term.md         长期记忆：她自己写下的、不该忘的事
//   memory/notebook/*.md        短期记事本：每 rotateDays 天换一本，旧的永不删
//   memory/chatlog/*.jsonl      每 snapshotHours 小时整份快照
//
// 设计：
// - 记事本只记"发生了什么"，每轮唤醒把当前本最近一段拼进提示词；
// - 快照是冷备份，怕日志被裁剪/进程被杀；
// - recall() 跨全部文件做关键词检索，供上层的「记忆检索」工具调用。

import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 3600 * 1000;

function pad(n) { return String(n).padStart(2, '0'); }

function ymd(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ymdhm(ts = Date.now()) {
  const d = new Date(ts);
  return `${ymd(ts)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function hhmm(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignore */ }
}

function readText(p, max = 200000) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw.length > max ? raw.slice(-max) : raw;
  } catch {
    return '';
  }
}

export function createRememberStore(opts = {}) {
  const dir = opts.dir || path.join(process.cwd(), 'memory');
  const rotateDays = Math.max(1, Number(opts.rotateDays) || 4);
  const snapshotHours = Math.max(1, Number(opts.snapshotHours) || 4);
  const notebookInjectChars = Math.max(200, Number(opts.notebookInjectChars) || 1500);
  const log = opts.log || (() => {});
  const sourceChatLog = opts.sourceChatLog || path.join(dir, 'shared-chat.jsonl');
  // 宿主如果想在记事本注入里追加自己的提示（例如说明工具名），传进来即可。
  const notebookTail = String(opts.notebookTail || '');   // 全量流水的真实位置

  const paths = {
    root: dir,
    people: path.join(dir, 'people.json'),
    sharedChat: path.join(dir, 'shared-chat.jsonl'),
    longTerm: path.join(dir, 'long-term.md'),
    notebookDir: path.join(dir, 'notebook'),
    chatlogDir: path.join(dir, 'chatlog'),
    dailyDir: path.join(dir, 'daily'),
    weeklyDir: path.join(dir, 'weekly'),
    monthlyDir: path.join(dir, 'monthly'),
  };

  for (const d of [paths.root, paths.notebookDir, paths.chatlogDir, paths.dailyDir, paths.weeklyDir, paths.monthlyDir]) ensureDir(d);

  // ── 按句子边界截断（2026-10-29）────────────────────────────────────
  // 为什么：以前是 `slice(0, maxChars)` 直接硬切，会把一句话切成「…十几秒的」这种半句。
  // 她说「最难受的是这个，看着像话没说完就被人掐了」。所以统一改成：
  // 先按句末标点切成句子，再从头往回收，收到放不下为止 —— 保证结尾一定是完整句子。
  // from='head' 从头保留（日记/回忆），from='tail' 从尾部保留（长期记忆/记事本，新的更重要）。
  function cutAtSentence(text, maxChars, from = 'head') {
    const t = String(text ?? '');
    if (t.length <= maxChars) return t;
    // 句末标点（中英文都算）
    const parts = t.split(/(?<=[。！？!?；;\n])/);
    const out = [];
    let used = 0;
    if (from === 'head') {
      for (const p of parts) {
        if (used + p.length > maxChars) break;
        out.push(p);
        used += p.length;
      }
      return out.join('');
    }
    // 从尾部保留
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (used + p.length > maxChars) break;
      out.unshift(p);
      used += p.length;
    }
    // 兜底：一句都放不下时，退回硬切（至少不返回空）
    return out.length ? out.join('') : t.slice(-maxChars);
  }

  // ── 记事本 ────────────────────────────────────────────────
  function listNotebooks() {
    try {
      return fs.readdirSync(paths.notebookDir)
        .filter((f) => /^notebook-.*\.md$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  function startDateOf(file) {
    const m = /notebook-(\d{4})-(\d{2})-(\d{2})\.md/.exec(file);
    if (!m) return 0;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }

  function currentNotebookFile(now = Date.now()) {
    const list = listNotebooks();
    const last = list[list.length - 1];
    if (last) {
      const started = startDateOf(last);
      if (started && now - started < rotateDays * DAY) return last;
    }
    const fresh = `notebook-${ymd(now)}.md`;
    const full = path.join(paths.notebookDir, fresh);
    if (!fs.existsSync(full)) {
      const head = `# 记事本 · 从 ${ymd(now)} 开始（${rotateDays} 天一本）\n\n`;
      fs.writeFileSync(full, head, 'utf8');
      log(`新记事本: ${fresh}`);
    }
    return fresh;
  }

  function appendNotebook({ who, text, key = '' }) {
    try {
      const body = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!body) return;
      const file = path.join(paths.notebookDir, currentNotebookFile());
      const line = `- ${hhmm()} ${who ? who + '：' : ''}${body.slice(0, 200)}${key ? `（${key}）` : ''}\n`;
      fs.appendFileSync(file, line, 'utf8');
    } catch (e) {
      log(`记事本写入失败: ${e?.message ?? e}`);
    }
  }

  /** 她自己写的一条补注（流水没记全但不想忘的事）。 */
  function appendHerNote(text, key = '') {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) return { ok: false, error: '内容不能为空' };
    appendNotebook({ who: '我（补注）', text: body, key });
    return { ok: true, file: path.join(paths.notebookDir, currentNotebookFile()) };
  }

  function notebookBlock(maxChars = notebookInjectChars, key = '') {
    const list = listNotebooks();
    const cur = list.length ? list[list.length - 1] : null;
    if (!cur) return '';
    const text = readText(path.join(paths.notebookDir, cur));
    if (!text.trim()) return '';
    const lines = text.split('\n').filter(Boolean);
    let picked = lines.slice(-40).join('\n');
    // 去掉冗余的会话后缀：本会话的直接删，其他会话缩成「私」「群」
    if (key) picked = picked.split(`（${key}）`).join('');
    picked = picked.replace(/（private:\d+）/g, '（私）').replace(/（group:\d+）/g, '（群）');
    if (picked.length > maxChars) picked = '…' + cutAtSentence(picked, maxChars - 1, 'tail');
    return `【短期记事本（最近 ${rotateDays} 天）】\n（这是记录，不是你的记忆——别人替你记的流水。你自己的记忆在下面的日记里。）\n${picked}\n（更早的在 ${paths.notebookDir}）\n【想不起来就查】以上是最近几天的流水；如果对方问的事不在里面、或你只记得个大概，用记忆检索去翻原文库——那里有全部原文，能查到当时具体是怎么说的。别凭印象编；查不到就说记不清了。${notebookTail}`;
  }

  /**
   * 今天有哪些聊天快照 —— 一行提示，让她知道"现在就有可查的原话"。
   * 为什么放在记事本里：她原本完全不知道 chatlog 的存在，只有在她每轮都看得到的地方
   * 提一句，她才会想起来用（2026-10-29：她说"找不到以前的聊天记录备份"）。
   */
  function chatlogHintBlock() {
    try {
      const dir = paths.chatlogDir;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
      if (!files.length) return '';
      const today = new Date().toISOString().slice(0, 10);
      const todayFiles = files.filter((f) => f.includes(today));
      const days = new Set(files.map((f) => (f.match(/chat-(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean));
      const newest = files[files.length - 1];
      const newestTime = (newest.match(/_(\d{2})(\d{2})-/) || []).slice(1).join(':');
      const parts = [`现有快照：共 ${days.size} 天`];
      if (todayFiles.length) parts.push(`今天 ${todayFiles.length} 份，最新 ${newestTime || '刚刚'}`);
      return `\n（${parts.join('，')}）`;
    } catch {
      return '';
    }
  }

  // ── 她自己的日记（最近几天，她自己写的）─────────────────────
  // 2026-10-29 修：以前是「从旧到新拼好、再从头部切」，结果**今天写的最先被砍掉**
  // （她今天写了 1355 字，注入只留 1400，几乎全被切走，看着像自己没写完）。
  // 现在：diaryNewestFirst —— 今天那篇先装、给足预算，剩下的名额才轮到前几天。
  function diaryBlock(days = 4, maxChars = 3200) {
    try {
      const files = fs.readdirSync(paths.dailyDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .slice(-days)
        .reverse();                        // 新的在前
      if (!files.length) return '';
      const header = '【你自己的日记（你亲手写的）】\n（下面这段是你自己的记忆。如果会话历史里出现一段"机器整理的摘要"——条目式、像别人写的——那只是一个索引/别人帮你记的目录，不是你真实记得的东西；以你自己的日记和长期记忆为准，需要细节就用记忆检索去翻原文库。）\n';
      const parts = [];
      let used = header.length;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const raw = readText(path.join(paths.dailyDir, f));
        const body = raw.split('\n').filter((l) => l && !l.startsWith('#')).join(' ').trim();
        if (!body) continue;
        const line = `${f.replace('.md', '')}：${body}`;
        const budget = maxChars - used;
        if (budget <= 120) break;          // 余量太小就不硬塞
        // 最近的一篇（今天）尽量给全文；更早的按余量收
        const fit = line.length <= budget ? line : cutAtSentence(line, budget - 1, 'head') + '…';
        parts.push(fit);
        used += fit.length + 1;
        if (used >= maxChars) break;
      }
      if (!parts.length) return '';
      return header + parts.join('\n');
    } catch {
      return '';
    }
  }

  // ── 周记 / 月报（金字塔上层）──────────────────────────────
  function layerBlock(kind, maxChars) {
    try {
      const dir = kind === 'monthly' ? paths.monthlyDir : paths.weeklyDir;
      if (!fs.existsSync(dir)) return '';
      const files = fs.readdirSync(dir)
        .filter((f) => /^\d{4}(-\d{2})*(-W\d{2})?\.md$/.test(f))
        .sort()
        .slice(-1);
      if (!files.length) return '';
      const raw = readText(path.join(dir, files[0]));
      const body = raw.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>')).join(' ').trim();
      if (!body) return '';
      const label = kind === 'monthly' ? '月报' : '周记';
      const name = files[0].replace('.md', '');
      let out = `【${label} · ${name}（她自己写的上层记忆）】\n${body}`;
      if (out.length > maxChars) out = cutAtSentence(out, maxChars - 1, 'head') + '…';
      return out;
    } catch {
      return '';
    }
  }

  function monthlyBlock(maxChars = 1200) { return layerBlock('monthly', maxChars); }
  function weeklyBlock(maxChars = 800) { return layerBlock('weekly', maxChars); }

  // ── 长期记忆 ──────────────────────────────────────────────
  function appendLongTerm(text, { by = '她' } = {}) {
    try {
      const body = String(text ?? '').trim();
      if (!body) return 0;
      if (!fs.existsSync(paths.longTerm)) {
        fs.writeFileSync(paths.longTerm, '# 长期记忆\n\n> 她自己决定要记住的事，按时间追加。\n\n', 'utf8');
      }
      fs.appendFileSync(paths.longTerm, `- ${ymd(Date.now())} ${hhmm()}（${by}）${body.slice(0, 500)}\n`, 'utf8');
      return fs.statSync(paths.longTerm).size;
    } catch (e) {
      log(`长期记忆写入失败: ${e?.message ?? e}`);
      return 0;
    }
  }

  function longTermBlock(maxChars = 1200) {
    const t = readText(paths.longTerm, 20000);
    if (!t.trim()) return '';
    const lines = t.split('\n').filter((l) => l.startsWith('- '));
    if (!lines.length) return '';
    const picked = lines.slice(-12).join('\n');
    return `【长期记忆（她主动记下的）】\n${picked.length > maxChars ? cutAtSentence(picked, maxChars, 'tail') : picked}`;
  }

  // ── 她自己补写的回忆（2026-10-29）────────────────────────────────────
  // 背景：10-29 16:23 那次压缩摘要在 191 字处断在半句上（「我说这名又」），
  // 10-26~10-29 的连贯记忆丢了。原话都还在 chatlog 里，所以让她按天重读、
  // 用自己的话重写一遍 —— 存到 recovered.md，长期注入。
  // 为什么不做成"改写压缩日志里的事件"：那要动 session.v4.jsonl.zstd，
  // 还要同步 session_projcache，风险远大于收益。
  const recoveredFile = path.join(dir, 'recovered.md');

  function recoveredBlock(maxChars = 4000) {
    const t = readText(recoveredFile, 40000);
    if (!t.trim()) return '';
    // 保留 `## 2026-10-26` 这种分界行（以前被整行删掉，四天糊成一大段）。
    // 转成 【10月26日】 这样好读的标记，她自己认得出这是哪天。
    const days = t.split(/^##\s*/m).map((x) => x.trim()).filter(Boolean);
    let body;
    if (days.length > 1) {
      body = days
        .map((seg) => {
          const nl = seg.indexOf('\n');
          const head = (nl < 0 ? seg : seg.slice(0, nl)).trim();
          const rest = (nl < 0 ? '' : seg.slice(nl + 1)).trim();
          const mm = head.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          const label = mm ? `${Number(mm[2])}月${Number(mm[3])}日` : head;
          return rest ? `【${label}】\n${rest}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
    } else {
      body = t.replace(/^#.*$/gm, '').trim();
    }
    if (!body.trim()) return '';
    const cut = body.length > maxChars ? cutAtSentence(body, maxChars, 'head') : body;
    return `【你自己补写的回忆】\n（这段是你照着聊天原话，用自己的话重写的。它和你的日记一样，是你自己的记忆。）\n${cut}`;
  }

  function appendRecovered(text) {
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: '内容不能为空' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(recoveredFile, `\n${body}\n`, 'utf8');
      return { ok: true, file: recoveredFile, bytes: fs.statSync(recoveredFile).size };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }


  // ── 4 小时快照 ────────────────────────────────────────────
  const STATE_FILE = path.join(paths.chatlogDir, '_snapshot-state.json');

  function lastSnapshotAt() {
    try {
      return Number(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastAt) || 0;
    } catch {
      return 0;
    }
  }

  function snapshotNow(label = 'auto') {
    const src = sourceChatLog;
    try {
      if (!src || !fs.existsSync(src)) return null;
      const dest = path.join(paths.chatlogDir, `chat-${ymdhm()}-${label}.jsonl`);
      fs.copyFileSync(src, dest);
      fs.writeFileSync(STATE_FILE, JSON.stringify({ lastAt: Date.now(), dest }), 'utf8');
      const size = fs.statSync(dest).size;
      log(`快照完成: ${path.basename(dest)} (${(size / 1024).toFixed(1)}KB)`);
      return dest;
    } catch (e) {
      log(`快照失败: ${e?.message ?? e}`);
      return null;
    }
  }

  let timer = null;
  function startSnapshotLoop() {
    if (timer) return;
    const due = snapshotHours * 3600 * 1000;
    const tick = () => {
      if (Date.now() - lastSnapshotAt() >= due) snapshotNow('auto');
    };
    timer = setInterval(tick, 10 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    setTimeout(tick, 60 * 1000).unref?.();
    log(`快照循环已启动 · 每 ${snapshotHours}h 一份 · 目标 ${paths.chatlogDir}`);
  }

  function stopSnapshotLoop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ── 跨文件检索 ────────────────────────────────────────────
  function recall(query, { limit = 20, maxFiles = 40 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const hits = [];
    const needle = q.toLowerCase();

    const scan = (file, label) => {
      const text = readText(file, 400000);
      if (!text) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ where: label, line: lines[i].slice(0, 300), at: lines[i].slice(0, 0) });
          if (hits.length >= limit * 4) return;
        }
      }
    };

    scan(paths.longTerm, 'long-term.md');
    scan(paths.people, 'people.json');
    for (const f of listNotebooks().slice(-maxFiles)) scan(path.join(paths.notebookDir, f), `notebook/${f}`);
    try {
      const logs = fs.readdirSync(paths.chatlogDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-3);
      for (const f of logs) scan(path.join(paths.chatlogDir, f), `chatlog/${f}`);
    } catch { /* ignore */ }

    return hits.slice(0, limit);
  }

  function stats() {
    const nb = listNotebooks();
    let chatlogCount = 0;
    try { chatlogCount = fs.readdirSync(paths.chatlogDir).filter((f) => f.endsWith('.jsonl')).length; } catch { /* ignore */ }
    return {
      dir: paths.root,
      notebooks: nb.length,
      currentNotebook: nb[nb.length - 1] || null,
      chatlogSnapshots: chatlogCount,
      lastSnapshotAt: lastSnapshotAt(),
      longTermBytes: fs.existsSync(paths.longTerm) ? fs.statSync(paths.longTerm).size : 0,
    };
  }

  return {
    paths,
    appendNotebook,
    appendHerNote,
    notebookBlock,
    appendLongTerm,
    longTermBlock,
    recoveredBlock,
    appendRecovered,
    diaryBlock,
    monthlyBlock,
    weeklyBlock,
    snapshotNow,
    startSnapshotLoop,
    stopSnapshotLoop,
    recall,
    stats,
  };
}

export default createRememberStore;
