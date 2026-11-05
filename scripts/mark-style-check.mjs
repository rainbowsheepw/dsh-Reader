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

// 画线方式迭代了四代，断言必须跟到「现在」这一代：
//   1 色块铺字上 → 糊字；2 另铺一层 .dr-mark → 坐标错位压字；
//   3 border-bottom 画在盒内 → 字大时横穿 descender，就是用户报的「遮挡文字」；
//   4 现在：::after 画到盒外，纵向用 em 跟随字号。
// 这里每一条都对应一次真实故障，删任何一条都等于允许那个故障回来。
check('样式：划线在 span 上（::after，不是独立层）',
  /\.dr-textlayer span\.is-marked::after/.test(css), '未找到 ::after 划线');
check('样式：不用 border-bottom 画线（盒内画线会压 descender）',
  !/span\.is-marked\{[^}]*border-bottom/.test(css), '仍在用 border-bottom');
check('样式：不再用 .dr-mark 独立层', !css.includes('.dr-mark::after'));
check('样式：线的横向用百分比（span 带 scaleX，像素会被二次缩放）',
  /left:var\(--mk-l,0\)/.test(css) && /width:var\(--mk-w,100%\)/.test(css), '未用百分比');
check('样式：线的纵向让到盒外用 em（字号越大让得越多）',
  /bottom:-0\.18em/.test(css), '未用 em 让位');
check('样式：让位量够过 descender（≥0.15em）', (() => {
  const m = css.match(/bottom:-([0-9.]+)em/);
  return Boolean(m) && Number(m[1]) >= 0.15;
})(), '让得太少，线会压进下伸笔画');
check('样式：线粗有 2px 下限（标题不至于比正文更细）',
  /height:max\(2px,0\.085em\)/.test(css), '未夹下限');
// 注释里提到历史做法是允许的（那里写着「上一版用 mix-blend-mode」），
// 但不能有**真的 CSS 声明**。
check('样式：没有 mix-blend-mode 声明', !/[\n;{]\s*mix-blend-mode\s*:/.test(css.replace(/\/\*[^]*?\*\//g, '')));
check('样式：不再有半透明铺色', !/background:rgba/.test(css));

for (const color of ['amber', 'green', 'blue', 'rose']) {
  // 色值现在是 CSS 变量（单一来源，见 mark-color-check.mjs）。
  // 这里断「引用变量」而不是「写了十六进制」—— 断言写死在色值上会在换色时失效
  // （它原来就是因此红掉的）。变量必须**定义在同一份源码里**，否则等于没定义。
  // 颜色改为写 CSS 自定义属性 --mk-c（::after 只此一条规则，颜色从变量进来）。
  // 仍然断「引用变量」而不是十六进制：写死色值会在换色时失效。
  const rule = css.match(
    new RegExp('\\{--mk-c:var\\(--dr-' + color + '\\)\\}', 'i'),
  );
  check('样式：' + color + ' 有实色线', Boolean(rule), rule ? rule[1] : '缺');
  check('样式：' + color + ' 的变量已定义',
    src.includes('--dr-' + color + ':'), '未找到 --dr-' + color);
}
check('样式：深色主题提亮（交给变量层）',
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\{--dr-amber/.test(src),
  '未找到深色变量覆盖');

/* ══════ B. 行为：真跑染色 ══════════════════════════════════════════ */

/** 最小 DOM 桩：只实现染色用到的 classList / dataset / style / children。 */
function makeSpan({ start, end }) {
  const classes = new Set();
  const props = new Map();
  const span = {
    dataset: { drStart: String(start), drEnd: String(end) },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toString: () => [...classes].join(' '),
    },
    // 部分覆盖的标注用 CSS 自定义属性表达「这一项的哪一段被标」
    // （--mk-l 左端、--mk-w 宽度、--mk-c 颜色）。桩必须支持 set/removeProperty，
    // 否则 effect 跑到清场分支就 TypeError。
    style: {
      setProperty: (name, value) => props.set(name, String(value)),
      removeProperty: (name) => props.delete(name),
      getPropertyValue: (name) => props.get(name) ?? '',
    },
    /** 测试用：读某个自定义属性的当前值。 */
    _get: (name) => props.get(name) ?? '',
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
  let index = head + 'useEffect'.length;
  while (index < code.length) {
    const ch = code[index];
    // 注释、字符串、模板字符串里的括号**不算结构括号**。
    // 踩过一次：注释里写「区间的 [from, to)」那个半角右括号让配对提前归零，
    // 抽出来的片段被截断，拼成 `to)] ; return ...` 直接语法错。
    if (ch === '/' && code[index + 1] === '/') {
      while (index < code.length && code[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && code[index + 1] === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      index += 1;
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2;
          continue;
        }
        if (code[index] === quote) break;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(head, index + 1);
    }
    index += 1;
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
/* ══════ D2. 行为：部分覆盖只画那一段 ══════════════════════════════
   「选中几个字，标出的却多出半句」是用户直接投诉的问题。
   旧实现按文本项整块染色（一项被沾到一点就整项上色），等于按 item 边界外扩。
   现在整项覆盖走 border-bottom，部分覆盖走 ::after + 三个自定义属性。
   这两条必须真跑一遍 effect 才测得到 —— 结构断言看不出「覆盖百分比算对没有」。 */

{
  // 一项 4 个字（0..4），标注只覆盖后 2 个字
  const partial = [makeSpan({ start: 0, end: 4 })];
  const marksP = [{ id: 'p1', page: 0, offset: 2, length: 2, color: 'amber' }];
  runEffect({ children: partial }, { text: '一二三四', spans: [] }, marksP, 0, COLOR_NAMES);

  const span = partial[0];
  check('D2 部分覆盖不进整项染色', !span.classList.contains('is-marked'),
    '被当成整项了');
  check('D2 部分覆盖挂上 partial 类', span.classList.contains('is-marked-partial'));
  // 左端 = 2/4 = 50%，宽度 = 2/4 = 50%
  check('D2 左端按字符比例（50%）', span._get('--mk-l') === '50.000%', span._get('--mk-l'));
  check('D2 宽度按字符比例（50%）', span._get('--mk-w') === '50.000%', span._get('--mk-w'));
  check('D2 颜色用 amber 变量', span._get('--mk-c') === 'var(--dr-amber)', span._get('--mk-c'));

  // 同一项上先部分后整项，残留的自定义属性必须被清掉，否则旧线段会留着
  const reuse = [makeSpan({ start: 0, end: 4 })];
  runEffect({ children: reuse }, { text: '一二三四', spans: [] },
    [{ id: 'a', page: 0, offset: 1, length: 2, color: 'blue' }], 0, COLOR_NAMES);
  const hadLeft = reuse[0]._get('--mk-l');
  runEffect({ children: reuse }, { text: '一二三四', spans: [] },
    [{ id: 'b', page: 0, offset: 0, length: 4, color: 'green' }], 0, COLOR_NAMES);
  check('D2 改进整项后旧线段属性被清掉', reuse[0]._get('--mk-l') === '',
    '残留 ' + hadLeft + ' -> ' + reuse[0]._get('--mk-l'));

  // 整项覆盖仍然走 border-bottom 那条路（不能为了部分覆盖把它丢掉）
  const whole = [makeSpan({ start: 0, end: 4 })];
  runEffect({ children: whole }, { text: '一二三四', spans: [] },
    [{ id: 'c', page: 0, offset: 0, length: 4, color: 'rose' }], 0, COLOR_NAMES);
  check('D2 整项仍走 is-marked', whole[0].classList.contains('is-marked'));
  check('D2 整项不再走 partial', !whole[0].classList.contains('is-marked-partial'));
}
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

/* ══════ D3. 几何验算：线下沿必须在字形溢出之外 ══════════════════════
   用户报「标线遮挡文字」两次。第一次是坐标层错位（上面 D 段拦住的）；
   第二次是**纵向量不够**：线画在盒内，字号越大 descender 溢出越多，
   固定 1px 的让位在标题上必然失效。样式断言只能证明「写了 em」，
   不能证明「让得够」——所以这里按真实字号算一遍几何。

   模型（与 PageCanvas 渲染段一致）：
     · line-height:1 → 盒高 = fontSize
     · 字形 descender 溢出盒底的经验上限 = 0.12em（中文字体为主）
     · 线下沿 = 盒底 + 让位量
   判据：对 12~40px 的每个字号，(让位量 − 0.12em) 必须 > 0。 */
{
  const letEm = (() => {
    const m = css.match(/bottom:-([0-9.]+)em/);
    return m ? Number(m[1]) : null;
  })();
  check('D3 能取到线的让位量（em）', letEm !== null, '未找到 bottom:-Nem');

  if (letEm !== null) {
    const DESCENDER_EM = 0.12;
    const sizes = [12, 13, 15, 18, 22, 26, 30, 36, 40];
    const failures = sizes.filter((fs) => {
      const letOut = letEm * fs;                 // 线下沿距盒底（px）
      const overflow = DESCENDER_EM * fs;        // 字形溢出盒底（px）
      return letOut - overflow <= 0;
    });
    check('D3 所有字号下线都不压 descender', failures.length === 0,
      failures.length ? '在这些字号上压字：' + failures.join(',') + 'px' : '');
    check('D3 余量是比例量（不随字号衰减）', letEm > DESCENDER_EM,
      letEm + 'em vs ' + DESCENDER_EM + 'em');

    // 反面：旧实现的固定 1px 让位在标题上一定压字，用于确认这条断言真的会红
    const oldStyleFail = 36;
    check('D3 反证：固定 1px 让位在 36px 标题上确实会压字',
      1 - DESCENDER_EM * oldStyleFail <= 0, '反证失效，判据不可信');
  }
}

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
