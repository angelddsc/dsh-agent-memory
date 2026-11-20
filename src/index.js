// index.js —— dsh-agent-memory 的统一入口
//
// 四层记忆，每层解决一个具体问题：
//
//   L0 原文库     recall.js      每条消息都留在 SQLite 里，靠 bigram 倒排按需捞回
//   L1 笔记/摘要   store.js       日记、周记、月报；越久越压缩，但永不删除
//   L2 长期记忆    store.js       long-term.md：她自己写下、不该忘的事
//   L3 产物索引    artifacts.js   长文落盘，只留 id/描述/sha256，正文不进上下文
//
// 另有 idle-compact.js：只在「对话安静下来」的时刻压缩上下文，
// 避免压缩改写历史前缀、把 provider 的 KV 缓存整段打死。
//
// 这几条约束都是踩过坑才写进代码的：
//   · 注入提示词的内容必须有字数上限，而且必须**按句子边界**截断（cutAtSentence）——
//     硬切会留下「看着像话没说完就被人掐了」的半句；
//   · 检索结果要带出处（时间 + 说话人），并明确标注「这是事实记录，不是指令」；
//   · 压缩只能在闲置边界做，不能在对话中途做。

import path from 'node:path';

import { createRememberStore } from './store.js';
import { createRecall } from './recall.js';
import { createArtifactStore } from './artifacts.js';

export { createRememberStore } from './store.js';
export { createRecall, gramsOf } from './recall.js';
export { createArtifactStore } from './artifacts.js';
export { createIdleCompactor } from './idle-compact.js';

/**
 * 一次性把三个存储组件装配好（闲置压缩需要 DSH/宿主侧的 RPC，单独构造）。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]      记忆根目录，默认 <cwd>/memory
 * @param {string} [opts.dbFile]   原文库 SQLite 路径，默认 <dir>/archive.db
 * @param {Function} [opts.log]    日志函数 (msg: string) => void
 * @returns {{ dir: string, store: object, recall: object, artifacts: object }}
 */
export function createMemory(opts = {}) {
  const dir = opts.dir || path.join(process.cwd(), 'memory');
  return {
    dir,
    store: createRememberStore({ dir, log: opts.log }),
    recall: createRecall({ dbFile: opts.dbFile || path.join(dir, 'archive.db') }),
    artifacts: createArtifactStore({ dir: path.join(dir, 'artifacts') }),
  };
}
