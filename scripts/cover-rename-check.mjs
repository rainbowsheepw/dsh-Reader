// 封面 + 重命名回归。
// 用法：node scripts/cover-rename-check.mjs
//
// 对应用户的两个诉求：
//   ① 「每本书应该有自己的封面，封面就读取书的第一页」
//   ② 「书名应该也能随时重命名」
//
// 封面有一个**硬约束**必须先断：宿主侧 Node 没有 canvas 模块，
// pdf.js 的 page.render() 跑不起来 → 封面只能在浏览器渲染后上传。
// 若哪天有人改成"服务端渲染"，这条断言会告诉他为什么不行。

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  MAX_COVER_BYTES,
  MAX_TITLE_LENGTH,
  hasCover,
  listBooks,
  readBookState,
  readCover,
  renameBook,
  saveCover,
} from '../lib/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const HTTP = readFileSync(join(HERE, '..', 'lib', 'http.js'), 'utf8');
const STORE = readFileSync(join(HERE, '..', 'lib', 'store.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log('ok   ' + name);
  } else {
    fail += 1;
    console.log('❌ ' + name + (detail ? '  → ' + detail : ''));
  }
};

const ID = 'covertest0000000000000000000000';

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'dr-cover-'));
  return { dir, libraryDir: join(dir, 'library') };
}

function seedBook(paths, extra = {}) {
  mkdirSync(join(paths.libraryDir, ID), { recursive: true });
  writeFileSync(
    join(paths.libraryDir, ID, 'meta.json'),
    JSON.stringify({
      id: ID,
      title: '原名',
      fileName: 'orig.pdf',
      format: 'pdf',
      pages: 120,
      progress: { page: 5, pct: 4, updatedAt: 0, scale: 1.6 },
      marks: [],
      notes: [],
      framework: { status: 'none', generatedAt: 0, data: null, error: '' },
      ...extra,
    }),
  );
}

/* ══════ A. 重命名：行为 ═════════════════════════════════════════════ */
{
  const paths = tempPaths();
  seedBook(paths);
  const state0 = await readBookState(paths, ID);
  check('A 初始书名', state0.title === '原名', state0.title);

  const next = await renameBook(paths, ID, '  深度  学习  ');
  check('A 重命名成功', next === '深度 学习', String(next));

  const state1 = await readBookState(paths, ID);
  check('A 读回是新名字', state1.title === '深度 学习', state1.title);
  // 原始文件名是溯源信息，绝不能跟着改 —— 否则用户再也认不出这本书从哪来
  check('A fileName 保持不变（溯源）', state1.fileName === 'orig.pdf', state1.fileName);
  // 重命名不能碰阅读进度与缩放
  check('A 重命名不影响进度', state1.progress.page === 5, String(state1.progress.page));
  check('A 重命名不影响缩放', state1.progress.scale === 1.6, String(state1.progress.scale));

  check('A 空名被拒', (await renameBook(paths, ID, '   ')) === undefined);
  check('A 只有空白的名字被拒', (await renameBook(paths, ID, '\t\n ')) === undefined);
  check('A 超过上限被拒',
    (await renameBook(paths, ID, 'x'.repeat(MAX_TITLE_LENGTH + 1))) === undefined);
  check('A 恰好等于上限允许',
    (await renameBook(paths, ID, 'y'.repeat(MAX_TITLE_LENGTH))) === 'y'.repeat(MAX_TITLE_LENGTH));
  check('A 不存在的书返回 undefined',
    (await renameBook(paths, 'nosuchbook00000000000000000', '新名')) === undefined);

  // 列表里也要是新名字（书架直接读这个）
  const listed = await listBooks(paths);
  check('A 书架列表显示新名字',
    listed[0] && listed[0].title === 'y'.repeat(MAX_TITLE_LENGTH), listed[0] && listed[0].title);
  rmSync(paths.dir, { recursive: true, force: true });
}

/* ══════ B. 封面：读写与校验 ═════════════════════════════════════════ */
{
  const paths = tempPaths();
  seedBook(paths);

  check('B 初始无封面', (await hasCover(paths, ID)) === false);
  check('B 无封面时 readCover 返回 undefined', (await readCover(paths, ID)) === undefined);
  check('B listBooks 初始 hasCover=false',
    (await listBooks(paths))[0].hasCover === false);

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check('B 存封面成功', (await saveCover(paths, ID, png)) === true);

  const back = await readCover(paths, ID);
  check('B 读回封面字节数一致', back && back.length === png.length, back && back.length);

  check('B 存后 hasCover=true', (await hasCover(paths, ID)) === true);
  check('B listBooks 反映 hasCover=true', (await listBooks(paths))[0].hasCover === true);

  check('B 空字节被拒', (await saveCover(paths, ID, new Uint8Array(0))) === false);
  check('B 超过 2MB 被拒',
    (await saveCover(paths, ID, new Uint8Array(MAX_COVER_BYTES + 1))) === false);
  check('B 恰好 2MB 允许',
    (await saveCover(paths, ID, new Uint8Array(MAX_COVER_BYTES))) === true);

  // 覆盖写：重新上传要能替换旧图（重新导入/换页生成时会发生）
  const png2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  check('B 覆盖写成功', (await saveCover(paths, ID, png2)) === true);
  const back2 = await readCover(paths, ID);
  check('B 覆盖后是新图', back2 && back2.length === png2.length, back2 && back2.length);

  check('B 封面不影响 meta（进度还在）',
    (await readBookState(paths, ID)).progress.page === 5);
  rmSync(paths.dir, { recursive: true, force: true });
}

/* ══════ C. 路由：方法与路径合法 ═════════════════════════════════════
   Host 的 ConnectionFetchMethod 只允许 GET / HEAD / POST。
   用 PUT 注册会被**静默丢弃**（没有报错，请求永远打不到）。
   这条是踩过的坑，必须钉住。 */
{
  const methods = [...HTTP.matchAll(/methods: \[([^\]]+)\]/g)].map((m) => m[1]);
  const illegal = methods.filter((m) => /\b(PUT|DELETE|PATCH|OPTIONS)\b/.test(m));
  check('C 没有非法 HTTP 方法（只有 GET/HEAD/POST）',
    illegal.length === 0, illegal.join(' | '));

  check('C /cover 路由存在', HTTP.includes("path: '/api/dsh-reader/cover'"));
  check('C /rename 路由存在', HTTP.includes("path: '/api/dsh-reader/rename'"));

  // 封面读写必须**同一条**路由按 method 分派：拆成两条同 path 的注册，
  // 精确路径表的冲突行为没有文档保证。
  const coverRoutes = HTTP.match(/path: '\/api\/dsh-reader\/cover'/g) || [];
  check('C /cover 只注册一条（读写合并）', coverRoutes.length === 1,
    '注册了 ' + coverRoutes.length + ' 条');

  const coverBlock = (() => {
    const at = HTTP.indexOf("path: '/api/dsh-reader/cover'");
    return at < 0 ? '' : HTTP.slice(at, at + 1600);
  })();
  check('C 封面路由声明了 POST（用于上传）',
    coverBlock.includes("methods: ['GET', 'HEAD', 'POST']"), '方法声明不对');
  check('C 封面上传校验 Content-Type 为 image/png',
    coverBlock.includes('image/png'), '未校验类型');
  check('C 封面读取返回 image/png',
    coverBlock.includes("'Content-Type': 'image/png'"), '未声明响应类型');
}

/* ══════ D. 前端：封面生成在浏览器（不是服务端） ══════════════════════
   这个约束来自事实：Node 侧没有 canvas，pdf.js 的 render() 需要真绘图上下文。 */
{
  check('D 有 renderCoverBlob（浏览器端渲染）',
    CLIENT.includes('async function renderCoverBlob('), '未找到');
  check('D 用 canvas.toBlob 导出 PNG',
    CLIENT.includes("canvas.toBlob(") && CLIENT.includes("'image/png'"), '未导出 PNG');
  check('D 只渲染第一页（getPage(1)）',
    CLIENT.includes('doc.getPage(1)'), '未取第一页');
  check('D 渲染后销毁文档（不泄漏句柄）',
    /finally[\s\S]{0,120}doc\.destroy\(\)/.test(CLIENT), '未销毁');
  check('D 铺白底（PDF 页面透明，否则 PNG 是黑底）',
    CLIENT.includes("context.fillStyle = '#ffffff'"), '未铺白底');
  check('D 封面字节上限与 store 对齐',
    CLIENT.includes('COVER_MAX_BYTES = 2 * 1024 * 1024') &&
      STORE.includes('MAX_COVER_BYTES = 2 * 1024 * 1024'),
    '两处不一致');

  // 补生成必须串行（并发会卡死主线程）
  check('D 补生成是串行循环（不是 Promise.all）',
    /for \(const book of missing\)/.test(CLIENT), '未串行');
  check('D 补生成有重入保护（避免 effect 反复触发）',
    CLIENT.includes('coveringRef.current'), '无重入保护');
  check('D 单本失败不中断后续',
    /catch \{[\s\S]{0,80}\/\/ 单本上传失败/.test(CLIENT), '未隔离单本失败');
}

/* ══════ E. 前端：接线 ═══════════════════════════════════════════════ */
{
  check('E 书架卡片用真封面图', CLIENT.includes("className: 'dr-cover-img'"));
  check('E 有图时不再盖标题文字（会遮住封面）',
    /hasCover && !coverFailed \? null : h\('div', \{ className: 'dr-cover-title' \}/.test(CLIENT),
    '有图时仍渲染标题');
  check('E 图片加载失败回退到渐变占位',
    CLIENT.includes('onError: () => setCoverFailed(true)'));
  check('E 重命名走后端（api.renameBook）',
    CLIENT.includes('api.renameBook(book.id, title)'));
  check('E 重命名失败返回 false（卡片留在编辑态）',
    /return false;[\s\S]{0,40}\},[\s\S]{0,40}\[\],/.test(CLIENT) || CLIENT.includes('return false;'),
    '未返回失败');
  check('E 回车提交、Esc 取消',
    /e\.key === 'Enter'[\s\S]{0,120}commitRename\(\)/.test(CLIENT) &&
      CLIENT.includes("e.key === 'Escape'"),
    '键盘交互缺失');
  check('E 输入有最大长度限制',
    CLIENT.includes('maxLength: 80'), '未限制');
  check('E 重命名局部更新列表（不整表刷新闪烁）',
    /setBooks\(\(prev\) =>\s*\n\s*prev\.map\(\(item\) => \(item\.id === book\.id \? \{ \.\.\.item, title: result\.title \}/.test(CLIENT),
    '未局部更新');
  // 封面 URL 的拼接方式：必须用 & 追加参数，不能用 ?
  //
  // 这里踩过一个**极难发现**的坑：coverUrl() 已经返回 `/cover?id=xxx`，
  // 再加 `?v=` 就得到 `?id=xxx?v=nndl-ge`。浏览器把整个 `xxx?v=nndl-ge`
  // 当成 id，后端校验不过返回 400 —— 而 <img> 加载失败不抛异常，
  // 只触发一次 onError，卡片静默退回渐变占位。
  // 结果是「功能全对、界面全静、封面永远不出现」，控制台一行都不报。
  check('E 封面 URL 用 & 追加参数（不能用 ?，会得到双问号）',
    CLIENT.includes("api.coverUrl(book.id) + '&v='"),
    '用了 ? —— 会拼成 ?id=xxx?v=yyy，后端 400');
  check('E 封面 URL 没有 ?v= 的双问号写法',
    !CLIENT.includes("api.coverUrl(book.id) + '?v='"),
    '仍存在双问号拼接');
  check('E 封面 URL 带失效参数（重命名后不拿旧图）',
    CLIENT.includes("+ '&v=' + encodeURIComponent(book.title)"), '未带版本参数');
  check('E 卡片不再是 button 套 button',
    CLIENT.includes("className: 'dr-book-open'"), '未拆开');
}

/* ══════ G. 删书必须释放文档缓存 ═══════════════════════════════════════
   `book-text.js` 按 id 长期握着打开的 PDF 文档（问答切原文要用）。
   只删目录不清缓存 = 句柄与内存一直留着，反复导入/删除会稳定泄漏。
   `forgetDocument` 正是为此存在，但它曾经被 import 了却忘了调用 ——
   静态检查能发现"导入了没用"，而这里钉住"删书时确实调用了"。 */
{
  const deleteAt = HTTP.indexOf("path: '/api/dsh-reader/delete'");
  check('G 找到 delete 路由', deleteAt >= 0);
  if (deleteAt >= 0) {
    const block = HTTP.slice(deleteAt, deleteAt + 700);
    check('G 删书后调用 forgetDocument（释放 PDF 句柄）',
      /forgetDocument\(id\)/.test(block), '未调用 —— 会泄漏文档句柄');
    check('G forgetDocument 先删目录后清缓存',
      block.indexOf('deleteBook(paths, id)') < block.indexOf('forgetDocument(id)'),
      '顺序反了（先清缓存再删目录也能工作，但删失败时会白白丢掉缓存）');
  }
  // 反向：确认这个函数确实存在且被 import
  check('G http.js 导入了 forgetDocument',
    /import\s*\{[^}]*forgetDocument/.test(HTTP), '未导入');
}

/* ══════ F. 端到端：按前端真实的拼接方式取封面必须 200 ═══════════════
   上面 E 段是静态检查（断言字符串写法），这一段是**真跑**：
   复刻前端的 URL 拼法，交给真路由，看是否 200 且拿到 PNG。
   只有这一段能证明「用户真的能看到图」。 */
{
  const { makeRoutes } = await import('../lib/http.js');
  const { resolvePaths } = await import('../lib/paths.js');

  const paths = tempPaths();
  seedBook(paths);
  await saveCover(paths, ID, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const logger = { warn: () => {} };
  const routes = makeRoutes({ paths, logger });
  const cover = routes.find((r) => r.path === '/api/dsh-reader/cover');
  check('F 能找到 /cover 路由', Boolean(cover));

  if (cover) {
    const API_BASE = '/api/dsh-reader';
    const coverUrl = (id) => API_BASE + '/cover?id=' + encodeURIComponent(id);

    // ① 前端现在的写法（&）
    const good = 'http://x' + coverUrl(ID) + '&v=' + encodeURIComponent('书名').slice(0, 24);
    const goodRes = await cover.fetch(new Request(good, { method: 'GET' }), {});
    check('F 前端拼接（&）取封面得 200', goodRes.status === 200, 'HTTP ' + goodRes.status);
    check('F 响应是 image/png',
      goodRes.headers.get('content-type') === 'image/png',
      goodRes.headers.get('content-type'));

    // ② 旧写法（?）必须是 400 —— 钉住这个坑，防止有人"简化"回去
    const bad = 'http://x' + coverUrl(ID) + '?v=' + encodeURIComponent('书名').slice(0, 24);
    const badRes = await cover.fetch(new Request(bad, { method: 'GET' }), {});
    check('F 旧的双问号写法确实会 400（不是猜的）',
      badRes.status === 400, 'HTTP ' + badRes.status);
  }

  rmSync(paths.dir, { recursive: true, force: true });
}

console.log('\n' + pass + ' pass, ' + fail + ' fail');
if (fail > 0) process.exitCode = 1;
