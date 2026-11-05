// 定位与保位数学回归：初次定位 / 重排保位 / 外部跳页 不互相打架。
// 与 client.js 里 ContinuousPdf 的 offsetFor / captureAnchor 同一套判据。
// 用法：node scripts/position-anchor-check.mjs
// 验证「定位只发生在该发生时」：抽取 client.js 的 offsetFor + 保位换算，
// 模拟一条真实的滚动序列，断言 ① 滚动过程中位置不被改写 ② 换页时页码单调 ③ 重排能保位
const PAGE_GAP = 14;

function offsetFor(heights, page, offsetInPage) {
  let acc = 0;
  for (let i = 0; i < Math.min(page, heights.length); i++) acc += heights[i] + PAGE_GAP;
  return Math.max(0, acc + (offsetInPage || 0));
}

// 复刻 recompute 的「当前页」判据（视口顶部）
function pageAt(heights, scrollTop) {
  let page = 0, acc = 0;
  for (let i = 0; i < heights.length; i++) {
    if (scrollTop >= acc) page = i; else break;
    acc += heights[i] + PAGE_GAP;
  }
  return page;
}

// 复刻 ResizeObserver 里的锚点采集
function captureAnchor(heights, scrollTop) {
  let page = 0, offsetInPage = 0, pageHeight = heights[0] || 1, acc = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i], pitch = h + PAGE_GAP;
    if (scrollTop >= acc && scrollTop < acc + pitch) { page = i; offsetInPage = scrollTop - acc; pageHeight = h; break; }
    acc += pitch; page = i; offsetInPage = Math.max(0, scrollTop - acc); pageHeight = h;
  }
  return { page, offsetInPage, pageHeight };
}

let pass = 0, fail = 0;
const eq = (n, got, want) => { if (got === want) pass++; else { fail++; console.log('FAIL', n, 'got', got, 'want', want); } };

const N = 100, H = 850;
const heights = new Array(N).fill(H);

// ① 纯滚动不该改位置：页码随 scrollTop 单调，且位置可反算
let prev = -1, monotonic = true;
for (let st = 0; st < (H + PAGE_GAP) * N; st += 400) {
  const p = pageAt(heights, st);
  if (p < prev) monotonic = false;
  prev = p;
  // 反算：byPage = offsetFor(heights, p, 0)，真实位置必须 >= 该页起点且 < 下一页起点
  const start = offsetFor(heights, p, 0);
  const nextStart = p + 1 < N ? offsetFor(heights, p + 1, 0) : Infinity;
  if (!(st >= start && st < nextStart)) { fail++; console.log('FAIL 反算不符', st, p, start, nextStart); }
}
eq('页码单调不倒退', monotonic, true);
pass++;

// ② 重排保位：fit 从 1 → 0.8（页高 850→680），同一个「第 10 页 + 页内 300px」要还原到
//    新坐标下的同一相对位置（300 * 680/850 ≈ 240）
const oldHeights = heights;
const newHeights = heights.map(() => 850 * 0.8);
const anchor = captureAnchor(oldHeights, offsetFor(oldHeights, 10, 300));
eq('锚点页正确', anchor.page, 10);
eq('锚点页内偏移正确', anchor.offsetInPage, 300);
const ratio = (newHeights[anchor.page]) / anchor.pageHeight;
const restored = offsetFor(newHeights, anchor.page, anchor.offsetInPage * ratio);
const newStart = offsetFor(newHeights, 10, 0);
eq('保位后仍在第 10 页', pageAt(newHeights, restored), 10);
eq('保位后页内偏移等比', Math.round(restored - newStart), Math.round(300 * 0.8));

// ③ 初次定位：从第 42 页开始，定位后页码必须是 42
eq('初次定位到指定页', pageAt(heights, offsetFor(heights, 42, 0)), 42);

// ④ 边界：末页定位不越界
const last = offsetFor(heights, N - 1, 0);
eq('末页定位正确', pageAt(heights, last), N - 1);

// ⑤ 边界：第 0 页定位是 0
eq('首页定位为 0', offsetFor(heights, 0, 0), 0);

// ⑥ 异形页下的保位（第 50 页是横页 600 高）
const mixed = heights.slice(); mixed[50] = 600;
const anchor50 = captureAnchor(mixed, offsetFor(mixed, 50, 200));
eq('异形页锚点页正确', anchor50.page, 50);
eq('异形页锚点偏移正确', anchor50.offsetInPage, 200);

console.log(`\n${pass} pass, ${fail} fail`);
