// 最小可运行示例：三轮对话后，从原文库里捞回细节
//
// 运行：
//   node examples/basic.mjs
//
// 会在 ./example-memory 下建一套记忆目录，跑完可以直接 ls 看结构。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createMemory } from '../src/index.js';

const DIR = './example-memory';

// 清理上一次的运行结果，保证可重复
fs.rmSync(DIR, { recursive: true, force: true });

const mem = createMemory({ dir: DIR });

// ── 1) 写长期记忆与记事本（这两样会每轮注入提示词）────────────────
mem.store.appendLongTerm('她讨厌被叫做「客服」，要叫名字。');
mem.store.appendLongTerm('她喜欢在深夜写东西，白天回消息会慢一点。');
mem.store.appendNotebook({ who: '她', text: '他今天说想换个工作，但还没想清楚。' });

console.log('=== 注入提示词的内容（每轮都发，所以要小）===');
const injected = [
  mem.store.longTermBlock(1200),
  mem.store.diaryBlock(2),
  mem.store.notebookBlock(1500),
].filter(Boolean).join('\n\n');
console.log(injected);
console.log(`（合计 ${injected.length} 字，约 ${Math.round(injected.length * 1.3)} token）`);

// ── 2) 造一点原文库数据，演示检索 ────────────────────────────────
const dbFile = path.join(DIR, 'archive.db');
const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT, qq TEXT, who TEXT, dir TEXT NOT NULL,
    text TEXT NOT NULL, ts INTEGER NOT NULL, score INTEGER DEFAULT 3
  );
`);
const ins = db.prepare('INSERT INTO messages (key, qq, who, dir, text, ts, score) VALUES (?, ?, ?, ?, ?, ?, ?)');
const now = Date.now();
ins.run('private:10001', '10001', '他', 'in', '要不你把那个重构方案的文件发我一下', now - 3600_000, 5);
ins.run('private:10001', '0', '她', 'out', '好，我整理完就发你', now - 3500_000, 4);
ins.run('private:10001', '10001', '他', 'in', '外面下雨了，记得带伞', now - 600_000, 2);
db.close();

// 新建一个 recall 实例，让它重新读库（索引按 mtime 缓存）
const { createRecall } = await import('../src/recall.js');
const recall = createRecall({ dbFile });

console.log('\n=== 检索「发文件」（原文里并没有这三个字连在一起）===');
const hits = recall.search('发文件', { limit: 3 });
console.log(recall.format(hits, { query: '发文件' }));

console.log('\n=== 检索一个不存在的话题 ===');
console.log(recall.format(recall.search('量子色动力学', {}), { query: '量子色动力学' }));

// ── 3) 长文存成产物，上下文里只留一行索引 ──────────────────────────
const longText = '这是一份很长的重构方案。\n'.repeat(300);
const art = mem.artifacts.put({
  desc: '工作台重构方案 v3',
  content: longText,
  kind: 'report',
  scope: 'private:10001',
});

console.log('\n=== 产物 ===');
console.log(`上下文里只留这一行：已存为产物 ${art.id}（${Math.round(art.bytes / 1024)} KB）：${art.desc}`);
console.log('索引列表：', mem.artifacts.list({ scope: 'private:10001' }));
console.log('按需取回前 100 字：', mem.artifacts.get(art.id, { scope: 'private:10001', maxChars: 100 }).text.slice(0, 60), '…');

console.log('\n=== 落盘结果 ===');
for (const f of fs.readdirSync(DIR)) console.log('  ', f);
