// 标注渲染回归：划线画在文字 span 上，且不压字。
//
// ## 这个文件为什么重写过
//
// 第一版验的是「`rectsForRange` 把同行相邻框合并成一条」，还写了 32 项断言。
// 但那个方向整体错了 —— 换成划线之后用户报「标线遮挡文字」，根因是：
//
//   文字层的 span 会做**垂直补偿**（delta = 实测高 − 目标高，最多下移行高的 40%），
//   而旁边独立画的高亮框用的是**未补偿**的原始 box。
//   两套坐标一错开，线就压在字形中间。
//
// 合并框只能让「同一行的线连不连」，救不了「整体错位」。所以彻底换方案：
// 线画在 span 自己身上（border-bottom）——span 在哪，线就在哪，没有第二次对位。
//
// 于是回归也换了靶子：
 //   A. 结构：必须有独立的染色 effect（marks 变了要重画线，但不能重画 canvas）
 //   B. 行为：给出 marks，真跑染色逻辑，看 span 被加了正确的类
 //   C. 样式：线在 span 上、实色、深色提亮
 //
 // ## 检查 B 用真 DOM 而不是假 React
 //
 // 染色 effect 的操作对象是 `layer.children` 上的 `dataset` 与 `classList`。
 // 假 React 给不出这些，所以这里手写一个最小的 DOM 桩：
 // classList / dataset / children 齐全，只实现染色用到的部分。

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

/* ══════ A. 结构 ════════════════════════════════════════════════════ */

check('结构：不再有独立的高亮层容器 .dr-marks', !src.includes("className: 'dr-marks'"));
check('结构：不再有 .dr-mark 元素渲染', !src.includes("className: 'dr-mark is-'"));
check('结构：已无 rectsForRange 死代码', !/function rectsForRange/.test(src));
check('结构：染色用 classList.add 两参形式', src.includes("span.classList.add('is-marked', 'is-' + mark.color)"));
check('结构：span 记录页文本区间', src.includes('span.dataset.drStart'));

// 染色必须是**独立 effect**，不能塞进渲染 effect。
// 塞进去的话：渲染 effect 依赖 [pdf, pageIndex, scale] 不含 marks → 标注后不出线；
// 反过来把 marks 加进渲染依赖 → 每标一条就重画整页位图。
const colorEffect = src.match(/useEffect\(\(\) => \{[^]*?span\.classList\.add\('is-marked'[^]*?\}, \[(marks, pageText, pageIndex|pageText, marks, pageIndex|marks, pageIndex, pageText|pageText, pageIndex, marks|pageIndex, marks, pageText|pageIndex, pageText, marks)\]\);/);
check('结构：染色是独立 effect，依赖含 marks', Boolean(colorEffect),
  colorEffect ? colorEffect[1] : '未找到');

const renderEffectDeps = src.match(/\}, \[pdf, pageIndex, scale\]\);/);
check('结构：渲染 effect 依赖不含 marks（不重画位图）', Boolean(renderEffectDeps), '未找到');
check('结构：渲染 effect 依赖确实只有三项', renderEffectDeps && !renderEffectDeps[0].includes('marks'));

/* ══════ C. 样式层 ══════════════════════════════════════════════════ */

const cssStart = src.indexOf('/* ── 标注：底部划线');
const cssEnd = src.indexOf('.dr-loading{display:flex');
const css = src.slice(cssStart, cssEnd);

check('样式：划线在 span 上', css.includes('.dr-textlayer span.is-marked'));
check('样式：用 border-bottom 画线', css.includes('border-bottom:2.5px solid transparent'));
check('样式：不再用 ::after 独立层', !css.includes('.dr-mark::after'));
// 注释里提到历史做法是允许的（那里写着「上一版用 mix-blend-mode」），
// 但不能有**真的 CSS 声明**。
check('样式：没有 mix-blend-mode 声明', !/[\n;{]\s*mix-blend-mode\s*:/.test(css.replace(/\/\*[^]*?\*\//g, '')));
check('样式：不再有半透明铺色', !/background:rgba/.test(css));

for (const color of ['amber', 'green', 'blue', 'rose']) {
  // 色值现在是 CSS 变量（单一来源，见 mark-color-check.mjs）。
  // 这里断「引用变量」而不是「写了十六进制」—— 断言写死在色值上会在换色时失效
  // （它原来就是因此红掉的）。变量必须**定义在同一份源码里**，否则等于没定义。
  const rule = css.match(
    new RegExp('\\.is-marked\\.is-' + color + '\\{border-bottom-color:(var\\(--dr-' + color + '\\))\\}', 'i'),
  );
  check('样式：' + color + ' 有实色线', Boolean(rule), rule ? rule[1] : '缺');
  check('样式：' + color + ' 的变量已定义',
    src.includes('--dr-' + color + ':'), '未找到 --dr-' + color);
}
check('样式：深色主题提亮（交给变量层）',
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\{--dr-amber/.test(src),
  '未找到深色变量覆盖');

/* ══════ B. 行为：真跑染色 ══════════════════════════════════════════ */

/** 最小 DOM 桩：只实现染色用到的 classList / dataset / children。 */
function makeSpan({ start, end }) {
  const classes = new Set();
  const span = {
    dataset: { drStart: String(start), drEnd: String(end) },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toString: () => [...classes].join(' '),
    },
  };
  return span;
}

/**
 * 把染色 effect 的实现从源码里抽出来直接跑。
 *
 * 做法：正则取出 `useEffect(() => { ... }, [marks, pageText, pageIndex])` 的函数体，
 * 用真的 layer 桩执行。这样测的是**源码里的逻辑本身**，不是复述一遍。
 */
/**
 * 把染色 effect 的**完整表达式**抽出来（`useEffect(() => {...}, [deps])`）。
 *
 * 做法：定位 `span.classList.add('is-marked'` 所在的 useEffect，
 * 从 `useEffect(` 起括号配平。这样测的是**源码里的逻辑本身**，不是复述一遍。
 */
function extractColorEffect(code) {
  const at = code.indexOf("span.classList.add('is-marked'");
  if (at < 0) return null;
  const head = code.lastIndexOf('useEffect(', at);
  if (head < 0) return null;
  let depth = 0;
  for (let index = head + 'useEffect'.length; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(head, index + 1);
    }
  }
  return null;
}

const effectExpr = extractColorEffect(src);
check('行为：能从源码抽出染色 effect', Boolean(effectExpr));

if (effectExpr) {
  /**
   * 跑一次染色。
   *
   * ⚠️ effectExpr 是 `useEffect(() => {...}, [deps])` 这样的**表达式**。
   * 直接拼进函数体开头会被解析成「标识符调用 + 后续语句」，后面接别的代码就报语法错。
   * 用数组包一层强制它是表达式。
   */
  const runEffect = (layer, pageText, marks, pageIndex, COLOR_NAMES) => {
    const React = { useEffect: (fn) => fn() };
    // 源码里 `useEffect` 是从 React 解构来的局部名，抽出的表达式里它是自由变量，
    // 所以要显式绑上；`layerRef` 同理（组件里是 useRef 产物）。
    const body =
      'const { useEffect } = React;' +
      'const layerRef = { current: layer };' +
      'const r = [' + effectExpr + ']; return r[0];';
    new Function('React', 'layer', 'pageText', 'marks', 'pageIndex', 'COLOR_NAMES', body)(
      React, layer, pageText, marks, pageIndex, COLOR_NAMES,
    );
  };


  // 造一页：6 个文本项，各自在页文本里的区间
  const spans = [
    makeSpan({ start: 0, end: 4 }),    // 0-4
    makeSpan({ start: 5, end: 8 }),    // 5-8
    makeSpan({ start: 9, end: 12 }),   // 9-12
    makeSpan({ start: 13, end: 17 }),  // 13-17
    makeSpan({ start: 18, end: 22 }),  // 18-22
    makeSpan({ start: 23, end: 27 }),  // 23-27
  ];
  const layer = { children: spans };
  const pageText = { text: '一二三四五六', spans: [] };
  const COLOR_NAMES = ['amber', 'green', 'blue', 'rose'];

  // 标注覆盖前 3 项（offset 0, length 12 → 0..12，含 9-12 那项）
  const marks = [{ id: 'm1', page: 0, offset: 0, length: 12, color: 'amber' }];
  runEffect(layer, pageText, marks, 0, COLOR_NAMES);

  check('行为：前 3 项被染色', spans.slice(0, 3).every((s) => s.classList.contains('is-marked')));
  check('行为：前 3 项颜色是 amber',
    spans.slice(0, 3).every((s) => s.classList.contains('is-amber')));
  check('行为：后 3 项未被染色', spans.slice(3).every((s) => !s.classList.contains('is-marked')));

  // 改色：同一条标注换成绿色，重跑。旧色必须被清掉（否则 span 上会同时挂两个色类）
  const marks2 = [{ id: 'm1', page: 0, offset: 0, length: 12, color: 'green' }];
  runEffect(layer, pageText, marks2, 0, COLOR_NAMES);
  check('行为：改色后是 green', spans[0].classList.contains('is-green'));
  check('行为：改色后旧色 amber 已清除', !spans[0].classList.contains('is-amber'),
    spans[0].classList.toString());
  check('行为：改色后没有残留多个色类',
    COLOR_NAMES.filter((c) => spans[0].classList.contains('is-' + c)).length === 1);

  // 删掉标注：重跑后一个都不该剩
  runEffect(layer, pageText, [], 0, COLOR_NAMES);
  check('行为：删标注后全部清空', spans.every((s) => !s.classList.contains('is-marked')));

  // 别的页的标注不能染这一页
  runEffect(layer, pageText, [{ id: 'x', page: 5, offset: 0, length: 30, color: 'blue' }], 0, COLOR_NAMES);
  check('行为：别的页的标注不染本页', spans.every((s) => !s.classList.contains('is-marked')));

  // 两条标注交叉覆盖 → 都该有颜色（后一条覆盖前一条的色）
  const overlap = [
    { id: 'a', page: 0, offset: 0, length: 12, color: 'amber' },
    { id: 'b', page: 0, offset: 9, length: 9, color: 'rose' },
  ];
  runEffect(layer, pageText, overlap, 0, COLOR_NAMES);
  check('行为：重叠区域取了后一条的颜色', spans[2].classList.contains('is-rose'),
    spans[2].classList.toString());
  check('行为：重叠区域只有一个色类',
    COLOR_NAMES.filter((c) => spans[2].classList.contains('is-' + c)).length === 1);
  check('行为：非重叠部分保留前一条', spans[0].classList.contains('is-amber'));
}

/* ══════ D. 关键：垂直补偿不能把线推到字上 ══════════════════════════ */

// 这条是本轮事故的直接防线。
// 线画在 span 上，所以「线跟着 span 走」是结构性保证 ——
// 只要不出现「另画一层用未补偿坐标」的代码，就不可能再错位。
check('防线：没有「用未补偿 box 另画一层」的代码',
  !src.includes('dr-mark') || !/left: item\.box\[0\]/.test(src));
check('防线：span 的 top 补偿仍在（文字与 PDF 对齐的前提）',
  src.includes("span.style.top = box[1] + Math.min(delta, height * 0.4) + 'px'"));
check('防线：补偿值被夹在行高的 40% 以内（防止极端字体撑飞）',
  src.includes('Math.min(delta, height * 0.4)'));

/* ══════ E. 通用防线：CSS 模板字符串里不得出现反引号 ══════════════
   这条坑踩了两次：
     1. 第一次在 CSS 注释里写 border-bottom 的反引号形式 → 整段 CSS 被提前截断，语法错；
     2. 第二次同时有两处，node --check **居然通过** —— 因为截断后的残片恰好
        又是一段合法代码，错误变成运行时的 ReferenceError，
        看起来像组件逻辑坏了，完全想不到是注释里的反引号。

   CSS 是用模板字符串嵌在 client.js 里的，注释里出现反引号就会提前收尾。
   所以单独扫一遍，并指出具体行号。 */
{
  const BACKTICK = String.fromCharCode(96);
  const head = 'const CSS = ' + BACKTICK;
  const cssStart = src.indexOf(head);
  const cssEnd = src.indexOf(BACKTICK + ';', cssStart);
  if (cssStart < 0 || cssEnd < 0) {
    console.log('❌ 找不到 CSS 模板字符串，源码形状变了');
    process.exit(1);
  }
  const inner = src.slice(cssStart + head.length, cssEnd);
  const lines = inner.split('\n');
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(BACKTICK)) hits.push({ line: index + 1, text: lines[index].trim() });
  }
  check('E CSS 模板内无反引号（不会被提前截断）', hits.length === 0,
    hits.length ? hits.map((h) => 'CSS 第 ' + h.line + ' 行：' + h.text).join(' / ') : '');
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
