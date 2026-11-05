// 缩放倍数持久化回归：读回 / 写入 / 不互相覆盖 / 边界夹紧。
// 用法：node scripts/scale-persist-check.mjs
//
// 这一组断言对应用户的一个真实诉求：
//   「pdf 阅读的缩放倍数应该有记忆，下次打开的时候和上次的倍数一样」
// 所以每条都必须是**行为**断言 —— 结构断言证明不了「下次打开还是 1.8」。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { readBookState, saveProgress, MIN_SCALE, MAX_SCALE } from '../lib/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const clientSrc = readFileSync(CLIENT, 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('ok   ' + name);
  } else {
    fail += 1;
    console.log('❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'dr-scale-'));
  return { dir, libraryDir: join(dir, 'library') };
}

const ID = 'scaletest0000000000000000000000';

function seedBook(paths, progress) {
  mkdirSync(join(paths.libraryDir, ID), { recursive: true });
  writeFileSync(
    join(paths.libraryDir, ID, 'meta.json'),
    JSON.stringify({
      id: ID,
      title: '尺度测试',
      fileName: 'x.pdf',
      format: 'pdf',
      pages: 300,
      progress,
      marks: [],
      notes: [],
      framework: { status: 'none', generatedAt: 0, data: null, error: '' },
    }),
  );
}

/* ══════ A. 后端：scale 存得进、读得回 ═══════════════════════════════ */
{
  const paths = tempPaths();
  seedBook(paths, { page: 42, pct: 14, updatedAt: 1000 });
  const initial = await readBookState(paths, ID);
  // 老书没有 scale 字段：必须是 0（"未设置"），不能是 1（那是"设成 100%"）
  check('A 老书（无 scale 字段）读回 scale=0', initial.progress.scale === 0,
    String(initial.progress.scale));
  check('A 老书页码没被改坏', initial.progress.page === 42, String(initial.progress.page));

  const saved = await saveProgress(paths, ID, { scale: 1.8 });
  const reread = await readBookState(paths, ID);
  // 「下次打开」就是重新读盘 —— 这才是用户诉求的直接验证
  check('A 存入 1.8 后重新读盘还是 1.8', reread.progress.scale === 1.8,
    String(reread.progress.scale));
  check('A 存 scale 不破坏页码', reread.progress.page === 42, String(reread.progress.page));
  check('A saveProgress 返回最新值', saved.progress.scale === 1.8, String(saved.progress.scale));
  rmSync(paths.dir, { recursive: true, force: true });
}

/* ══════ B. 翻页不覆盖缩放（最容易写错的一条） ═══════════════════════
   页码保存是高频的，缩放是低频的。若翻页请求把 scale 一起带上去，
   用户刚设的 1.8 会在下一次滚动时被打回旧值。
   后端用「不传就保持不变」守住这条；这里断的是那个语义真的成立。 */
{
  const paths = tempPaths();
  seedBook(paths, { page: 10, pct: 3, updatedAt: 0 });
  await saveProgress(paths, ID, { scale: 2.2 });

  // 模拟连续翻页：只带页码，不带 scale
  for (const page of [11, 12, 13, 40, 90]) {
    await saveProgress(paths, ID, { page, pct: (page / 300) * 100, pages: 300 });
  }
  const after = await readBookState(paths, ID);
  check('B 翻页 5 次后 scale 仍是 2.2', after.progress.scale === 2.2,
    String(after.progress.scale));
  check('B 翻页确实生效（page=90）', after.progress.page === 90, String(after.progress.page));

  // 反过来：只带 scale 的请求不能把页码清零
  await saveProgress(paths, ID, { scale: 0.9 });
  const after2 = await readBookState(paths, ID);
  check('B 只改缩放不影响页码', after2.progress.page === 90, String(after2.progress.page));
  check('B 只改缩放生效（0.9）', after2.progress.scale === 0.9, String(after2.progress.scale));
  rmSync(paths.dir, { recursive: true, force: true });
}

/* ══════ C. 边界夹紧 ═════════════════════════════════════════════════ */
{
  const paths = tempPaths();
  seedBook(paths, { page: 0, pct: 0, updatedAt: 0 });

  const hi = await saveProgress(paths, ID, { scale: MAX_SCALE * 25 });
  check('C 超上限被夹到 MAX_SCALE', hi.progress.scale === MAX_SCALE, String(hi.progress.scale));

  const lo = await saveProgress(paths, ID, { scale: 0.001 });
  check('C 低于下限被夹到 MIN_SCALE', lo.progress.scale === MIN_SCALE, String(lo.progress.scale));

  // 负数 / NaN / 字符串：不能写进磁盘变成坏数据
  const neg = await saveProgress(paths, ID, { scale: -3 });
  check('C 负数按"未设置"处理（不会存成负数）', neg.progress.scale === 0, String(neg.progress.scale));

  const bad = await saveProgress(paths, ID, { scale: NaN });
  check('C NaN 不会写坏磁盘', bad.progress.scale === 0, String(bad.progress.scale));

  const str = await saveProgress(paths, ID, { scale: '1.6' });
  check('C 数字字符串被正确转成数字', str.progress.scale === 1.6, String(str.progress.scale));
  rmSync(paths.dir, { recursive: true, force: true });
}

/* ══════ D. 前端：clampScale 与后端区间一致 ══════════════════════════
   两处各有一份区间常量（前端夹 state、后端夹磁盘），必须同值，
   否则会出现「界面显示 4x，磁盘存成 4x，但下次打开被后端夹成别的值」。 */
{
  const m = clientSrc.match(/const MIN_SCALE = ([0-9.]+);/);
  const M = clientSrc.match(/const MAX_SCALE = ([0-9.]+);/);
  const D = clientSrc.match(/const DEFAULT_SCALE = ([0-9.]+);/);
  check('D 前端有 MIN_SCALE/MAX_SCALE/DEFAULT_SCALE',
    Boolean(m && M && D), '缺常量');
  if (m && M && D) {
    check('D 前端 MIN_SCALE 与后端一致（' + MIN_SCALE + '）',
      Number(m[1]) === MIN_SCALE, m[1]);
    check('D 前端 MAX_SCALE 与后端一致（' + MAX_SCALE + '）',
      Number(M[1]) === MAX_SCALE, M[1]);
    check('D 默认缩放 1.25', Number(D[1]) === 1.25, D[1]);

    // 浮点累加：点 5 下 + 之后不能变成 1.7000000000000002
    const clampSrc = clientSrc.match(/const clampScale = \(value\) => \{[^}]*\}/);
    check('D clampScale 定义存在', Boolean(clampSrc));
    if (clampSrc) {
      check('D clampScale 做了两位小数对齐（防浮点累加）',
        clampSrc[0].includes('Math.round(n * 100) / 100'),
        '未对齐小数');
      // 抽出来的 clampScale 是自由引用 MIN/MAX/DEFAULT 的，要在同一个作用域里
      // 把那三个常量也定义出来，否则 Function 里它们是未定义标识符。
      const clamp = new Function(
        'const MIN_SCALE = ' + MIN_SCALE + ';' +
        'const MAX_SCALE = ' + MAX_SCALE + ';' +
        'const DEFAULT_SCALE = ' + Number(D[1]) + ';' +
        clampSrc[0].replace('const clampScale = ', 'return ') + ';',
      )();
      const steps = [1.25, 1.4, 1.55, 1.7, 1.85, 2.0];
      check('D 连点 + 的结果没有浮点尾巴',
        steps.every((s) => {
          const r = clamp(clamp(s + 0.15));
          return String(r).length <= 5;
        }),
        steps.map((s) => String(clamp(clamp(s + 0.15)))).join(','));
      check('D clamp 默认值回落正确', clamp(NaN) === 1.25, String(clamp(NaN)));
    }
  }
}

/* ══════ E. 前端：读回与写入的接线都在 ═══════════════════════════════
   结构断言只证明「接线存在」，不能证明行为 —— 但少了它，
   上面 A/B/C 全绿而界面依然不记忆（上一版「写笔记没反应」就是这么发生的：
   逻辑全对，前端根本没调用）。 */
{
  check('E 打开书时读回 progress.scale',
    /state\.progress && state\.progress\.scale/.test(clientSrc), '未读回');
  check('E 读回时 0 不当成有效值（老书不该被缩小成 0.5）',
    /savedScale > 0/.test(clientSrc), '把 0 当成了有效缩放');
  check('E 缩放变化会落盘',
    /api\.saveProgress\(bookId, pageRef\.current, 0, pageCount, scale\)/.test(clientSrc),
    '未落盘');
  check('E 缩放落盘有防抖（连点不刷请求）',
    /scaleTimer\.current = setTimeout/.test(clientSrc), '未防抖');
  check('E 卸载时补写未落盘的缩放',
    /JSON\.stringify\(\{ id: bookId, scale: pending \}\)/.test(clientSrc), '未补写');
  check('E 页码落盘不带 scale（否则每次翻页打回旧值）',
    /api\.saveProgress\(bookId, pendingPage, pct, total\)\.catch/.test(clientSrc),
    '页码调用疑似带了 scale');
  check('E api.saveProgress 的 scale 是可选项',
    /scale === undefined \? \{ id, page, pct, pages \}/.test(clientSrc),
    'scale 被强制传入');
}

console.log('\n' + pass + ' pass, ' + fail + ' fail');
if (fail > 0) process.exitCode = 1;
