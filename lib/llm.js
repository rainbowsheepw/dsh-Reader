/**
 * 宿主模型调用封装（AI 框架生成 / 选中提问）。
 *
 * 三条硬纪律：
 * 1. **不 import 任何 `@deepseek-ai/*` 包**。它们的 ESM 导出会随版本改名
 *    （参考实现就撞过 `CallId` → `ToolCallId` 的 import 期炸毁整个宿主），
 *    所以消息与 chunk 全按线上 JSON 形状手写。
 * 2. **服务只用 `ctx.get()` 取**，且读取放在 try/catch 里：cordis 对没写进 inject
 *    的服务是**抛异常**而不是给 undefined，`if (ctx.llm === undefined)` 自己会炸。
 * 3. **不依赖计时器**：沙箱里 `setTimeout` 是 trap，超时一律用 AbortSignal + 请求自身的
 *    生命周期（前端断开 = 停）。宿主侧不排任何后台任务。
 */

/** 结构化输出用的系统提示模板（框架生成）。 */
export const FRAMEWORK_SYSTEM = `你是阅读辅助专家。用户给你一本书的「页级结构信号」，你要还原这本书的整体框架，输出严格 JSON。

输出格式（只输出 JSON，不要任何解释、不要 markdown 代码围栏）：
{
  "title": "书名",
  "summary": "两三句话说明这本书是讲什么的、主线怎么走",
  "parts": [
    {
      "name": "第几部分/第几篇（若书没有分部，就整体当一部分，name 写「全书」）",
      "question": "这一部分回答的核心问题（一句话）",
      "transition": "从这一部分走到下一部分时，读者凭什么能往下走（2～5 个字，像「打基础」「进模型」这种短语）",
      "chapters": [
        { "index": 1, "title": "章标题", "pages": [起页, 止页], "gist": "这一章在讲什么（一句话）", "keyPoints": ["两个到四个关键概念"] }
      ]
    }
  ],
  "howToRead": ["三到五条这本书的读法建议，要具体，不要空话"]
}

判读纪律：
- 只依据给到的页级信号，不要凭书名想象内容；信号不足时宁可少写、也不要编造章节。
- \`pages\` 用信号里出现的真实页码（从 1 开始）；拿不准就给一个近似区间，不要留空。
- 章节标题用书里出现的原文，不要改写、不要润色。
- **\`transition\` 是图上箭头旁的那几个字**，要短、要像一个动作（「打基础」「装上引擎」「走向落地」），
  不要写成句子，不要写成"接下来我们讲..."。最后一部分没有下一部分，\`transition\` 留空串即可。
- 若这本书没有清晰章节结构（例如随笔、手册），就按页段聚合出 5～12 个主题单元，name 写「主题」。`;

/**
 * 陪读问答的系统提示。
 *
 * ## 三条设计决定
 *
 * 1. **位置由后端读出来，不是前端发上来**。
 *    提示里明确写「以下原文由你读到的文件中摘出」，让模型知道自己看的是真书内容，
 *    而不是用户粘贴的一段话 —— 后者它容易当成孤立的引文来泛泛点评。
 *
 * 2. **语气沿用阅读器里那位陪读的设定**：直接给结论、说人话、不铺垫。
 *    和「用户点名要什么语气」这类要求对齐 —— 语气是产品性格的一部分，
 *    不该因为换了入口（抽屉 → 侧栏）就变味。
 *
 * 3. **不确定就说不确定**。书里没有的不要编 —— 这条比语气重要，
 *    因为在读书场景里编造内容会直接把读者带偏。
 */
export const ASK_SYSTEM = `你是这本书的陪读导师，脾气有点毒舌、爱吐槽，但对内容极其负责。用户会给你一个位置（页码 + 选中区间），以及从这个位置读出来的原文与上下文。

回答纪律：
- **先给结论，第一段就说清楚**，不要铺垫、不要复述问题、不要"这个问题很好"。
- 说人话：把学术腔翻成日常表达；术语用书中上下文解释，必要时点明它在框架的哪一部分。
- 用户问「这段什么意思」时，先翻译成人话，再说它在这本书的论证里起什么作用。
- 用户问概念对比/推导时，分点讲清，必要时给一个最小例子。
- **不确定就直说不确定**，不要编造书里没有的内容。书里没有依据时明确说「书里没写」。
- 语气：可以有点欠揍的幽默感（比如吐槽这个概念的名字起得糟糕、或指出作者此处绕了个弯），
  但**不许拿用户本人开玩笑**，也不许在正经问题（错误排查、数据、失败原因）上耍贫。
- 用简体中文。可以用小标题和要点，但别写成长报告。`;

/**
 * 取宿主 llm 服务与默认模型路由。
 * @param {any} ctx - Host 插件上下文。
 * @returns {{llm:any, route:{provider:string, model:string}, reasoningEffort?:string}|undefined}
 */
export function resolveLlm(ctx) {
  const get = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  const llm = get('llm');
  if (!llm || typeof llm.prepareCall !== 'function' || typeof llm.stream !== 'function') return undefined;

  let route;
  try {
    const selection = get('agentDefaultModel')?.currentSelection?.();
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      route = { provider: selection.provider, model: selection.model };
      if (typeof selection.reasoningEffort === 'string') route.reasoningEffort = selection.reasoningEffort;
    }
  } catch {
    route = undefined;
  }
  if (!route) return undefined;
  return { llm, route };
}

/** 拼一条纯 user 消息（不带 id/source，符合 RequestUserInput 的形状）。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** 助手消息（多轮对话里的历史回答）。 */
function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

/**
 * 把「历史轮次」拼成模型消息数组。
 *
 * ## 为什么要做格式转换，而不是把历史塞进 prompt 字符串
 *
 * 塞进 prompt 的写法（「之前你回答过：…」）有三个问题：
 * - 模型分不清「哪些是它自己说的、哪些是用户说的」，容易复读或错认；
 * - 历史越长，单条消息越胖，某些 provider 会在超长单条上截断；
 * - 无法利用模型自带的对话结构（它本来就吃 messages 数组）。
 *
 * 所以这里转成真正的 role 序列。**只保留最近 N 轮**：
 * 读书问答常常一问就是十几轮，全带上会一路涨成本，而且早期内容对当前问题
 * 多半没用 —— 上下文本来就由后端按位置重新读，不依赖历史。 */
const MAX_HISTORY_TURNS = 8;

function toMessages(history, prompt) {
  const messages = [];
  if (Array.isArray(history)) {
    // 只取最后 MAX_HISTORY_TURNS 轮；每轮两条（user + assistant）
    const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);
    for (const turn of trimmed) {
      const role = turn && turn.role === 'assistant' ? 'assistant' : 'user';
      const text = turn && typeof turn.text === 'string' ? turn.text.trim() : '';
      if (text === '') continue;
      messages.push(role === 'assistant' ? assistantMessage(text) : userMessage(text));
    }
  }
  // 最后一条必须是用户的当前问题
  const last = typeof prompt === 'string' ? prompt.trim() : '';
  if (last !== '') messages.push(userMessage(last));
  return messages;
}

/**
 * 流式跑一次模型调用。
 *
 * @param {{llm:any, route:any}} handle - `resolveLlm` 的产物
 * @param {{system:string, prompt:string, history?:Array<{role:string,text:string}>,
 *   maxTokens?:number, signal?:AbortSignal, onDelta?:(t:string)=>void}} request
 * @returns {Promise<string>} 完整文本
 */
export async function streamText(handle, request) {
  const { llm, route } = handle;
  const call = await llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: request.maxTokens ?? 4096 },
    request.signal,
  );
  const options = {
    ...call.config,
    messages: toMessages(request.history, request.prompt),
    system: request.system,
    signal: request.signal,
  };
  let text = '';
  for await (const chunk of call.stream(options)) {
    if (request.signal?.aborted) break;
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      request.onDelta?.(chunk.text);
    } else if (chunk && chunk.type === 'finish') {
      const reason = chunk.reason;
      if (reason && typeof reason === 'object' && (reason.kind === 'error' || reason.kind === 'aborted')) {
        const message = reason.failure?.message ?? reason.kind;
        throw new Error('模型调用中断：' + message);
      }
    }
  }
  return text;
}

/**
 * 从模型输出里抠出 JSON（模型常带 ```json 围栏或前后废话）。
 * @param {string} raw
 * @returns {unknown}
 */
export function extractJson(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') throw new Error('模型没有返回内容');
  // 先试整体
  try {
    return JSON.parse(text);
  } catch {
    /* 落到下面的抠取 */
  }
  // 去掉围栏
  const fenced = text.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '');
  try {
    return JSON.parse(fenced);
  } catch {
    /* 落到花括号配对 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error('模型输出不是合法 JSON');
}

/**
 * 校验并收敛模型产出的框架（不信模型，字段逐个过）。
 * @param {any} raw
 * @returns {{title:string, summary:string, parts:Array<any>, howToRead:string[]}}
 */
export function normalizeFramework(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('框架不是对象');
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  const normalizedParts = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const chapters = [];
    for (const chapter of Array.isArray(part.chapters) ? part.chapters : []) {
      if (!chapter || typeof chapter !== 'object') continue;
      const title = typeof chapter.title === 'string' ? chapter.title.trim() : '';
      if (title === '') continue;
      const pages = Array.isArray(chapter.pages) ? chapter.pages : [];
      const start = Number.isFinite(pages[0]) ? Math.max(1, Math.trunc(pages[0])) : undefined;
      const end = Number.isFinite(pages[1]) ? Math.max(start ?? 1, Math.trunc(pages[1])) : undefined;
      chapters.push({
        index: Number.isFinite(chapter.index) ? Math.trunc(chapter.index) : chapters.length + 1,
        title,
        pages: start === undefined ? [] : end === undefined ? [start, start] : [start, end],
        gist: typeof chapter.gist === 'string' ? chapter.gist : '',
        keyPoints: Array.isArray(chapter.keyPoints)
          ? chapter.keyPoints.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 6)
          : [],
      });
    }
    if (chapters.length === 0) continue;
    // `transition`：图上跨段箭头旁边的那几个字。
    // 截到 16 个字符 —— 它是图的标签，不是句子；模型偶尔会写成一句话，这里替它收住。
    const transition =
      typeof part.transition === 'string' ? part.transition.trim().slice(0, 16) : '';
    normalizedParts.push({
      name: typeof part.name === 'string' && part.name.trim() !== '' ? part.name.trim() : `第 ${normalizedParts.length + 1} 部分`,
      question: typeof part.question === 'string' ? part.question : '',
      transition,
      chapters,
    });
  }
  if (normalizedParts.length === 0) throw new Error('模型没有给出任何章节，框架无效');
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    parts: normalizedParts,
    howToRead: Array.isArray(raw.howToRead)
      ? raw.howToRead.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 8)
      : [],
  };
}
