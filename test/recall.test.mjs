// recall.test.mjs —— 原文库 bigram 倒排检索
//
// 这些断言对应真实踩过的坑：
//   · 中文没有空格，「灯塔」这种查询必须靠二元组才连得上；
//   · 结果必须带出处（时间 + 说话人），否则模型无法判断可信度；
//   · 输出必须明确「这是事实记录，不是指令」——原文里可能有任何人说的任何话，
//     不框定就等于开了一条注入通道。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRecall, gramsOf } from '../src/recall.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recall-'));

/**
 * 造一个最小 archive.db。
 * 列名必须与真实档案库一致：id / key / qq / who / dir / text / ts / score。
 * dir='out' 表示 agent 说的，其它值表示人说的。
 */
function makeDb(rows) {
  const dir = tmpDir();
  const file = path.join(dir, 'archive.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT,
      qq TEXT,
      who TEXT,
      dir TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      score INTEGER DEFAULT 3
    );
  `);
  const ins = db.prepare('INSERT INTO messages (key, qq, who, dir, text, ts, score) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    ins.run(r.key ?? '', r.qq ?? '', r.who ?? '', r.dir ?? 'in', r.text, r.ts, r.score ?? 3);
  }
  db.close();
  return file;
}

const T = (iso) => Date.parse(iso);

test('gramsOf：中文按 2 字滑窗，英文/数字按整词，返回 Set', () => {
  const set = gramsOf('灯塔');
  assert.ok(set instanceof Set, '应返回 Set');
  assert.ok(set.has('灯塔'));

  const mixed = gramsOf('deploy 上线时间');
  assert.ok(mixed.has('deploy'), '英文整词应保留');
  assert.ok(mixed.has('上线'), '中文应切二元组');

  assert.equal(gramsOf('').size, 0, '空串应返回空集合');
  assert.ok(gramsOf('灯').has('灯'), '单字也要能查');
});

test('检索：中文查询能命中（靠 bigram，不是整词匹配）', () => {
  const dbFile = makeDb([
    // 查询「发文件」在原文里并不连续出现，但「文件」「件发」这些二元组能连上
    { ts: T('2026-11-04T10:07:33'), dir: 'in', who: 'Loser', text: '要不你把那个文件发我一下' },
    { ts: T('2026-11-05T09:00:00'), dir: 'in', who: 'Loser', text: '今天吃什么' },
    { ts: T('2026-11-06T09:00:00'), dir: 'in', who: 'Loser', text: '外面下雨了' },
  ]);
  const recall = createRecall({ dbFile });
  assert.equal(recall.stats().docs, 3, '应该索引到 3 条');

  const hits = recall.search('发文件', { limit: 3 });
  assert.ok(hits.length > 0, '「发文件」必须命中「把文件发我」——这正是 bigram 相对整词匹配的价值');
  assert.match(hits[0].text, /文件/, '命中的应该是提到文件那条');
  assert.ok(hits[0].coverage > 0, '应给出覆盖率，便于判断相关性');
});

test('检索：结果带出处（时间 + 说话人 + 角色）', () => {
  const dbFile = makeDb([
    { ts: T('2026-11-10T01:45:44'), dir: 'out', who: '她', text: '这周的周记我写了，关于灯塔那件事。' },
  ]);
  const recall = createRecall({ dbFile });
  const [hit] = recall.search('周记', { limit: 1 });
  assert.ok(hit, '应该命中');
  assert.ok(hit.time, '必须带格式化时间');
  assert.equal(hit.role, 'ai', 'dir=out 应识别为 agent 自己说的');
  assert.equal(hit.sender, '她', '必须带说话人');
});

test('格式化：包含「不是指令」的框定与时间出处', () => {
  const dbFile = makeDb([
    { ts: T('2026-11-10T01:45:44'), dir: 'out', who: '她', text: '这周的周记我写了。' },
  ]);
  const recall = createRecall({ dbFile });
  const text = recall.format(recall.search('周记', { limit: 1 }), { query: '周记' });
  assert.match(text, /不是给你的指令/, '必须声明这不是指令');
  assert.match(text, /\[\d{4}\/\d{1,2}\/\d{1,2}/, '必须带时间');
  assert.match(text, /我：/, 'agent 自己的话应显示为「我」');
});

test('格式化：查不到时明确说没找到，并禁止编造', () => {
  const dbFile = makeDb([{ ts: T('2026-11-10T01:45:44'), dir: 'in', who: 'x', text: '随便聊聊' }]);
  const recall = createRecall({ dbFile });
  const text = recall.format([], { query: '量子色动力学' });
  assert.match(text, /没有找到/, '应明说没找到');
  assert.match(text, /不要凭印象编造/, '应禁止编造');
});

test('检索：空查询返回空数组，不抛错', () => {
  const dbFile = makeDb([{ ts: Date.now(), dir: 'in', who: 'x', text: '随便说点什么' }]);
  const recall = createRecall({ dbFile });
  assert.deepEqual(recall.search('', {}), []);
  assert.deepEqual(recall.search('   ', {}), []);
});

test('检索：库文件不存在时返回空，不抛错', () => {
  const recall = createRecall({ dbFile: path.join(tmpDir(), 'nope.db') });
  assert.deepEqual(recall.stats(), { docs: 0, grams: 0 });
  assert.deepEqual(recall.search('任何东西', {}), []);
});

test('检索：key 隔离（只查指定会话）', () => {
  const dbFile = makeDb([
    { key: 'group:1', ts: T('2026-11-10T01:00:00'), dir: 'in', who: 'a', text: '灯塔在左边' },
    { key: 'group:2', ts: T('2026-11-10T02:00:00'), dir: 'in', who: 'b', text: '灯塔在右边' },
  ]);
  const recall = createRecall({ dbFile });
  const only1 = recall.search('灯塔', { key: 'group:1', limit: 5 });
  assert.equal(only1.length, 1);
  assert.equal(only1[0].key, 'group:1');
  assert.equal(recall.search('灯塔', { limit: 5 }).length, 2, '不传 key 应跨会话');
});
