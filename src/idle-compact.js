// idle-compact.js —— 闲置边界压缩（从上游 qq-dsh-bridge 移植，2026-11-19）
//
// 为什么要这个模块：
//   DSH 的 compaction-basic 是在 agent loop 里**按 token 阈值**触发的，也就是对话
//   进行到一半就压。而压缩会改写对话历史的前缀 —— provider 的 KV cache 正是按前缀
//   命中的，于是每次压缩都让缓存整段失效，之后每一步都要重算全部历史。
//
//   实测（上游给的数）：阈值低时「每 2~3 步就有一次全量 miss」，命中步的 miss 高达
//   15 万 token、单步 45~55 秒；改成「对话中永不压缩 + 闲置时压一次」之后，
//   29 步里只有 1 次 miss，单步 3~4 秒。
//
//   我们自己的账本也对得上：她平均单步输入 34 万 token、11-19 一天新输入 5.9M。
//   所以这不是"省钱小技巧"，是当前最大的一笔浪费。
//
// 策略（和 DSH 内置的正好相反）：
//   · 对话进行中：preset 的 thresholdRatio 抬到 0.95（≈95 万）→ 基本永不触发；
//   · 用户安静 idleMs、DSH 没在跑、上下文超过 thresholdTokens 时：
//       ① 先让模型把要点写进记忆库（含 selfNote）
//       ② 等这一轮真正跑完
//       ③ 调 DSH 的 /compact 原地压缩（会话不换、映射不动）
//       ④ 置 idleCompactedAt，直到用户下一条消息才解锁，绝不反复触发
//
//   三条失败路径都是「宁可不压」：记忆没投出去 → 不压；记忆没写完 → 不压；
//   /compact 未识别 → 记日志并置标志（不每分钟重试，每次重试都是真金白银的调用）。

/**
 * @param {object} deps
 * @param {object} deps.cfg            全局配置（读 socialV2.compaction）
 * @param {object} deps.api            DSH RPC 客户端（需有 callUnary）
 * @param {Function} deps.withTimeout  超时包装
 * @param {object} deps.tokenLedger    令牌账本（需有 recent()）
 * @param {object} deps.state          会话映射 { sessions: { key: sessionId } }
 * @param {Function} deps.getSocialV2State
 * @param {Function} deps.saveSocialV2State
 * @param {Function} deps.isConversationBusyV2
 * @param {Function} deps.deliverPrompt    投递一轮 prompt（用于记忆整理）
 * @param {Function} deps.waitForTurnIdle  等回合结束
 * @param {Function} deps.log
 */
export function createIdleCompactor(deps) {
  const {
    cfg, api, withTimeout, tokenLedger, state,
    getSocialV2State, saveSocialV2State, isConversationBusyV2,
    deliverPrompt, waitForTurnIdle, log,
  } = deps;

  // COMPACT_TIMEOUT_MS (2026-11-20 改)：180s → 可配，默认 900s（15 分钟）。
  //
  // 为什么改：她的私聊会话 26 MB / 54 万 token，/compact 要一次装载全部历史再让
  // summarization 模型分段总结，实测超过 180s 就被我们自己的 withTimeout 掐断。
  // 掐断后 DSH 那边的压缩可能仍在进行，于是「超时 → 重试 → 又超时」循环，
  // 一天 13 次失败、0 次成功，会话一点没变小（25.2 MB → 26.1 MB）。
  //
  // 压缩是后台任务，没人等它 —— 给足时间比快速失败有用得多。
  const COMPACT_TIMEOUT_MS = Math.max(60000, Number(cfg.socialV2?.compaction?.timeoutMs) || 900000);

  // 记忆整理冷却（2026-11-20 新增）。同一段历史里，第一次整理写下的东西已经够了；
  // 失败重试时再整轮重新整理，等于每次都拿 54 万上下文做一次完整推理 —— 这是纯浪费。
  const SUMMARIZE_COOLDOWN_MS = Math.max(
    600000,
    Number(cfg.socialV2?.compaction?.summarizeCooldownMs) || 4 * 3600 * 1000,
  );

  // 失败退避（2026-11-20 新增）：第一次失败等 30 分钟，之后每失败一次翻倍，封顶 4 小时。
  // 原来失败后仍是每 30 分钟重试一次，一天烧掉十几次 54 万上下文的调用。
  const BACKOFF_BASE_MS = Math.max(300000, Number(cfg.socialV2?.compaction?.backoffBaseMs) || 30 * 60 * 1000);
  const BACKOFF_MAX_MS = Math.max(BACKOFF_BASE_MS, Number(cfg.socialV2?.compaction?.backoffMaxMs) || 4 * 3600 * 1000);

  /**
   * 该会话当前上下文多大。
   *
   * 2026-11-20 修正：原来取「最近一步」的输入侧 token。但最近一步可能是记忆整理、
   * 心跳之类的小请求（实测 43,813），于是判定永远不满足 `ctx >= 250k`，
   * 闲置压缩看起来"跑了但从不触发"。
   *
   * 现在取最近 ctxWindowSize 步里的**最大值**：上下文只会在压缩时下降，
   * 所以「最近几步的最大输入」就是当前上下文的可靠上界估计。
   */
  function currentContextTokens(key, since = 0) {
    try {
      const rows = tokenLedger.recent(300).filter((r) => r && r.key === key);
      if (!rows.length) return 0;
      // `since` = 上次压缩成功的时间。压缩之前的采样描述的是**旧**（更大的）上下文，
      // 拿它们做判断会让刚压过的会话立刻又被判成"需要压"。只看压缩之后的采样。
      const fresh = since > 0 ? rows.filter((r) => Number(r.time) > since) : rows;
      if (!fresh.length) return 0; // 压缩后还没有任何新采样 → 认为未知，不压
      const windowSize = Math.max(1, Number(cfg.socialV2?.compaction?.ctxWindowSize) || 6);
      let max = 0;
      for (const row of fresh.slice(0, windowSize)) {
        const total = (row.cacheMiss || 0) + (row.cacheHit || 0) + (row.cacheWrite || 0);
        if (total > max) max = total;
      }
      return max;
    } catch (error) {
      log(`[compaction] 读取上下文大小失败 ${key}: ${error?.message ?? error}`);
      return 0;
    }
  }

  /**
   * 判定是否到了「闲置边界」。返回判定依据，不满足返回 null。
   * 刻意保守：压缩不可逆，误压一次等于让她忘掉一段对话，代价远大于少省一点钱。
   */
  function decision(key, st, now = Date.now()) {
    const c = cfg.socialV2?.compaction ?? {};
    if (c.enabled === false) return null;
    if (c.onlyPrivate !== false && !String(key).startsWith('private:')) return null;
    if (st.idleCompactedAt) return null;       // 一轮只压一次，等下条用户消息解锁
    if (st.idleCompactingAt) return null;      // 正在压
    // 失败退避：连错几次就多等一会儿，别每次都用 54 万上下文再赌一遍。
    if (st.idleCompactBackoffUntil && now < Number(st.idleCompactBackoffUntil)) return null;
    if (isConversationBusyV2(key, st)) return null;
    if (!state.sessions[key]) return null;
    const lastUser = st.lastIncomingAt || 0;
    if (!lastUser) return null;
    const idleMs = Math.max(60000, Number(c.idleMs) || 1800000);
    if (now - lastUser < idleMs) return null;
    // 模型自己刚动过就先不动：那说明它还在为这条会话干活。
    if (now - (st.lastActionAt || 0) < Math.floor(idleMs / 2)) return null;
    const threshold = Math.max(10000, Number(c.thresholdTokens) || 300000);
    // 只看「上次压缩之后」的采样：压缩前的采样是旧的大上下文，会让刚压过的会话立刻又被判需要压。
    const ctxTokens = currentContextTokens(key, Number(st.idleCompactedAt) || 0);
    if (ctxTokens < threshold) return null;
    return { idleMs: now - lastUser, ctxTokens };
  }

  /** 压缩前的记忆整理：让模型把值得长期记住的东西写进记忆库。silent，不会发到 QQ。 */
  async function summarize(key) {
    const promptText = [
      '【后台任务 · 上下文压缩前的记忆整理】',
      '这段对话的历史马上会被压缩成摘要，原文细节会丢。趁现在把值得长期记住的东西写进记忆库。',
      '',
      '写这些：',
      '· 用户提到的事实、偏好、习惯、约定；',
      '· 你们之间形成的默契、称呼、玩笑；',
      '· 还没做完、下次需要接着做的事。',
      '用 qq_memory_append 写入（每条一句话，写结论不写流水账，不要复述整段对话）。',
      '',
      '另外，如果有的话，也写一两句关于**你自己**的（category 用 selfNote）：',
      '· 你对这个人的看法有没有变（他是什么样的人、你们是什么关系）；',
      '· 你自己有没有什么变了（说话习惯、脾气、以前怎么想现在怎么想）。',
      '这条只有你能写，别写成日记，想到一句写一句就够了。',
      '没有值得记的就直接结束，不要凑数。',
    ].join('\n');
    try {
      const result = await deliverPrompt(key, promptText, { silent: true });
      return !!result?.ok;
    } catch (error) {
      log(`[compaction] 记忆整理投递失败 ${key}: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 调 DSH 的 /compact。
   * 走 commands/execute 而不是发一条 "/compact" 文本：命令由 DSH 的 commands 服务
   * 解析（parseCommand → 命令表 → compaction.compactNow），当普通 prompt 发出去模型
   * 只会收到一句看不懂的话，白烧一次调用。参数名是 agentId 不是 sessionId。
   */
  async function compactSession(key) {
    const sessionId = state.sessions[key];
    if (!sessionId) return { ok: false, error: '会话未建立' };
    try {
      const res = await withTimeout(
        api.callUnary('commands/execute', { agentId: sessionId, line: '/compact', submittedAttachments: [] }),
        COMPACT_TIMEOUT_MS,
        'commands/execute(/compact)',
      );
      const envelope = res?.result;
      if (envelope && envelope.ok === false) {
        return { ok: false, error: envelope.error?.message ?? 'commands/execute 返回失败' };
      }
      const settled = envelope?.value;
      const kind = settled?.result?.kind;
      const text = settled?.result?.text ?? '';
      if (!settled || !kind) {
        return { ok: false, error: 'DSH 未识别 /compact（preset 里可能没挂 command-compact）' };
      }
      return { ok: kind === 'success', kind, text, commandId: settled.commandId ?? null };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  async function run(key, d) {
    const st = getSocialV2State(key);
    st.idleCompactingAt = Date.now();
    saveSocialV2State();
    const mins = Math.round(d.idleMs / 60000);
    const kCtx = Math.round(d.ctxTokens / 1000);
    log(`[compaction] 闲置边界：${key} 已安静 ${mins} 分钟、上下文约 ${kCtx}k token，开始压缩`);
    if (d.ctxTokens > 500000) {
      log(`[compaction] ⚠️ ${key} 上下文 ${kCtx}k 偏大，压缩会比较久（超时上限 ${Math.round(COMPACT_TIMEOUT_MS / 60000)} 分钟）`);
    }
    const startedAt = Date.now();
    try {
      // ① 先写记忆，失败就放弃压缩
      //    但同一段历史只整理一次：上次已整理过且没超过冷却期，就直接压，别重跑整轮推理。
      const summarizeOn = cfg.socialV2?.compaction?.summarize !== false;
      const lastSummarized = Number(st.idleSummarizedAt) || 0;
      const summarizeFresh = summarizeOn && (Date.now() - lastSummarized > SUMMARIZE_COOLDOWN_MS);
      if (summarizeOn && !summarizeFresh) {
        const hours = Math.round((Date.now() - lastSummarized) / 3600000);
        log(`[compaction] ${key} 记忆刚整理过（${hours} 小时前），跳过整理直接压缩`);
      }
      if (summarizeFresh) {
        const delivered = await summarize(key);
        if (!delivered) {
          st.idleCompactedAt = Date.now();
          log(`[compaction] ${key} 记忆整理投递失败，本次跳过压缩`);
          return;
        }
        const finished = await waitForTurnIdle(key);
        if (!finished) {
          st.idleCompactedAt = Date.now();
          log(`[compaction] ${key} 记忆整理未在时限内完成，本次跳过压缩`);
          return;
        }
        st.idleSummarizedAt = Date.now();
        saveSocialV2State();
      }
      // ② 原地压缩
      const result = await compactSession(key);
      const tookS = Math.round((Date.now() - startedAt) / 1000);
      st.idleCompactedAt = Date.now();
      if (result.ok) {
        // 成功就把失败计数清零：下次（几小时后）再压时又是从 30 分钟退避起算。
        st.idleCompactFailures = 0;
        st.idleCompactBackoffUntil = 0;
        log(`[compaction] 闲置压缩完成 ${key}（${tookS}s，压前约 ${kCtx}k）：${result.text || '已压缩'}（会话 ${state.sessions[key] ?? '无'} 未变）`);
      } else {
        const failures = (Number(st.idleCompactFailures) || 0) + 1;
        const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);
        st.idleCompactFailures = failures;
        st.idleCompactBackoffUntil = Date.now() + delayMs;
        log(`[compaction] 闲置压缩失败 ${key}（${tookS}s，第 ${failures} 次）：${result.error}`
          + `；${Math.round(delayMs / 60000)} 分钟后才再试`);
      }
    } catch (error) {
      const failures = (Number(st.idleCompactFailures) || 0) + 1;
      const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);
      st.idleCompactFailures = failures;
      st.idleCompactBackoffUntil = Date.now() + delayMs;
      log(`[compaction] 闲置压缩异常 ${key}（第 ${failures} 次）: ${error?.message ?? error}`
        + `；${Math.round(delayMs / 60000)} 分钟后才再试`);
    } finally {
      st.idleCompactingAt = 0;
      saveSocialV2State();
    }
  }

  /** 启动定时巡检（默认每 5 分钟扫一次）。 */
  function start(options = {}) {
    const c = cfg.socialV2?.compaction ?? {};
    if (c.enabled === false) {
      log('[compaction] 闲置压缩已禁用');
      return null;
    }
    const intervalMs = Math.max(60000, Number(options.intervalMs) || 5 * 60 * 1000);
    const tick = () => {
      try {
        for (const key of Object.keys(state.sessions || {})) {
          const st = getSocialV2State(key);
          const d = decision(key, st);
          if (d) void run(key, d);
        }
      } catch (error) {
        log(`[compaction] 巡检异常: ${error?.message ?? error}`);
      }
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    log(`[compaction] 闲置边界压缩已启用（每 ${Math.round(intervalMs / 60000)} 分钟巡检，`
      + `闲置 ${Math.round((Number(c.idleMs) || 1800000) / 60000)} 分钟且上下文 > `
      + `${Math.round((Number(c.thresholdTokens) || 300000) / 1000)}k 才压）`);
    return timer;
  }

  return { start, decision, run, compactSession, currentContextTokens };
}
