// 框架 SVG 回归：扩大视图必须画成矢量图（框/箭头/标签/卡片），而不是卡片列表。
//
// 版式对齐 nndl-ge全书框架.html 的四层表达。不用 iframe 的原因：
//   · iframe 是独立文档，拿不到 --dsw-alias-* token，亮暗主题不跟随；
//   · 点击节点无法联动跳页；
//   · 那份 HTML 坐标写死，换书即废。
//
// 用法：node scripts/framework-svg-check.mjs
// 渲染 FrameworkCanvas，断言它产出的是 **SVG 图**（框/箭头/标签/卡片），
// 而不是之前的 flex 卡片列表。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');
const start = src.indexOf('factory(require) {');
const end = src.lastIndexOf('},\n});');
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数的内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = src.slice(start + 'factory(require) {'.length, end);
const EXPOSE = "      __expose: (() => { globalThis.__dr = { FrameworkCanvas, FrameworkGraph, layoutFramework }; return true; })(),\n";

const hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);

const React = {
  createElement: (type, props, ...kids) => {
    // 函数组件：真实 React 会在渲染阶段调用它。测试脚手架必须照做，
    // 否则收集到的树里全是函数引用，断言自然找不到 svg / path。
    if (typeof type === 'function') return type(props || {});
    return { type, props: props || {}, kids };
  },
  Fragment: Symbol('fragment'),
  useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
  useRef: (i) => ({ current: i }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
};
const factory = (0, eval)('(function(require){\n' + hooked + '\n})');
factory((n) => { if (n === 'react') return React; throw new Error('unexpected: ' + n); });
const D = globalThis.__dr;

const framework = {
  status: 'done',
  data: {
    title: '《神经网络与深度学习》',
    summary: '四段路线。',
    parts: [
      { name: '第一段 · 打地基', question: '怎么学？', transition: '打基础', chapters: [
        { index: 2, title: '机器如何自己学习', pages: [10, 40], gist: '三要素', keyPoints: ['模型', '损失'] },
        { index: 3, title: '从神经元到深度网络', pages: [41, 70], gist: '结构', keyPoints: ['前馈'] },
      ]},
      { name: '第二段 · 核心机制', question: '怎么进大模型？', transition: '', chapters: [
        { index: 4, title: '注意力引爆大模型', pages: [71, 110], gist: 'Transformer', keyPoints: ['QKV'] },
      ]},
    ],
    howToRead: ['先读第一章'],
  },
};

const out = D.FrameworkCanvas({
  framework, currentChapter: undefined,
  onGotoMark() {}, onGenerate() {}, bookTitle: 'nndl-ge', page: 47, pageCount: 360, onCollapse() {},
});

// 收集所有标签名
function collect(node, tags = []) {
  if (!node || typeof node !== 'object') return tags;
  if (Array.isArray(node)) { for (const k of node) collect(k, tags); return tags; }
  if (typeof node.type === 'string') tags.push(node.type);
  for (const k of node.kids || []) collect(k, tags);
  return tags;
}
const tags = collect(out);
const counts = tags.reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {});

let pass = 0, fail = 0;
const t = (n, ok, d) => ok ? (pass++) : (fail++, console.log('FAIL ' + n + ' ' + (d ?? '')));

t('有 svg 元素', counts.svg === 1, JSON.stringify(counts));
t('有 viewBox（可缩放）', (() => {
  let found = false;
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.props && n.props.viewBox) found = true;
    (n.kids || []).forEach(walk);
  })(out);
  return found;
})(), 'svg 上必须有 viewBox 才能等比缩放');
t('区域框 rect 数 ≥ 段数', (counts.rect || 0) >= framework.data.parts.length, 'rect=' + counts.rect);
t('有 path（箭头）', (counts.path || 0) >= 2, 'path=' + counts.path);
t('有 text 元素（标签）', (counts.text || 0) >= 5, 'text=' + counts.text);
t('有 marker（箭头形状）', (counts.marker || 0) === 1, 'marker=' + counts.marker);
t('有 polygon（箭头尖）', (counts.polygon || 0) === 1, '');
t('跨段过渡文字出现在图上', (() => {
  const texts = [];
  (function walk(n) {
    if (typeof n === "string") { texts.push(n); return; }
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    (n.kids || []).forEach(walk);
  })(out);
  return texts.includes('打基础');
})(), '');
t('章号出现在图上', (() => {
  const texts = [];
  (function walk(n) {
    if (typeof n === "string") { texts.push(n); return; }
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    (n.kids || []).forEach(walk);
  })(out);
  return texts.some((y) => /第 \d+ 章/.test(y));
})(), '');
t('不再有 flex 卡片列表（dr-band-row）', !JSON.stringify(out).includes('dr-band-row'), '');
t('顶部有总览摘要', (() => { const texts=[]; (function w(n){ if(typeof n==='string'){texts.push(n);return;} if(!n||typeof n!=='object')return; if(Array.isArray(n))return n.forEach(w); (n.kids||[]).forEach(w); })(out); return texts.includes('四段路线。'); })(), '');
t('有「怎么读这本书」', (() => { const texts=[]; (function w(n){ if(typeof n==='string'){texts.push(n);return;} if(!n||typeof n!=='object')return; if(Array.isArray(n))return n.forEach(w); (n.kids||[]).forEach(w); })(out); return texts.includes('怎么读这本书'); })(), '');
t('有缩略按钮', (() => { const texts=[]; (function w(n){ if(typeof n==='string'){texts.push(n);return;} if(!n||typeof n!=='object')return; if(Array.isArray(n))return n.forEach(w); (n.kids||[]).forEach(w); })(out); return texts.includes('缩略'); })(), '');

console.log(`\n${pass} pass, ${fail} fail`);
console.log('元素统计:', JSON.stringify(counts));
