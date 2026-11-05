// 侧栏页签合并回归：「读到哪」并入「整体框架」。
//
// ## 合并的理由
//
// 两者回答的是同一个问题 ——「我在全书的哪个位置」。
// 分成两个页签时，用户要来回点才能把「读到第 191 页」和
// 「框架里这一章在哪」对上号。合并后：进度条在最上，紧跟着就是按段/章
// 排好的结构，当前章还有高亮与「在读」标记。
//
 // ## 这个改动容易漏的四处
//
// 1. **页签按钮**：少一个，且「整体框架」要在 `'where'` 时也保持高亮
//    （旧状态/外部跳转可能仍传 'where'，否则会出现「一个都不亮」的面板）。
// 2. **渲染分支**：`'where'` 那条整段删除；若只剩两个分支，
//    `NotesTab` 与 `FrameworkTab` 的顺序不能错。
// 3. **数据传递**：`page` / `pageCount` / `book` 要传给 FrameworkTab，
//    否则进度条算不出百分比（`total=0` → 显示 `?`）。
// 4. **无框架时**：进度条仍必须显示 —— 读了多少页是事实，与有没有框架无关。
//
 // 用法：node scripts/side-tabs-check.mjs

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

/* ══════ 抽出 SidePanel 与 FrameworkTab 的函数体 ═════════════════════ */

function extractFn(code, name) {
  const at = code.indexOf('function ' + name + '(props)');
  if (at < 0) return null;
  const brace = code.indexOf('{', at);
  if (brace < 0) return null;
  let depth = 0;
  for (let index = brace; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(at, index + 1);
    }
  }
  return null;
}

const sidePanel = extractFn(src, 'SidePanel');
const frameworkTab = extractFn(src, 'FrameworkTab');

check('能找到 SidePanel', Boolean(sidePanel));
check('能找到 FrameworkTab', Boolean(frameworkTab));

/* ══════ A. 页签按钮：只剩两个 ══════════════════════════════════════ */

if (sidePanel) {
  // 统计页签按钮：只数 `dr-side-tab`（不带 s），否则会把容器的 `dr-side-tabs` 也计进去
  const tabButtons = [...sidePanel.matchAll(/dr-side-tab(?![s])/g)].length;
  // 现在有 3 个：整体框架 / 问答 / 标注笔记
  check('A 页签按钮共 3 个', tabButtons === 3, tabButtons);
  check('A 有「问答」页签', sidePanel.includes("'问答'"));

  check('A 有「整体框架」页签', sidePanel.includes("'整体框架'"));
  check('A 不再有「读到哪」页签', !sidePanel.includes("'读到哪'"), '仍存在');
  check('A 仍有「标注笔记」页签', sidePanel.includes("'标注笔记 '"));
} else {
  check('A 页签检查（未能抽取 SidePanel）', false);
}

/* ══════ B. 渲染分支 ═════════════════════════════════════════════════ */

if (sidePanel) {
  // tab === 'where' 不能作为**渲染分支条件**出现（只允许出现在高亮条件里）
  // 判据：`tab === 'where'` 后面紧跟 `?` 就是分支（旧写法），紧跟 `||` 或 `)` 是高亮
  // 旧写法的特征是 `: tab === 'where'` 后面接 `? h(...)` 形成渲染链。
  // 现在只允许它出现在高亮条件（与 framework 用 || 并列）。
  const branchWhere = /:\s*tab === 'where'/.test(sidePanel);
  check('B 不再有 tab===\'where\' 的渲染分支', !branchWhere, '仍存在 : tab===\'where\' 渲染链');

  // 两个分支必须都在
  check('B 有 NotesTab 分支', sidePanel.includes('h(NotesTab, {'));
  check('B 有 FrameworkTab 分支', sidePanel.includes('h(FrameworkTab, {'));

  // 高亮：兼容 where
  const highlight = sidePanel.match(/tab === 'framework'[^)]*\) ?\? ' is-on'|tab === 'framework' \|\| tab === 'where'/);
  check('B 旧 where 状态下「整体框架」仍高亮',
    sidePanel.includes("tab === 'framework' || tab === 'where'"), '未找到兼容条件');
}

/* ══════ C. 数据传递：页面数据必须传给 FrameworkTab ═════════════════ */


if (sidePanel) {
  const ftCall = sidePanel.slice(sidePanel.indexOf('h(FrameworkTab, {'));
  const ftCallEnd = ftCall.indexOf('}),');
  const block = ftCall.slice(0, ftCallEnd);

  check('C FrameworkTab 收到 page', /page,\n|page:/.test(block), block.slice(0, 120));
  check('C FrameworkTab 收到 pageCount', block.includes('pageCount: total') || block.includes('pageCount,'), block);
  check('C FrameworkTab 收到 book', block.includes('book,'), block);
}

/* ══════ D. FrameworkTab 内部：进度块 ════════════════════════════════ */

if (frameworkTab) {
  check('D 有 progressBlock', frameworkTab.includes('const progressBlock'), '未定义');
  check('D 接收 page / pageCount', frameworkTab.includes('page, pageCount'), frameworkTab.slice(0, 200));
  check('D 计算 total', /const total = pageCount \|\|/.test(frameworkTab));
  check('D 计算百分比', frameworkTab.includes('const pct = total > 0'), '未计算');

  // 无框架分支必须也渲染进度块（读了多少页与有没有框架无关）
  const noDataAt = frameworkTab.indexOf('if (!data) {');
  check('D FrameworkTab 里有 if (!data) 分支', noDataAt >= 0, noDataAt);
  if (noDataAt >= 0) {
    /**
     * 取 `if (!data) {` 这个**代码块**的全文：从花括号起做配平。
     *
     * 上一版写成「从 if 到下一个 return h(」—— 但 `if (!data) {` 后面紧跟的就是
     * `return h(`，切片长度只有 21 字符，等于什么都没取到，
     * 于是任何分支内容都断言不出来（这条检查形同虚设）。
     */
    const brace = frameworkTab.indexOf('{', noDataAt);
    let depth = 0;
    let close = -1;
    for (let index = brace; index < frameworkTab.length; index += 1) {
      const ch = frameworkTab[index];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { close = index; break; }
      }
    }
    const noDataBranch = close > brace ? frameworkTab.slice(brace, close + 1) : '';
    check('D 无框架分支取到内容', noDataBranch.length > 100, noDataBranch.length);
    check('D 无框架时也显示进度块', noDataBranch.includes('progressBlock'), noDataBranch.slice(0, 160));
  }

  // 有框架分支：进度块在 summary / parts **之前**
  const mainReturn = frameworkTab.slice(frameworkTab.indexOf('if (!data) {') + 10);
  const progressIdx = mainReturn.indexOf('progressBlock,');
  const summaryIdx = mainReturn.indexOf('data.summary');
  const partsIdx = mainReturn.indexOf('(data.parts || [])');
  check('D 进度块在有框架分支里也被渲染', progressIdx >= 0, progressIdx);
  check('D 进度块排在 summary 之前', progressIdx >= 0 && summaryIdx > progressIdx,
    progressIdx + ' vs ' + summaryIdx);
  check('D 进度块排在章列表之前', progressIdx >= 0 && partsIdx > progressIdx,
    progressIdx + ' vs ' + partsIdx);

  // 当前章节详情：有则显示，无则不留空洞
  check('D 当前章节详情用 currentChapter 判断', /currentChapter\n?\s*$|currentChapter\n/.test(mainReturn) || mainReturn.includes('currentChapter'), '未找到');
  check('D 当前章节详情块有样式类', src.includes('.dr-fw-here'), '缺 .dr-fw-here 样式');
} else {
  check('D FrameworkTab 检查（未能抽取）', false);
}

/* ══════ E. 行为：真渲染，验进度条与章节详情 ══════════════════════════ */

const bodyStart = src.indexOf('factory(require) {');
const bodyEnd = src.lastIndexOf('},\n});');
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数的内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = src.slice(bodyStart + 'factory(require) {'.length, bodyEnd);
const EXPOSE = `      __expose: (() => { globalThis.__dr = { SidePanel, FrameworkTab }; return true; })(),\n`;


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

function load() {
  const hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);
  const f = (0, eval)('(function(require){\n' + hooked + '\n})');
  f((n) => {
    if (n === 'react') return makeReact();
    throw new Error('unexpected require: ' + n);
  });
  return globalThis.__dr;
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
  const comps = load();
  const noop = () => {};
  const FRAMEWORK = {
    status: 'done',
    data: {
      parts: [{ name: '第三段', question: 'q', transition: '', chapters: [
        { no: null, index: 9, title: '算力', gist: '算力如何成为故事主角', pages: [192, 212], keyPoints: ['GPU', '集群'] },
      ] }],
    },
  };
  const currentChapter = {
    part: FRAMEWORK.data.parts[0],
    chapter: FRAMEWORK.data.parts[0].chapters[0],
  };
  const baseProps = {
    book: { id: 'b', title: 'T', pages: 360 },
    page: 190,       // 第 191 页
    pageCount: 360,
    framework: FRAMEWORK,
    currentChapter,
    marks: [], notes: [],
    onTab: noop, onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop,
    onMarkNote: noop, onClearMarks: noop,
    onGenerateFramework: noop, onExpandFramework: noop,
  };

  // E1：framework 页签里能看到进度
  const tabTree = comps.SidePanel({ ...baseProps, tab: 'framework' });
  const tabText = textOf(tabTree);
  check('E1 framework 页签显示当前页', tabText.includes('第 191 / 360 页'), tabText.slice(0, 120));
  // 191/360 = 53.1%（写成 52.8 是我手算错了，断言不能凭印象写）
  check('E1 framework 页签显示百分比', tabText.includes('53.1%'), tabText.slice(0, 160));
  check('E1 framework 页签显示当前章节标题', tabText.includes('算力'));
  check('E1 framework 页签显示章节要点', tabText.includes('GPU'));

  // E2：进度条元素真实存在
  check('E2 有进度条容器', byClass(tabTree, 'dr-fw-progress').length >= 1);
  check('E2 有进度条填充', byClass(tabTree, 'dr-bar').length >= 1);

  // E3：旧 'where' 状态不再产生独立内容，但也不崩
  const whereTree = comps.SidePanel({ ...baseProps, tab: 'where' });
  const whereText = textOf(whereTree);
  check('E3 where 状态仍渲染框架内容（兼容）', whereText.includes('第 191 / 360 页'), whereText.slice(0, 120));
  check('E3 where 状态仍高亮「整体框架」页签',
    byClass(whereTree, 'is-on').length >= 1 &&
      byClass(whereTree, 'is-on').some((n) => textOf(n).includes('整体框架')));

  // E4：无框架时进度条仍在（这是「读到哪」独立存在的价值，不能丢）
  const noFw = comps.SidePanel({
    ...baseProps, tab: 'framework', framework: { status: 'none', data: null, error: '' }, currentChapter: undefined,
  });
  const noFwText = textOf(noFw);
  check('E4 无框架时仍显示页数', noFwText.includes('第 191 / 360 页'), noFwText.slice(0, 160));
  check('E4 无框架时仍显示百分比', noFwText.includes('53.1%'), noFwText.slice(0, 160));
  check('E4 无框架时显示生成引导', noFwText.includes('还没有框架'));
  // 无章节详情时不留「这一页没有落在任何一章」这种给已生成框架用的提示
  check('E4 无框架时不出现"没落在任何一章"的多余提示',
    !noFwText.includes('页码区间没对上'), noFwText.slice(0, 200));

  // E5：notes 页签不受影响
  const notesTree = comps.SidePanel({ ...baseProps, tab: 'notes' });
  check('E5 notes 页签正常渲染', byClass(notesTree, 'dr-side-body').length === 1);
  check('E5 notes 页签不显示进度条', byClass(notesTree, 'dr-fw-progress').length === 0);

  // E6：页签数量
  const tabs = walk(tabTree).filter((n) => {
    const c = n.props && n.props.className;
    return typeof c === 'string' && c.split(/\s+/).includes('dr-side-tab');
  });
  check('E6 共 3 个页签按钮', tabs.length === 3, tabs.map(textOf).join(' | '));
  // 顺序：整体框架 → 问答 → 标注笔记。问答放在中间是有意的：
  // 它是「读到一半想问」的入口，紧挨着框架（那里有章节上下文）比放最后更顺手。
  check('E6 页签名与顺序正确',
    textOf(tabs[0]) === '整体框架' &&
      textOf(tabs[1]) === '问答' &&
      textOf(tabs[2]).startsWith('标注笔记'),
    tabs.map(textOf).join(' | '));
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
