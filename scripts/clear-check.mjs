// 批量清除回归：一键清全部 / 清某一章。
//
// ## 这类功能的风险等级和别的不一样
//
// 别的 bug 是「显示错了」，这里是「**数据没了**」。所以断言分三组：
//   1. **范围语义**：null=全清、区间=只清区间，不许混；
//   2. **差一位**：框架 `chapter.pages` 是 1 起，mark/note 的 `page` 是 0 起；
//   3. **不该删的不删**：清第 9 章不能连带删掉第 8 章最后一条 / 第 10 章第一条。
//
 // 第 3 条是重点。差一位的 bug 表现恰好是「多删一页」，而多删的东西
 // 用户往往过几天才发觉 —— 那时已经无从恢复。
//
 // 用法：node scripts/clear-check.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = fileURLToPath(new URL('../', import.meta.url));

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

/* ══════ 第一部分：Host 侧 store.clearMarks ══════════════════════════ */

const { clearMarks, readBookState, createBook } = await import(here + 'lib/store.js');

const dir = await mkdtemp(join(tmpdir(), 'dr-clear-'));
const paths = { libraryDir: dir, bookDir: (id) => join(dir, id) };

/** 造一本书：meta 直接写盘，省掉 PDF。 */
async function seed(id, marks, notes) {
  const bookDir = join(dir, id);
  await mkdir(bookDir, { recursive: true });
  await writeFile(
    join(bookDir, 'meta.json'),
    JSON.stringify({
      id,
      title: 'T',
      fileName: 'T.pdf',
      format: 'pdf',
      pages: 360,
      bytes: 1,
      createdAt: 1,
      progress: { page: 0, pct: 0, updatedAt: 0 },
      marks,
      notes,
      framework: { status: 'none', generatedAt: 0, data: null, error: '' },
    }),
  );
}

const mk = (id, page, text) => ({ id, page, offset: 0, length: text.length, text, color: 'amber', note: '', createdAt: 1, updatedAt: 1 });
const nt = (id, page, text) => ({ id, page, text, createdAt: 1, updatedAt: 1 });

// 区间 [191, 211]（= 第 192–212 页）—— 真实书第 9 章「算力」的范围
const MARKS = [
  mk('m1', 190, '第191页：第8章最后一条'), // 边界外（前一页）
  mk('m2', 191, '第192页：第9章第一条'),   // 边界内（首）
  mk('m3', 200, '第201页：第9章中间'),
  mk('m4', 211, '第212页：第9章最后一条'),  // 边界内（尾）
  mk('m5', 212, '第213页：第10章第一条'),   // 边界外（后一页）
];
const NOTES = [
  nt('n1', 190, '第191页的散记'),
  nt('n2', 195, '第196页的散记'),
  nt('n3', 211, '第212页的散记'),
  nt('n4', 213, '第214页的散记'),
];

// ── 1. 清某一章 ─────────────────────────────────────────────────
{
  await seed('book-chapter', MARKS, NOTES);
  const before = await readBookState(paths, 'book-chapter');
  check('清章：清除前 5 标注 4 笔记', before.marks.length === 5 && before.notes.length === 4);

  const meta = await clearMarks(paths, 'book-chapter', { from: 191, to: 211 });
  const after = await readBookState(paths, 'book-chapter');

  check('清章：删掉 3 条标注 + 2 条笔记', meta.__cleared.marks === 3 && meta.__cleared.notes === 2,
    JSON.stringify(meta.__cleared));
  check('清章：剩 2 标注 2 笔记', after.marks.length === 2 && after.notes.length === 2,
    after.marks.length + '/' + after.notes.length);

  const keptMarkIds = after.marks.map((m) => m.id).sort().join(',');
  check('清章：保留边界外的第 191 页与第 213 页标注', keptMarkIds === 'm1,m5', keptMarkIds);
  const keptNoteIds = after.notes.map((n) => n.id).sort().join(',');
  check('清章：保留边界外的散记', keptNoteIds === 'n1,n4', keptNoteIds);

  // 边界内的必须全没了
  check('清章：边界内的 m2/m3/m4 已删',
    !after.marks.some((m) => ['m2', 'm3', 'm4'].includes(m.id)));
  check('清章：边界内的 n2/n3 已删',
    !after.notes.some((n) => ['n2', 'n3'].includes(n.id)));
}

// ── 2. 清全部 ───────────────────────────────────────────────────
{
  await seed('book-all', MARKS, NOTES);
  const meta = await clearMarks(paths, 'book-all', null);
  const after = await readBookState(paths, 'book-all');
  check('清全部：删掉 5+4 条', meta.__cleared.marks === 5 && meta.__cleared.notes === 4,
    JSON.stringify(meta.__cleared));
  check('清全部：标注清空', after.marks.length === 0);
  check('清全部：笔记清空', after.notes.length === 0);
}

// ── 3. 只清第 1 页（range 非 null 但范围极小）────────────────────
//
// 这条防的是「range={from:0,to:0} 被当成全清」的误读。
{
  await seed('book-zero', [mk('z1', 0, '第1页'), mk('z2', 5, '第6页')], []);
  const meta = await clearMarks(paths, 'book-zero', { from: 0, to: 0 });
  const after = await readBookState(paths, 'book-zero');
  check('只清第1页：删 1 条', meta.__cleared.marks === 1, meta.__cleared.marks);
  check('只清第1页：第6页还在', after.marks.length === 1 && after.marks[0].id === 'z2');
}

// ── 4. 空书清一遍：不能报错、不能写坏文件 ─────────────────────────
{
  await seed('book-empty', [], []);
  const meta = await clearMarks(paths, 'book-empty', null);
  check('空书清全部：删 0 条', meta.__cleared.total === 0, JSON.stringify(meta.__cleared));
  const after = await readBookState(paths, 'book-empty');
  check('空书清全部：meta 仍可读', after && Array.isArray(after.marks));
}

// ── 5. 不存在的书：必须抛错，而不是静默成功 ──────────────────────
{
  let threw = false;
  try {
    await clearMarks(paths, 'book-nope', null);
  } catch {
    threw = true;
  }
  check('不存在的书：抛错（不静默成功）', threw);
}

/* ══════ 第二部分：HTTP 路由的参数校验 ═════════════════════════════ */

const httpSrc = await readFile(here + 'lib/http.js', 'utf8');
check('路由：/clear 已注册', httpSrc.includes("'/api/dsh-reader/clear'"));
check('路由：导入了 clearMarks', /import\s*\{[^}]*clearMarks/s.test(httpSrc));
check('路由：校验 from<=to', httpSrc.includes('to < from'));
check('路由：校验整数', httpSrc.includes('!Number.isInteger(from)'));
check('路由：返回删除数', httpSrc.includes('cleared'));

/* ══════ 第三部分：前端语义 ═══════════════════════════════════════ */

const clientSrc = await readFile(here + 'client.js', 'utf8');
check('前端：clearMarks API 存在', clientSrc.includes("clearMarks: (id, range) => api.post('/clear'"));
check('前端：null 显式传递', clientSrc.includes("range === null ? { id, range: null }"));
check('前端：组带页码区间', clientSrc.includes('range: hit && hit.chapter.pages'));
// 差一位：框架 pages 1 起 → 组 range 0 起。
// 检查两处：from 与 to 都必须减 1（只减一处就是典型的半修 bug）
check('前端：组区间 from 做了 -1 换算', clientSrc.includes('from: Math.max(0, hit.chapter.pages[0] - 1)'));
check('前端：组区间 to 也做了 -1 换算',
  clientSrc.includes('hit.chapter.pages[1] == null ? hit.chapter.pages[0] : hit.chapter.pages[1]) - 1'));
check('前端：两段式确认态存在', clientSrc.includes('confirmClear'));
check('前端：清除全部按钮存在', clientSrc.includes("'清除全部'"));
check('前端：清除本章按钮存在', clientSrc.includes("'清除本章'"));
check('前端：未分章组不给清除入口', clientSrc.includes('group.range\n                        ? confirmClear'));

/* ══════ 第四部分：清除后的 UI 渲染 ═══════════════════════════════ */

const start = clientSrc.indexOf('factory(require) {');
const end = clientSrc.lastIndexOf('},\n});');
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = clientSrc.slice(start + 'factory(require) {'.length, end);
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

/**
 * 加载 NotesTab，可把 `confirmClear` 的初值注入成某个确认态。
 *
 * 为什么需要：假 React 的 `useState` setter 是空函数，点按钮不会改变状态。
 * 要验「确认态下的界面 + 点确定后实际传出去的 range」，只能从初值注入进去。
 * 这也是唯一能在 Node 里测「破坏性操作的最终参数」的办法。
 */
function loadNotesTab(confirmInit) {
  let hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);
  if (confirmInit !== undefined) {
    const from = 'const [confirmClear, setConfirmClear] = useState(null);';
    const to = 'const [confirmClear, setConfirmClear] = useState(' + JSON.stringify(confirmInit) + ');';
    if (!hooked.includes(from)) {
      console.log('❌ 没找到 confirmClear 的 useState 声明，形状变了');
      process.exit(1);
    }
    hooked = hooked.replace(from, to);
  }
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
  const FRAMEWORK = {
    data: {
      parts: [{ name: '第三段', question: 'q', transition: '', chapters: [
        { no: null, title: '算力', gist: 'g', pages: [192, 212] },
      ] }],
    },
  };
  const marks = [mk('a', 200, '算力里的标注')];
  const NotesTab = loadNotesTab();
  const noop = () => {};
  const tree = NotesTab({
    marks, notes: [], page: 200, framework: FRAMEWORK,
    onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop, onClearMarks: noop,
  });

  // ── 核心：点「确定」之后，**实际传给 onClearMarks 的 range 是什么** ──
  //
  // 这是破坏性操作唯一真正要紧的断言。做法：把确认态直接注入成
  // 「第 9 章待确认」，再在渲染出来的元素树里找「确定」按钮，真调用它的 onClick，
  // 从 spy 里读到 host 会收到的参数。
  {
    const noop2 = () => {};
    const captured = [];
    const WithConfirm = loadNotesTab({
      scope: 'chapter-key',
      range: { from: 191, to: 211 },
      count: 3,
    });
    // 组的 key 是章节标题（'算力'）
    const Confirmed = loadNotesTab({
      scope: '算力',
      range: { from: 191, to: 211 },
      count: 1,
    });
    const treeConfirmed = Confirmed({
      marks, notes: [], page: 200, framework: FRAMEWORK,
      onGotoMark: noop2, onSaveNote: noop2, onDeleteMark: noop2, onMarkNote: noop2,
      onClearMarks: (r) => captured.push(r),
    });

    // 确认态下应出现「确定」「取消」两个按钮，且是 is-danger
    const dangerBtns = walk(treeConfirmed).filter(
      (n) => n.type === 'button' && (n.props.className || '').includes('is-danger'),
    );
    check('确认态：出现红色「确定」按钮', dangerBtns.length >= 1, dangerBtns.length);

    // 真调用 onClick
    const okBtn = dangerBtns.find((n) => textOf(n) === '确定');
    check('确认态：找到「确定」按钮', Boolean(okBtn));
    if (okBtn) okBtn.props.onClick();
    check('确认态：传给 onClearMarks 的是 [191,211]',
      captured.length === 1 && captured[0].from === 191 && captured[0].to === 211,
      JSON.stringify(captured));
    check('确认态：就是第 9 章的页码区间（0 起）',
      captured[0] && captured[0].from === 192 - 1 && captured[0].to === 212 - 1);
  }

  // ── 不注入确认态，直接验「点清除本章后，确认态里存的 range 对不对」 ──
  //
  // 上面那组是**注入** range 再点确定，等于绕过了换算环节。
  // 这里改从「清除本章」按钮的 onClick 走一遍真实路径：
  // 把 setConfirmClear 换成会存值的假 setter。
  {
    // 换一个会保存值的 useState：只对 confirmClear 那个 state 生效
    const saved = [];
    const capturingReact = () => ({
      createElement: (type, props, ...kids) =>
        typeof type === 'function' ? type(props || {}) : { type, props: props || {}, kids: kids.flat() },
      Fragment: Symbol('fragment'),
      useState: (init) => {
        const value = typeof init === 'function' ? init() : init;
        // 用「初值是 null 且后续被 set 成带 scope 的对象」这个特征无法区分，
        // 所以统一存进 saved：只要 setter 被调用过就记下来。
        return [value, (next) => { saved.push(next); }];
      },
      useRef: (init) => ({ current: init }),
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useEffect: () => {},
    });
    const hookedNoInject = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);
    const f2 = (0, eval)('(function(require){\n' + hookedNoInject + '\n})');
    f2((n) => {
      if (n === 'react') return capturingReact();
      throw new Error('unexpected require: ' + n);
    });
    const NotesTab2 = globalThis.__dr.NotesTab;
    const noop4 = () => {};
    const treePlain = NotesTab2({
      marks, notes: [], page: 200, framework: FRAMEWORK,
      onGotoMark: noop4, onSaveNote: noop4, onDeleteMark: noop4, onMarkNote: noop4, onClearMarks: noop4,
    });
    const chapterBtn = walk(treePlain).find(
      (n) => n.type === 'button' && textOf(n) === '清除本章',
    );
    check('真实路径：找到「清除本章」按钮', Boolean(chapterBtn));
    if (chapterBtn) chapterBtn.props.onClick();
    // 最后一次 set 一定是「点清除本章」产生的确认态
    const last = saved.filter((x) => x && typeof x === 'object' && 'range' in x).pop();
    check('真实路径：确认态带 range', Boolean(last), JSON.stringify(saved));
    check('真实路径：range 是 [191,211]（1 起 [192,212] 换算而来）',
      last && last.range && last.range.from === 191 && last.range.to === 211,
      JSON.stringify(last && last.range));
    check('真实路径：range 未越界到第 213 页',
      last && last.range && last.range.to < 212, JSON.stringify(last && last.range));
  }

  // 全部清除的确认态：传给 onClearMarks 的必须是 null（不是 {from:0,...}）
  {
    const captured = [];
    const ConfirmedAll = loadNotesTab({ scope: 'all', range: null, count: 2 });
    const noop3 = () => {};
    const treeAll = ConfirmedAll({
      marks, notes: [], page: 200, framework: FRAMEWORK,
      onGotoMark: noop3, onSaveNote: noop3, onDeleteMark: noop3, onMarkNote: noop3,
      onClearMarks: (r) => captured.push(r),
    });
    const ok = walk(treeAll).find(
      (n) => n.type === 'button' && textOf(n) === '确定清除',
    );
    check('清全部确认态：「确定清除」按钮存在', Boolean(ok));
    if (ok) ok.props.onClick();
    check('清全部确认态：传的是 null（不是区间对象）',
      captured.length === 1 && captured[0] === null, JSON.stringify(captured));
  }

  check('UI：有「清除全部」按钮', textOf(tree).includes('清除全部'));
  check('UI：有「清除本章」按钮', textOf(tree).includes('清除本章'));
  check('UI：清除按钮不是红色常态（无 is-danger 在未确认时）',
    byClass(tree, 'is-danger').length === 0);
}

// 未分章组（无框架）：不给「清除本章」
{
  const NotesTab = loadNotesTab();
  const noop = () => {};
  const tree = NotesTab({
    marks: [mk('b', 50, '无框架的标注')], notes: [], page: 50, framework: undefined,
    onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop, onClearMarks: noop,
  });
  check('UI：无框架时不给「清除本章」', !textOf(tree).includes('清除本章'));
  check('UI：无框架时「清除全部」仍在', textOf(tree).includes('清除全部'));
}

// 空书：一个清除入口都不给（没东西可清）
{
  const NotesTab = loadNotesTab();
  const noop = () => {};
  const tree = NotesTab({
    marks: [], notes: [], page: 0, framework: undefined,
    onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop, onClearMarks: noop,
  });
  check('UI：空书不给清除入口', !textOf(tree).includes('清除全部'));
}

// 清理临时目录
await rm(dir, { recursive: true, force: true });

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
