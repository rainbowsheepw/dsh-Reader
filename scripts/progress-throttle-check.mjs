// 阅读进度落盘时序回归：节流 + 尾随，保证「连续滚动不刷请求、最后位置一定写」。
// 与 client.js 里 ReaderView 的 persist/flushSave 同一套判据。
// 用法：node scripts/progress-throttle-check.mjs
// 节流+尾随的时序验证：模拟连续滚动 20 次换页，断言
// ① 不会每次都发 ② 最后的位置一定被写 ③ 间隔 ≥1.2s 时立刻写
const calls = [];
let pending = { at: 0, page: -1, pages: 0 };
let timer = null;
let now = 0;
const THROTTLE = 1200;

function flush() {
  const { page, pages } = pending;
  if (page < 0) return;
  calls.push({ at: now, page });
  pending = { at: now, page: -1, pages };
}
function persist(nextPage, total) {
  if (nextPage === pending.page && total === pending.pages && pending.page >= 0) return;
  pending = { ...pending, page: nextPage, pages: total };
  const gap = now - pending.at;
  if (timer) { timer = null; }
  if (gap >= THROTTLE) { flush(); return; }
  const delay = THROTTLE - gap + 60;
  const fireAt = now + delay;
  timer = { fireAt };
}

let pass = 0, fail = 0;
const check = (n, ok, d) => ok ? pass++ : (fail++, console.log('FAIL', n, d ?? ''));

// 场景 A：用户快速滚过 20 页（每 100ms 一次）
now = 0; pending = { at: 0, page: -1, pages: 0 }; calls.length = 0; timer = null;
for (let p = 0; p < 20; p++) { now += 100; persist(p, 360); }
check('A 快速滚动没有每次都发', calls.length <= 3, 'calls=' + calls.length);
// 让尾随定时器触发
now = Math.max(now, timer ? timer.fireAt : now);
if (timer) { timer = null; flush(); }
check('A 最后位置被写入', calls.some(c => c.page === 19), JSON.stringify(calls));

// 场景 B：慢速阅读（每 3 秒换一页）→ 每次都应该立刻写
now = 0; pending = { at: 0, page: -1, pages: 0 }; calls.length = 0; timer = null;
for (let p = 0; p < 5; p++) { now += 3000; persist(p, 360); }
check('B 慢速阅读每次都写', calls.length === 5, 'calls=' + calls.length);

// 场景 C：页码不变不重复写
now = 0; pending = { at: 0, page: -1, pages: 0 }; calls.length = 0;
now = 5000; persist(7, 360); const c1 = calls.length;
persist(7, 360); persist(7, 360);
check('C 同页码不重复写', calls.length === c1, 'calls=' + calls.length);

console.log(`\n${pass} pass, ${fail} fail`);
