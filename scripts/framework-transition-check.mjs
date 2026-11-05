// 框架生成回路回归：transition 字段（跨段箭头旁的字）必须打通。
//
// 这条链路有三段，任何一段漏掉，图上就只剩箭头没有含义：
//   ① 提示词要求模型输出 parts[].transition
//   ② normalizeFramework 接收、截断、缺字段兜底为空串
//   ③ 走真实 HTTP 路由 + 真实存储落盘（不是只测函数）
//
// 用法：node scripts/framework-transition-check.mjs
import { makeRoutes } from '../lib/http.js';
import { createBook, readBookState } from '../lib/store.js';
import { FRAMEWORK_SYSTEM, normalizeFramework } from '../lib/llm.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

let pass = 0;
let fail = 0;
const t = (name, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log('FAIL ' + name + ' ' + (detail ?? ''));
  }
};

// ── ① 提示词必须点名 transition，并说清它是什么形状 ────────────────
t('提示词包含 transition 字段', FRAMEWORK_SYSTEM.includes('"transition"'), '');
t('提示词说明它是箭头旁的字', FRAMEWORK_SYSTEM.includes('箭头旁'), '');
t('提示词要求短、不要句子', FRAMEWORK_SYSTEM.includes('不要写成句子'), '');
t('提示词说明末段留空', FRAMEWORK_SYSTEM.includes('留空串'), '');

// ── ② normalizeFramework：接收 / 截断 / 兜底 ──────────────────────
const normalized = normalizeFramework({
  title: 'T',
  summary: 'S',
  parts: [
    {
      name: 'A',
      question: 'q',
      transition: '打基础',
      chapters: [{ index: 1, title: 'c1', pages: [1, 9] }],
    },
    {
      name: 'B',
      question: 'q2',
      // 模型偶尔会写成一句话 —— 必须替它收住
      transition: '这是一个非常非常长的过渡描述句子应该被截断',
      chapters: [{ index: 2, title: 'c2' }],
    },
    {
      name: 'C',
      chapters: [{ index: 3, title: 'c3' }],
    },
  ],
});
t('短 transition 原样保留', normalized.parts[0].transition === '打基础', normalized.parts[0].transition);
t('长 transition 被截到 16 字', normalized.parts[1].transition.length <= 16, 'len=' + normalized.parts[1].transition.length);
t('缺 transition 时兜底为空串', normalized.parts[2].transition === '', JSON.stringify(normalized.parts[2].transition));

// ── ③ 真实 HTTP 路由 + 真实落盘 ───────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'dr-transition-'));
const paths = { dir, libraryDir: join(dir, 'library') };

const fakeLlm = {
  prepareCall: async (config) => ({
    config,
    stream: async function* () {
      const text = JSON.stringify({
        title: '测试书',
        summary: '两段',
        parts: [
          {
            name: '第一段 · 打地基',
            question: '怎么学',
            transition: '打基础',
            chapters: [{ index: 2, title: '机器如何自己学习', pages: [10, 40], gist: '三要素', keyPoints: ['模型'] }],
          },
          {
            name: '第二段 · 进大模型',
            question: '怎么进',
            transition: '',
            chapters: [{ index: 8, title: '语言的魔法', pages: [161, 200], gist: 'LLM', keyPoints: ['分词'] }],
          },
        ],
        howToRead: ['先读第一章'],
      });
      for (let i = 0; i < text.length; i += 60) {
        yield { type: 'text-delta', index: 0, text: text.slice(i, i + 60) };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  }),
  stream: () => {},
};

const routes = makeRoutes({
  paths,
  llmHandle: () => ({ llm: fakeLlm, route: { provider: 'fake', model: 'fake' } }),
  logger: { warn: () => {} },
});

const server = createServer(async (req, res) => {
  const route = routes.find((r) => r.path === (req.url || '/').split('?')[0]);
  if (!route) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  const request = new Request('http://' + (req.headers.host || '127.0.0.1') + req.url, {
    method: req.method,
    headers: req.headers,
    body:
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : new ReadableStream({
            start(controller) {
              req.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
              req.on('end', () => controller.close());
            },
          }),
    duplex: 'half',
  });
  const response = await route.fetch(request);
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(new Uint8Array(await response.arrayBuffer()));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

try {
  const meta = await createBook(paths, {
    title: '测试书',
    fileName: 't.pdf',
    bytes: new TextEncoder().encode('%PDF-1.4'),
  });

  const res = await fetch(base + '/api/dsh-reader/framework', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: meta.id,
      samples: Array.from({ length: 20 }, (_, i) => ({
        page: i + 1,
        text: '第' + (i + 1) + '页 内容'.repeat(8),
      })),
    }),
  });

  t('framework 路由返回 200', res.status === 200, 'status=' + res.status);
  t('返回 NDJSON 流', (res.headers.get('content-type') || '').includes('ndjson'), res.headers.get('content-type'));

  let raw = '';
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += new TextDecoder().decode(value);
  }
  const events = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  t('事件流以 done 结束', events[events.length - 1].type === 'done', events.map((e) => e.type).join(','));

  const done = events.find((e) => e.type === 'done');
  t('done 事件带回框架', !!done && !!done.framework, '');
  t(
    '流里保留了 transition',
    done.framework.parts.map((p) => p.transition).join('|') === '打基础|',
    JSON.stringify(done.framework.parts.map((p) => p.transition)),
  );

  // 真正落盘的那一份也要对
  const state = await readBookState(paths, meta.id);
  t('落盘状态为 done', state.framework.status === 'done', state.framework.status);
  t(
    '落盘的 transition 与流一致',
    state.framework.data.parts.map((p) => p.transition).join('|') === '打基础|',
    JSON.stringify(state.framework.data.parts.map((p) => p.transition)),
  );
  t('framework 可用于画图（有 chapters）', state.framework.data.parts.every((p) => Array.isArray(p.chapters) && p.chapters.length > 0), '');
} finally {
  server.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
