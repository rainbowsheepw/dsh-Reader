// 问答页签改造回归：多轮对话 + 输入框在底部。
//
// ## 这次的两条需求
//
// 1. 输入框从**顶部**移到**底部** —— 每问一次不必把视线往上拽回输入框。
// 2. 从单轮问答改成**可连问的对话** —— 上一轮的回答要成为下一轮的上下文。
//
 // ## 多轮最容易错的地方
//
 // 不是「有没有 history 字段」，而是：
 //   · 历史里混进 system 角色 → 能改写模型行为（必须拦）；
 //   · 历史无限增长 → 成本一路涨，且早期内容对当前问题多半没用（必须截断）；
 //   · 流式增量只写「最后一条助手消息」→ 若历史追加逻辑写错，会覆盖上一轮回答；
 //   · 用户那一问要**先**进列表（界面立刻有反馈），不能等模型返回才显示。
 //
 // 用法：DR_SAMPLE_PDF=/path/to.pdf node scripts/qa-multi-check.mjs

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

/* ══════ A. 结构：对话列表 + 输入在底 ═════════════════════════════════ */

{
  const at = clientSrc.indexOf('function AskTab(props)');
  const end = clientSrc.indexOf('/* ═══ 提问抽屉');
  const body = at >= 0 && end > at ? clientSrc.slice(at, end) : '';
  check('A 找到 AskTab', body.length > 0);

  if (body) {
    check('A 用 turns 数组存轮次', /const \[turns, setTurns\] = useState\(\[\]\)/.test(body), '未用数组');
    check('A 不再有单一 answer state', !/const \[answer, setAnswer\]/.test(body), '仍是单轮');
    check('A 有可滚动历史区', body.includes("className: 'dr-qa-scroll'"), '未找到历史区');
    check('A 有固定输入区', body.includes("className: 'dr-qa-composer'"), '未找到输入区');

    // 顺序：历史区必须在输入区**之前**（即输入在底部）
    const scrollIdx = body.indexOf("className: 'dr-qa-scroll'");
    const composerIdx = body.indexOf("className: 'dr-qa-composer'");
    check('A 历史区在输入区之前（输入在底部）', scrollIdx >= 0 && composerIdx > scrollIdx,
      scrollIdx + ' vs ' + composerIdx);
  }
}

/* ══════ B. 多轮请求：history 传上去并截断 ═══════════════════════════ */

{
  const at = clientSrc.indexOf('function AskTab(props)');
  const end = clientSrc.indexOf('/* ═══ 提问抽屉');
  const body = at >= 0 && end > at ? clientSrc.slice(at, end) : '';

  check('B 请求里带 history', body.includes('history: historyForRequest'), '未带 history');
  check('B 用户问题先进列表（不等模型）',
    /setTurns\(\(prev\) => \[...prev, userTurn/.test(body), '未先入列');
  check('B 提前追加空助手占位',
    // 用双引号串，避免在单引号串里转义单引号
    body.includes("{ role: 'assistant', text: '' }"), '未占位');

  // 流式增量必须写到最后一条助手消息，而不是覆盖整段
  check('B 流式增量追加到最后一条',
    body.includes('text: last.text + delta'),
    '未追加到最后一条');
  check('B 追加时校验最后一条是 assistant',
    /if \(!last \|\| last\.role !== 'assistant'\) return prev/.test(body),
    '未校验角色');

  // 引用快照：流式期间引用被改不能影响这一轮
  check('B 引用取快照', body.includes('refSnapshot'), '未取快照');
}

/* ══════ C. 后端：历史校验与截断 ═════════════════════════════════════ */

{
  const at = httpSrc.indexOf("path: '/api/dsh-reader/ask'");
  const end = httpSrc.indexOf('    },', httpSrc.indexOf('return ndjson(', at));
  const body = at >= 0 ? httpSrc.slice(at, end) : '';
  check('C 找到 ask 路由', body.length > 0);

  if (body) {
    check('C 解析 history', body.includes('body.history'), '未解析');
    // 关键：丢弃非 user/assistant 的角色（防 system 注入）
    check('C 丢弃 system 等非法 role',
      body.includes("turn.role === 'assistant'") && body.includes("turn.role === 'user'") &&
        body.includes('if (role === null) continue'),
      '未拦非法角色');
    check('C 历史条数截断', body.includes('.slice(-16)'), '未截断');
    check('C 单条 text 截断', body.includes('.slice(0, 2000)'), '未截断');
    check('C 空 text 跳过', body.includes("text.trim() === ''"), '未跳过');
    check('C 传给 streamText', body.includes('history,'), '未传');
  }
}

/* ══════ D. llm.js：历史转 role 序列 + 轮数上限 ═════════════════════ */

{
  check('D 有 toMessages 转换', llmSrc.includes('function toMessages'), '未实现');
  check('D 有 assistant 消息构造', llmSrc.includes('function assistantMessage'), '未实现');
  check('D 有轮数上限常量', /MAX_HISTORY_TURNS\s*=\s*\d+/.test(llmSrc), '未定义上限');
  check('D streamText 用 toMessages', llmSrc.includes('messages: toMessages('), '未使用');

  // 行为级：抽出 toMessages 真跑
  const at = llmSrc.indexOf('const MAX_HISTORY_TURNS');
  const end = llmSrc.indexOf('/**', llmSrc.indexOf('function toMessages') + 10);
  const chunk = at >= 0 ? llmSrc.slice(at, end > at ? end : llmSrc.length) : '';
  if (chunk) {
    const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
    const assistantMessage = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
    const fn = new Function('userMessage', 'assistantMessage', chunk + '\nreturn toMessages;')(userMessage, assistantMessage);

    // D1：正常两轮 + 当前问题
    const msgs = fn(
      [
        { role: 'user', text: '第一问' },
        { role: 'assistant', text: '第一答' },
      ],
      '第二问',
    );
    check('D1 历史转成 role 序列', msgs.length === 3, msgs.length);
    check('D1 角色顺序正确',
      msgs[0].role === 'user' && msgs[1].role === 'assistant' && msgs[2].role === 'user',
      msgs.map((m) => m.role).join(','));
    check('D1 内容正确', msgs[0].content[0].text === '第一问' && msgs[2].content[0].text === '第二问');

    // D2：最后一条必须是当前问题（不能被历史顶掉）
    check('D2 末条是当前问题', msgs[msgs.length - 1].content[0].text === '第二问');

    // D3：轮数上限生效
    const many = [];
    for (let i = 0; i < 30; i += 1) {
      many.push({ role: 'user', text: 'q' + i });
      many.push({ role: 'assistant', text: 'a' + i });
    }
    const capped = fn(many, 'current');
    const limitMatch = llmSrc.match(/MAX_HISTORY_TURNS\s*=\s*(\d+)/);
    const limit = limitMatch ? Number(limitMatch[1]) : 0;
    check('D3 历史被截断到 ' + limit + ' 轮以内', capped.length <= limit * 2 + 1, capped.length);
    check('D3 截断保留最近的内容', capped[0].content[0].text === 'q' + (30 - limit), capped[0].content[0].text);

    // D4：空历史
    const none = fn(undefined, '问');
    check('D4 无历史时只有一问', none.length === 1 && none[0].role === 'user', none.length);

    // D5：非法 role 被归一成 user（上游已拦，这里兜底）
    const weird = fn([{ role: 'system', text: '越权指令' }], '问');
    check('D5 非法 role 不成为 system',
      weird.every((m) => m.role !== 'system'), weird.map((m) => m.role).join(','));

    // D6：空 text 被跳过
    const blanks = fn([{ role: 'user', text: '' }, { role: 'assistant', text: '  ' }], '问');
    check('D6 空文本不产生空消息', blanks.length === 1, blanks.length);
  } else {
    check('D 能抽出 toMessages 段', false);
  }
}

/* ══════ E. 布局：问答页签父容器不滚（否则输入区会跑掉）════════════════ */

check('E 有 is-fixed-shell 容器类', clientSrc.includes('is-fixed-shell'), '未定义');
check('E 问答页签启用该模式', clientSrc.includes("tab === 'qa' ? ' is-fixed-shell'"), '未启用');
check('E fixed-shell 关掉父级滚动',
  /\.dr-side-body\.is-fixed-shell\{[^}]*overflow:hidden/.test(clientSrc), '未关滚动');
check('E fixed-shell 是 flex 列',
  /\.dr-side-body\.is-fixed-shell\{[^}]*flex-direction:column/.test(clientSrc), '未设列方向');
check('E 历史区自己滚', /\.dr-qa-scroll\{[^}]*overflow:auto/.test(clientSrc), '未滚');
check('E 输入区不滚', /\.dr-qa-composer\{[^}]*flex:none/.test(clientSrc), '未固定');

/* ══════ F. 交互手感 ═════════════════════════════════════════════════ */

{
  const at = clientSrc.indexOf('function AskTab(props)');
  const end = clientSrc.indexOf('/* ═══ 提问抽屉');
  const body = at >= 0 ? clientSrc.slice(at, end) : '';
  // 对话框手感：Enter 发送、Shift+Enter 换行
  check('F Enter 发送（无修饰键）',
    /e\.key === 'Enter' && !e\.shiftKey/.test(body), '未支持');
  check('F Shift+Enter 不发送', body.includes('!e.shiftKey'), '未排除');
  check('F 忙时按钮变停止', body.includes('dr-qa-send is-stop'), '未变');
  check('F 有清空对话', body.includes('clearTurns'), '未提供');
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
