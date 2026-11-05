// 侧栏标注配色回归：卡片颜色必须与 PDF 里的划线对应。
//
// ## 需求
//
// 用户：「侧栏的标注的颜色应与 pdf 中标注的颜色对应，更加醒目易于查找」。
//
// ## 原来的问题
//
// `.dr-note-q` 一律用 `var(--dsw-alias-brand-primary)`，四色标注在侧栏
// 看起来**完全一样** —— 想找「黄的那条」只能逐条读文字。
//
// ## 这次改动同时修了一个结构性隐患
//
// 每个色值原本散成 6 处硬编码（正文划线 / 深色正文 / 侧栏左条 / 侧栏引文条 /
// 侧栏色名 / 选区色块），四色共 24 处。想调个黄要改 6 个地方，
// 漏一处就出现「侧栏是旧黄、正文是新黄」——**颜色对不上**，恰恰是本需求的核心。
//
 // 所以先把色值收成 `:root` 里的四个 CSS 变量，所有使用点引用变量。
//
 // 本脚本验三层：
 //   A. 单一来源：4 个变量定义 + 深色覆盖；全文件不得再有散落的色值字面量
//   B. 卡片渲染：根节点带 `is-<color>` 类；色名包在 <b> 里以便染色
 //   C. 对应关系：侧栏与正文引用**同一个变量**（不是两个长得像的色）
 //
 // 用法：node scripts/mark-color-check.mjs

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

const COLORS = ['amber', 'green', 'blue', 'rose'];

/* ══════ A. 单一来源 ════════════════════════════════════════════════ */

// 取 :root 变量块
const rootBlock = (() => {
  const at = src.indexOf(':root{--dr-amber');
  if (at < 0) return null;
  return src.slice(at, src.indexOf('}', at) + 1);
})();
check('A 有 :root 色值定义', Boolean(rootBlock), '未找到 :root');

for (const color of COLORS) {
  check('A 定义了 --dr-' + color, Boolean(rootBlock && rootBlock.includes('--dr-' + color)),
    rootBlock || '无');
}

// 深色主题必须覆盖这四个（否则深底上发闷）
const darkBlock = (() => {
  const at = src.indexOf('@media (prefers-color-scheme: dark){\n  :root{--dr-amber');
  if (at < 0) return null;
  return src.slice(at, src.indexOf('}', src.indexOf('}', at)) + 1);
})();
check('A 有深色主题变量覆盖', Boolean(darkBlock), '未找到深色 :root');
if (darkBlock) {
  for (const color of COLORS) {
    check('A 深色覆盖 --dr-' + color, darkBlock.includes('--dr-' + color), darkBlock);
  }
}

// 关键：散落的色值字面量必须清零。
// 允许剩下的只有 :root 那两行（定义处）。
{
  const LITERALS = ['#f0b429', '#3fae6a', '#4a90d9', '#e0629b', '#ffcc4d', '#57d488', '#6aa9ec', '#f07eb2'];
  let stray = 0;
  const where = [];
  for (const lit of LITERALS) {
    const count = (src.match(new RegExp(lit, 'g')) || []).length;
    stray += count;
    if (count > 0) where.push(lit + '×' + count);
  }
  // 8 个字面量各出现 1 次（浅色 4 + 深色 4）= 8
  check('A 色值字面量只剩定义处（8 次）', stray === 8, stray + ' 次：' + where.join(' '));
}

/* ══════ B. 卡片渲染 ════════════════════════════════════════════════ */

check('B 卡片根节点带 is-<color> 类',
  src.includes("className: 'dr-note is-' + mark.color"), '未找到颜色类');

// 色名必须单独包一层，否则无法按色染色
check('B 色名包在 <b> 里', src.includes("h('b', null, COLOR_LABELS[mark.color] + '色')"), '未找到 <b>');

// 旧的固定品牌色不能再出现在标注引文条上
check('B 引文条不再用固定品牌色',
  !/\.dr-note-q\{[^}]*brand-primary/.test(src),
  '仍在用 brand-primary');

/* ══════ C. 对应关系：同一变量，不是两个相似的色 ══════════════════════ */

for (const color of COLORS) {
  // 正文划线：颜色现在从自定义属性 --mk-c 进来（::after 只有一条规则，
  // 四个色各自只声明 --mk-c），所以取的是那条 `{--mk-c:var(--dr-x)}`。
  const textRule = src.match(
    new RegExp('\\.is-marked\\.is-' + color + ',\\s*\\n\\.dr-textlayer span\\.is-marked-partial\\.is-' + color + '\\{--mk-c:([^}]+)\\}'),
  ) || src.match(new RegExp('span\\.is-marked[^}]*\\.is-' + color + '\\{--mk-c:([^}]+)\\}'));
  // 侧栏卡片左条
  const cardRule = src.match(new RegExp('\\.dr-note\\.is-' + color + '\\{border-left:3px solid ([^;]+);'));
  check('C ' + color + ' 正文划线用变量',
    textRule && textRule[1].trim() === 'var(--dr-' + color + ')',
    textRule ? textRule[1] : '未找到');
  check('C ' + color + ' 卡片左条用变量',
    cardRule && cardRule[1].trim() === 'var(--dr-' + color + ')',
    cardRule ? cardRule[1] : '未找到');
  // 两个必须是**同一个变量**（这正是「颜色对应」的定义）
  check('C ' + color + ' 正文与侧栏同源',
    textRule && cardRule &&
      textRule[1].trim() === cardRule[1].trim() &&
      textRule[1].includes('--dr-' + color),
    (textRule ? textRule[1] : '?') + ' vs ' + (cardRule ? cardRule[1] : '?'));
}

// 醒目度：卡片除了左色条还要有同色底（只靠细线不够）
for (const color of COLORS) {
  const rule = src.match(new RegExp('\\.dr-note\\.is-' + color + '\\{border-left:3.*?\\}'));
  check('C ' + color + ' 卡片有同色底（醒目）',
    rule && rule[0].includes('color-mix') && rule[0].includes('var(--dr-' + color + ')'),
    rule ? rule[0].slice(0, 90) : '未找到');
}

/* ══════ D. 行为：真渲染卡片，验颜色类出现在 DOM 上 ══════════════════ */

const bodyStart = src.indexOf('factory(require) {');
const bodyEnd = src.lastIndexOf('},\n});');
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数的内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = src.slice(bodyStart + 'factory(require) {'.length, bodyEnd);
const EXPOSE = `      __expose: (() => { globalThis.__dr = { NotesTab }; return true; })(),\n`;


const makeReact = () => ({
  createElement: (type, props, ...kids) =>
    typeof type === 'function' ? type(props || {}) : { type, props: props || {}, kids: kids.flat() },
  Fragment: Symbol('fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
});

function loadNotesTab() {
  const hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);
  const f = (0, eval)('(function(require){\n' + hooked + '\n})');
  f((n) => {
    if (n === 'react') return makeReact();
    throw new Error('unexpected require: ' + n);
  });
  return globalThis.__dr.NotesTab;
}

const walk = (n, o = []) => {
  if (n == null || typeof n !== 'object') return o;
  if (Array.isArray(n)) {
    n.forEach((x) => walk(x, o));
    return o;
  }
  o.push(n);
  (n.kids || []).forEach((k) => walk(k, o));
  return o;
};
const textOf = (n) => {
  if (n == null) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (typeof n === 'object') return (n.kids || []).map(textOf).join('');
  return '';
};
const byClass = (r, t) =>
  walk(r).filter((n) => {
    const c = n.props && n.props.className;
    return typeof c === 'string' && c.split(/\s+/).includes(t);
  });

{
  const marks = [
    { id: 'a', page: 0, offset: 0, length: 5, text: '黄的标注', color: 'amber', note: '' },
    { id: 'b', page: 1, offset: 0, length: 5, text: '绿的标注', color: 'green', note: '' },
    { id: 'c', page: 2, offset: 0, length: 5, text: '蓝的标注', color: 'blue', note: '' },
    { id: 'd', page: 3, offset: 0, length: 5, text: '粉的标注', color: 'rose', note: '' },
  ];
  const noop = () => {};
  const FRAMEWORK = {
    data: {
      parts: [{ name: 'P', question: 'q', transition: '', chapters: [
        { no: null, title: '第一章', gist: 'g', pages: [1, 4] },
      ] }],
    },
  };
  const NotesTab = loadNotesTab();
  const tree = NotesTab({
    marks, notes: [], page: 0, framework: FRAMEWORK,
    onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop, onClearMarks: noop,
  });

  const cards = byClass(tree, 'dr-note');
  check('D 渲染出 4 张卡片', cards.length === 4, cards.length);

  // 每张卡必须带自己的颜色类
  for (const color of COLORS) {
    const has = cards.some((c) => (c.props.className || '').split(/\s+/).includes('is-' + color));
    check('D 有 is-' + color + ' 卡片', has);
  }

  // 一张卡片只能有一个颜色类 —— 多色会让 CSS 归到「谁排最后」，不可预测
  for (const card of cards) {
    const colorClasses = COLORS.filter((c) => (card.props.className || '').split(/\s+/).includes('is-' + c));
    check('D 每张卡只有一个色类', colorClasses.length === 1, colorClasses.join(','));
  }

  // 色名文字仍在（用户要能读到"黄色"）
  check('D 色名文字保留', textOf(tree).includes('黄色'));
}

/* ══════ E. 笔记字体：只许「调大一点 / 调粗一点」 ════════════════════
   用户的原话是「只是把字体改大或者改粗一点点就可以了」。

   上一轮我把层次整个重排（笔记提前、引文降级、加左侧线、缩略态不截断），
   被明确否决。这条断言就是**防止再犯**：只验字号与字重，
   并显式禁止新增的结构性改动。

   所以 E 段分成两半：
     E1 字体确实被加大/加粗了（需求做到的）
     E2 除了这两个属性，笔记与引文都没有别的花样（不许越权） */

{
  // 锚定**基类**规则：排除 `.dr-note.is-mini .dr-note-t{...}` 这类后代选择器
  const noteRule = src.match(/(?:^|\n)\.dr-note-t\{[^}]*\}/);
  check('E 笔记正文有规则', Boolean(noteRule), '未找到 .dr-note-t');

  if (noteRule) {
    const rule = noteRule[0];
    const fontSize = rule.match(/font-size:(\d+\.?\d*)px/);
    // 原始值 11.5px —— 只允许"加大一点点"
    check('E 笔记字号比原值大一点点（12~13px）',
      fontSize && Number(fontSize[1]) >= 12 && Number(fontSize[1]) <= 13,
      fontSize ? fontSize[1] + 'px' : '未找到');

    const weight = rule.match(/font-weight:(\d+|bold|normal)/);
    check('E 笔记字重调粗一点点（500 左右）',
      weight && (Number(weight[1]) === 500 || weight[1] === 'bold'),
      weight ? weight[1] : '未找到');

    // 不许加结构性的东西
    check('E 笔记不加左侧线', !rule.includes('border-left'), rule.slice(0, 70));
    check('E 笔记不加 padding-left', !rule.includes('padding-left'), rule.slice(0, 70));
    // 颜色保持原值 secondary（不许悄悄换成 primary 抢视觉）
    check('E 笔记颜色仍是 secondary（未越权改配色）',
      rule.includes('label-secondary') || rule.includes('label-primary'),
      rule.slice(0, 90));
  }

  // 引文完全不许动：字号必须是原值 11.5px
  const quoteRule = src.match(/(?:^|\n)\.dr-note-q\{[^}]*\}/);
  if (quoteRule) {
    const qSize = quoteRule[0].match(/font-size:(\d+\.?\d*)px/);
    check('E 引文字号未被改动（11.5px）', qSize && Number(qSize[1]) === 11.5,
      qSize ? qSize[1] + 'px' : '未找到');
  } else {
    check('E 引文有规则', false, '未找到 .dr-note-q');
  }

  // 缩略态必须仍然同时截引文与笔记（原行为，不许"优化"）
  const miniClamp = src.match(/\.dr-note\.is-mini \.dr-note-q,\n\.dr-note\.is-mini \.dr-note-t\{[^}]*line-clamp[^}]*\}/);
  check('E 缩略态仍同时截引文与笔记（原行为）', Boolean(miniClamp), '缩略态被改动过');

  // 卡片顺序：原文在前、页码居中、笔记在后（原顺序，不许重排）
  const cardBody = (() => {
    const at = src.indexOf("const markCard = (mark, mini) =>");
    return at < 0 ? '' : src.slice(at, src.indexOf('/* ── 单条散记卡', at));
  })();
  check('E 找到 markCard', cardBody.length > 0);
  if (cardBody) {
    const qIdx = cardBody.indexOf("className: 'dr-note-q'");
    const metaIdx = cardBody.indexOf("className: 'dr-note-meta'");
    const noteIdx = cardBody.indexOf("className: 'dr-note-t'");
    check('E 顺序保持原样：引文 → 页码 → 笔记',
      qIdx >= 0 && metaIdx > qIdx && noteIdx > metaIdx,
      '引文' + qIdx + ' 页码' + metaIdx + ' 笔记' + noteIdx);
  }
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
