// 标注笔记写入回归。
//
// ## 事故
//
// 用户：「无法写入标注的笔记，点击写入后用户界面感觉无效」。
//
// 查出来是**两个互相掩盖**的缺陷：
//
// ### 缺陷 1：路由校验无条件要求 `mark.text`
//
// 前端更新笔记时只发 `{id, note}`（原文没变，没必要重传整条），
// 而 `/mark` 路由**无条件**校验：
//
//     if (typeof mark.text !== 'string' || mark.text.trim() === '') {
//       return failJson(400, 'body-invalid', '标注没有原文，无法保存');
//     }
//
// → 每次「写笔记」必然 400。而 store 层的 `upsertMark` 本来就能正确更新 note
//（实测：直接调 store，note 写进去了）。所以坏的不是存储，是网关校验。
//
// ### 缺陷 2：失败在界面上不可见 + 草稿被丢弃
//
// `error` state 只在 `error && !pdf` 分支渲染 —— 那是「PDF 都载入失败」的整屏错误。
// 而写笔记时 PDF 早就载入成功了，所以**错误文案永远不显示**。
//
// 同时 `commitEdit` 是：
//     onMarkNote(mark, draft);   // 不 await
//     setEditing(null);          // 立刻关编辑器
//     setDraft('');              // 立刻清草稿
//
// 失败时：编辑器关了、草稿清了、界面没提示 → **用户写的内容直接消失**。
// 两个缺陷叠加，体验就是「点了写笔记，什么都没发生」。
//
 // 用法：node scripts/note-write-check.mjs

import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const clientSrc = await readFile(here + 'client.js', 'utf8');
const httpSrc = await readFile(here + 'lib/http.js', 'utf8');

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

/* ══════ A. HTTP 校验：更新不该要求原文 ═════════════════════════════ */

{
  const markRoute = (() => {
    const at = httpSrc.indexOf("path: '/api/dsh-reader/mark'");
    if (at < 0) return null;
    const end = httpSrc.indexOf('path:', at + 10);
    return httpSrc.slice(at, end < 0 ? httpSrc.length : end);
  })();

  check('A 找到 /mark 路由', Boolean(markRoute));

  if (markRoute) {
    // 必须区分「新建」与「更新」
    check('A 路由区分更新与新建', markRoute.includes('isUpdate'), '未找到 isUpdate');
    check('A 更新时不再强制要求 text',
      /!isUpdate\s*&&/.test(markRoute.replace(/\s+/g, ' ')),
      markRoute.match(/if \([^)]*text[^)]*\)/g)?.join(' | '));
    // 新建仍要有原文（否则会存进一条没有原文的空标注）
    check('A 新建仍校验原文非空',
      markRoute.includes("mark.text.trim() === ''"),
      '原文校验被整体删掉了');
    // deleteMarkId 分支要在前面，别被原文校验拦掉
    const delIdx = markRoute.indexOf('deleteMarkId');
    const textIdx = markRoute.indexOf('mark.text.trim()');
    check('A 删除分支先于原文校验', delIdx >= 0 && delIdx < textIdx, delIdx + ' vs ' + textIdx);
  }
}

/* ══════ B. store 层：确认它本来就支持只更新 note ═══════════════════ */

const { upsertMark, readBookState } = await import(here + 'lib/store.js');

{
  const dir = await mkdtemp(join(tmpdir(), 'dr-notewrite-'));
  const paths = { libraryDir: dir, bookDir: (id) => join(dir, id) };
  const id = 'book-nw-1';
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(
    join(dir, id, 'meta.json'),
    JSON.stringify({
      id, title: 'T', fileName: 'T.pdf', format: 'pdf', pages: 10, bytes: 1, createdAt: 1,
      progress: { page: 0, pct: 0, updatedAt: 0 },
      marks: [{ id: 'm1', page: 0, offset: 0, length: 5, text: '原文', color: 'amber', note: '', createdAt: 1, updatedAt: 1 }],
      notes: [],
      framework: { status: 'none', generatedAt: 0, data: null, error: '' },
    }),
  );

  // 前端更新时发的正是这种载荷（只有 id + note）
  const meta1 = await upsertMark(paths, id, { id: 'm1', note: '我的笔记' });
  const state1 = await readBookState(paths, id);
  check('B 只发 {id,note} 能写入', state1.marks[0].note === '我的笔记', JSON.stringify(state1.marks[0].note));
  check('B 原文未被覆盖', state1.marks[0].text === '原文', state1.marks[0].text);
  check('B 颜色未被清空', state1.marks[0].color === 'amber', state1.marks[0].color);

  // 改颜色（发 {id,color}）
  await upsertMark(paths, id, { id: 'm1', color: 'green' });
  const state2 = await readBookState(paths, id);
  check('B 只发 {id,color} 能改色', state2.marks[0].color === 'green', state2.marks[0].color);
  check('B 只发 {id,color} 不清空笔记', state2.marks[0].note === '我的笔记', state2.marks[0].note);

  // 清空笔记（空串）
  await upsertMark(paths, id, { id: 'm1', note: '' });
  const state3 = await readBookState(paths, id);
  check('B 空串能把笔记清掉', state3.marks[0].note === '', JSON.stringify(state3.marks[0].note));

  await rm(dir, { recursive: true, force: true });
}

/* ══════ C. 前端：错误可见 + 草稿不丢 ═══════════════════════════════ */

check('C 有独立的操作错误条（不只 PDF 失败那条）', clientSrc.includes("className: 'dr-err dr-err-bar'"));
check('C 错误条带关闭按钮', clientSrc.includes("className: 'dr-err-close'"));

// 错误条必须在 PDF 已载入的渲染路径里（而不是只在 error && !pdf 那个整屏分支）
{
  const mainRender = clientSrc.slice(clientSrc.indexOf("const title = book ? book.title"));
  check('C 错误条在 PDF 已载入路径中', mainRender.includes('dr-err-bar'));
}

// commitEdit 必须 await 结果
{
  const at = clientSrc.indexOf('const commitEdit = async (mark) => {');
  check('C commitEdit 是 async', at >= 0, '未找到');
  if (at >= 0) {
    const body = clientSrc.slice(at, clientSrc.indexOf('};', at) + 2);
    check('C commitEdit 里 await 了 onMarkNote', body.includes('await onMarkNote'), body.split('\n')[1]);
    check('C commitEdit 收到 false 就不关编辑器', body.includes('ok === false'), '未找到');
    // 关键：关闭与清空必须写在成功后
    const okIdx = body.indexOf('ok === false');
    const closeIdx = body.indexOf('setEditing(null)');
    check('C 先判成败再关编辑器', okIdx >= 0 && closeIdx > okIdx, okIdx + ' vs ' + closeIdx);
  }
}

// updateMark 必须返回成败
{
  const at = clientSrc.indexOf('const updateMark = useCallback(');
  check('C updateMark 存在', at >= 0);
  if (at >= 0) {
    const body = clientSrc.slice(at, clientSrc.indexOf('[bookId],', at));
    check('C 成功返回 true', body.includes('return true'), '未找到');
    check('C 失败返回 false', body.includes('return false'), '未找到');
    check('C 成功时清掉旧错误', body.includes("setError('')"), '未找到');
  }
}

// 保存中要禁用按钮
check('C 保存中有禁用态', clientSrc.includes('saving === mark.id'));
check('C 保存中显示「保存中…」', clientSrc.includes("'保存中…'"));

/* ══════ D. 行为：真跑 commitEdit，验「失败不丢草稿」══════════════════ */

{
  /**
   * 从源码抽出 commitEdit 的**函数体**（`{ ... }`）。
   *
   * 起点取 `=> {` 之后的那个 `{`，否则会把参数列表的括号一起卷进来。
   */
  function extractCommitBody(code) {
    const at = code.indexOf('const commitEdit = async (mark) => {');
    if (at < 0) return null;
    const brace = code.indexOf('{', code.indexOf('=>', at));
    if (brace < 0) return null;
    let depth = 0;
    for (let index = brace; index < code.length; index += 1) {
      const ch = code[index];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return code.slice(brace, index + 1);
      }
    }
    return null;
  }

  const body = extractCommitBody(clientSrc);
  check('D 能抽取 commitEdit 函数体', Boolean(body));
  if (body) {
    /**
     * 跑一次 commitEdit，返回「调用顺序」与「最终状态」。
     *
     * 抽出的函数体里引用了 setSaving / setEditing / setDraft / onMarkNote / saving / draft ——
     * 这些在组件里都是局部名，所以求值时全部作为参数注入。
     */
    async function runCommit(okValue, shouldThrow) {
      const calls = [];
      const state = { editing: 'm1', draft: '我的笔记', saving: null };
      const setSaving = (v) => { calls.push('setSaving:' + v); state.saving = v; };
      const setEditing = (v) => { calls.push('setEditing:' + v); state.editing = v; };
      const setDraft = (v) => { calls.push('setDraft:' + v); state.draft = v; };
      const onMarkNote = async () => {
        calls.push('onMarkNote');
        if (shouldThrow) throw new Error('网络断了');
        return okValue;
      };
      const fn = new Function(
        'setSaving', 'setEditing', 'setDraft', 'onMarkNote', 'saving', 'draft',
        'return (async (mark) => ' + body + ')({ id: "m1" });',
      );
      let threw = null;
      try {
        await fn(setSaving, setEditing, setDraft, onMarkNote, null, '我的笔记');
      } catch (error) {
        threw = error.message;
      }
      return { calls, state, threw };
    }

    // 成功
    const ok = await runCommit(true, false);
    check('D 成功：关闭编辑器', ok.state.editing === null, String(ok.state.editing));
    check('D 成功：清空草稿', ok.state.draft === '', JSON.stringify(ok.state.draft));
    check('D 成功：saving 复位', ok.state.saving === null, String(ok.state.saving));
    check('D 成功：先 onMarkNote 再关编辑器',
      ok.calls.indexOf('onMarkNote') < ok.calls.findIndex((c) => c.startsWith('setEditing:null')),
      ok.calls.join(' → '));

    // 失败（返回 false）——这是本次事故的核心场景
    const bad = await runCommit(false, false);
    check('D 失败：保留编辑器打开', bad.state.editing === 'm1', String(bad.state.editing));
    check('D 失败：保留草稿（用户写的不丢）', bad.state.draft === '我的笔记', JSON.stringify(bad.state.draft));
    check('D 失败：saving 已复位', bad.state.saving === null, String(bad.state.saving));
    check('D 失败：没有调用 setEditing(null)',
      !bad.calls.includes('setEditing:null'), bad.calls.join(' → '));

    // 抛异常（网络层失败）——同样不能丢草稿
    const thrown = await runCommit(true, true);
    check('D 抛异常：草稿仍在', thrown.state.draft === '我的笔记', JSON.stringify(thrown.state.draft));
    check('D 抛异常：编辑器仍开着', thrown.state.editing === 'm1', String(thrown.state.editing));
    check('D 抛异常：saving 仍复位（finally 生效）', thrown.state.saving === null, String(thrown.state.saving));
  }
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
