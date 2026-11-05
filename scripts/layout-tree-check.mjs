// 版式树回归：侧栏（SidePanel）必须与 PDF 视图**同级**，都在 dr-viewer 内。
//
// 事故：SidePanel 曾被放在 dr-reader 的直接子级，而 dr-reader 是 flex-direction: column，
// 结果侧栏被排到 PDF 下方，PDF 被挤到看不见 —— 用户看到「切到整体框架就什么都没有了」。
//
// 用法：node scripts/layout-tree-check.mjs
// 而不是 dr-viewer 的兄弟（那会把 PDF 挤到侧栏上方）。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const src = await readFile(clientPath, 'utf8');
const start = src.indexOf('factory(require) {');
const end = src.lastIndexOf('},\n});');
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数的内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = src.slice(start + 'factory(require) {'.length, end);

const EXPOSE = `      __expose: (() => {
        globalThis.__dr = { ReaderView, ContinuousPdf, PageCanvas, SidePanel, FrameworkTab, NotesTab };
        return true;
      })(),
`;

const hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);

const React = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  Fragment: Symbol('fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
};
const factory = (0, eval)('(function(require){\n' + hooked + '\n})');
factory((n) => { if (n === 'react') return React; throw new Error('unexpected: ' + n); });

const comps = globalThis.__dr;
const fakePdf = {
  numPages: 360,
  getPage: async () => ({
    getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale, transform: [1,0,0,-1,0,842] }),
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve() }),
  }),
};

const book = { id: 'x', title: 'nndl-ge', pages: 360, progress: { page: 47, pct: 13 }, marks: [], notes: [] };

// 用 ReaderView 渲染（它内部才有 dr-viewer / SidePanel 的关系），
// 但 ReaderView 需要 pdf 状态 —— 直接调用时 pdf 为 null，会走 loading 分支。
// 所以改用「静态结构断言」：在源码里检查 SidePanel 的位置。
const s2 = src;
const vIdx = s2.indexOf("className: 'dr-viewer'");
const sideIdx = s2.indexOf('sideOpen && book');
const readerIdx = s2.indexOf("className: 'dr-reader'");

let pass = 0, fail = 0;
const t = (n, ok, d) => ok ? (pass++) : (fail++, console.log('FAIL ' + n + ' ' + (d ?? '')));

t('dr-reader 在 dr-viewer 之前', readerIdx < vIdx, `${readerIdx} < ${vIdx}`);
t('SidePanel 出现在 dr-viewer 之后', vIdx < sideIdx, `${vIdx} < ${sideIdx}`);

// 关键：SidePanel 必须在 dr-viewer 的 h(...) 括号内 —— 用配平检查
const hAt = s2.lastIndexOf('h(', vIdx);
let depth = 0, closeAt = -1;
for (let k = s2.indexOf('(', hAt); k < s2.length; k++) {
  if (s2[k] === '(') depth++;
  else if (s2[k] === ')') { depth--; if (depth === 0) { closeAt = k; break; } }
}
t('SidePanel 在 dr-viewer 的括号内', sideIdx < closeAt && closeAt > 0, `side=${sideIdx}, close=${closeAt}`);

// CSS：dr-viewer 必须是横向 flex，dr-side 固定宽、不收缩
t('dr-viewer 是 flex 行', /\.dr-viewer\{[^}]*display:flex/.test(s2));
t('dr-side 固定宽度', /\.dr-side\{[^}]*width:310px[^}]*flex:none/.test(s2));
t('dr-scrollwrap 占满剩余', /\.dr-scrollwrap\{[^}]*flex:1/.test(s2));

console.log(`\n${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
