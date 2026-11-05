// 滚动监听挂载回归：复现「只加载几页就再也不动」并锁住修法。
// 根因：layout 为 null 时组件返回 loading div，页面上没有 .dr-stage，
// 挂监听的 effect 拿到 null 提前 return；而依赖里没有「容器就绪」这个量，
// 于是它永远不再重跑 —— 监听从未存在。
// 用法：node scripts/scroll-listener-mount-check.mjs
// 精确复现：依赖里有没有「容器就绪」，决定监听能不能挂上。
let pass = 0, fail = 0;
const t = (n, ok, d) => ok ? (pass++) : (fail++, console.log('FAIL ' + n + ' ' + (d ?? '')));

// 模拟 React：render N 次，effect 只在「依赖数组的元素值变化」时重跑。
function simulate(withContainerReadyDep) {
  let rendered = 0;
  let layout = null;
  let stage = null;
  let listener = null;
  let lastDeps = null;
  let windowRange = 'untouched';
  let layoutChangedTimes = 0;

  const recompute = () => { if (stage) windowRange = { from: 1, to: 4 }; };

  function render() {
    rendered++;
    // 第 1 次：layout 还是 null → 返回 loading div，没有 stage 元素
    // 第 2 次：layout 已就绪 → 渲染出 .dr-stage
    if (rendered >= 2) {
      if (!stage) stage = { addEventListener: (n, fn) => { listener = fn; } };
    }
    // 依赖数组：旧写法只有 [recompute]（在真实代码里可能是个 id 恒定的东西）
    const deps = withContainerReadyDep ? [layout !== null] : ['recompute-stable'];
    const changed = lastDeps === null || deps.some((d, i) => d !== lastDeps[i]);
    lastDeps = deps;
    if (changed) {
      // effect 体
      if (!stage) return;            // 提前 return：没挂上
      if (withContainerReadyDep && !layout) return;
      listener = () => {};
      recompute();
    }
  }

  // 第一次 render + effect（layout=null, 无 stage）
  layoutChangedTimes++;
  render();
  // 量完尺寸：layout 就绪
  layout = { heights: [850] };
  layoutChangedTimes++;
  render();
  // 用户滚动若干次
  for (let i = 0; i < 5; i++) { if (listener) { windowRange = { from: 50 + i, to: 55 + i }; } }
  return { rendered, listenerAttached: listener !== null, windowRange };
}

const oldR = simulate(false);
t('旧写法复现：监听没挂上', oldR.listenerAttached === false, JSON.stringify(oldR));
t('旧写法复现：窗口不更新', oldR.windowRange === 'untouched', String(oldR.windowRange));

const newR = simulate(true);
t('新写法：监听挂上', newR.listenerAttached === true, JSON.stringify(newR));
t('新写法：窗口随滚动更新', newR.windowRange.from === 54 && newR.windowRange.to === 59, JSON.stringify(newR.windowRange));

// 只变高的场景
let recomputeCalls = 0;
const onResize = (w, h) => { if (!w && !h) return; if (w) { /* 重排 */ } else if (h) recomputeCalls++; };
onResize(false, true); onResize(true, false); onResize(false, false);
t('只变高会重算窗口', recomputeCalls === 1, 'calls=' + recomputeCalls);

console.log(`\n${pass} pass, ${fail} fail`);
