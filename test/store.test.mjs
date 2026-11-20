// store.test.mjs —— 文件层：写入、注入上限、句子边界截断
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRememberStore } from '../src/store.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-'));
const ymd = (ts = new Date()) => ts.toISOString().slice(0, 10);

test('长期记忆：写入后能读回，且按句子边界截断', () => {
  const dir = tmpDir();
  const store = createRememberStore({ dir });

  // 多句、足够长，必然触发截断
  for (let i = 0; i < 40; i += 1) {
    store.appendLongTerm(`第 ${i} 条：她喜欢在深夜写东西。第二句是废话。第三句也是。`);
  }

  const block = store.longTermBlock(500);
  assert.ok(block.length > 0, '应该返回内容');
  assert.ok(block.length <= 520, `截断后不应超过上限，实际 ${block.length}`);
  // 结尾必须落在句末标点或列表项结尾，不能停在半句中间
  assert.match(block.trimEnd(), /[。！？!?；;)]$/, `结尾不完整：…${block.slice(-20)}`);
});

test('长期记忆：超过上限时从尾部保留（新的更重要）', () => {
  const dir = tmpDir();
  const store = createRememberStore({ dir });
  store.appendLongTerm('最早的记忆，应该被丢掉。');
  for (let i = 0; i < 50; i += 1) store.appendLongTerm(`后来的第 ${i} 条记忆。`);

  const block = store.longTermBlock(200);
  assert.match(block, /第 49 条记忆/, '最新的内容必须留下');
  assert.doesNotMatch(block, /最早的记忆/, '最旧的内容应被挤掉');
});

test('日记：diaryBlock 读取 daily/*.md', () => {
  const dir = tmpDir();
  const store = createRememberStore({ dir });

  // 日记文件由模型写入（工具层），这里直接落文件模拟
  fs.writeFileSync(path.join(dir, 'daily', `${ymd()}.md`), '# 今天\n\n她把咖啡洒在键盘上了。\n', 'utf8');

  const block = store.diaryBlock(1);
  assert.match(block, /咖啡/);
});

test('记事本：appendNotebook 写入后 notebookBlock 能注入', () => {
  const dir = tmpDir();
  const store = createRememberStore({ dir });

  store.appendNotebook({ who: '她', text: '记住：他不喜欢别人替他做决定。' });
  const block = store.notebookBlock();
  assert.match(block, /不喜欢别人替他做决定/);
});

test('目录结构：首次调用就建好所有子目录', () => {
  const dir = tmpDir();
  createRememberStore({ dir });
  for (const sub of ['notebook', 'daily', 'weekly', 'monthly', 'chatlog']) {
    assert.ok(fs.existsSync(path.join(dir, sub)), `${sub} 应该存在`);
  }
});

test('空目录：所有注入函数返回空串而不是抛错', () => {
  const dir = tmpDir();
  const store = createRememberStore({ dir });
  assert.equal(store.longTermBlock(), '');
  assert.equal(store.diaryBlock(3), '');
  assert.equal(store.notebookBlock(), '');
  assert.equal(store.weeklyBlock(), '');
  assert.equal(store.monthlyBlock(), '');
});

test('stats：返回可用的统计信息', () => {
  const dir = tmpDir();
  const store = createRememberStore({ dir });
  store.appendLongTerm('一条记忆。');
  const s = store.stats();
  assert.equal(typeof s, 'object');
  assert.ok(s);
});
