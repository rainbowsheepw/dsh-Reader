// 样式完整性回归：**JS 里渲染的每个 class 都必须在 CSS 里定义**。
//
// ## 为什么必须有这条
//
// 深色模式截图暴露的问题：`dr-scope` / `dr-clear-btn` / `dr-group-clear` 等 8 个类
// 在 JS 里被大量使用，但 CSS 里**一条规则都没有**。于是它们回落到浏览器默认按钮样式
// —— 浅灰实心块，在深色主题下格外刺眼。
//
// 根因是我改问答样式时按「起点到终点」替换了一段 CSS，
// 而两端之间还夹着另外两个样式块，被一起覆盖删掉了。
//
// **这类 bug 在 Node 里完全测不出来**（没有渲染引擎），构建也不报错，
// 只有人眼在深色模式下才发现。所以只能靠静态对账：
//   把 JS 里出现过的 `className: '...'` 收集起来，
//   逐个检查 CSS 里有没有对应的 `.xxx{...}` 规则。
//
 // ## 判定口径
 //
// - 只查**本项目自己定义**的类（`dr-*`）。宿主 token 类（`dsw-*`）不归我们管。
// - 类名可能带条件拼接（`'dr-note is-' + color`），所以按「出现的每个 dr-* token」查，
//   而不是按完整 className 字符串查。
// - 允许「有意的无样式类」：某些类只作语义标记（如 `is-on` 靠后代选择器生效）。
 //   这类在 ALLOWLIST 里显式列出，**不允许靠加白名单来掩盖真缺失**。
//
 // 用法：node scripts/class-css-check.mjs

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

/* ══════ 1. 取出 CSS 模板 ═══════════════════════════════════════════ */

const BT = String.fromCharCode(96); // 反引号
const head = 'const CSS = ' + BT;
const cssStart = src.indexOf(head);
const cssEnd = src.indexOf(BT + ';', cssStart);
if (cssStart < 0 || cssEnd < 0) {
  console.log('❌ 找不到 CSS 模板字符串');
  process.exit(1);
}
const css = src.slice(cssStart + head.length, cssEnd);
// 去掉注释，避免把注释里提到的类名当成"已定义"
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/* ══════ 2. 收集 CSS 里定义过的类 ═══════════════════════════════════ */

/**
 * 从 CSS 抽出「**作为基类被定义**」的类名。
 *
 * ⚠️ 不能把后代选择器里的类也算成「已定义」。
 * 实测：删掉 `.dr-scope{...}` 之后，`.dr-scope button:hover{...}` 这类规则里
 * 仍然含 `dr-scope` token，于是「已定义」判定为真，**注入故障也抓不到**。
 *
 * 判据：只有选择器里**末位那个**简单类选择器才算「定义了这个类的本体」。
 * 例如：
 *   `.dr-scope{...}`            → 定义 dr-scope
 *   `.dr-scope button:hover{...}` → 定义 button(:hover)，不定义 dr-scope
 *   `.dr-note.is-amber .dr-note-q{...}` → 定义 dr-note-q
 *
 * 这样「基类规则被删」就能被 detect 到。
 */
const defined = new Set();
{
  const rulePattern = /([^{}]+)\{[^{}]*\}/g;
  let m;
  while ((m = rulePattern.exec(cssNoComments)) !== null) {
    const selector = m[1].trim();
    if (/^\s*@/.test(selector)) continue;
    // 规则可能是一组逗号分隔的选择器，逐个处理
    for (const one of selector.split(',')) {
      const part = one.trim();
      if (part === '') continue;
      // 取最后一段「简单选择器」（去掉伪类/伪元素后再取类）
      const lastSegment = part.split(/[ >+~]+/).filter(Boolean).pop() || '';
      const cleanSegment = lastSegment.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
      const matches = cleanSegment.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || [];
      for (const token of matches) defined.add(token.slice(1));
    }
  }
}

check('2 解析到 CSS 类（样本量合理）', defined.size > 40, defined.size + ' 个');

/* ══════ 3. 收集 JS 里用到的 dr-* 类 ═════════════════════════════════ */

/**
 * 从 JS 里抽出所有 `dr-*` token。
 *
 * 不用「className: '...'」整串匹配，因为常见写法是
 * `className: 'dr-note is-' + color + (mini ? ' is-mini' : '')` ——
 * 类名是拼接出来的。所以直接扫全文件里的 dr-* 字面量。
 *
 * 排除注释：注释里提到类名不代表真渲染了它。
 */
const jsPart = src.slice(0, cssStart) + src.slice(cssEnd);
const jsNoComments = jsPart.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * 只收「作为 class 使用的」dr-* name。
 *
 * ⚠️ 不能直接扫所有字符串里的 dr-*：`'data-dr-scrollable': '1'` 这种
 * **属性名**里也含 dr-，但它不是 class。上一版就是这么误报了 4 个。
 *
 * 判据：值必须是**选择器形态**（class 名），且不能是纯数字/布尔。
 * 用「字符串里由空格分隔的 dr-* token」来收，并排除以 data- 开头的整体。
 */
const used = new Set();
const addFrom = (raw) => {
  // 整个字符串若以 data- 开头，说明它是属性名不是 className
  if (/^data-/.test(raw.trim())) return;
  for (const token of raw.matchAll(/(dr-[a-z0-9][a-z0-9-]*)/g)) {
    const name = token[1];
    // 排除 data-dr-xxx 这种被切出来的残片：检查它前一字符是否 '-'
    const at = token.index;
    if (at > 0 && raw[at - 1] === '-') continue;
    used.add(name);
  }
};
for (const match of jsNoComments.matchAll(/'([^']*)'/g)) addFrom(match[1]);
for (const match of jsNoComments.matchAll(/"([^"]*)"/g)) addFrom(match[1]);

check('3 解析到已用类（样本量合理）', used.size > 40, used.size + ' 个');

/* ══════ 4. 对账 ════════════════════════════════════════════════════ */

/**
 * 允许「无独立样式规则」的类。
 *
 * 每一条都必须写清理由 —— 这个名单是用来**区分有意标记类与真缺失**的，
 * 不是用来消音的。往这里加东西前先问：它真的不需要样式吗？
 */
const ALLOW = new Map([
  // 语义标记：实际样式由后代/兄弟选择器提供（如 .dr-note.is-amber .dr-note-q）
  ['is-marked', '只用 classList.add 打标记，样式由 .dr-textlayer span.is-marked 提供'],
  ['is-mini', '由 .dr-note.is-mini 系列规则提供'],
  ['is-on', '由 .dr-scope button.is-on / .dr-side-tab.is-on 提供'],
  ['is-now', '进度指示，样式由后代选择器提供'],
  // SVG 里 `dr-g-arrow` 是 `dr-g-arrowhead` 被切出来的残片（扫描按点分割导致）
  ['prefix:dr-g-arrow', '是 dr-g-arrowhead 的切词残片，不是独立类'],
]);

const missing = [];
for (const name of used) {
  if (defined.has(name)) continue;
  if (ALLOW.has(name)) continue;
  /**
   * 前缀误报：`dr-g-arrow` 会被当成一个独立类，而 CSS 里其实只有
   * `dr-g-arrowhead`。判据：若**定义过的某个类以它开头**，说明是切词切断的残片。
   * 同理 `dr-band` / `dr-chip` 在复合选择器里出现过（如 `.dr-band-row`），
   * 这层由下面「定义过」的集合自然覆盖 —— 但若只在复合里出现，也可能被漏，
   * 所以额外做一次「以它开头的已定义类」检查。
   */
  /**
   * 前缀误报的处理要**更细**：只有当「以它开头的类」是它加了后缀、且它自己没有
   * 独立规则的**合理情况**才放过。
   *
   * 实测踩过：`dr-scope` 被删后，因为存在 `dr-scope-hint`，前缀判定把
   * `dr-scope` 当成残片跳过了 —— 而这恰恰是我们要抓的真缺失。
   *
   * 所以只在「它由多个词组成且最后一个词是残缺的缩写」时才放过，
   * 简单的做法：要求前缀关系是**单字母断词**（如 dr-g-arrow → dr-g-arrowhead），
   * 即 name 的最后一段不是完整单词。这里用更保守的判据：
   * 只有当以它开头的类**数量≥1 且它本身长度比对方短很多（差 1~8 字符）**
   * 才视为残片。`dr-scope` vs `dr-scope-hint` 差 5，仍会误判……
   *
   * 最终采用：**不靠前缀放过**。改为在 ALLOW 里显式列出确实是残片的项。
   * `dr-g-arrow` 是 `dr-g-arrowhead` 被切断的残片（点号分割导致），
   * 它只出现在 SVG 的 className 拼接里 —— 显式列进 ALLOW 最清楚。
   */
  if (ALLOW.has('prefix:' + name)) continue;
  missing.push(name);
}

if (missing.length === 0) {
  console.log('ok   4 JS 用到的类全部有 CSS 规则');
  passed += 1;
} else {
  failed += 1;
  console.log('❌ 4 有 ' + missing.length + ' 个类被 JS 使用但 CSS 里没定义：');
  for (const name of missing.sort()) console.log('     · .' + name);
  console.log('     → 这些按钮/容器会回落到浏览器默认样式（深色模式下会变成浅灰实心块）');
}

/* ══════ 5. 深色模式专项：本次事故的 8 个类 ══════════════════════════ */

// 这 8 个是这次真的丢了的。单独钉死，防止再被某次整段替换带走。
const MUST_HAVE = [
  'dr-scope',
  'dr-scope-hint',
  'dr-clear-row',
  'dr-clear-btn',
  'dr-confirm',
  'dr-clear-hint',
  'dr-group-clear',
  'dr-group-confirm',
];
for (const name of MUST_HAVE) {
  check('5 .' + name + ' 有 CSS 规则', defined.has(name), '缺失（会回落默认样式）');
}

// 它们都不能依赖浏览器默认的按钮外观
{
  const scopeRule = cssNoComments.match(/\.dr-scope\s*\{[^}]*\}/);
  check('5 范围开关有底槽（不裸奔）',
    scopeRule && scopeRule[0].includes('background'), scopeRule ? scopeRule[0].slice(0, 70) : '无规则');

  const clearRule = cssNoComments.match(/\.dr-clear-btn\s*\{[^}]*\}/);
  check('5 清除按钮有边框与透明底',
    clearRule && clearRule[0].includes('border') && clearRule[0].includes('background:transparent'),
    clearRule ? clearRule[0].slice(0, 80) : '无规则');

  // hover 才显现的那个按钮，常态必须是 opacity:0（否则组头会变成按钮墙）
  const groupClear = cssNoComments.match(/\.dr-group-clear\s*\{[^}]*\}/);
  check('5 章节清除按钮常态隐藏',
    groupClear && groupClear[0].includes('opacity:0'),
    groupClear ? groupClear[0].slice(0, 80) : '无规则');
}

/* ══════ 5b. 深色模式对比度：填充按钮必须成对使用 token ══════════════

   一次真实事故：导入 PDF 那颗主按钮在深色主题下**变成一片白**。
   原因不是漏了样式，而是样式**配错了**：

     .dr-btn.is-primary { background: var(--dsw-alias-brand-primary); color: #fff }

   浅色主题下 brand-primary 是品牌色，白字正常。
   深色主题下宿主把 --dsw-alias-brand-primary 改成了 neutral-bluish-50（近白），
   于是「近白底 + 白字」= 一片白。

   ## 判据：不能用「底色 token + 硬编码前景色」
   宿主的 button-primary-fill 与 label-primary-foreground 是**配好的一对**，
   两套主题下都保证对比度。凡是 background 用了 token 而 color 写死 #fff
   （或反过来），就是同一个坑的变体。

   ## 例外：封面
   .dr-cover 的 color:#fff 是**故意的** —— 它的底色是按书名哈希算出的深色渐变
   （hsl 44%~46% 亮度、42%~28% 亮度），永远是深色，固定白字才对。
   这个例外要显式登记，不能靠「反正没报错」蒙过去。 */

{
  const PAIR_TOKEN = '--dsw-alias-label-primary-foreground';
  // 找出所有「底色用 token 但前景写死白色」的规则
  const offenders = [];
  for (const m of cssNoComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim().split('\n').pop().trim();
    const body = m[2];
    if (!/background:\s*var\(/.test(body)) continue;
    if (!/color:\s*#(fff|ffffff)\b/i.test(body)) continue;
    offenders.push(selector);
  }

  const ALLOW = ['dr-cover']; // 深色渐变底，见上
  const real = offenders.filter((sel) => !ALLOW.some((n) => sel.includes('.' + n + '{') || sel.endsWith('.' + n)));
  check('5b 没有「token 底 + 硬编码白字」的规则（深色会白底白字）',
    real.length === 0, real.join(' | '));

  // 主按钮必须真的用了那对 token
  const primary = cssNoComments.match(/\.dr-btn\.is-primary\{([^}]*)\}/);
  check('5b 主按钮底色用 button-primary-fill',
    primary && primary[1].includes('--dsw-alias-button-primary-fill'),
    primary ? primary[1].slice(0, 80) : '无规则');
  check('5b 主按钮前景用 label-primary-foreground',
    primary && primary[1].includes(PAIR_TOKEN),
    primary ? primary[1].slice(0, 80) : '无规则');
  check('5b 主按钮不再硬编码 #fff',
    primary && !/color:\s*#fff/i.test(primary[1]),
    primary ? primary[1].slice(0, 80) : '无规则');

  // 主按钮 hover 也要从 token 来（否则鼠标一上去又露馅）
  const primaryHover = cssNoComments.match(/\.dr-btn\.is-primary:hover[^{]*\{([^}]*)\}/);
  check('5b 主按钮 hover 走 token（不是硬编码色）',
    primaryHover && /--dsw-alias-button-primary-hover/.test(primaryHover[1]),
    primaryHover ? primaryHover[1].slice(0, 80) : '无 hover 规则');

  // 危险按钮同理
  const danger = cssNoComments.match(/\.dr-confirm button\.is-danger\{([^}]*)\}/);
  check('5b 危险按钮底色与字色都来自 token',
    danger &&
      danger[1].includes('--dsw-alias-state-error-primary') &&
      danger[1].includes(PAIR_TOKEN) &&
      !/color:\s*#fff/i.test(danger[1]),
    danger ? danger[1].slice(0, 90) : '无规则');
}

/* ══════ 6. 反向：CSS 里有没有「定义了但没人用」的类 ══════════════════ */
//
// 这条只报信息，不算失败 —— 但能帮人发现「某次替换把 JS 里的用法删了、
// CSS 成了孤儿」。真出现时会在这里冒出来。

{
  const orphans = [];
  for (const name of defined) {
    if (!name.startsWith('dr-')) continue;
    if (used.has(name)) continue;
    // 变体类（is-xxx）常在 JS 里拼出来，这里只统计基类
    if (/^is-/.test(name)) continue;
    orphans.push(name);
  }
  if (orphans.length > 0) {
    console.log('⚠️  CSS 里有 ' + orphans.length + ' 个类没在 JS 里出现（可能是孤儿样式）：');
    for (const name of orphans.sort().slice(0, 12)) console.log('     · .' + name);
    if (orphans.length > 12) console.log('     …还有 ' + (orphans.length - 12) + ' 个');
  } else {
    console.log('ok   CSS 无孤儿类');
  }
  passed += 1;
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
