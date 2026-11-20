// artifacts.test.mjs —— 产物索引：长文落盘，正文不进上下文
//
// 真实契约（与实现一致，别按直觉改）：
//   · put 必须给 scope，不给就抛错（防止产物串场）；
//   · get 找不到 / scope 不符 / 文件被改动 都**抛错**，不返回 {found:false}
//     —— 静默返回空会诱导模型编造；
//   · list 只回索引字段，绝不带正文。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createArtifactStore } from '../src/artifacts.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-art-'));
const makeStore = (dir) => createArtifactStore({ dir });

test('put/get：正文落盘，按 id 取回', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  const body = '长报告正文。'.repeat(200);

  const put = s.put({ desc: '一份长报告', content: body, kind: 'report', scope: 'demo' });
  assert.ok(put.id, '应返回 id');
  assert.ok(put.bytes > 0, '应记录字节数');
  assert.ok(put.sha256, '应记录哈希');

  const got = s.get(put.id, { scope: 'demo' });
  assert.equal(got.desc, '一份长报告');
  assert.match(got.text, /长报告正文/);
  assert.equal(got.truncated, false, '未超上限时不应标记截断');
});

test('list：只回索引字段，绝不带正文', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  s.put({ desc: '第一件', content: 'x'.repeat(100), scope: 'demo' });
  s.put({ desc: '第二件', content: 'y'.repeat(100), scope: 'demo' });

  const list = s.list({ scope: 'demo' });
  assert.equal(list.length, 2);
  for (const item of list) {
    assert.ok(item.id);
    assert.ok(item.desc);
    assert.equal(item.text, undefined, '索引里不应带正文');
  }
});

test('scope 隔离：用错的 scope 取不到（抛错而不是给内容）', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  const a = s.put({ desc: 'A 的产物', content: 'aaa', scope: 'a' });
  s.put({ desc: 'B 的产物', content: 'bbb', scope: 'b' });

  assert.equal(s.list({ scope: 'a' }).length, 1);
  assert.equal(s.list({ scope: 'b' }).length, 1);
  assert.equal(s.list().length, 2, '不传 scope 应列出全部（管理视角）');
  assert.throws(() => s.get(a.id, { scope: 'b' }), /不属于当前会话/);
});

test('scope 必填：不给就抛错', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  assert.throws(() => s.put({ desc: 'x', content: 'y' }), /scope 不能为空/);
});

test('desc 必填：没有描述就没法以后找回', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  assert.throws(() => s.put({ content: 'z', scope: 'demo' }), /desc 不能为空/);
});

test('get：maxChars 截断，并标记 truncated 与总长度', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  const put = s.put({ desc: '很长的东西', content: 'z'.repeat(5000), scope: 'demo' });

  const got = s.get(put.id, { scope: 'demo', maxChars: 500 });
  assert.ok(got.text.length <= 500, '正文应被截断');
  assert.equal(got.truncated, true, '应标记为已截断');
  assert.ok(got.totalChars >= 5000, '应告知总长度，便于分段取');
});

test('取不存在的 id：抛错（不静默返回空，否则会诱导编造）', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  assert.throws(() => s.get('art_不存在', { scope: 'demo' }), /没有这个产物/);
});

test('篡改检测：正文被改动后拒绝引用', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  const put = s.put({ desc: '会被改的', content: '原始内容', scope: 'demo' });

  fs.writeFileSync(path.join(dir, put.file), '被偷偷改过的内容', 'utf8');
  assert.throws(() => s.get(put.id, { scope: 'demo' }), /已被改动/);
});

test('上限：超过 maxBytes 直接拒绝', () => {
  const dir = tmpDir();
  const s = createArtifactStore({ dir, maxBytes: 64 });
  assert.throws(() => s.put({ desc: '太大', content: 'x'.repeat(200), scope: 'demo' }), /超过上限/);
});

test('索引与正文都真的落盘（不是只存内存）', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  const put = s.put({ desc: '落盘验证', content: '内容', scope: 'demo' });

  assert.ok(fs.existsSync(path.join(dir, 'index.jsonl')), '应有索引文件');
  assert.ok(fs.existsSync(path.join(dir, put.file)), `应有正文文件 ${put.file}`);

  // 换一个实例也能读到（说明靠磁盘而不是内存状态）
  const s2 = makeStore(dir);
  assert.equal(s2.get(put.id, { scope: 'demo' }).desc, '落盘验证');
});

test('stats：返回件数与总字节', () => {
  const dir = tmpDir();
  const s = makeStore(dir);
  s.put({ desc: 'a', content: 'x'.repeat(10), scope: 'demo' });
  s.put({ desc: 'b', content: 'y'.repeat(20), scope: 'demo' });
  const st = s.stats();
  assert.equal(st.count, 2);
  assert.ok(st.bytes >= 30);
});
