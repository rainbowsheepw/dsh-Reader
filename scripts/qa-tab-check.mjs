// 「问答」页签回归：位置传递 + 后端自读 + 语气设定。
//
// ## 这个需求的三条硬要求
//
// 1. **选中语句的「位置」也要一并传给 AI** —— 不只是文字。
// 2. **AI 收到位置后自行读取书文件** —— 原文必须由后端从 PDF 里读出来，
//    不能是前端把自己那份文字发上去充数。
// 3. **说话语气要和阅读器里的陪读一样** —— 语气是产品性格，换入口不该变味。
//
 // ## 为什么第 2 条必须验「后端真的在读」
 //
 // 如果只是前端把 quote 发给模型，功能看起来完全正常，但埋了一个致命隐患：
 // 客户端与文件一旦不同步（换书、或标注区间按旧逻辑记的），模型就会基于
 // 一段**并不存在于书里**的引文作答 —— 而用户完全看不出来。
 // 所以本脚本要证明 `readAt()` 真能按位置从 PDF 取到字，且它就是 /ask 用的那条路径。
 //
 // 用法：DR_SAMPLE_PDF=/path/to.pdf node scripts/qa-tab-check.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const clientSrc = await readFile(here + 'client.js', 'utf8');
const httpSrc = await readFile(here + 'lib/http.js', 'utf8');
const llmSrc = await readFile(here + 'lib/llm.js', 'utf8');

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

/* ══════ A. 侧栏页签与组件 ══════════════════════════════════════════ */

check('A 有 AskTab 组件', /function AskTab\(props\)/.test(clientSrc));
check('A 侧栏有「问答」页签', clientSrc.includes("onTab('qa')") && clientSrc.includes("'问答'"));
check('A 渲染分支接进 AskTab', clientSrc.includes('h(AskTab, {'));
// 多轮改造后，引用条从 .dr-qa-ref 换成 .dr-qa-chip（贴在输入框上方）
check('A 页签样式已定义', clientSrc.includes('.dr-qa{') && clientSrc.includes('.dr-qa-chip{'));

// 正文浮层必须有「送到问答」的入口，否则侧栏只能手工引用当前页
check('A 浮层有送到问答的按钮', clientSrc.includes('onSendToQA'));
check('A 送到问答时传的是位置',
  /onSendToQA\(\{[\s\S]{0,120}page: bubble\.page[\s\S]{0,80}offset: bubble\.offset[\s\S]{0,80}length: bubble\.length/.test(clientSrc),
  '未按位置传');

/* ══════ B. AskTab 发给后端的是位置，不是文字 ════════════════════════ */

{
  // 多轮改造后依赖数组也变了（多了 turns）
  const at = clientSrc.indexOf('const ask = useCallback(async () => {');
  const end = clientSrc.indexOf('}, [busy, question, ref, book, page, outline, turns]);', at);
  const body = at >= 0 && end > at ? clientSrc.slice(at, end) : '';
  check('B 找到 ask 回调', body.length > 0);

  if (body) {
    check('B 请求里带 id（后端据此找书）', body.includes('id: book && book.id'), body.slice(0, 200));
    // 多轮改造后改用「引用快照」refSnapshot（流式期间引用被改也不影响这一轮）
    check('B 请求里带 page',
      body.includes('page: refSnapshot ? refSnapshot.page : page'), body.slice(0, 220));
    check('B 请求里带 offset',
      body.includes('offset: refSnapshot ? refSnapshot.offset'), body.slice(0, 260));
    check('B 请求里带 length',
      body.includes('length: refSnapshot ? refSnapshot.length'), body.slice(0, 260));
    // 关键：前端**不**把自己那份 quote 发上去冒充原文
    check('B 请求里不发 quote 原文', !/\bquote\s*:/.test(body), '仍在发 quote');
  }
}

/* ══════ C. /ask 路由：按位置读盘 ════════════════════════════════════ */

{
  const at = httpSrc.indexOf("path: '/api/dsh-reader/ask'");
    const end = httpSrc.indexOf('    },', httpSrc.indexOf('return ndjson(', at));
  const body = at >= 0 ? httpSrc.slice(at, end < 0 ? httpSrc.length : end) : '';
  check('C 找到 /ask 路由', body.length > 0);

  if (body) {
    check('C 调用了 readAt', body.includes('await readAt(paths'), '未调用');
    check('C 传 page/offset/length 给 readAt',
      body.includes('offset: body.offset') && body.includes('length: body.length'),
      body.slice(body.indexOf('readAt'), body.indexOf('readAt') + 200));
    // 读盘结果必须覆盖客户端传的，否则客户端仍能左右原文
    check('C 读盘结果覆盖客户端 quote', /if \(info\.quote\) quote = info\.quote/.test(body), '未覆盖');
    check('C 读盘结果覆盖客户端 context', /if \(info\.context\) context = info\.context/.test(body), '未覆盖');
    // 读不出来时要降级而不是 500，并在提示词里说明来源
    check('C 读盘失败时降级（不中断提问）', body.includes('未能读取书文件'), '未降级');
    check('C 提示词里写明原文来源', body.includes('sourceNote'), '未说明来源');
    check('C 提示词里带选中区间', body.includes('选中区间'), '未带区间');
  }
}

/* ══════ C2. 行为级：读盘结果**真的**覆盖了客户端原文 ════════════════
   上面 C 段只验「源码里有 readAt 调用」—— 那是结构断言，
   把 `canRead` 改成 false（即彻底不读盘）也照样通过（实测过）。

   所以这里从源码抽出 /ask 里那段「先取客户端 quote，再尝试读盘覆盖」的逻辑，
   喂一个**故意错误**的客户端 quote，验最终用于提示词的 quote 到底是谁的。 */

{
  const at = httpSrc.indexOf("path: '/api/dsh-reader/ask'");
  const start = httpSrc.indexOf('let quote =', at);
  const end = httpSrc.indexOf('const outline =', start);
  const logic = start >= 0 && end > start ? httpSrc.slice(start, end) : null;
  check('C2 能抽出「取引用」的逻辑段', Boolean(logic));

  if (logic) {
    // 用一个假的 readAt：返回「真实原文」，与客户端传的假 quote 明显不同
    const REAL = '这是从书文件里读出来的真实原文';
    const FAKE = '这是客户端伪造的引文';
    // 注意：抽出的 logic 段**自己就声明了** quote/context/page/sourceNote。
    // 所以在外面重复声明会撞 `Identifier has already been declared`。
    // 直接接一段 return 即可。
    // 抽出的段里有 await，必须包在 async 函数里求值
    const run = new Function(
      'body', 'paths', 'isBookId', 'readAt',
      'return (async () => {\n' + logic + '\nreturn { quote, context, page, sourceNote };\n})();',
    );

    // 情形一：读盘成功 → 最终 quote 必须是**读盘**的结果
    const ok = await run(
      { id: 'abc12345book', page: 5, offset: 0, length: 10, quote: FAKE },
      {},
      () => true,
      async () => ({ quote: REAL, context: REAL + '（上下文）', page: 5, contextFrom: 4, contextTo: 6 }),
    );
    check('C2 读盘成功时用的是读出来的原文', ok.quote === REAL, ok.quote);
    check('C2 读盘成功时客户端原文被丢弃', ok.quote !== FAKE, ok.quote);
    check('C2 读盘成功时带上来源说明', ok.sourceNote.includes('从书文件中'), ok.sourceNote);

    // 情形二：读盘失败 → 必须降级用客户端原文，并**说明**来源
    const failed = await run(
      { id: 'abc12345book', page: 5, offset: 0, length: 10, quote: FAKE },
      {},
      () => true,
      async () => {
        throw new Error('ENOENT');
      },
    );
    check('C2 读盘失败时降级用客户端原文', failed.quote === FAKE, failed.quote);
    check('C2 读盘失败时说明来源', failed.sourceNote.includes('未能读取书文件'), failed.sourceNote);

    // 情形三：没有 id（前端没带书）→ 不尝试读盘，用客户端原文
    const noId = await run(
      { page: 5, quote: FAKE },
      {},
      () => false,
      async () => {
        throw new Error('不该被调用');
      },
    );
    check('C2 无 id 时不读盘', noId.quote === FAKE, noId.quote);
  }
}

/* ══════ C3. 导入完整性：用了 readAt 就必须 import ═════════════════════
   这次的线上 bug：改写脚本把 import { readAt } from './book-text.js' 弄丢了，
   而 node --check **只验语法**，查不出「用了未导入的变量」——
   直到用户在界面上点「提问」，看到模型回答里那句
   readAt is not defined。

   所以必须静态验：凡是在 http.js 里调用的跨模块函数，都要在 import 列表里。
   宿主沙箱没有全局兜底，未导入的标识符只在运行时才炸。 */

{
  const importLine = httpSrc.match(/import\s*\{[^}]*\}\s*from\s*'\.\/book-text\.js'/);
  check('C3 导入了 book-text 模块', Boolean(importLine), '缺 import 语句');
  if (importLine) {
    check('C3 导入里含 readAt', importLine[0].includes('readAt'), importLine[0]);
  }

  const usesReadAt = httpSrc.includes('await readAt(');
  const importsReadAt = Boolean(importLine && importLine[0].includes('readAt'));
  check('C3 用了就一定要导（本次 bug 的直接判据）',
    !usesReadAt || importsReadAt,
    usesReadAt && !importsReadAt ? '调用了 readAt 但没导入 → 运行时 is not defined' : '');
  check('C3 readAt 有实际调用', usesReadAt, '未调用');

  // 同类检查：store / llm 的关键导出也必须在 import 列表
  const storeImport = httpSrc.match(/import\s*\{[^}]*\}\s*from\s*'\.\/store\.js'/);
  check('C3 导入了 store 模块', Boolean(storeImport));
  if (storeImport) {
    for (const fn of ['clearMarks', 'upsertMark', 'editNote', 'addNote', 'deleteMark']) {
      check('C3 store 导入含 ' + fn, storeImport[0].includes(fn), storeImport[0].slice(0, 80));
    }
  }

  const llmImport = httpSrc.match(/import\s*\{[^}]*\}\s*from\s*'\.\/llm\.js'/);
  check('C3 导入了 llm 模块', Boolean(llmImport));
  if (llmImport) {
    for (const fn of ['ASK_SYSTEM', 'FRAMEWORK_SYSTEM', 'streamText']) {
      check('C3 llm 导入含 ' + fn, llmImport[0].includes(fn), llmImport[0].slice(0, 90));
    }
  }
}

/* ══════ D. 语气设定 ═════════════════════════════════════════════════ */

{
  const at = llmSrc.indexOf('export const ASK_SYSTEM');
  const end = llmSrc.indexOf('`;', at);
  const prompt = at >= 0 ? llmSrc.slice(at, end) : '';
  check('D 找到 ASK_SYSTEM', prompt.length > 0);

  if (prompt) {
    check('D 要求先给结论', prompt.includes('先给结论'), '缺');
    check('D 要求说人话', prompt.includes('说人话'), '缺');
    check('D 允许幽默但不许拿用户开玩笑',
      prompt.includes('幽默') && prompt.includes('不许拿用户本人开玩笑'), '缺约束');
    check('D 正经问题不许耍贫', prompt.includes('正经问题'), '缺');
    check('D 不确定就直说（不许编造）',
      prompt.includes('不确定就直说不确定') && prompt.includes('不要编造'), '缺');
    check('D 指定简体中文', prompt.includes('简体中文'), '缺');
    // 语气要有「毒舌/欠揍」这类具体词，否则模型会写成中性客服腔
    check('D 有时间性格描述（毒舌/欠揍）',
      prompt.includes('毒舌') || prompt.includes('欠揍'), '语气太中性');
  }
}

/* ══════ E. 真 PDF：readAt 能按位置取到字 ═════════════════════════════ */

const sample = process.env.DR_SAMPLE_PDF;
if (!sample) {
  console.log('跳过 E：设 DR_SAMPLE_PDF 指向一本真实 PDF 再跑');
} else {
  const { readAt } = await import(here + 'lib/book-text.js');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  // 用线上真实那本书（存在才测；不存在则跳过具体内容，只测机制）
  const libDir = join(homedir(), '.dsh', 'dsh-reader', 'library');
  const paths = { dir: join(homedir(), '.dsh', 'dsh-reader'), libraryDir: libDir };

  let bookId = null;
  try {
    const meta = JSON.parse(await readFile(join(libDir, '4a0a9faaee4c43b38f0d45d0', 'meta.json'), 'utf8'));
    bookId = meta.id;
  } catch {
    bookId = null;
  }

  if (!bookId) {
    console.log('跳过 E：本机没有已导入的书（' + libDir + '）');
  } else {
    // E1：给位置，必须能读到非空原文
    const info = await readAt(paths, bookId, { page: 190, offset: 107, length: 225, neighbor: 1 });
    check('E1 按位置读到原文', info.quote.length > 0, info.quote.length);
    check('E1 原文长度等于请求区间', info.quote.length === 225, info.quote.length);
    check('E1 读到了上下文', info.context.length > info.quote.length, info.context.length);

    // E2：同一位置重复调用，内容必须一致（docCache 不能把内容搞脏）
    const again = await readAt(paths, bookId, { page: 190, offset: 107, length: 225, neighbor: 1 });
    check('E2 重复读取内容一致（缓存未串味）', again.quote === info.quote);

    // E3：不同位置要读到不同内容（防「永远返回第一页」的假实现）
    const other = await readAt(paths, bookId, { page: 300, offset: 0, length: 120, neighbor: 0 });
    check('E3 不同页读到不同内容', other.quote !== info.quote);
    check('E3 页号正确回传', other.page === 300, other.page);

    // E4：越界页码被夹住，不崩
    const far = await readAt(paths, bookId, { page: 99999, offset: 0, length: 50, neighbor: 0 });
    check('E4 越界页码被夹到末页', far.page === far.total - 1, far.page + '/' + far.total);
    check('E4 越界时仍有内容', far.quote.length > 0 || far.pageText.length > 0);

    // E5：非法区间退化成页首，而不是抛错
    const bad = await readAt(paths, bookId, { page: 50, offset: 999999, length: 10, neighbor: 0 });
    check('E5 非法区间仍返回内容（不抛错）', bad.quote.length > 0, bad.quote.length);

    // E6：上下文确实包含相邻页
    check('E6 neighbor=1 时上下文跨 3 页范围',
      info.contextFrom === Math.max(0, info.page - 1) && info.contextTo === Math.min(info.total - 1, info.page + 1),
      info.contextFrom + '–' + info.contextTo);

    // E8：区间以**字符串**形式进来时也要正确（本次线上 bug 之一）
    //
    // 实测：Number.isFinite('1019') === false，于是判据整体失效 → 退化成页首，
    // 而界面预览显示的文字是对的 —— 用户看到的现象就是
    // 「引的文字没问题，但 AI 答的不是那段」。
    const strOffset = await readAt(paths, bookId, { page: 157, offset: '1019', length: '20', neighbor: 0 });
    check('E8 字符串 offset 也能精确切', strOffset.quote.length > 0 && strOffset.quote.length <= 200,
      strOffset.quote.slice(0, 40));
    check('E8 字符串 offset 不等于页首内容',
      !strOffset.quote.startsWith('7.10'),
      strOffset.quote.slice(0, 40));

    // E9：字符串页码不能取错页
    const strPage = await readAt(paths, bookId, { page: '157', offset: 1019, length: 20, neighbor: 0 });
    check('E9 字符串页码取到正确页', strPage.page === 157, strPage.page);

    // E10：数字与字符串两种写法必须得到**同一个结果**
    const numOffset = await readAt(paths, bookId, { page: 157, offset: 1019, length: 20, neighbor: 0 });
    check('E10 数字/字符串区间结果一致', numOffset.quote === strOffset.quote,
      JSON.stringify(numOffset.quote.slice(0, 20)) + ' vs ' + JSON.stringify(strOffset.quote.slice(0, 20)));

    check('E7 段落数合理（不会把整页拼成一串无分隔）', info.spanCount > 20, info.spanCount);
  }
}

/* ══════ F. Markdown 渲染（回答里的符号不能裸露）══════════════════════
   用户截图里的原话：「大模型的输出的显示也有问题，会有一些不明所以的符号」。
   原因是回答区用 CSS white-space:pre-wrap 直接倒纯文本，
   于是 **结论**、`readAt`、- 列表 这些 Markdown 记号原样显示。

   修法：写了个只覆盖问答场景的渲染器（client.js 里的 renderInline / renderMarkdown），
   并把 pre-wrap 去掉。本段验两件事：
     F1 过滤：能识别的记号必须变成真元素
     F2 不吞：不认识的语法要原样保留，**绝不能吃掉内容**
    F2 比 F1 重要 —— 渲染器宁可少渲染，也不能让用户看不到内容。 */

{
  // 抽出渲染器（只取这两个函数，避开组件依赖）
  const a = clientSrc.indexOf('    function renderInline(');
  const b = clientSrc.indexOf('    /* ═══ 侧栏「问答」页签');
  const code = a >= 0 && b > a ? clientSrc.slice(a, b) : null;
  check('F 能抽出渲染器', Boolean(code));

  if (code) {
    const makeH = (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat() });
    const factory = new Function('h', code + '\nreturn { renderInline, renderMarkdown };');
    const { renderMarkdown } = factory(makeH);

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
    const typesOf = (tree) => [...new Set(walk(tree).filter((n) => n.type).map((n) => n.type))];
    const BT = String.fromCharCode(96);

    // F1：记号变元素
    const rich = renderMarkdown(
      ['**粗体** 与 ' + BT + 'code' + BT, '', '- 甲', '- 乙', '', '### 小标题'].join('\n'),
    );
    const types = typesOf(rich);
    check('F1 **粗体** 渲染成 strong', types.includes('strong'), types.join(','));
    check('F1 反引号渲染成 code', types.includes('code'), types.join(','));
    check('F1 无序列表渲染成 ul/li', types.includes('ul') && types.includes('li'), types.join(','));
    check('F1 标题渲染成带 dr-md-h 的块',
      walk(rich).some((n) => typeof (n.props && n.props.className) === 'string' &&
        n.props.className.includes('dr-md-h')),
      types.join(','));

    // 渲染后文本里不该再有裸露记号
    const leaked = walk(rich)
      .filter((x) => typeof x === 'string')
      .filter((x) => x.includes('**') || x.includes(BT) || x.includes('###'));
    check('F1 渲染后无裸露记号', leaked.length === 0, leaked.join(' | '));

    // 分段：空行分段，单换行不分段（模型常在句中硬换行）
    const para = renderMarkdown(['第一句', '第二句在同一段', '', '新段落'].join('\n'));
    const ps = walk(para).filter((n) => n.type === 'p');
    check('F1 空行分成 2 段（单换行不切段）', ps.length === 2, ps.length);
    check('F1 同段内单换行被合并', textOf(ps[0]).includes('第一句') && textOf(ps[0]).includes('第二句'),
      textOf(ps[0]));

    // F2：不认识的语法要原样保留
    const unknown = renderMarkdown(['| 列1 | 列2 |', '|---|---|', '| a | b |'].join('\n'));
    check('F2 表格语法原样保留（不吞内容）',
      textOf(unknown).includes('列1') && textOf(unknown).includes('列2'),
      textOf(unknown));
    check('F2 竖线仍在（未被当成语法吃掉）', textOf(unknown).includes('|'), textOf(unknown));

    // F2：空输入不炸
    check('F2 空串返回 null/空', renderMarkdown('') == null || renderMarkdown('').length === 0);
    check('F2 纯空白不炸', Array.isArray(renderMarkdown('   ') || []) || true);

    // F2：超长单行不炸，且内容完整
    const longLine = '甲'.repeat(500);
    const longTree = renderMarkdown(longLine);
    check('F2 超长行内容完整', textOf(longTree).length === 500, textOf(longTree).length);

    // 有序列表
    const olTree = renderMarkdown(['1. 甲', '2. 乙'].join('\n'));
    const ol = walk(olTree).find((n) => n.type === 'ol');
    check('F1 有序列表是 ol 且 2 项', ol && ol.kids.length === 2, ol ? ol.kids.length : '无');
  }

  // 所有回答渲染点都必须走渲染器，且不能再有 pre-wrap（会让 ** 等符号漏出来）。
  // 抽屉删掉之后，「抽屉也走渲染器」这条断言失去对象：它查的字符串与上一条相同，
  // 两条一起变红只会误导。现在改为断「渲染点数量」与「都在正确的容器里」。
  check('F 问答页签走 renderMarkdown',
    /renderMarkdown\(turn\.text\)/.test(clientSrc), '未在多轮消息里渲染');
  check('F 抽屉已移除（不再有第二个渲染组件）',
    !clientSrc.includes('function AskDrawer('), '抽屉仍然存在');
  check('F 多轮消息也走 renderMarkdown',
    /renderMarkdown\(turn\.text\)/.test(clientSrc), '未在 turns 渲染里使用');
  check('F 用户消息不走 Markdown（原样显示）',
    !/renderMarkdown\(turn\.text\)\s*:\s*turn\.text/.test(clientSrc) === false ||
      clientSrc.includes("turn.role === 'assistant'"), '未区分角色');
  check('F 回答区不再用 white-space:pre-wrap',
    !/\.dr-qa-answer\{[^}]*white-space:pre-wrap/.test(clientSrc),
    '仍保留 pre-wrap（会把源码换行与分段冲突）');
  check('F 抽屉回答区不再用 pre-wrap',
    !/\.dr-ask-body\{[^}]*white-space:pre-wrap/.test(clientSrc));
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
