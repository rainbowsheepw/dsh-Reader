// 渲染冒烟回归：真的调用组件函数，让 V8 亲自报 TDZ / ReferenceError。
//
// ## 为什么必须有这个
//
// `node --check` 只验语法，验不出两类致命错误：
//   1. **暂时性死区（TDZ）**：`const` 在声明前被使用。事故现场是 ResizeObserver
//      那个 effect 的**依赖数组**里引用了还声明在后面的 `recompute`，
//      组件一渲染就 `ReferenceError: Cannot access 'recompute' before initialization`，
//      整个面板被卸载，用户看到「什么都看不到」。
//   2. **跨作用域引用**：在组件 A 里写了组件 B 的局部变量名。
//      事故现场见 scripts/scope-check.mjs 的注释（一标注就白屏）。
//
// ## 这一版补上的关键一条：**必须用非空数据渲染**
//
// 上一版所有用例都传 `marks: []`。而那次「一标注就白屏」的代码长这样：
//
//     marks.length > 0 && book && pageCount > 0 ? h(有的组件, …) : null
//
// `marks.length > 0` 为假 → 短路 → `book` 那一段**根本没被执行** →
// 冒烟检查全绿、用户一点就炸。所以用例表里每个组件都跑两遍：空数据 + **满数据**。
// 数据驱动的分支，只有喂了数据才走到。
//
// 用法：node scripts/render-smoke-check.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const src = await readFile(clientPath, 'utf8');

const start = src.indexOf('factory(require) {');
const end = src.lastIndexOf('},\n});');
if (start < 0 || end < 0) {
  console.log('❌ 没找到 factory 结构，源码形状变了');
  process.exit(1);
}
// factory 的 return 对象里那一行（源码里唯一）。用它当锚点最稳：
// `return {` 会匹配到十几个无关函数的内部，而 inject 的数组内容又会随版本变。
const INJECT_LINE = "      inject: ['slots'],";

const body = src.slice(start + 'factory(require) {'.length, end);

const EXPOSE = `      __expose: (() => {
        globalThis.__dr = { ReaderView, ContinuousPdf, PageCanvas, SidePanel, NewNoteBox, FrameworkTab, NotesTab, BookCard, ReaderPage, FrameworkCanvas, FrameworkGraph };
        return true;
      })(),
`;


if (!body.includes(INJECT_LINE)) {
  console.log('❌ 没找到 factory 的 inject 行，源码结构变了');
  process.exit(1);
}

/** 最小假 React：只提供组件求值时真正会碰到的钩子。 */
const makeReact = () => ({
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  Fragment: Symbol('fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
});

/**
 * 把组件挂出来。
 *
 * @param {boolean} withLayout - 是否让 `ContinuousPdf` 的 `layout` state 一开始就非空。
 *   关键：layout 为 null 时组件直接 return 一个 loading div，**渲染分支根本走不到**。
 *   上一版正是只测了「loading 态」，所以那条 `marks.length > 0 && book` 从未被执行。
 */
function load(withLayout) {
  let hooked = body.replace(INJECT_LINE, EXPOSE + INJECT_LINE);
  if (withLayout) {
    const fakeLayout = { width: 744, heights: Array(360).fill(1052), fit: 1 };
    const patched = hooked.replace(
      'const [layout, setLayout] = useState(null);',
      'const [layout, setLayout] = useState(' + JSON.stringify(fakeLayout) + ');',
    );
    if (patched === hooked) {
      console.log('❌ 没找到 layout state 声明，形状变了');
      process.exit(1);
    }
    hooked = patched;
  }
  const factory = (0, eval)('(function(require){\n' + hooked + '\n})');
  factory((name) => {
    if (name === 'react') return makeReact();
    throw new Error('unexpected require: ' + name);
  });
  const comps = globalThis.__dr;
  if (!comps) {
    console.log('❌ 钩子未执行，组件没挂出');
    process.exit(1);
  }
  return comps;
}

const fakePdf = {
  numPages: 360,
  getPage: async () => ({
    getViewport: ({ scale }) => ({
      width: 595 * scale,
      height: 842 * scale,
      transform: [1.5, 0, 0, -1.5, -30, 900],
    }),
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve() }),
  }),
};

/** 一条真实形状的标注：颜色、页面、页内偏移、原文、笔记齐全。 */
const MARK = {
  id: 'mark-1',
  page: 3,
  offset: 120,
  length: 48,
  text: '反向传播的核心是用链式法则把误差从输出层逐层传回。',
  color: 'amber',
  note: '这里是推导的关键一步，注意 Jacobian 的形状。',
  createdAt: 1,
  updatedAt: 1,
};

/** 一条真实形状的笔记。 */
const NOTE = {
  id: 'note-1',
  page: 3,
  text: '第 3 章看完：把梯度下降与反向传播串起来理解。',
  createdAt: 1,
  updatedAt: 1,
};

/** 一份生成完成的框架（4 段 12 章，带 transition 标签）。 */
const FRAMEWORK = {
  status: 'done',
  error: '',
  generatedAt: 1,
  data: {
    title: '《神经网络与深度学习》全书框架',
    overview: '从基础到前沿的四段式结构。',
    parts: [
      {
        name: '第一段 · 打地基',
        question: '机器怎么学？',
        transition: '',
        chapters: [
          { no: '第 2 章', title: '机器学习基础', gist: '把问题写成可优化的形式', pages: [1, 30], keyPoints: ['损失函数', '梯度下降'] },
          { no: '第 3 章', title: '线性模型', gist: '最简单的可学模型', pages: [31, 60], keyPoints: ['线性回归', '正则化'] },
          { no: '第 4 章', title: '前馈神经网络', gist: '堆叠线性变换', pages: [61, 90], keyPoints: ['激活函数', '万能逼近'] },
        ],
      },
      {
        name: '第二段 · 装上引擎',
        question: '怎么训练得动？',
        transition: '打基础',
        chapters: [
          { no: '第 5 章', title: '卷积神经网络', gist: '利用局部性与平移不变性', pages: [91, 130], keyPoints: ['卷积核', '池化'] },
          { no: '第 6 章', title: '循环神经网络', gist: '处理序列与记忆', pages: [131, 170], keyPoints: ['LSTM', '梯度消失'] },
          { no: '第 7 章', title: '网络优化与正则化', gist: '让训练真的收敛', pages: [171, 210], keyPoints: ['Adam', 'Dropout'] },
        ],
      },
      {
        name: '第三段 · 进入大模型',
        question: '怎么规模化？',
        transition: '装上引擎',
        chapters: [
          { no: '第 8 章', title: '注意力机制', gist: '让模型自己选择看哪里', pages: [211, 240], keyPoints: ['自注意力', '多头'] },
          { no: '第 9 章', title: 'Transformer', gist: '注意力的完整堆叠', pages: [241, 270], keyPoints: ['残差', '位置编码'] },
          { no: '第 10 章', title: '预训练模型', gist: '一次预训练，处处微调', pages: [271, 300], keyPoints: ['BERT', 'GPT'] },
        ],
      },
      {
        name: '第四段 · 望向物理与未来',
        question: '还能往哪走？',
        transition: '进入大模型',
        chapters: [
          { no: '第 11 章', title: '概率图模型', gist: '把不确定性写进结构', pages: [301, 330], keyPoints: ['贝叶斯网', 'EM'] },
          { no: '第 12 章', title: '生成模型', gist: '学会数据分布本身', pages: [331, 355], keyPoints: ['VAE', 'GAN'] },
          { no: '第 13 章', title: '深度强化学习', gist: '从奖励里学策略', pages: [356, 360], keyPoints: ['Q-learning', '策略梯度'] },
        ],
      },
    ],
  },
};

const spy = () => {};
const noop = () => {};

/** 组装一套「有内容」的 props；每项按组件需要挑。 */
const fullProps = {
  ContinuousPdf: {
    pdf: fakePdf,
    scale: 1.25,
    pageCount: 360,
    marks: [MARK],
    onMark: noop,
    onAsk: noop,
    initialPage: 3,
    onCurrentPage: noop,
    jumpToken: 0,
    jumpPage: 0,
    currentPage: 3,
    onFocusMark: noop,
    onDeleteMark: noop,
    onMarkNote: noop,
  },
  PageCanvas: {
    pdf: fakePdf,
    pageIndex: 3,
    scale: 1.25,
    width: 700,
    marks: [MARK],
    onBubble: noop,
    onCommitMark: noop,
    onAsk: noop,
  },
  SidePanel: {
    tab: 'notes',
    onTab: noop,
    book: { id: 'b1', title: '神经网络与深度学习', pages: 360, markCount: 1 },
    page: 3,
    pageCount: 360,
    framework: FRAMEWORK,
    marks: [MARK],
    notes: [NOTE],
    onGotoMark: noop,
    onSaveNote: noop,
    onDeleteMark: noop,
    onMarkNote: noop,
    onGenerateFramework: noop,
    onExpandFramework: noop,
    currentChapter: { part: FRAMEWORK.data.parts[0], chapter: FRAMEWORK.data.parts[0].chapters[0] },
  },
  NotesTab: { marks: [MARK], notes: [NOTE], page: 3, onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop },
  FrameworkTab: { framework: FRAMEWORK, currentChapter: undefined, onGotoMark: noop, onGenerate: noop, hasPdf: true },
  FrameworkCanvas: {
    framework: FRAMEWORK,
    currentChapter: undefined,
    onGotoMark: noop,
    onGenerate: noop,
    bookTitle: '神经网络与深度学习',
    page: 3,
    pageCount: 360,
    onCollapse: noop,
  },
  FrameworkGraph: { framework: FRAMEWORK.data, hereChapter: undefined, onJump: noop, height: 900 },
  NewNoteBox: { page: 3, onSave: noop, value: '', onChange: noop },
  BookCard: { book: { id: 'b1', title: '神经网络与深度学习', pages: 360, pages: 360, markCount: 1, progress: { page: 3, pct: 1.1 }, fileName: 'nndl-ge.pdf', framework: FRAMEWORK }, onOpen: noop, onRemove: noop },
  ReaderPage: { useSessions: undefined },
};

/** 空数据版本：把集合类字段清空，让「数据为空 → 提前 return」的分支也跑到。 */
const emptyProps = {
  ContinuousPdf: { ...fullProps.ContinuousPdf, marks: [] },
  PageCanvas: { ...fullProps.PageCanvas, marks: [] },
  SidePanel: { ...fullProps.SidePanel, marks: [], notes: [], framework: { status: 'none', data: null, error: '' } },
  NotesTab: { marks: [], notes: [], page: 3, onGotoMark: noop, onSaveNote: noop, onDeleteMark: noop, onMarkNote: noop },
  FrameworkTab: { framework: { status: 'none', data: null, error: '' }, currentChapter: undefined, onGotoMark: noop, onGenerate: noop, hasPdf: true },
  FrameworkCanvas: { ...fullProps.FrameworkCanvas, framework: { status: 'none', data: null, error: '' } },
  FrameworkGraph: { framework: undefined, hereChapter: undefined, onJump: noop, height: 900 },
};

let failed = 0;
let passed = 0;

function run(comps, name, props, label) {
  const fn = comps[name];
  if (typeof fn !== 'function') {
    console.log('❌ 缺组件 ' + name);
    failed += 1;
    return;
  }
  try {
    fn(props);
    passed += 1;
    console.log('ok   ' + label);
  } catch (error) {
    failed += 1;
    console.log('❌ ' + label + '：' + error.constructor.name + ': ' + error.message);
    for (const frame of (error.stack || '').split('\n').slice(1, 4)) console.log('   ' + frame.trim());
  }
}

// ── 第一轮：loading 态（layout 为 null），空数据 ──────────────────────
const loadingComps = load(false);
for (const name of ['ContinuousPdf', 'ReaderPage', 'PageCanvas']) {
  const props = name === 'ReaderPage' ? { useSessions: undefined } : emptyProps[name];
  run(loadingComps, name, props, name + ' [loading 态 / 空数据]');
}

// ── 第二轮：layout 就绪 + **有数据**（真正的渲染分支）────────────────
//
// 这一轮才是关键：`marks` 非空时才会走到 `marks.length > 0 && …` 那段，
// `book` / `page` / `removeMark` 这些被错写的名字才会真的被求值。
const readyComps = load(true);
run(readyComps, 'ContinuousPdf', fullProps.ContinuousPdf, 'ContinuousPdf [就绪 / 1 条标注]');
run(readyComps, 'ContinuousPdf', emptyProps.ContinuousPdf, 'ContinuousPdf [就绪 / 无标注]');
run(readyComps, 'PageCanvas', fullProps.PageCanvas, 'PageCanvas [就绪 / 1 条标注]');
run(readyComps, 'PageCanvas', emptyProps.PageCanvas, 'PageCanvas [就绪 / 无标注]');

// ── 第三轮：其余面板组件，有数据 + 空数据两遍 ────────────────────────
const others = ['SidePanel', 'NotesTab', 'FrameworkTab', 'FrameworkCanvas', 'FrameworkGraph', 'NewNoteBox', 'BookCard'];
for (const name of others) {
  if (fullProps[name]) run(readyComps, name, fullProps[name], name + ' [有数据]');
  if (emptyProps[name]) run(readyComps, name, emptyProps[name], name + ' [空数据]');
}

// ── 第四轮：框架图的三个侧栏页签都点一遍 ─────────────────────────────
// 页签只剩两个：「读到哪」已并入「整体框架」。
// 'where' 仍然测一遍 —— 它是**旧状态的兼容路径**，必须被当作 framework 处理，
// 否则会渲染出没有页签高亮的面板（或直接崩）。
for (const tab of ['framework', 'where', 'notes']) {
  run(readyComps, 'SidePanel', { ...fullProps.SidePanel, tab }, 'SidePanel [tab=' + tab + ']');
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
