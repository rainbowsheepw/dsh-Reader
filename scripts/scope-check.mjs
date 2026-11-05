// 跨组件作用域泄漏检查。
//
// ## 这次的事故现场
//
// client.js 是**单文件、单作用域**——所有组件都定义在同一个 factory 里。
// 这种结构允许一种很阴的出错方式：在 A 组件里顺手写了 B 组件的局部变量名。
//
//     function ContinuousPdf(props) {
//       const { marks, pageCount } = props;
//       ...
//       marks.length > 0 && book && pageCount > 0   // ← book 是 ReaderView 的 useState 产物
//         ? h(某个用到了 marks 的组件, { ... })
//         : null,
//     }
//
// 危险之处：`marks.length > 0 &&` 短路求值 —— **没有标注时根本不会求值到 `book`**。
// 所以空书架、空标注、空笔记一切正常；用户一标注就
// `ReferenceError: book is not defined` → React 卸载整个面板 → 整屏空白。
//
// 既有检查全都抓不到：`node --check` 只验语法（引用未声明变量语法合法）；
// 冒烟检查用空 marks 渲染，短路在第一个条件就跳过了。
//
// ## 判定口径
//
// 对每个函数做**词法作用域**分析：把它的嵌套函数体（`function …` 与 `=> {…}`）
// 从「本作用域净文本」里剔除，剩下的才是「本作用域直接写的代码」。
// 然后：
//   own   = 参数名 + 净文本里所有 const/let/var 解构与声明名
//   refs  = 净文本里被引用的标识符
//   hook  = 各个组件的 useState/useReducer/useCallback/useMemo/useRef 产物
//
// 判据：refs 里出现了「自己没声明、但别的组件用 hook 声明过」的名字 → 泄漏。
//
// 为什么必须剔除嵌套体：`recompute` 箭头里有 `let page = 0`（循环局部），
// 若不剔除就会把 `page` 算进 ContinuousPdf 的 own，让真 bug 静默通过。
// 为什么必须带参数名与 props 解构：`const { pdf, scale } = props` 在函数体首行，
// 漏掉它就会把「组件用自己的 props」误报成泄漏（实测一次冒出 70 条假警报）。
//
// 用法：node scripts/scope-check.mjs

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
const bodyOffset = start + head.length;
const body = src.slice(bodyOffset, end);
const lineOf = (at) => src.slice(0, bodyOffset + at).split('\n').length;

/** 把注释与字符串抹成空格（保留换行 → 行号不变）。 */
function mask(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (out[index] !== '\n') out[index] = ' ';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      const stop = text.indexOf('\n', index);
      const to = stop < 0 ? text.length : stop;
      blank(index, to);
      index = to;
    } else if (char === '/' && next === '*') {
      const stop = text.indexOf('*/', index + 2);
      const to = stop < 0 ? text.length : stop + 2;
      blank(index, to);
      index = to;
    } else if (char === '\'' || char === '"' || char === '`') {
      let scan = index + 1;
      while (scan < text.length) {
        if (text[scan] === '\\') scan += 2;
        else if (text[scan] === char) break;
        else scan += 1;
      }
      blank(index + 1, Math.min(scan, text.length));
      index = scan + 1;
    } else index += 1;
  }
  return out.join('');
}

const masked = mask(body);

/** 从 `openIndex` 指向的括号找到配对右括号。 */
function matchBracket(text, openIndex) {
  const open = text[openIndex];
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** 所有 `function Name(...) { ... }` 定义。 */
function findFunctions(text) {
  const out = [];
  for (const match of text.matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const open = text.indexOf('(', match.index);
    const closeParams = matchBracket(text, open);
    if (closeParams < 0) continue;
    let brace = closeParams + 1;
    while (brace < text.length && text[brace] !== '{') brace += 1;
    const closeBody = matchBracket(text, brace);
    if (closeBody < 0) continue;
    out.push({
      name: match[1],
      at: match.index,
      params: text.slice(open + 1, closeParams),
      bodyStart: brace + 1,
      bodyEnd: closeBody,
    });
  }
  return out;
}

/** 返回 `[from, to]` 区间列表：本作用域内的嵌套函数体（function 与 `=> {}`）。 */
function nestedBodySpans(text, from, to) {
  const spans = [];
  // function 声明 / 表达式
  for (const match of text.slice(from, to).matchAll(/\bfunction\s*[A-Za-z_$0-9]*\s*\(/g)) {
    const open = from + match.index + match[0].length - 1;
    const closeParams = matchBracket(text, open);
    if (closeParams < 0) continue;
    let brace = closeParams + 1;
    while (brace < to && text[brace] !== '{') brace += 1;
    const closeBody = matchBracket(text, brace);
    if (closeBody < 0 || closeBody > to) continue;
    spans.push([from + match.index, closeBody + 1]);
  }
  // 箭头函数体（只处理带花括号的；表达式体与外层同链，保留在内更安全）
  for (const match of text.slice(from, to).matchAll(/=>\s*\{(?![^\n]*\})/g)) {
    const brace = from + match.index + match[0].length - 1;
    const closeBody = matchBracket(text, brace);
    if (closeBody < 0 || closeBody > to) continue;
    spans.push([from + match.index, closeBody + 1]);
  }
  // 合并重叠区间
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** 把区间抹成空格（保留长度与换行 → 下标仍然对得上原文本）。 */
function blankSpans(text, spans, base) {
  const out = text.split('');
  for (const [from, to] of spans) {
    for (let index = from - base; index < to - base; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  }
  return out.join('');
}

/** 收集一段文本里所有 const/let/var 声明的名字（含数组/对象解构）。 */
function collectDeclared(text) {
  const names = new Set();
  for (const match of text.matchAll(/\b(?:const|let|var)\b/g)) {
    const before = match.index > 0 ? text[match.index - 1] : ' ';
    if (/[A-Za-z0-9_$]/.test(before)) continue;
    let depth = 0;
    let index = match.index;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (char === '=' || char === ';' || char === '\n')) break;
    }
    for (const ident of text.slice(match.index, index).matchAll(IDENT)) names.add(ident[0]);
  }
  // `catch (error)` / `catch {` —— catch 的绑定名同样是本作用域的声明。
  //
  // 漏掉这一步会**假红**：`ReaderPage` / `ReaderView` 里都有 `const [error, setError]`，
  // 于是 `error` 被登记成那两个组件的 hook 产物；另一个模块级函数里写
  // `catch (error)` 就被告成「跨组件作用域泄漏」——
  // 明明只是它自己的 catch 参数。第一次踩到是 renderCoverBlob。
  for (const match of text.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g)) {
    names.add(match[1]);
  }
  // 嵌套函数的**参数名**同样是声明。
  //
  // ⚠️ 这一步必须在**未剔除嵌套体的原文**上做：剔除区间从 `=>` 起算，
  // `=>` 自己在净文本里已被抹成空格，参数表后面的 `=>` 就认不出来了。
  // 上一版在净文本上判，于是 `(error) =>` / `async (draft) =>` / `(heights, page, …) =>`
  // 这三处参数全被误报成跨组件泄漏。
  for (const match of text.matchAll(/(?:function\s*[A-Za-z_$0-9]*\s*)?\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    let after = close + 1;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    const isArrow = text[after] === '=' && text[after + 1] === '>';
    const isFunction = /\bfunction\b/.test(match[0]);
    if (!isArrow && !isFunction) continue;
    for (const ident of text.slice(open + 1, close).matchAll(IDENT)) names.add(ident[0]);
  }
  // 无括号单参数箭头：`x => …`
  for (const match of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) names.add(match[1]);
  return names;
}

/** 引用的标识符（排除属性访问与对象字面量键）。 */
function collectReferenced(text) {
  const names = new Set();
  for (const match of text.matchAll(IDENT)) {
    const name = match[0];
    const at = match.index;
    let before = at - 1;
    while (before >= 0 && /\s/.test(text[before])) before -= 1;
    const beforeChar = before >= 0 ? text[before] : '';
    let after = at + name.length;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    const afterChar = after < text.length ? text[after] : '';
    if (beforeChar === '.') continue;
    if (afterChar === ':' && (beforeChar === '{' || beforeChar === ',')) continue;
    names.add(name);
  }
  return names;
}

const functions = findFunctions(masked);

// ── 各函数的「本作用域净文本」与 own 集合 ────────────────────────────
const scopes = new Map();
for (const fn of functions) {
  const raw = masked.slice(fn.bodyStart, fn.bodyEnd);
  const spans = nestedBodySpans(masked, fn.bodyStart, fn.bodyEnd).map(([a, b]) => [a - fn.bodyStart, b - fn.bodyStart]);
  const net = blankSpans(raw, spans, 0);
  const own = new Set();
  for (const arg of fn.params.matchAll(IDENT)) own.add(arg[0]);
  for (const name of collectDeclared(net)) own.add(name);
  // 参数表在原文里（净文本已把 `=>` 抹掉），补一遍
  for (const name of collectDeclared(raw)) own.add(name);
  scopes.set(fn.name, { net, own, offset: fn.bodyStart });
}

// ── hook 产物 → 归属组件 ─────────────────────────────────────────────
const hookOwners = new Map();
const hookOwnOf = new Map();
for (const fn of functions) {
  const { net } = scopes.get(fn.name);
  const names = new Set();
  for (const match of net.matchAll(/\b(?:const|let)\s*\[([^\]]+)\]\s*=\s*(?:useState|useReducer)\b/g)) {
    for (const ident of match[1].matchAll(IDENT)) names.add(ident[0]);
  }
  for (const match of net.matchAll(/\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:useCallback|useMemo|useRef)\b/g)) {
    names.add(match[1]);
  }
  hookOwnOf.set(fn.name, names);
  for (const name of names) {
    if (!hookOwners.has(name)) hookOwners.set(name, []);
    hookOwners.get(name).push(fn.name);
  }
}

// ── 判定 ─────────────────────────────────────────────────────────────
let failed = 0;
for (const fn of functions) {
  const { net, own, offset } = scopes.get(fn.name);
  const ownHooks = hookOwnOf.get(fn.name) || new Set();
  const seen = new Set();
  for (const ref of collectReferenced(net)) {
    if (own.has(ref) || ownHooks.has(ref)) continue;
    const owners = hookOwners.get(ref);
    if (!owners) continue;
    const others = owners.filter((owner) => owner !== fn.name);
    if (others.length === 0) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    failed += 1;
    const at = net.search(new RegExp('\\b' + ref.replace(/[$]/g, '\\$&') + '\\b'));
    console.log(
      '❌ ' + fn.name + ' 第 ' + lineOf(offset + Math.max(0, at)) + ' 行引用了 `' + ref + '`，' +
        '它只是 ' + others.join(' / ') + ' 的 hook 产物 —— 跨组件作用域泄漏',
    );
  }
}

console.log('\n' + (failed === 0 ? '1 pass' : '0 pass') + ', ' + failed + ' fail（扫描 ' +
  functions.length + ' 个函数，追踪 ' + hookOwners.size + ' 个 hook 产物）');
process.exitCode = failed ? 1 : 0;
