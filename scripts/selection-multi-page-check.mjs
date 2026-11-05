// 多页选区回归：连续滚动时窗口内 5~7 页同时挂载，它们共享一个 bubble 状态。
//
// 事故：每页都监听 selectionchange，且「选区不在本页」时上报 undefined，
// 结果命中页刚算好的工具条被其它页在同一 tick 覆盖成空 ——
// 用户看到的是「选中文字，工具条闪一下就没了」，等于标注功能消失。
//
// 修法：不在本页的监听保持沉默；只有「原本归我」的那一页负责清空。
//
// 用法：node scripts/selection-multi-page-check.mjs
// 旧写法：不在本页的监听上报 undefined → 覆盖命中页 → 工具条消失
// 新写法：不在本页的监听保持沉默（除非原本归它）
let pass = 0, fail = 0;
const t = (n, ok, d) => ok ? (pass++) : (fail++, console.log('FAIL ' + n + ' ' + (d ?? '')));

// 模拟：6 页挂载，共享一个 bubble 状态
function run(pages, selectedPage, withFix) {
  let bubble = null;
  const logs = [];
  const handlers = pages.map((idx) => {
    let mine = false;
    return () => {
      const inThisPage = idx === selectedPage;
      if (!inThisPage) {
        if (withFix) {
          if (mine) { mine = false; bubble = null; logs.push('p' + idx + ':clear'); }
          // 沉默
        } else {
          bubble = null; logs.push('p' + idx + ':clear(覆盖!)');
        }
        return;
      }
      // 命中页上报
      mine = true;
      bubble = { page: idx, text: '选中文字' };
      logs.push('p' + idx + ':set');
    };
  });
  // 一次 selectionchange，所有监听按挂载顺序触发
  for (const h of handlers) h();
  return { bubble, logs };
}

// 真实挂载顺序：窗口内页 0..5，用户选中第 3 页
const pages = [0, 1, 2, 3, 4, 5];

const oldR = run(pages, 3, false);
t('旧写法：工具条被后面的页覆盖掉（复现 bug）', oldR.bubble === null, JSON.stringify(oldR.bubble));

const newR = run(pages, 3, true);
t('新写法：工具条保留（命中页数据存活）', newR.bubble !== null && newR.bubble.page === 3, JSON.stringify(newR.bubble));
t('新写法：命中页确实上报过', newR.logs.includes('p3:set'), newR.logs.join(','));
t('新写法：其它页没有覆盖', newR.logs.every((l) => !l.includes('覆盖')), newR.logs.join(','));

// 选中最后一页（挂载顺序末尾）
const lastR = run(pages, 5, true);
t('新写法：选中最后一页也保留', lastR.bubble !== null && lastR.bubble.page === 5, JSON.stringify(lastR.bubble));

// 选中第一页（后面还有 5 个监听会触发）
const firstR = run(pages, 0, true);
t('新写法：选中第一页也保留', firstR.bubble !== null && firstR.bubble.page === 0, JSON.stringify(firstR.bubble));

console.log(`\n${pass} pass, ${fail} fail`);
