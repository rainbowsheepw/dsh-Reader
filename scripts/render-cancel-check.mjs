// 缩放时画面翻转的回归。
//
// ## 症状与因果链
//
// 用户：「pdf 放大到一定程度后，pdf 显示会突然翻转，倒过来显示」。
//
// 排查过的事实：
//   · PDF 本身没旋转 —— 逐页检查 p1/40/120/164/200/360，`page.rotate` 全是 0，
//     `viewport.transform` 恒为 `[1.4,0,0,-1.4,0,952.43]`（正常的 y 轴翻转）；
//   · 所以翻转不是数据问题，是**渲染并发**问题。
//
// 因果链：
//
//   1. 点「放大」→ `scale` +0.15 → 渲染 effect 依赖变化 → 重跑；
//   2. effect 里第一步就是 `canvas.width = …`，而**给 canvas 赋 width/height
//      会立刻清空整块位图**（DOM 规范行为）；
//   3. 上一轮的 `render().promise` 还没结束，它仍在往这块 canvas 上按**旧 viewport**
//      画像素；新的一轮已经用**新 viewport** 重置了尺寸和变换。
//   4. 两套 `setTransform` 与两套尺寸写进同一块位图 → 画面翻折、错位、撕裂。
//
//   旧代码只有 `renderToken`，它只能在**画完之后**判断「我过期了」，
//   拦不住已经在写像素的那一帧。唯一能拦的是 `renderTask.cancel()`。
//
// ## 本脚本能验与不能验的
//
// 本环境没有 node-canvas，**无法**采样像素证明「翻转」。
// 所以这里验的是**机制**：
//   A. 渲染前必须 cancel 旧任务（而不是只在结束后判 token）
//   B. 卸载时必须 cancel
//   C. 取消异常不能被当成「渲染失败」记日志
//   D. 用真 pdf.js 验证：cancel 确实能让进行中的 render 停下并抛 RenderingCancelledException
//
// D 是真的跑 pdf.js —— 它证明「这个 API 在当前版本有效」，不是靠文档推断。
//
 // 用法：node scripts/render-cancel-check.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const src = await readFile(clientPath, 'utf8');

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

/* ══════ A/B/C. 源码机制 ════════════════════════════════════════════ */

const renderEffect = (() => {
  const at = src.indexOf('canvas.width = Math.floor(viewport.width * dpr)');
  if (at < 0) return null;
  const head = src.lastIndexOf('useEffect(', at);
  if (head < 0) return null;
  let depth = 0;
  for (let index = head + 'useEffect'.length; index < src.length; index += 1) {
    const ch = src[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(head, index + 1);
    }
  }
  return null;
})();

check('结构：能找到渲染 effect', Boolean(renderEffect));

if (renderEffect) {
  // A. render 之前必须 cancel
  const cancelIdx = renderEffect.indexOf('renderTaskRef.current.cancel()');
  const renderIdx = renderEffect.indexOf('pageProxy.render(');
  check('A 渲染前有 cancel', cancelIdx >= 0, '未找到 cancel');
  check('A cancel 出现在 render 之前（顺序正确）', cancelIdx >= 0 && cancelIdx < renderIdx,
    cancelIdx + ' vs ' + renderIdx);

  // 不能只有 token 判断 —— token 是「事后」的
  check('A 不只是靠 renderToken 事后判断',
    renderEffect.includes('renderTaskRef.current.cancel()'),
    '只靠 token 拦不住正在写像素的帧');

  // B. 清理函数里也要 cancel
  const cleanup = renderEffect.slice(renderEffect.indexOf('return () => {'));
  check('B 卸载时 cancel', cleanup.includes('renderTaskRef.current.cancel()'));
  // 顺序：先 cancel 再清零 canvas，否则清零点数被打断
  const cleanCancelIdx = cleanup.indexOf('renderTaskRef.current.cancel()');
  const cleanZeroIdx = cleanup.indexOf('canvas.width = 0');
  check('B 先 cancel 再清零 canvas', cleanCancelIdx >= 0 && cleanCancelIdx < cleanZeroIdx,
    cleanCancelIdx + ' vs ' + cleanZeroIdx);

  // C. 取消异常不能当失败
  check('C 取消异常被识别', renderEffect.includes('RenderingCancelledException'));
  const catchBlock = renderEffect.slice(renderEffect.indexOf('} catch (error) {'));
  check('C 取消时跳过 console.error',
    catchBlock.includes("name !== 'RenderingCancelledException'"),
    catchBlock.split('\n')[0]);
}

check('结构：renderTaskRef 已声明', src.includes('const renderTaskRef = useRef(null)'));
// 任务必须在 await 完成后清掉，否则下次会 cancel 一个已结束的任务
check('结构：任务完成后清 ref',
  src.includes('if (renderTaskRef.current === task) renderTaskRef.current = null;'));

/* ══════ D. 用真 pdf.js 验证 cancel 真的有效 ═════════════════════════ */

let pdfOk = true;
try {
  const lib = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
  const worker = await import(new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href);
  globalThis.pdfjsWorker = worker;
  lib.GlobalWorkerOptions.workerSrc = 'unused';

  const sample = process.env.DR_SAMPLE_PDF;
  if (!sample) {
    console.log('跳过 D：设 DR_SAMPLE_PDF 指向一本真实 PDF 再跑');
  } else {
    const data = await readFile(sample);
    const doc = await lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);

    // 假 canvas：pdf.js 在 node 下不会真的画，但我们能观察「任务是否被取消」
    const makeCanvas = () => {
      const store = { width: 0, height: 0, resets: 0 };
      const ctx = new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop === 'canvas') return canvas;
            // pdf.js 会解构 getTransform() 的返回值（`{a,b,c,d,e,f}`），
            // 只返回 undefined 会在解构时抛 TypeError。
            if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            if (prop === 'getImageData') return () => ({ data: new Uint8Array(4) });
            if (prop === 'measureText') return () => ({ width: 0 });
            if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
            if (prop === 'createPattern') return () => ({});
            if (prop === 'createImageData') return () => ({ data: new Uint8Array(4), width: 1, height: 1 });
            return () => {};
          },
        },
      );
      const canvas = {
        getContext: () => ctx,
        get width() { return store.width; },
        set width(v) { if (store.width !== v) store.resets += 1; store.width = v; },
        get height() { return store.height; },
        set height(v) { store.height = v; },
        style: {},
        store,
      };
      return canvas;
    };

    // D1：cancel 之后 promise 必须拒绝，且拒绝原因是 RenderingCancelledException
    {
      const canvas = makeCanvas();
      const viewport = page.getViewport({ scale: 2 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      // 立刻取消
      task.cancel();
      let name = null;
      try {
        await task.promise;
      } catch (error) {
        name = error && error.name;
      }
      check('D1 cancel 让 render 拒绝', name !== null, name);
      check('D1 拒绝原因是 RenderingCancelledException', name === 'RenderingCancelledException', name);
    }

    // D2/D3 需要 pdf.js **真的把像素画出来**，而它在 Node 里会内部
    // `require('@napi-rs/canvas')` —— 本环境没装，所以做不到。
    //
    // 这里改成：先探测能力，有就跑，没有就明确跳过。
    // 不假装通过、也不假装失败 —— 一条检查如果永远红着，会被当成噪音忽略掉，
    // 那比没有更糟。
    let canvasModule = false;
    try {
      await import('@napi-rs/canvas');
      canvasModule = true;
    } catch {
      canvasModule = false;
    }

    if (!canvasModule) {
      console.log('跳过 D2/D3：Node 侧缺 @napi-rs/canvas，pdf.js 无法真的画像素');
      console.log('      （D1 仍然有效：取消发生在加载 canvas 之前）');
    } else {
      // D2：不 cancel 时能正常完成（证明 D1 的拒绝是 cancel 造成的，不是环境问题）
      {
        const canvas = makeCanvas();
        const viewport = page.getViewport({ scale: 1.4 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        let done = false;
        let why = '';
        try {
          await task.promise;
          done = true;
        } catch (error) {
          why = (error && (error.name + ': ' + error.message)) || String(error);
        }
        check('D2 不 cancel 时渲染能完成', done, why);
      }

      // D3：取消后可以立刻重开新任务（放大连续点场景）
      {
        const canvas = makeCanvas();
        const vp1 = page.getViewport({ scale: 1.4 });
        canvas.width = vp1.width;
        canvas.height = vp1.height;
        const t1 = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp1 });
        t1.cancel();
        try { await t1.promise; } catch { /* 预期取消 */ }

        const vp2 = page.getViewport({ scale: 1.55 });
        canvas.width = vp2.width;
        canvas.height = vp2.height;
        const t2 = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp2 });
        let ok = false;
        let why = '';
        try {
          await t2.promise;
          ok = true;
        } catch (error) {
          why = (error && (error.name + ': ' + error.message)) || String(error);
        }
        check('D3 取消旧任务后能重开新任务', ok, why);
      }
    }

    await doc.destroy();
  }
} catch (error) {
  pdfOk = false;
  console.log('❌ D 段（真 pdf.js）执行失败：' + (error && error.message));
  failed += 1;
}

console.log('\n' + passed + ' pass, ' + failed + ' fail');
process.exitCode = failed ? 1 : 0;
