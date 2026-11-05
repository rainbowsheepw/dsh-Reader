// 连续滚动窗口数学回归：当前页判定 / 渲染窗口有界 / 异形页。
// 与 client.js 里 ContinuousPdf 的 recompute 同一套公式，纯函数可跑。
// 用法：node scripts/scroll-window-check.mjs
// 抄出 client.js 里 recompute 的滚动数学，用真实尺寸跑断言。
const PAGE_GAP = 14;
const WINDOW_RADIUS = 2;

function makeIndex(heights) {
  const pitch = heights.map((h) => h + PAGE_GAP);
  const offsets = [];
  let acc = 0;
  for (const step of pitch) { offsets.push(acc); acc += step; }
  return { pitch, offsets, total: acc };
}

function compute(heights, scrollTop, viewportHeight, current) {
  const { pitch, offsets } = makeIndex(heights);
  const probe = scrollTop + viewportHeight / 2;
  let next = 0;
  for (let i = 0; i < offsets.length; i++) { if (probe >= offsets[i]) next = i; else break; }

  let firstVisible = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (scrollTop >= offsets[i] + pitch[i]) continue;
    firstVisible = i; break;
  }
  let lastVisible = firstVisible;
  const bottom = scrollTop + viewportHeight;
  for (let i = firstVisible; i < offsets.length; i++) {
    lastVisible = i;
    if (offsets[i] + pitch[i] >= bottom) break;
  }
  const from = Math.max(0, firstVisible - WINDOW_RADIUS);
  const to = Math.min(heights.length - 1, lastVisible + WINDOW_RADIUS);
  return { current: next, from, to, firstVisible, lastVisible };
}

// 一本 360 页、页高 850、视口 900 的书（真实 nndl-ge 尺寸）
const N = 360;
const H = 850;
const heights = new Array(N).fill(H);
const vh = 900;
let pass = 0, fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log('FAIL', name, 'got', got, 'want', want); } };

// 1) 顶部
eq('顶部当前页', compute(heights, 0, vh, 0).current, 0);
// 2) 滚到第 10 页顶部
const off10 = (H + PAGE_GAP) * 10;
const r10 = compute(heights, off10, vh, 0);
eq('第 10 页当前页', r10.current >= 10 && r10.current <= 11, true);
eq('第 10 页窗口包含它', r10.from <= 10 && r10.to >= 10, true);
// 3) 窗口不越界
const rEnd = compute(heights, (H + PAGE_GAP) * (N - 1), vh, 0);
eq('末页窗口不越界', rEnd.to <= N - 1 && rEnd.from >= 0, true);
eq('末页当前页=最后一页', rEnd.current, N - 1);
// 4) 窗口大小有界（不会膨胀到整本）
for (const st of [0, 1000, 50000, 200000, (H+PAGE_GAP)*359]) {
  const r = compute(heights, st, vh, 0);
  const span = r.to - r.from + 1;
  if (span > 10) { fail++; console.log('FAIL 窗口过大', st, span); } else pass++;
  if (r.from < 0 || r.to > N - 1) { fail++; console.log('FAIL 窗口越界', st, r.from, r.to); } else pass++;
}
// 5) 单调性：scrollTop 增大，current 不减小
let prev = 0;
for (let st = 0; st < (H+PAGE_GAP)*N; st += 500) {
  const c = compute(heights, st, vh, 0).current;
  if (c < prev) { fail++; console.log('FAIL 当前页倒退', st, prev, c); }
  prev = c;
}
pass++;
// 6) 异形页（横页）也要正确
const mixed = heights.slice(); mixed[50] = 600; mixed[51] = 600;
const off50 = (H + PAGE_GAP) * 50;
const rm = compute(mixed, off50, vh, 0);
eq('横页当前页正确', rm.current >= 50 && rm.current <= 51, true);
eq('横页窗口包含它', rm.from <= 50 && rm.to >= 51, true);

console.log(`\n${pass} pass, ${fail} fail`);
console.log('窗口跨度示例（顶部）:', compute(heights, 0, vh, 0));
console.log('窗口跨度示例（中部）:', compute(heights, 100000, vh, 0));
