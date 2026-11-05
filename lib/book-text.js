/**
 * 按「位置」读书：把用户选中的那一页（及邻近页）的文字取出来，喂给模型。
 *
 * ## 为什么在 Host 半做，而不是前端
 *
 * 用户的需求是「选中的语句位置一并传给 AI，AI 可以收到位置后**自行读取书的文件**」。
 * 这要求后端真的去读 PDF —— 而不是让前端把整页文字一起发上来。
 *
 * 两者的差别不只是实现位置：
 * - 前端发文字：请求体随页长膨胀（一页几百字、多页上千字），且**内容由客户端决定**，
 *   Host 无法验证它和文件里那页是否一致；
 * - Host 自己读：只收「页码 + 字符区间」这十几个字节，读盘后自己切。
 *   这既省带宽，也让「位置」成为唯一可信的输入。
 *
 * ## 沙箱纪律（与 store.js / http.js 一致）
 *
 * - **没有 `Buffer`**：字节一律 `Uint8Array`；`readFile` 不给 encoding 就返回 Buffer，
 *   这里显式包一层 `new Uint8Array(...)`（Buffer 是 Uint8Array 的子类，
 *   `new Uint8Array(buffer)` 只复制视图、不复制数据，够用）。
 * - **不能依赖 `@napi-rs/canvas`**：纯取文本不需要渲染像素，所以**不能**调 `page.render()`。
 *   实测：只 `getTextContent()` 在本环境可跑；一旦涉及 render 就会要求 canvas 模块。
 * - **不做计时器**：不排后台任务。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** pdf.js 只加载一次（它自身有缓存，但重复 import 会让 worker 装两次）。 */
let pdfjsPromise = null;

/**
 * 装 pdf.js（含 fake worker）。
 *
 * 不用 `new Worker`：Node 里没有 Worker 的浏览器实现，pdf.js 会退回同线程执行，
 * 但需要把 worker 模块挂到 `globalThis.pdfjsWorker` 才认。
 */
function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const lib = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
    const worker = await import(new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href);
    globalThis.pdfjsWorker = worker;
    lib.GlobalWorkerOptions.workerSrc = 'unused';
    return lib;
  })().catch((error) => {
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}

/** 每本书一个文档句柄缓存：反复问答不必每次重开 20MB 的文件。 */
const docCache = new Map();

/**
 * 打开一本书的 PDF 文档。
 * @param {{dir:string, libraryDir?:string}} paths
 * @param {string} id
 */
async function openDocument(paths, id) {
  const cached = docCache.get(id);
  if (cached) return cached;
  const lib = await loadPdfjs();
  const file = join(paths.libraryDir ?? join(paths.dir, 'library'), id, 'book.pdf');
  const raw = await readFile(file);
  /**
   * **必须是纯 Uint8Array，不能是 Buffer。**
   *
   * pdf.js 会检查 `instanceof Uint8Array` —— Buffer 虽然是它的子类，
   * 但 pdf.js 内部用的是**另一份 realm 的 Uint8Array**（worker 侧），
   * 跨 realm 的 instanceof 为 false，于是它报：
   *   `Please provide binary data as Uint8Array, rather than Buffer.`
   *
   * 而且 `new Uint8Array(buffer)` 对 Buffer 是「按元素复制」——
   * Buffer 的每个元素是字节值，所以会得到正确数据；但它仍是 Uint8Array 类型。
   * 实测这条路径可用（纯取文本不需要 canvas）。
   */
  const data = new Uint8Array(raw.buffer ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw);
  const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
  docCache.set(id, doc);
  return doc;
}

/** 清掉缓存（删书/重新导入时用）。 */
export function forgetDocument(id) {
  const doc = docCache.get(id);
  docCache.delete(id);
  if (doc && typeof doc.destroy === 'function') {
    try {
      doc.destroy();
    } catch {
      /* 忽略：已经销毁过 */
    }
  }
}

/**
 * 取一页的纯文本（按文本项拼接，项间用换行）。
 *
 * 与前端 `buildPageText` 的拼法**必须一致**：前端记下的 `offset/length`
 * 是按同一套拼法算出来的。两边拼法不同，同一个 offset 指向的字符就不同，
 * 引用会错位。所以这里复制同一套规则，并在回归里交叉验证。
 *
 * @param {any} pageProxy
 * @returns {Promise<{text:string, spans:Array<{start:number,end:number,str:string}>}>}
 */
async function pageTextOf(pageProxy) {
  const content = await pageProxy.getTextContent();
  const chunks = [];
  const spans = [];
  let cursor = 0;
  for (const raw of content.items) {
    const str = typeof raw.str === 'string' ? raw.str : '';
    if (str === '') continue;
    if (chunks.length > 0) {
      chunks.push('\n');
      cursor += 1;
    }
    const start = cursor;
    chunks.push(str);
    cursor += str.length;
    spans.push({ start, end: cursor, str });
  }
  return { text: chunks.join(''), spans };
}

/**
 * 读书：给出「位置」，返回该处的文字与上下文。
 *
 * @param {{dir:string, libraryDir?:string}} paths
 * @param {string} id - 书 id
 * @param {{page:number, offset?:number, length?:number, neighbor?:number}} where
 *   - `page`：**0 起**页码（与前端 mark.page 一致）
 *   - `offset` / `length`：该页文本里的字符区间（前端记的标注区间）
 *   - `neighbor`：前后各带几页作为上下文（默认 1，上限 3）
 * @returns {Promise<{page:number, total:number, quote:string, pageText:string,
 *   context:string, contextFrom:number, contextTo:number}>}
 */
export async function readAt(paths, id, where) {
  const doc = await openDocument(paths, id);
  const total = doc.numPages;
  // 页码夹到合法范围：位置来自客户端，不能信它一定合法
  const rawPage = Number(where.page);
  const pageIndex = Math.max(
    0,
    Math.min(total - 1, Number.isFinite(rawPage) ? Math.trunc(rawPage) : 0),
  );
  const neighbor = Math.max(0, Math.min(3, Math.trunc(where.neighbor ?? 1)));

  const pageProxy = await doc.getPage(pageIndex + 1);
  const { text: pageText, spans } = await pageTextOf(pageProxy);

  /**
   * 把「可能是字符串」的区间值转成整数。
   *
   * ## 为什么必须容错（实测踩过）
   *
   * `Number.isFinite('1019')` 是 **false** —— 它只认 number 类型。
   * 一旦区间以字符串形式进来（查询串、表单、或某层序列化把数字变成了字符串），
   * 判据就整体失效 → 退化成「页首」，而**页面显示的文字预览仍是对的**，
   * 于是用户看到的现象是「引用的文字看着没问题，但 AI 答的不是那段」。
   *
   * 实测对比（第 158 页，「稀疏奖励」在 offset 1019）：
   *   传 1019    → "稀疏奖励和稠密奖励．奖励的密度直接…"   ✅
   *   传 "1019"  → "7.10 如何设计一个好的奖励…"（页首）    ❌
   *
   * 所以先 `Number(...)` 再判，并且只在**真正无效**时才退化。
   */
  const toInt = (value) => {
    if (value === null || value === undefined || value === '') return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  };

  let quote = '';
  const offset = toInt(where.offset);
  const length = toInt(where.length);
  if (Number.isFinite(offset) && Number.isFinite(length) && length > 0) {
    quote = pageText.slice(Math.max(0, offset), Math.max(0, offset) + length);
  }
  if (quote === '' && pageText !== '') {
    // 没有可靠区间时给页首，让模型至少能看清这一段讲什么
    quote = pageText.slice(0, 300);
  }
  // 页码同样容错：字符串页码会让 getPage(0) 取错页
  // （已在上面用 pageIndex 夹住，这里只保证 pageIndex 来自数字）

  // 上下文：相邻页拼起来，模型据此判断「这段在讲什么」
  const from = Math.max(0, pageIndex - neighbor);
  const to = Math.min(total - 1, pageIndex + neighbor);
  const parts = [];
  for (let index = from; index <= to; index += 1) {
    if (index === pageIndex) {
      parts.push(pageText);
      continue;
    }
    const proxy = index === pageIndex ? pageProxy : await doc.getPage(index + 1);
    const info = await pageTextOf(proxy);
    parts.push(info.text);
  }

  return {
    page: pageIndex,
    total,
    quote,
    pageText,
    context: parts.join('\n\n'),
    contextFrom: from,
    contextTo: to,
    spanCount: spans.length,
  };
}
