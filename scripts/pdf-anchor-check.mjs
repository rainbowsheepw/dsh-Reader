// 标注锚点回归：**精确到字符**的偏移计算。
//
// ## 这个脚本原来是验一个已废弃的实现
//
// 上一版内联了一份 `offsetFromRects`（用矩形猜覆盖）并写了 24 项断言。
// 而那个实现正是「标出来的比选中的多」的元凶 —— 它按**文本项边界**扩：
// 真实数据里第 165 页有一个 25 字的项，只选中间 3 字会标出 25 字。
//
// **继续验一个已删除的实现，等于给自己错误的信心。** 所以改测现在的
// `offsetFromRange`：从源码抽出来，用真 PDF 的页文本 + DOM 桩跑。
//
// 用法：DR_SAMPLE_PDF=/path/to.pdf node scripts/pdf-anchor-check.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const clientSrc = await readFile(here + 'client.js', 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log('❌ ' + name, detail === undefined ? '' : '→ ' + detail);
  }
};

/* ══════ 抽出 offsetFromRange ════════════════════════════════════════ */

/** 括号配平到函数收尾。 */
function extractFn(code, name) {
  const at = code.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let depth = 0;
  for (let index = at; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(at, index + 1);
    }
  }
  return null;
}

const fnSrc = extractFn(clientSrc, 'offsetFromRange');
if (!fnSrc) {
  console.log('❌ 找不到 offsetFromRange，源码形状变了');
  process.exit(1);
}
const offsetFromRange = new Function(fnSrc + '\nreturn offsetFromRange;')();

/* ══════ DOM 桩 ══════════════════════════════════════════════════════ */

/** offsetFromRange 只用 nodeType / parentNode / dataset.drStart。 */
function makeSpanNode(start) {
  const textNode = { nodeType: 3, parentNode: null };
  const el = { nodeType: 1, dataset: { drStart: String(start) }, parentNode: null };
  textNode.parentNode = el;
  return { el, textNode };
}

function makePage(text, spans) {
  const nodes = spans.map((span) => makeSpanNode(span.start));
  return { text, spans, nodes };
}

/* ══════ 构造页文本（与 client.js 的 buildPageText 同规则）═══════════ */

/** 复刻 buildPageText：项之间插 '\n'。 */
function buildPageText(items) {
  const chunks = [];
  const spans = [];
  let cursor = 0;
  for (const item of items) {
    if (!item.str) continue;
    if (chunks.length > 0) {
      chunks.push('\n');
      cursor += 1;
    }
    const start = cursor;
    chunks.push(item.str);
    cursor += item.str.length;
    spans.push({ start, end: cursor, item });
  }
  return { text: chunks.join(''), spans };
}

/* ══════ A. 无 PDF 时的纯逻辑用例（总是跑）═════════════════════════ */

{
  // 项内部分选中：只标那 4 个字，不许扩到整项
  const LONG = '它背后的语言模型仍建立在前面介绍过的'; // 真实数据里的 18 字项
  const page = makePage('前言\n' + LONG + '\n后记', [
    { start: 0, end: 2, item: { str: '前言' } },
    { start: 3, end: 3 + LONG.length, item: { str: LONG } },
    { start: 3 + LONG.length + 1, end: 3 + LONG.length + 3, item: { str: '后记' } },
  ]);
  const nodes = page.nodes;
  const range = {
    startContainer: nodes[1].textNode,
    startOffset: 4,
    endContainer: nodes[1].textNode,
    endOffset: 8,
  };
  const hit = offsetFromRange(page, range);
  check('A1 项内 4 字能定位', Boolean(hit));
  check('A1 长度恰好 4（不扩到整项 18）', hit && hit.length === 4, hit ? hit.length : '无');
  check('A1 内容正确', hit && page.text.slice(hit.offset, hit.offset + hit.length) === LONG.slice(4, 8),
    hit ? JSON.stringify(page.text.slice(hit.offset, hit.offset + hit.length)) : '无');
}

{
  // 空白/找不到归属 → undefined，不猜
  const page = makePage('甲\n乙', [
    { start: 0, end: 1, item: { str: '甲' } },
    { start: 2, end: 3, item: { str: '乙' } },
  ]);
  const orphan = { nodeType: 3, parentNode: { nodeType: 1, dataset: {} } };
  const range = { startContainer: orphan, startOffset: 0, endContainer: page.nodes[1].textNode, endOffset: 1 };
  check('A2 无归属节点返回 undefined', offsetFromRange(page, range) === undefined);
}

/* ══════ B. 真 PDF 用例 ══════════════════════════════════════════════ */

const SAMPLE = process.env.DR_SAMPLE_PDF;
if (!SAMPLE) {
  console.log('跳过 B：设 DR_SAMPLE_PDF 指向一本真实 PDF 再跑');
  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exitCode = fail ? 1 : 0;
} else {
  const lib = await import(here + 'vendor/pdf.min.mjs');
  const worker = await import(here + 'vendor/pdf.worker.min.mjs');
  globalThis.pdfjsWorker = worker;
  lib.GlobalWorkerOptions.workerSrc = 'unused';

  // itemBox 也从源码抽（保证与运行时同一套换算）
  const geomSrc = (() => {
    const a = clientSrc.indexOf('function composeTransform(');
    const b = clientSrc.indexOf('/* ═══ 全书抽样');
    return clientSrc.slice(a, b);
  })();
  const { itemBox } = new Function(geomSrc + '\nreturn { itemBox };')();

  const data = await readFile(SAMPLE);
  const doc = await lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;

  // 选几页，覆盖正文/图表页
  for (const pn of [12, 165, 200, 300]) {
    if (pn > doc.numPages) continue;
    const pageProxy = await doc.getPage(pn);
    const scale = 1.4;
    const viewport = pageProxy.getViewport({ scale });
    const content = await pageProxy.getTextContent();
    const items = content.items
      .filter((raw) => raw.str && raw.str.trim())
      .map((raw) => ({
        str: raw.str,
        transform: raw.transform,
        width: raw.width,
        box: itemBox(raw, viewport.transform, scale),
      }));
    const pageText = buildPageText(items);
    const page = makePage(pageText.text, pageText.spans);

    // B1. 每个项「只取中间 1 个字符」→ 长度必须恰好 1
    let midOk = 0;
    for (let index = 0; index < Math.min(page.spans.length, 40); index += 1) {
      const span = page.spans[index];
      const len = span.item.str.length;
      if (len < 2) continue;
      const mid = Math.floor(len / 2);
      const range = {
        startContainer: page.nodes[index].textNode,
        startOffset: mid,
        endContainer: page.nodes[index].textNode,
        endOffset: mid + 1,
      };
      const hit = offsetFromRange(page, range);
      if (hit && hit.length === 1 && page.text.slice(hit.offset, hit.offset + 1) === span.item.str[mid]) {
        midOk += 1;
      }
    }
    check(`p${pn} 单字符选中精确（${midOk} 项通过）`, midOk > 5, midOk);

    // B2. 整项选中 → 长度等于该项长度（一个字不多）
    let wholeOk = 0;
    for (let index = 0; index < Math.min(page.spans.length, 40); index += 1) {
      const span = page.spans[index];
      const range = {
        startContainer: page.nodes[index].textNode,
        startOffset: 0,
        endContainer: page.nodes[index].textNode,
        endOffset: span.item.str.length,
      };
      const hit = offsetFromRange(page, range);
      if (hit && hit.length === span.item.str.length) wholeOk += 1;
    }
    check(`p${pn} 整项选中不扩张（${wholeOk} 项通过）`, wholeOk > 5, wholeOk);

    // B3. 偏移必须落在页文本范围内
    const lastSpan = page.spans[page.spans.length - 1];
    check(`p${pn} 偏移在范围内`, lastSpan.end <= page.text.length, lastSpan.end + ' vs ' + page.text.length);

    // B4. 原始选区矩形不应再参与计算 —— 页文本里不该出现矩形相关字段
    check(`p${pn} 页对象无 rect 字段`, !page.rects, Object.keys(page).join(','));
  }

  await doc.destroy();

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exitCode = fail ? 1 : 0;
}
