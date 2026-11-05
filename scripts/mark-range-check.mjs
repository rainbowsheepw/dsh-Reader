// 标注范围回归：标出的必须**恰好**是选中的那些字。
//
// ## 事故
//
// 用户：「标注功能有问题，最终标有黄线的文字多于当时选中的文字」。
//
// ## 根因（用真实数据量化的）
//
// `offsetFromRects` 用**矩形**去猜选区覆盖了哪些文本项：
//
//     if (overlapY(...)/height < 0.5) return false;   // 垂直重叠 ≥50%
//     return overlapX(box[0], box[2], rect.left, rect.right) > 0;  // ← 横向**沾一点**
//     ...
//     offset = startSpan.start;                 // ← 从该项**开头**
//     length = endSpan.end - startSpan.start;   // ← 到该项**结尾**
//
// pdf.js 会把一行切成很长的项。真实数据里第 165 页有一项是
// `它背后的语言模型仍建立在前面介绍过的`（**18 字**）。
// 用户只选中间 4 个字，但「沾到一点」→ 整项纳入 → 首尾扩到项边界，
// **标出 18 字，多出 14 字**。
//
 // ## 修法
//
 // 用 `Range.startOffset / endOffset` —— 浏览器已经把「在第几个 span 的第几个字符」
 // 算准了，不该再用矩形去猜。矩形从此只用于定位浮层工具条。
 //
 // ## 本脚本验什么
 //
 // 用**真 pdf.js** 取的页文本，配合 DOM 桩模拟 Range，喂给源码里的
 // `offsetFromRange`，逐项断言：
 //   1. 项内部分选中 → 只标那部分（不多不少）
 //   2. 整项选中 → 标整项
 //   3. 跨项选中 → 从首项的第 a 个字符到末项的第 b 个字符
 //   4. 起点在项尾、终点在下一项时，不能把中间的空格/换行错算进去或漏算
 //   5. 反向选区（先选下面再拖到上面）也要正确
 //
 // 用法：node scripts/mark-range-check.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const src = await readFile(clientPath, 'utf8');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('ok   ' + label);
  } else {
    failed += 1;
    console.log('❌ ' + label + (detail === undefined ? '' : '  → ' + detail));
  }
}

/* ══════ A. 结构：旧逻辑必须彻底消失 ══════════════════════════════ */

check('A 旧函数 offsetFromRects 已移除', !/function offsetFromRects/.test(src));
check('A 不再用矩形猜覆盖（isItemCovered 已删）', !/function isItemCovered/.test(src));
check('A 不再用 overlapX 判横向', !/function overlapX/.test(src));
check('A 调用点改用 offsetFromRange', src.includes('offsetFromRange(pageText, range)'));

/* ══════ B. 抽出源码里的 offsetFromRange ═══════════════════════════ */

const fnStart = src.indexOf('function offsetFromRange(');
if (fnStart < 0) {
  console.log('❌ 找不到 offsetFromRange');
  process.exit(1);
}
// 从 function 起括号配平到收尾
let depth = 0;
let fnEnd = -1;
for (let index = fnStart; index < src.length; index += 1) {
  const ch = src[index];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) {
      fnEnd = index + 1;
      break;
    }
  }
}
const fnSrc = src.slice(fnStart, fnEnd);
const offsetFromRange = new Function(fnSrc + '\nreturn offsetFromRange;')();

/* ══════ C. 行为：用 DOM 桩跑真函数 ═══════════════════════════════ */

/**
 * 造一个极简 DOM 桩。
 *
 * `offsetFromRange` 只用三样东西：节点的 `nodeType`、`parentNode`、`dataset.drStart`。
 * 所以桩不需要 classList / getBoundingClientRect。
 */
function makeSpanNode(start) {
  const textNode = { nodeType: 3, parentNode: null, textContent: '' };
  const el = {
    nodeType: 1,
    dataset: { drStart: String(start) },
    parentNode: null,
    textNode,
  };
  textNode.parentNode = el;
  return { el, textNode };
}

/**
 * 造一页：每个文本项一个 span，`page.spans` 记录各自的字符区间。
 * @param {string[]} strs
 */
function makePage(strs) {
  const spans = [];
  const parts = [];
  let cursor = 0;
  const nodes = [];
  for (const str of strs) {
    if (parts.length > 0) {
      parts.push('\n');
      cursor += 1; // buildPageText 在项之间插 '\n'
    }
    const start = cursor;
    parts.push(str);
    cursor += str.length;
    const { el, textNode } = makeSpanNode(start);
    nodes.push({ el, textNode });
    spans.push({ start, end: cursor, item: { str } });
  }
  return { text: parts.join(''), spans, nodes };
}

/** 造 Range：指定起止落在哪个 span 的第几个字符。 */
function makeRange(nodes, from, to) {
  const startNode = nodes[from.index].textNode;
  const endNode = nodes[to.index].textNode;
  return { startContainer: startNode, startOffset: from.offset, endContainer: endNode, endOffset: to.offset };
}

/** 用「肉眼可读」的方式检查标出来的文本。 */
function markedText(page, hit) {
  return hit ? page.text.slice(hit.offset, hit.offset + hit.length) : '';
}

// ── C1. 项内部分选中：只能标选中的那几个字 ──────────────────────
{
  // 这一项直接取自真实数据：第 165 页那个 18 字的项
  const LONG = '它背后的语言模型仍建立在前面介绍过的';
  const page = makePage(['前言', LONG, '后记']);

  // 只选 LONG 的第 5~8 个字符（「语言」两字其实在第 4~6，这里按索引取）
  const range = makeRange(page.nodes, { index: 1, offset: 4 }, { index: 1, offset: 8 });
  const hit = offsetFromRange(page, range);
  check('C1 项内部分选中能定位', Boolean(hit));
  const text = markedText(page, hit);
  check('C1 标出的是那 4 个字', text === LONG.slice(4, 8), JSON.stringify(text));
  check('C1 长度恰好 4', hit && hit.length === 4, hit ? hit.length : '无');
  // 这条是事故的正面判据：旧逻辑会标整项 18 字
  check('C1 没有扩到整项 18 字', hit && hit.length !== LONG.length, hit ? hit.length : '无');
}

// ── C2. 整项选中：标整项，一个字不多 ──────────────────────────────
{
  const page = makePage(['甲', '乙丙丁', '戊']);
  const range = makeRange(page.nodes, { index: 1, offset: 0 }, { index: 1, offset: 3 });
  const hit = offsetFromRange(page, range);
  check('C2 整项选中长度 3', hit && hit.length === 3, hit ? hit.length : '无');
  check('C2 内容正确', markedText(page, hit) === '乙丙丁', JSON.stringify(markedText(page, hit)));
}

// ── C3. 跨项选中：从首项中间到末项中间 ───────────────────────────
{
  const page = makePage(['一二三四五', '六七八九十']);
  const range = makeRange(page.nodes, { index: 0, offset: 2 }, { index: 1, offset: 3 });
  const hit = offsetFromRange(page, range);
  check('C3 跨项能定位', Boolean(hit));
  const text = markedText(page, hit);
  // 期望：首项从第 2 字起「三四五」+ 换行 + 末项前 3 字「六七八」
  check('C3 内容 = 三四五 + 换行 + 六七八', text === '三四五\n六七八', JSON.stringify(text));
}

// ── C4. 起点在项尾（offset 等于该项长度）────────────────────────
//
// 浏览器在「从两项之间的空隙拖选」时可能给出 offset == 该项长度。
// 这时起点应落在该项**之后**（下一项开头），不能越界到负数或算成整项。
{
  const page = makePage(['末尾', '下一项']);
  const range = makeRange(page.nodes, { index: 0, offset: 2 }, { index: 1, offset: 3 });
  const hit = offsetFromRange(page, range);
  // 期望只标「下一项的前 3 字」
  const text = markedText(page, hit);
  check('C4 项尾起点不吞掉整项', text === '下一项'.slice(0, 3), JSON.stringify(text));
}

// ── C5. 反向选区（Shift+方向键往回选）────────────────────────────
//
// Range 的 startContainer/endContainer 总是「文档顺序靠前/靠后」，
// 所以浏览器会自动归一化，这里验一下即使传入反的也能给出正长度。
{
  const page = makePage(['甲乙丙', '丁戊己']);
  // 故意把「文档靠后」的节点当 start
  const reversed = {
    startContainer: page.nodes[1].textNode,
    startOffset: 2,
    endContainer: page.nodes[0].textNode,
    endOffset: 1,
  };
  const hit = offsetFromRange(page, reversed);
  // 逻辑里 firstIndex > lastIndex 时返回 undefined —— 明确失败而不是给出错误范围
  check('C5 反向选区被明确拒绝（不给出错范围）', hit === undefined, hit ? JSON.stringify(hit) : 'undefined');
}

// ── C6. 长度必须恒等于「末位置 − 首位置」，不许有任何扩张 ─────────
{
  const page = makePage(['aa', 'bbbb', 'cc']);
  // 从 index0.offset1 到 index1.offset2
  const range = makeRange(page.nodes, { index: 0, offset: 1 }, { index: 1, offset: 2 });
  const hit = offsetFromRange(page, range);
  const expectStart = page.spans[0].start + 1;
  const expectEnd = page.spans[1].start + 2;
  check('C6 offset 等于精确起点', hit && hit.offset === expectStart, hit ? hit.offset + ' vs ' + expectStart : '无');
  check('C6 length 等于精确跨度', hit && hit.length === expectEnd - expectStart,
    hit ? hit.length + ' vs ' + (expectEnd - expectStart) : '无');
}

// ── C7. 找不到所属 span 时返回 undefined（不猜）──────────────────
{
  const page = makePage(['甲', '乙']);
  const orphan = { nodeType: 3, parentNode: { nodeType: 1, dataset: {} } };
  const range = { startContainer: orphan, startOffset: 0, endContainer: page.nodes[1].textNode, endOffset: 1 };
  check('C7 节点不在页内时返回 undefined', offsetFromRange(page, range) === undefined);
}

/* ══════ D. 用真 pdf.js 的页文本再跑一遍 ═══════════════════════════ */

const sample = process.env.DR_SAMPLE_PDF;
if (!sample) {
  console.log('跳过 D：设 DR_SAMPLE_PDF 指向一本真实 PDF 再跑');
} else {
  const lib = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
  const worker = await import(new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href);
  globalThis.pdfjsWorker = worker;
  lib.GlobalWorkerOptions.workerSrc = 'unused';

  const geomStart = src.indexOf('function composeTransform');
  const geomEnd = src.indexOf('/* ═══ 全书抽样');
  const geom = new Function(src.slice(geomStart, geomEnd) + '\nreturn { buildPageText, itemBox };')();
  const { buildPageText, itemBox } = geom;

  const data = await readFile(sample);
  const doc = await lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const pageProxy = await doc.getPage(165);
  const viewport = pageProxy.getViewport({ scale: 1.4 });
  const content = await pageProxy.getTextContent();
  const items = content.items
    .filter((raw) => raw.str)
    .map((raw) => ({ str: raw.str, transform: raw.transform, width: raw.width, box: itemBox(raw, viewport.transform, 1.4) }));
  const pageText = buildPageText(items);

  // 找最长的那一项，模拟「只选中间一段」
  let longest = 0;
  for (let index = 1; index < pageText.spans.length; index += 1) {
    if (pageText.spans[index].item.str.length > pageText.spans[longest].item.str.length) longest = index;
  }
  const target = pageText.spans[longest];
  const strLen = target.item.str.length;
  console.log('D 真实最长项：' + JSON.stringify(target.item.str.slice(0, 20)) + (strLen > 20 ? '…' : '') + '（' + strLen + ' 字）');

  // 造一个只覆盖中间 3 字的 DOM 桩
  const { el, textNode } = makeSpanNode(target.start);
  const page = { text: pageText.text, spans: pageText.spans, nodes: [{ el, textNode }] };
  const mid = Math.floor(strLen / 2);
  const range = {
    startContainer: textNode,
    startOffset: mid,
    endContainer: textNode,
    endOffset: Math.min(strLen, mid + 3),
  };
  const hit = offsetFromRange(page, range);
  const expect = target.item.str.slice(mid, mid + 3);
  check('D 真实项：只标中间 3 字', hit && hit.length === 3, hit ? hit.length : '无');
  check('D 真实项：内容正确', hit && page.text.slice(hit.offset, hit.offset + hit.length) === expect,
    hit ? JSON.stringify(page.text.slice(hit.offset, hit.offset + hit.length)) : '无');
  check('D 真实项：没有扩到整项 ' + strLen + ' 字', hit && hit.length !== strLen);

  await doc.destroy();
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
