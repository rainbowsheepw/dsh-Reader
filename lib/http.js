/**
 * Host 半路由族：`/api/dsh-reader/*`。
 *
 * ## 为什么走 `connection.fetch.register` 而不是 `webServer.register`
 *
 * 这一条是安装后实测撞出来的：`webServer.register({ kind: 'exact' })` 在 `/api/*` 下**确实**
 * 能通，但 `kind: 'prefix'` 会被宿主的 API 网关拦成 `401 unauthorized`（网关只放行精确
 * 端点，前缀一律当未授权）。也就是说静态资源（pdf.js 那份 ~1.7MB）用 webServer 前缀路由
 * 永远拿不到。
 *
 * `connection.fetch.register` 是 `/api` 通道的正式入口：它自带浏览器的签名凭据校验，
 * 路由表是**精确路径**（`methods` + `requestBody` + `fetch(Request) → Response`），
 * 注册随之生效于插件 fiber —— 插件卸载、路由消失。于是这里只保留精确路径，
 * vendor 两个文件各走一条精确路由。
 *
 * ## 沙箱三纪律
 * - **不许 `Buffer`**：沙箱里它是 undefined；字节用 `Uint8Array`，长度用 `TextEncoder`。
 * - **不许 `process` / `setTimeout`**：顶层读 process 会让整条 fiber FAILED；没有计时器。
 * - **失败恒为信封** `{ ok:false, error:{ code, message } }`。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  MARK_COLORS,
  addNote,
  clearMarks,
  createBook,
  deleteBook,
  deleteMark,
  editNote,
  listBooks,
  readBookBytes,
  readBookState,
  saveFramework,
  saveProgress,
  upsertMark,
} from './store.js';
import { isBookId } from './paths.js';
import { ASK_SYSTEM, FRAMEWORK_SYSTEM, extractJson, normalizeFramework, streamText } from './llm.js';
// readAt：按「页码 + 字符区间」从 PDF 里读原文（问答页签靠它自己读书，而不是靠前端传文字）
import { forgetDocument, readAt } from './book-text.js';

/** 上传体积上限（字节）。 */
const MAX_UPLOAD_BYTES = 160 * 1024 * 1024;
/** 一次框架请求里信号文本的字符上限。 */
const MAX_SIGNAL_CHARS = 60000;

/** UTF-8 字节数（沙箱没有 Buffer.byteLength）。 */
function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

/** 插件包内相对路径 → 绝对路径（只对白名单里的固定名字调用）。 */
function assetPath(relative) {
  return fileURLToPath(new URL('../' + relative, import.meta.url));
}

/** 允许投递的静态文件白名单：绝不用请求路径拼文件系统路径。 */
const VENDOR = {
  '/api/dsh-reader/vendor/pdf.min.mjs': 'vendor/pdf.min.mjs',
  '/api/dsh-reader/vendor/pdf.worker.min.mjs': 'vendor/pdf.worker.min.mjs',
};

/** 成功信封。 */
function okJson(value, status = 200) {
  return new Response(JSON.stringify({ ok: true, ...value }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** 失败信封。 */
function failJson(status, code, message) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** 取 URL query。 */
function urlOf(request) {
  return new URL(request.url, 'http://127.0.0.1');
}

/** 读请求体为 Uint8Array（带上限）。 */
async function readBody(request, limit) {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) {
    throw Object.assign(new Error('请求体过大'), { code: 'too-large' });
  }
  return new Uint8Array(buffer);
}

/** 读 JSON 请求体。 */
async function readJson(request, limit = 8 * 1024 * 1024) {
  const bytes = await readBody(request, limit);
  if (bytes.length === 0) return {};
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'body-invalid' });
  }
}

/**
 * NDJSON 流式响应：Content-Type 用 application/x-ndjson，
 * 浏览器端按行解析；比 SSE 简单，也不受代理缓冲的那套约定影响。
 * @param {(send:(event:object)=>void, close:()=>void) => Promise<void>} producer
 */
function ndjson(producer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      try {
        await producer(send, close);
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * 把「页级信号」压成一份可读结构清单给模型。
 * @param {Array<{page:number, text:string, heading?:string}>} samples
 * @returns {string}
 */
function buildSignalText(samples) {
  const lines = [];
  let total = 0;
  for (const sample of samples) {
    if (!sample || typeof sample.text !== 'string') continue;
    const text = sample.text.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const page = Number.isFinite(sample.page) ? Math.trunc(sample.page) : 0;
    const heading = typeof sample.heading === 'string' ? sample.heading.trim() : '';
    const line = `p${page}${heading ? ` [${heading}]` : ''}: ${text}`;
    total += line.length + 1;
    if (total > MAX_SIGNAL_CHARS) break;
    lines.push(line);
  }
  return lines.join('\n').slice(0, MAX_SIGNAL_CHARS);
}

/**
 * 构造整族路由（形状对齐 `ConnectionFetchRoute`）。
 *
 * @param {{paths:{dir:string, libraryDir:string}, llmHandle:()=>any, logger:{warn:(e:unknown)=>void}}} deps
 * @returns {Array<{path:string, methods:string[], requestBody:string, fetch:(req:Request)=>Promise<Response>}>}
 */
export function makeRoutes(deps) {
  const { paths } = deps;

  /** 统一兜底：业务异常 → 信封。 */
  const guard = (handler) => async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal';
      deps.logger.warn(error);
      const status =
        code === 'not-found' ? 404
          : code === 'no-llm' ? 503
            : code === 'body-invalid' || code === 'too-large' ? 400
              : 500;
      return failJson(status, code, error instanceof Error ? error.message : String(error));
    }
  };

  /** 取并校验 id。 */
  const requireId = (value) => {
    if (!isBookId(value)) throw Object.assign(new Error('书 id 非法'), { code: 'body-invalid' });
    return value;
  };

  /** 模型句柄：不可用就给人话。 */
  const llmOrFail = () => {
    const handle = deps.llmHandle();
    if (!handle) {
      throw Object.assign(
        new Error('宿主没有可用的模型路由：请先在 设置 → 模型 里选定默认模型'),
        { code: 'no-llm' },
      );
    }
    return handle;
  };

  return [
    // ── 静态 vendor（精确路径 ×2）───────────────────────────────────────
    ...Object.entries(VENDOR).map(([path, relative]) => ({
      path,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const bytes = await readFile(assetPath(relative));
        return new Response(request.method === 'HEAD' ? null : bytes, {
          status: 200,
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Content-Length': String(bytes.length),
            'Cache-Control': 'public, max-age=600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }),
    })),

    // ── 能力检查 ───────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async () => {
        const handle = deps.llmHandle();
        return okJson({
          llm: handle ? { provider: handle.route.provider, model: handle.route.model } : null,
        });
      }),
    },

    // ── 书目 ───────────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/books',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async () => okJson({ books: await listBooks(paths) })),
    },

    // ── 导入（原始字节）────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/import',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const params = urlOf(request).searchParams;
        const fileName = String(params.get('name') ?? 'book.pdf');
        if (!/\.pdf$/i.test(fileName)) {
          return failJson(400, 'unsupported', '第一版只收 PDF，请拖入 .pdf 文件');
        }
        const body = await readBody(request, MAX_UPLOAD_BYTES);
        if (body.length < 5 || new TextDecoder().decode(body.slice(0, 5)) !== '%PDF-') {
          return failJson(400, 'body-invalid', '这不是一个 PDF 文件（缺少 %PDF- 文件头）');
        }
        const rawTitle = params.get('title');
        const title = (rawTitle && rawTitle.trim()) || fileName.replace(/\.pdf$/i, '');
        const meta = await createBook(paths, { title, fileName, bytes: body, format: 'pdf' });
        return okJson({
          book: { id: meta.id, title: meta.title, fileName: meta.fileName, bytes: meta.bytes, format: meta.format },
        });
      }),
    },

    // ── 单本状态 ───────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/book',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const id = requireId(urlOf(request).searchParams.get('id'));
        const state = await readBookState(paths, id);
        if (!state) return failJson(404, 'not-found', '这本书不在了');
        return okJson({ book: state });
      }),
    },

    // ── 原始字节（阅读器取 PDF）────────────────────────────────────────
    {
      path: '/api/dsh-reader/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const id = requireId(urlOf(request).searchParams.get('id'));
        let bytes;
        try {
          bytes = await readBookBytes(paths, id);
        } catch {
          return failJson(404, 'not-found', '这本书的文件不在了，请重新导入');
        }
        return new Response(request.method === 'HEAD' ? null : bytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(bytes.length),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }),
    },

    // ── 删除 ───────────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const id = requireId((await readJson(request)).id);
        await deleteBook(paths, id);
        return okJson({ deleted: id });
      }),
    },

    // ── 进度 ───────────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/progress',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await readJson(request);
        const id = requireId(body.id);
        const meta = await saveProgress(paths, id, body);
        return okJson({ progress: meta.progress, pages: meta.pages });
      }),
    },

    // ── 标注 ───────────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/mark',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await readJson(request);
        const id = requireId(body.id);
        if (typeof body.deleteMarkId === 'string') {
          const meta = await deleteMark(paths, id, body.deleteMarkId);
          return okJson({ marks: meta.marks });
        }
        const mark = body.mark;
        if (!mark || typeof mark !== 'object') return failJson(400, 'body-invalid', '缺少标注内容');
        /**
         * ⚠️ 「原文不能为空」只对**新建**生效。
         *
         * 上一版是无条件校验 `mark.text`，于是「改笔记」这条必然 400：
         * 前端更新时只发 `{id, note}`（原文没变，没必要重传整条），
         * 校验却要求 text 非空 → 每次都失败，而界面又不显示错误，
         * 用户看到的就是「点了写笔记，毫无反应」。
         *
         * 判定口径：有 `id` 说明是**更新**，此时只校验 it 传了哪些字段。
         */
        const isUpdate = typeof mark.id === 'string' && mark.id !== '';
        if (!isUpdate && (typeof mark.text !== 'string' || mark.text.trim() === '')) {
          return failJson(400, 'body-invalid', '标注没有原文，无法保存');
        }
        if (typeof mark.color === 'string' && !MARK_COLORS.includes(mark.color)) {
          return failJson(400, 'body-invalid', '颜色不在色板里');
        }
        const meta = await upsertMark(paths, id, mark);
        return okJson({ marks: meta.marks });
      }),
    },

    // ── 笔记 ───────────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/note',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await readJson(request);
        const id = requireId(body.id);
        const note = body.note;
        if (!note || typeof note !== 'object') return failJson(400, 'body-invalid', '缺少笔记内容');
        const meta = note.id ? await editNote(paths, id, note) : await addNote(paths, id, note);
        return okJson({ notes: meta.notes });
      }),
    },

    // ── 批量清除 ─────────────────────────────────────────────────────
    {
      path: '/api/dsh-reader/clear',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await readJson(request);
        const id = requireId(body.id);
        /**
         * 范围校验必须严：这是**破坏性**操作，参数解析错一次就是删光。
         *
         *   range === null / undefined → 全部清除
         *   range 是对象 → 必须是两个有限整数，且 from <= to
         *   其它任何形状 → 400，什么都不删
         *
         * 特别防 `{from: 0, to: 0}` 被当成「全清」的误读：这里它是**合法的**
         * （只清第 1 页），全清只能由 range 缺失表达。
         */
        let range = null;
        if (body.range !== undefined && body.range !== null) {
          const raw = body.range;
          if (typeof raw !== 'object') {
            return failJson(400, 'body-invalid', 'range 必须是区间对象或省略');
          }
          const from = Number(raw.from);
          const to = Number(raw.to);
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
            return failJson(400, 'body-invalid', 'range 的 from/to 必须是非负整数且 from <= to');
          }
          range = { from, to };
        }
        const meta = await clearMarks(paths, id, range);
        const cleared = meta.__cleared || { marks: 0, notes: 0, total: 0 };
        return okJson({ marks: meta.marks, notes: meta.notes, cleared });
      }),
    },

    // ── AI 生成全书框架（NDJSON 流）─────────────────────────────────────
    {
      path: '/api/dsh-reader/framework',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await readJson(request, 16 * 1024 * 1024);
        const id = requireId(body.id);
        const state = await readBookState(paths, id);
        if (!state) return failJson(404, 'not-found', '这本书不在了');

        const handle = llmOrFail();
        const signalText = buildSignalText(Array.isArray(body.samples) ? body.samples : []);
        if (signalText.length < 200) {
          return failJson(
            400,
            'body-invalid',
            '抽出来的文字太少（不足 200 字）：这本可能是扫描版图片 PDF，没有文字层',
          );
        }

        await saveFramework(paths, id, {
          status: 'running',
          generatedAt: state.framework.generatedAt,
          data: state.framework.data,
        });

        return ndjson(async (send, close) => {
          try {
            const raw = await streamText(handle, {
              system: FRAMEWORK_SYSTEM,
              maxTokens: 8000,
              prompt:
                `书名：${state.title}\n总页数：${state.pages || '未知'}\n` +
                `下面是从各页抽出的结构信号（pN 表示第 N 页）：\n\n${signalText}`,
              onDelta: (delta) => send({ type: 'delta', text: delta }),
            });
            const framework = normalizeFramework(extractJson(raw));
            await saveFramework(paths, id, { status: 'done', generatedAt: Date.now(), data: framework, error: '' });
            send({ type: 'done', framework });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await saveFramework(paths, id, { status: 'failed', error: message, data: state.framework.data });
            send({ type: 'error', message });
          } finally {
            close();
          }
        });
      }),
    },

    // ── 选中提问（NDJSON 流）────────────────────────────────────────────
    {
      path: '/api/dsh-reader/ask',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: guard(async (request) => {
        const body = await readJson(request, 1024 * 1024);
        const handle = llmOrFail();

        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (question === '') return failJson(400, 'body-invalid', '问题为空');

        /**
         * ## 位置由后端读，不信前端发来的原文
         *
         * 用户要求「选中的位置一并传给 AI，AI 收到位置后自行读取书文件」。
         * 所以这里只接受 page / offset / length 三个数，真正的原文由 readAt()
         * 去 PDF 里切出来。
         *
         * 好处：
         * - 请求体只有几十字节，不受页长影响；
         * - 「位置」是唯一可信输入 —— 前端发来的 quote 可能与文件里那页不一致，
         *   而这种不一致在读书场景里是致命的（模型会基于假引文作答）。
         *
         * 例外：书文件读不出来（缺文件、PDF 坏了）时回落到前端传来的 quote，
         * 并把这个事实写进提示词 —— 宁可让模型知道「引用来自客户端」，
         * 也不要在这种情况下直接报错、让用户没法提问。
         */
        let quote = typeof body.quote === 'string' ? body.quote.trim() : '';
        let context = typeof body.context === 'string' ? body.context.slice(0, 6000) : '';
        let page = Number.isFinite(body.page) ? Math.trunc(body.page) : 0;
        let sourceNote = '';

        const canRead = typeof body.id === 'string' && isBookId(body.id);
        if (canRead) {
          try {
            const info = await readAt(paths, body.id, {
              page,
              offset: body.offset,
              length: body.length,
              neighbor: body.neighbor,
            });
            // 读盘结果覆盖客户端传的 quote/context —— 以文件为准
            if (info.quote) quote = info.quote;
            if (info.context) context = info.context;
            page = info.page;
            sourceNote =
              '（以下原文由系统从书文件中第 ' + (info.page + 1) + ' 页直接读出，' +
              '上下文范围：第 ' + (info.contextFrom + 1) + '–' + (info.contextTo + 1) + ' 页）';
          } catch (error) {
            sourceNote =
              '（未能读取书文件，以下原文由客户端提供：' +
              (error instanceof Error ? error.message : String(error)) + '）';
          }
        }

        const outline = typeof body.outline === 'string' ? body.outline.slice(0, 3000) : '';
        const rangeNote = Number.isFinite(body.offset) && Number.isFinite(body.length)
          ? '，选中区间 [' + Math.trunc(body.offset) + ', ' + (Math.trunc(body.offset) + Math.trunc(body.length)) + ')'
          : '';
        const prompt = [
          body.bookTitle ? '书名：' + body.bookTitle : '',
          '当前位置：第 ' + (page + 1) + ' 页' + rangeNote,
          sourceNote,
          outline ? '这本书的整体框架：\n' + outline : '',
          quote ? '选中的原文：\n"""' + quote + '"""' : '',
          context && context !== quote ? '该处上下文（供理解，不必逐句回应）：\n"""' + context + '"""' : '',
          '用户的问题：' + question,
        ]
          .filter(Boolean)
          .join('\n\n');

        /**
         * 多轮历史：前端把之前的问答传上来，转成真正的 role 序列。
         *
         * 校验从严：只接受 {role, text} 且 role 只能是 user/assistant，
         * text 截断到 2000 字。前端传来的东西不能直接信 ——
         * 万一有人塞进 role:'system'，就能绕过 system 提示词改写模型行为。
         */
        const history = [];
        if (Array.isArray(body.history)) {
          for (const turn of body.history.slice(-16)) {
            if (!turn || typeof turn !== 'object') continue;
            const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'user' ? 'user' : null;
            if (role === null) continue; // 丢弃 system / 其它角色
            const text = typeof turn.text === 'string' ? turn.text.slice(0, 2000) : '';
            if (text.trim() === '') continue;
            history.push({ role, text });
          }
        }

        return ndjson(async (send, close) => {
          try {
            await streamText(handle, {
              // 语气是产品性格的一部分 —— 换入口（抽屉 → 侧栏）不该让它变味
              system: ASK_SYSTEM,
              maxTokens: 2400,
              prompt,
              history,
              onDelta: (delta) => send({ type: 'delta', text: delta }),
            });
          } catch (error) {
            send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          } finally {
            close();
          }
        });
      }),
    },
  ];
}

export { byteLength };
