// 「标注笔记」页的范围切换回归（全部 / 当页）。
//
// ## 这个功能最容易错的地方
//
// 不是「过滤写错」，而是**过滤器的计数、列表内容、空态提示三者对不上**：
//
//   · 开关上写「当页 5」，点进去列表只有 2 条 —— 计数用了另一套判据；
//   · 选了「当页」而这页一条没有，于是整页空白、没有任何解释 —— 用户以为丢数据了；
//   · 空书（全书 0 条）时仍显示筛选器 —— 先甩工具、后教用法，顺序反了。
//
// 所以断言不止「过滤对不对」，还要断「数出来的和显示出来的一致」。
//
// ## 为什么用源码注入而不是 setState
//
// 假 React 的 `useState` 返回的 setter 是空函数，点了按钮状态不会变。
// 所以对每个 `scope` 取值，把源码里 `useState('all')` 的字面量替换掉再求值，
// 直接测「那个状态下的渲染结果」。这也是唯一能在 Node 里测 hooks 组件的可靠办法。
//
// 用法：node scripts/notes-scope-check.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const src = await readFile(clientPath, 'utf8');

const head = 'factory(require) {';
const start = src.indexOf(head);
const end = src.lastIndexOf('},\n});');
if (start < 0 || end < 0) {
  console.log('❌ 没找到 factory 结构，源码形状变了');
  process.exit(1);
}
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数的内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = src.slice(start + head.length, end);

const EXPOSE = `      __expose: (() => { globalThis.__dr = { NotesTab }; return true; })(),\n`;


/**
 * 假 React：`createElement` 主动调用函数组件，得到**真的元素树**（而不是函数引用）。
 * 这是能对渲染结果做断言的前提 —— 只收集引用的话，什么也数不出来。
 */
const makeReact = () => ({
  createElement: (type, props, ...kids) => {
    if (typeof type === 'function') return type(props || {});
    return { type, props: props || {}, kids: kids.flat() };
  },
  Fragment: Symbol('fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
});

/**
 * 加载 NotesTab，并把 `useState('all')` 的初值换成给定值。
 * @param {'all'|'page'} scope
 */
function loadWithScope(scope) {
  let hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);
  const from = "const [scope, setScope] = useState('all');";
  const to = "const [scope, setScope] = useState('" + scope + "');";
  if (!hooked.includes(from)) {
    console.log('❌ 没找到 scope 的 useState 声明，形状变了');
    process.exit(1);
  }
  hooked = hooked.replace(from, to);
  const factory = (0, eval)('(function(require){\n' + hooked + '\n})');
  factory((name) => {
    if (name === 'react') return makeReact();
    throw new Error('unexpected require: ' + name);
  });
  return globalThis.__dr.NotesTab;
}

/** 深度遍历元素树，收集所有节点。 */
function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return out;
  }
  out.push(node);
  for (const kid of node.kids || []) walk(kid, out);
  return out;
}

/** 某个节点下所有文本，拼成一个串。 */
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return (node.kids || []).map(textOf).join('');
  return '';
}

/** 按 className 取节点（支持 is-on 这类附加类）。 */
function byClass(root, token) {
  return walk(root).filter((node) => {
    const cls = node.props && node.props.className;
    return typeof cls === 'string' && cls.split(/\s+/).includes(token);
  });
}

let failed = 0;
let passed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('ok   ' + label);
  } else {
    failed += 1;
    console.log('❌ ' + label + (detail === undefined ? '' : '  → ' + detail));
  }
}

// ── 测试数据：跨 3 页共 5 条标注 + 2 条散记 ──────────────────────
// 刻意让「当前页」只有一部分，才能验出「全部 vs 当页」的差异。
const PAGE = 10;
const MARKS = [
  { id: 'm1', page: 8, offset: 10, length: 20, text: '第 9 页的标注甲', color: 'amber', note: '' },
  { id: 'm2', page: 10, offset: 30, length: 20, text: '第 11 页的标注乙', color: 'green', note: '乙的笔记' },
  { id: 'm3', page: 10, offset: 60, length: 20, text: '第 11 页的标注丙', color: 'blue', note: '' },
  { id: 'm4', page: 12, offset: 90, length: 20, text: '第 13 页的标注丁', color: 'rose', note: '' },
];
const NOTES = [
  { id: 'n1', page: 10, text: '第 11 页的散记甲', updatedAt: 1 },
  { id: 'n2', page: 9, text: '第 10 页的散记乙', updatedAt: 2 },
];
const noop = () => {};
const baseProps = { marks: MARKS, notes: NOTES, page: PAGE, framework: undefined, onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop };

const onThisPage = MARKS.filter((m) => m.page === PAGE).length + NOTES.filter((n) => n.page === PAGE).length;
const allCount = MARKS.length + NOTES.length;

// ── 场景 1：全部 ────────────────────────────────────────────────
{
  const NotesTab = loadWithScope('all');
  const tree = NotesTab(baseProps);

  const scopeButtons = byClass(tree, 'dr-scope').flatMap((node) => walk(node).filter((n) => typeof n.type === 'string' && n.type === 'button'));
  check('全部模式：开关存在', scopeButtons.length === 2, scopeButtons.length);
  check('全部模式：「全部」高亮', byClass(tree, 'is-on').length >= 1);

  // 计数必须与「实际会显示出来的条数」一致
  const allLabel = textOf(scopeButtons[0]);
  const pageLabel = textOf(scopeButtons[1]);
  check('全部模式：「全部」标签含总数 ' + allCount, allLabel.includes(String(allCount)), allLabel);
  check('全部模式：「当页」标签含本页数 ' + onThisPage, pageLabel.includes(String(onThisPage)), pageLabel);

  // 列表内容：标注卡 + 散记卡各 4 + 2 张
  const cards = byClass(tree, 'dr-note');
  check('全部模式：显示 ' + allCount + ' 张卡片', cards.length === allCount, cards.length);
  check('全部模式：包含其它页的标注', textOf(tree).includes('第 9 页的标注甲'));
  check('全部模式：包含其它页的散记', textOf(tree).includes('第 10 页的散记乙'));
  check('全部模式：标题写「标注」（非「本页标注」）', !textOf(tree).includes('本页标注'));
  check('全部模式：不显示"本页为空"提示', !textOf(tree).includes('还没有标注或笔记'));
}

// ── 场景 2：当页 ────────────────────────────────────────────────
{
  const NotesTab = loadWithScope('page');
  const tree = NotesTab(baseProps);

  const scopeButtons = byClass(tree, 'dr-scope').flatMap((node) => walk(node).filter((n) => typeof n.type === 'string' && n.type === 'button'));
  check('当页模式：开关存在', scopeButtons.length === 2);

  const cards = byClass(tree, 'dr-note');
  check('当页模式：只显示本页 ' + onThisPage + ' 张卡片', cards.length === onThisPage, cards.length);
  check('当页模式：排除其它页的标注', !textOf(tree).includes('第 9 页的标注甲'));
  check('当页模式：排除其它页的散记', !textOf(tree).includes('第 10 页的散记乙'));
  check('当页模式：保留本页标注乙', textOf(tree).includes('第 11 页的标注乙'));
  check('当页模式：保留本页散记甲', textOf(tree).includes('第 11 页的散记甲'));
  check('当页模式：标题写「本页标注」', textOf(tree).includes('本页标注'));
  check('当页模式：散记标题写「本页散记」', textOf(tree).includes('本页散记'));
  // 计数口径必须和过滤口径一致
  const pageLabel = textOf(scopeButtons[1]);
  check('当页模式：计数 ' + onThisPage + ' 与真实条数一致', pageLabel.includes(String(onThisPage)), pageLabel);
}

// ── 场景 3：当页，但这一页空空如也 ─────────────────────────────
{
  const NotesTab = loadWithScope('page');
  const tree = NotesTab({ ...baseProps, page: 40 });
  check('本页无内容：给出明确提示（不是空白）', textOf(tree).includes('第 41 页还没有标注或笔记'));
  check('本页无内容：提示里带「看全部」出口', textOf(tree).includes('看全部'));
  check('本页无内容：卡片数为 0', byClass(tree, 'dr-note').length === 0);
  check('本页无内容：开关仍在（可切回）', byClass(tree, 'dr-scope').length === 1);
}

// ── 场景 4：全书一条都没有 ───────────────────────────────────────
{
  const NotesTab = loadWithScope('all');
  const tree = NotesTab({ ...baseProps, marks: [], notes: [] });
  check('空书：给出引导语', textOf(tree).includes('还没有标注'));
  check('空书：不显示筛选器', byClass(tree, 'dr-scope').length === 0);
  check('空书：写笔记盒子仍在', textOf(tree).includes('写一条笔记'));
}

// ── 场景 5：只有散记、没有标注 ───────────────────────────────────
{
  const NotesTab = loadWithScope('all');
  const tree = NotesTab({ ...baseProps, marks: [] });
  check('只有散记：不算空书（有筛选器）', byClass(tree, 'dr-scope').length === 1);
  // 只有散记时不该出现「标注」小标题（那是标注区的头）。
  // 注意不能写成 `!tree.kids[1]` —— 那个下标依赖渲染结构的层数，
  // 每次加控件（清除按钮、确认条）都会失效，属于「断言写死在结构上」的坏味道。
  // 改成检查：文本里没有「本页标注」/「标注」这类小标题，且散记卡数量对得上。
  check('只有散记：不出现标注区小标题',
    !byClass(tree, 'dr-fw-partname').map(textOf).some((t) => t === '标注' || t === '本页标注'));
  check('只有散记：散记卡片在', byClass(tree, 'dr-note').length === NOTES.length);
}

// ── 场景 7：按章分组（有框架）──────────────────────────────────
//
// 这是「全部」模式的核心：列表不是一坨平铺，而是按 AI 生成的章节结构归类。
// 断言重点不是「有没有分组标题」，而是**每条都落进了正确的那一章**。
{
  const FRAMEWORK = {
    status: 'done',
    error: '',
    data: {
      parts: [
        {
          name: '第一段 · 打地基',
          question: '怎么学？',
          transition: '',
          chapters: [
            { no: '第 2 章', title: '机器学习基础', gist: 'g', pages: [1, 30] },
            { no: '第 3 章', title: '线性模型', gist: 'g', pages: [31, 60] },
          ],
        },
        {
          name: '第二段 · 装上引擎',
          question: '怎么训？',
          transition: '打基础',
          chapters: [
            { no: '第 8 章', title: '注意力机制', gist: 'g', pages: [201, 240] },
            { no: '第 9 章', title: 'Transformer', gist: 'g', pages: [241, 270] },
          ],
        },
      ],
    },
  };
  // page 是 0 起，框架 pages 是 1 起 —— 差一位，这里刻意测边界
  const marks = [
    { id: 'a', page: 4, offset: 1, length: 5, text: '第2章的标注', color: 'amber', note: '' },
    { id: 'b', page: 39, offset: 2, length: 5, text: '第3章的标注', color: 'green', note: '' },
    { id: 'c', page: 204, offset: 3, length: 5, text: '第8章的标注', color: 'blue', note: '' },
    { id: 'd', page: 250, offset: 4, length: 5, text: '第9章的标注', color: 'rose', note: '' },
    { id: 'e', page: 300, offset: 5, length: 5, text: '框架外的标注', color: 'amber', note: '' },
  ];
  const NotesTab = loadWithScope('all');
  const tree = NotesTab({ ...baseProps, marks, notes: [], page: 4, framework: FRAMEWORK });

  const groups = byClass(tree, 'dr-group');
  check('分组：共 5 组（4 章 + 1 未分章）', groups.length === 5, groups.length);

  // 组头现在是「第 N 章 + 章名」，**不再显示段名**。
  // 段名回答不了「这是第几章」，而按书读的人记的就是章号。
  check('分组：不显示段名', byClass(tree, 'dr-group-part').length === 0);
  const nos = byClass(tree, 'dr-group-no').map(textOf);
  const names = byClass(tree, 'dr-group-name').map(textOf);
  check('分组：章号自动编号（第 1~4 章 + 未分章）',
    nos.join('|') === '第 1 章|第 2 章|第 3 章|第 4 章|未分章', nos.join('|'));
  check('分组：章名与章号配对正确',
    names.join('|') === '机器学习基础|线性模型|注意力机制|Transformer|',
    names.join('|'));

  // 关键：每条内容必须落在**自己那一章**的组里，不能只落在某一组
  const cardIn = (groupText, needle) => groupText.includes(needle);
  const groupTexts = groups.map(textOf);
  // 逐条查归属：内容必须和它那一章的**章名**出现在同一个组里
  const belongs = (needle, chapterName) =>
    groupTexts.filter((t) => cardIn(t, needle) && cardIn(t, chapterName)).length === 1;
  check('分组：p4 的标注在「机器学习基础」组', belongs('第2章的标注', '机器学习基础'));
  check('分组：p39 的标注在「线性模型」组', belongs('第3章的标注', '线性模型'));
  check('分组：p204 的标注在「注意力机制」组', belongs('第8章的标注', '注意力机制'));
  check('分组：p250 的标注在「Transformer」组', belongs('第9章的标注', 'Transformer'));
  check('分组：框架外的标注落进「未分章」',
    groupTexts.some((t) => cardIn(t, '框架外的标注') && cardIn(t, '未分章')));

  // 顺序：必须按框架的段/章顺序，而不是页码顺序
  // 顺序：按全书章序 1→2→3→4，未分章最后
  const order = nos.join(' | ');
  const seqOk = nos.slice(0, 4).join('|') === '第 1 章|第 2 章|第 3 章|第 4 章' && nos[4] === '未分章';
  check('分组：顺序为 1→2→3→4→未分章', seqOk, order);

  // 条数显示
  check('分组：每组显示条数', byClass(tree, 'dr-group-count').length === 5);
  check('分组：单条组显示「1 条」', textOf(tree).includes('1 条'));
}

// ── 场景 7b：只有一章有内容（编号不能从 1 开始瞎编）────────────
{
  const NotesTab = loadWithScope('all');
  const tree = NotesTab({ ...baseProps, marks: [MARKS[2]], notes: [], page: 10, framework: undefined });
  // 没有框架 → 单组「未分章」。单组时**整块组头都不渲染**：
  // 一条内容配一个「未分章」标题是纯噪音。此时也不该出现任何章号节点。
  check('无框架：不显示组头（单组无意义）', byClass(tree, 'dr-group-head').length === 0);
  check('无框架：不出现章号节点', byClass(tree, 'dr-group-no').length === 0);
  check('无框架：内容照常显示', textOf(tree).includes('第 11 页的标注丙'));
}

// ── 场景 7c：真实框架的形态（chapter.no 全为 null）──────────────
//
// 线上书的 AI 框架里 `chapter.no` 一律是 null。曾经拿它当组头，
// 结果整页只剩段名，看不出「第几章」。所以必须验「章号由程序编」。
{
  const Realish = {
    status: 'done',
    data: {
      parts: [
        { name: '第一段', question: 'q', transition: '', chapters: [
          { no: null, title: '绪论', gist: 'g', pages: [10, 38] },
          { no: null, title: '机器如何自己学习', gist: 'g', pages: [39, 62] },
        ] },
        { name: '第二段', question: 'q', transition: 't', chapters: [
          { no: null, title: 'Transformer', gist: 'g', pages: [105, 122] },
        ] },
      ],
    },
  };
  const marks = [
    { id: 'x', page: 20, offset: 0, length: 5, text: '绪论里的', color: 'amber', note: '' },
    { id: 'y', page: 110, offset: 0, length: 5, text: 'Transformer里的', color: 'blue', note: '' },
  ];
  const NotesTab = loadWithScope('all');
  const tree = NotesTab({ ...baseProps, marks, notes: [], page: 20, framework: Realish });
  const nos = byClass(tree, 'dr-group-no').map(textOf);
  // no 全 null → 程序按全书顺序编：绪论=1、机器=2、Transformer=3
  check('null 章号：编号仍连续（第 1/3 章）', nos.join('|') === '第 1 章|第 3 章', nos.join('|'));
  const names = byClass(tree, 'dr-group-name').map(textOf);
  check('null 章号：章名照常显示', names.join('|') === '绪论|Transformer', names.join('|'));
}
// ── 场景 8：缩略态 ─────────────────────────────────────────────
{
  const NotesTab = loadWithScope('all');
  const tree = NotesTab({ ...baseProps, marks: MARKS, notes: [] });
  const cards = byClass(tree, 'dr-note');
  check('缩略：全部模式每张卡都是 is-mini', cards.every((c) => (c.props.className || '').includes('is-mini')), cards.length);
  check('缩略：全部模式仍有 ' + MARKS.length + ' 张卡（不是只显示摘要就少画）', cards.length === MARKS.length, cards.length);

  const pageTree = NotesTab({ ...baseProps, marks: MARKS, notes: [], page: 10 });
  // 当页模式换 scope 需要重载
  const PageNotes = loadWithScope('page');
  const pageTree2 = PageNotes({ ...baseProps, marks: MARKS, notes: [], page: 10 });
  const pageCards = byClass(pageTree2, 'dr-note');
  check('缩略：当页模式**不**缩略（完整显示）', pageCards.every((c) => !(c.props.className || '').includes('is-mini')), pageCards.length);
}

// ── 场景 6：默认是「全部」 ──────────────────────────────────────
{
  // 直接读源码里的初值，防有人把默认改成 'page'（那会让人以为标注丢了）
  const m = body.match(/const \[scope, setScope\] = useState\('([^']*)'\);/);
  check('默认范围是 all', m && m[1] === 'all', m ? m[1] : '未找到声明');
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
