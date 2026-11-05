/**
 * dsh-reader — Client 半入口（浏览器）。
 *
 * 三件事：注册工厂 → 占两个座位（`sidebar.panellist` + `main`）→ 注入样式。
 *
 * 三条不能破的纪律：
 * 1. `id` 必须等于包名，否则 ModuleLoader 报 "loaded without registering"。
 * 2. **只 require `react`**。模块表里只有几个 seed（react / react-dom / cordis / ui-slots…），
 *    require 任何第三方包都是整个 web boot 失败（不是"本插件缺席"）。
 *    pdf.js 因此走 `import()` 从本插件的 vendor 路由动态加载。
 * 3. 注册问题一律 catch + console.error 往外**不抛** —— apply 抛一次整个 GUI 起不来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reader',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useMemo, useRef, useCallback } = React;
    const h = React.createElement;

    /** 面板 id：sidebar 行与 main 页共用同一个 key。 */
    const PANEL_ID = 'reader';
    const PANEL_ORDER = 45;
    const COLOR_NAMES = ['amber', 'green', 'blue', 'rose'];
    const COLOR_LABELS = { amber: '黄', green: '绿', blue: '蓝', rose: '粉' };

    /* ── 阅读缩放 ───────────────────────────────────────────────────────
       倍数**跟着书走**（存在 meta.progress.scale），不是全局偏好：
       同一本 300 页的教材和一本 20 页的小册子，舒服的字号本来就不一样。

       三处数值必须一致，改一处就要改另两处：
         · DEFAULT_SCALE —— 从没设置过时用（store 里存 0 表示"未设置"）
         · STEP / 上下限 —— 工具栏 +/− 按钮
         · store.js 的 MIN_SCALE / MAX_SCALE —— 后端夹紧（防止手改 meta 越界）
       前端也夹一遍，是为了不让 +/− 点到边界后 state 与磁盘不一致。 */
    const DEFAULT_SCALE = 1.25;
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 4;
    const SCALE_STEP = 0.15;

    /** 夹到合法区间并对齐到两位小数（浮点累加会积出 1.7000000000000002）。 */
    const clampScale = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return DEFAULT_SCALE;
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n * 100) / 100));
    };

    /* ═══ 样式：全部 --dsw-alias-* token，选择器统一前缀 dr- ═══════════════ */
    const CSS = `/* ── 标注四色：**单一来源** ─────────────────────────────────────────
   这四个色值同时被三处使用：正文划线、侧栏卡片、选区色块按钮。
   之前散成 24 处硬编码 —— 想换个黄得改 6 个地方，漏一处就会出现
   「侧栏是旧黄、正文是新黄」的错位。现在只在 :root 定义一次。 */
:root{--dr-amber:#f0b429;--dr-green:#3fae6a;--dr-blue:#4a90d9;--dr-rose:#e0629b}
@media (prefers-color-scheme: dark){
  :root{--dr-amber:#ffcc4d;--dr-green:#57d488;--dr-blue:#6aa9ec;--dr-rose:#f07eb2}
}
.dr-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;position:relative}
.dr-root *{box-sizing:border-box}
.dr-btn{display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 11px;font-size:13px;cursor:pointer;transition:border-color .12s ease;font-family:inherit}
.dr-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.dr-btn:disabled{opacity:.45;cursor:default}
/* ⚠️ 主按钮必须**成对**使用宿主的按钮 token，不能自己配底色 + 硬编码白字。
   踩过的坑：写 background:brand-primary 配 color:#fff，在浅色下正常，
   在深色下 brand-primary 变成 neutral-bluish-50（近白）→ 白底白字，整颗按钮一片白。
   button-primary-fill 与 label-primary-foreground 是宿主自己配好的一对，
   深色下自动是「浅底 + 深字」。 */
.dr-btn.is-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dr-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dr-btn.is-ghost{background:transparent;border-color:transparent}
.dr-btn.is-ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.dr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:7px;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.dr-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dr-input{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;font-family:inherit}
.dr-input:focus{border-color:var(--dsw-alias-brand-primary)}

.dr-shelf{display:flex;flex-direction:column;height:100%;min-height:0;position:relative}
.dr-shelf-head{display:flex;align-items:center;gap:12px;padding:16px 20px 10px;flex:none}
.dr-shelf-title{font-size:17px;font-weight:600;margin:0}
.dr-shelf-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dr-shelf-tools{margin-left:auto;display:flex;gap:8px;align-items:center}
.dr-grid-scroll{flex:1;min-height:0;overflow:auto;padding:8px 20px 28px}
.dr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(146px,1fr));gap:24px 18px}
/* 整张卡片是容器（不再是 button）：卡片里除了"打开"，还有重命名与删除两个操作，
   套在一个 button 里会出现"按钮嵌按钮"，点击事件也会互相打架。 */
.dr-book{display:flex;flex-direction:column;gap:7px;position:relative}
.dr-book-open{display:flex;flex-direction:column;border:none;background:transparent;padding:0;cursor:pointer;text-align:left;font-family:inherit;-webkit-appearance:none;appearance:none}
.dr-cover{position:relative;aspect-ratio:2/3;border-radius:5px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);box-shadow:0 2px 8px rgba(0,0,0,.16);transition:transform .16s ease,box-shadow .16s ease;display:flex;flex-direction:column;justify-content:center;padding:14px 14px 14px 16px;color:#fff;background:var(--dsw-alias-bg-layer-2)}
.dr-cover.has-image{padding:0}
.dr-book:hover .dr-cover{transform:translateY(-3px);box-shadow:0 8px 20px rgba(0,0,0,.26)}
/* 真封面铺满整张卡：object-fit:cover 保证不因页面比例不同而变形 */
.dr-cover-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
.dr-cover-spine{position:absolute;left:0;top:0;bottom:0;width:6px;background:rgba(0,0,0,.3)}
.dr-cover-title{font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dr-cover-mark{position:absolute;right:8px;bottom:9px;font-size:10px;opacity:.9;background:rgba(0,0,0,.32);border-radius:9px;padding:1px 6px}
.dr-cover-progress{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(0,0,0,.3)}
.dr-cover-progress i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.dr-book-name-row{display:flex;align-items:flex-start;gap:4px}
.dr-book-name{font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;flex:1;min-width:0}
/* 重命名按钮：默认隐身，悬停才露出来 —— 满屏 ✎ 会显得书架很吵 */
.dr-book-rename-btn{opacity:0;transition:opacity .12s ease;flex:none}
.dr-book:hover .dr-book-rename-btn{opacity:1}
.dr-book-rename-btn:focus-visible{opacity:1}
/* 重命名输入框：与书名同样的字号，编辑时视觉上不"跳变" */
.dr-rename-input{width:100%;font-size:12.5px;line-height:1.4;font-family:inherit;padding:3px 6px;border-radius:5px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}
.dr-book-rename{width:100%}
.dr-book-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}
.dr-book-del{position:absolute;right:-8px;top:-8px;opacity:0;transition:opacity .12s ease}
.dr-book:hover .dr-book-del{opacity:1}
.dr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:64px 20px;color:var(--dsw-alias-label-secondary);text-align:center}
.dr-empty h3{margin:0;font-size:15px;color:var(--dsw-alias-label-primary)}
.dr-drop{position:absolute;inset:8px;border:2px dashed var(--dsw-alias-brand-primary);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--dsw-alias-brand-primary);pointer-events:none;z-index:6}

.dr-reader{display:flex;flex-direction:column;height:100%;min-height:0}
.dr-reader-bar{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;background:var(--dsw-alias-bg-layer-1)}
.dr-reader-title{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:32%}
.dr-spacer{flex:1}
.dr-page-ind{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dr-viewer{flex:1;min-height:0;display:flex;overflow:hidden;background:var(--dsw-alias-bg-layer-2);position:relative}
.dr-scrollwrap{flex:1;min-width:0;display:flex;min-height:0;position:relative}
.dr-stage{flex:1;min-width:0;overflow:auto;padding:18px;display:flex;justify-content:center;align-items:flex-start;position:relative}
.dr-stage.is-scroll{display:block;padding:20px 20px 40px;overscroll-behavior:contain}
.dr-pages{display:flex;flex-direction:column;align-items:center;margin:0 auto}
.dr-vsheet{position:relative;flex:none;display:flex;justify-content:center;align-items:flex-start;max-width:100%}
.dr-sheet{position:relative;flex:none;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.22);border-radius:2px}
.dr-sheet.is-flow{max-width:100%;overflow:hidden}
/* canvas 与文字层必须严格同尺寸：绝不能用 max-width 去压 canvas，
   否则位图被拉伸、文字层盒子不动，选区会整体错位（而且看起来"还好"，只是选不准）。 */
.dr-sheet canvas{display:block;border-radius:2px}
.dr-textlayer{position:absolute;inset:0;overflow:hidden;line-height:1;text-align:initial;transform-origin:0 0;z-index:2}
.dr-textlayer span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;cursor:text}
.dr-textlayer span::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,transparent)}
/* ── 标注：底部划线，画在**文字盒之外**（这是本文件最容易被"优化"坏的一段）──

   ## 三代做法，两代翻车

   1. 色块铺在文字上（mix-blend-mode:multiply）→ 笔画被糊，用户说「颜色叠在
      文字上面影响阅读」。
   2. 旁边另铺一层 .dr-mark → 线跑到字中间。span 有垂直补偿（delta），
      那层用的是未补偿的原始 box，两套坐标一错开就压字。
   3. 线长在 span 自己身上（border-bottom）→ 对位问题没了，但**位置又错了**：
      border-bottom 画在**盒子底边的内侧**，而文字层 span 是 line-height:1，
      盒高就等于 fontSize —— 中文的 descender（下伸笔画）会溢出盒底，
      字号越大溢出越多。于是 2.5px 的线正好横穿字形下缘。
      大标题最明显（「设为…」那行线直接切进字里），正文也切字底。

   ## 现在的做法：::after 画到盒子外侧

   线的**横向**用百分比（span 带着 scaleX，像素值会被再乘一次缩放，百分比不会）。
   线的**纵向**用 em 往下让（em 相对 span 自己的字号，字号越大让得越多）。
   两者都是比例量，所以缩放、字号变化都不会让线重新爬回字里。

   bottom 必须让到 descender 之外：本行字号约 15~22px，下伸笔画溢出盒底
   约 0.1~0.15em。让位量 0.24em 是**留有余量**的取值 —— 不是算出来的下限，
   是用户在手感上按「再往下一点点」定下来的。
   下限（0.15em）只是安全线，实际值故意比它大，让线看起来更像纸书上的一条
   clean 分隔线，而不是贴在字底的一道边。
   （上一版 padding-bottom:1px 的教训是：固定像素补比例量，大字号必失效。）
   线粗也用 em 夹一个 2px 下限，标题的线才不会看起来比正文还细。 */
.dr-textlayer span.is-marked::after,
.dr-textlayer span.is-marked-partial::after{content:'';position:absolute;left:var(--mk-l,0);width:var(--mk-w,100%);bottom:-0.24em;height:max(2px,0.085em);background:var(--mk-c,var(--dr-amber));border-radius:1px;pointer-events:none}
.dr-textlayer span.is-marked.is-amber,
.dr-textlayer span.is-marked-partial.is-amber{--mk-c:var(--dr-amber)}
.dr-textlayer span.is-marked.is-green,
.dr-textlayer span.is-marked-partial.is-green{--mk-c:var(--dr-green)}
.dr-textlayer span.is-marked.is-blue,
.dr-textlayer span.is-marked-partial.is-blue{--mk-c:var(--dr-blue)}
.dr-textlayer span.is-marked.is-rose,
.dr-textlayer span.is-marked-partial.is-rose{--mk-c:var(--dr-rose)}

.dr-loading{display:flex;align-items:center;justify-content:center;flex:1;color:var(--dsw-alias-label-secondary);font-size:13px;gap:12px;flex-direction:column;padding:48px;text-align:center;line-height:1.6}
.dr-spinner{width:18px;height:18px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dr-spin .8s linear infinite}
@keyframes dr-spin{to{transform:rotate(360deg)}}

.dr-bubble{position:absolute;z-index:9;display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 18px rgba(0,0,0,.3)}
.dr-bubble-fixed{position:absolute;z-index:40}
.dr-bubble button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-family:inherit}
.dr-bubble button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dr-swatch{width:15px;height:15px;border-radius:50%;border:1px solid rgba(0,0,0,.28);display:inline-block}
.dr-swatch.is-amber{background:var(--dr-amber)}.dr-swatch.is-green{background:var(--dr-green)}
.dr-swatch.is-blue{background:var(--dr-blue)}.dr-swatch.is-rose{background:var(--dr-rose)}


.dr-side{width:310px;flex:none;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.dr-side-tabs{display:flex;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 4px}
.dr-side-tab{padding:9px 9px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;border-bottom:2px solid transparent;font-family:inherit;white-space:nowrap}
.dr-side-tab.is-on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.dr-side-body{flex:1;min-height:0;overflow:auto;padding:12px 12px 28px}
/* 问答页签要「内部自己滚、输入贴底」，所以父容器必须**不滚**，
   否则 flex:1 在 overflow:auto 的父级里拿不到确定高度，
   输入区会跟着内容一起跑掉。用 is-fixed-shell 显式关掉父级滚动。 */
.dr-side-body.is-fixed-shell{overflow:hidden;display:flex;flex-direction:column;padding:12px 12px 12px}
.dr-fw-summary{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);margin:0 0 12px}
.dr-fw-part{margin-bottom:15px}
.dr-fw-partname{font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary);margin:0 0 3px}

/* ── 「读到哪」并入框架页后的进度块 ─────────────────────────────────
   位置：框架页最顶部。顺序是「进度条 → 当前章节 → 全书结构」——
   先回答「我在哪」，再给地图。原来这两件事分在两个页签，
   用户要来回点才能把「第几页」和「框架里哪一章」对上号。 */
.dr-fw-progress{margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 当前章节详情：用左侧色条括起来，和下面的段/章列表在视觉上区分开 */
.dr-fw-here{margin-top:10px;padding-left:8px;border-left:2.5px solid var(--dsw-alias-brand-primary)}
.dr-fw-here-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:3px;line-height:1.45}
.dr-fw-q{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:0 0 7px;line-height:1.5}
.dr-fw-ch{display:flex;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;border:1px solid transparent;background:transparent;text-align:left;width:100%;font-family:inherit}
.dr-fw-ch:hover{background:var(--dsw-alias-bg-layer-2)}
.dr-fw-ch.is-here{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dr-fw-ch-idx{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:15px;padding-top:2px}
.dr-fw-ch-title{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary);word-break:break-word}
.dr-fw-ch-gist{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dr-fw-key{display:inline-block;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 5px;margin:3px 3px 0 0}
.dr-fw-howto{margin:0;padding-left:16px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dr-fw-howto li{margin-bottom:5px}
.dr-here{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7}
.dr-here b{color:var(--dsw-alias-label-primary);font-weight:600}
.dr-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:7px 0 4px}
.dr-bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease}
.dr-note{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;margin-bottom:7px;background:var(--dsw-alias-bg-base)}
/* ── 侧栏卡片：颜色与 PDF 里的划线对应 ──────────────────────────────
   左边那道竖线用**和正文划线同一个变量**，所以「黄的那条」在侧栏和页面上
   是同一个黄（变量在 :root 定义，深色主题自动切，不用另写一套）。

   除了左色条，卡片背景也带一层极淡的同色底 —— 只靠 3px 细线在一列卡片里
   还不够醒目，8% 的同色底就能一眼分组，又不至于让整栏变成色块墙
   （那正是「铺色块挡字」那轮被骂的做法，这里只是**背景**，文字压在浅底上仍清楚）。 */
.dr-note.is-amber{border-left:3px solid var(--dr-amber);background:color-mix(in srgb,var(--dr-amber) 8%,var(--dsw-alias-bg-base))}
.dr-note.is-green{border-left:3px solid var(--dr-green);background:color-mix(in srgb,var(--dr-green) 8%,var(--dsw-alias-bg-base))}
.dr-note.is-blue{border-left:3px solid var(--dr-blue);background:color-mix(in srgb,var(--dr-blue) 8%,var(--dsw-alias-bg-base))}
.dr-note.is-rose{border-left:3px solid var(--dr-rose);background:color-mix(in srgb,var(--dr-rose) 8%,var(--dsw-alias-bg-base))}
/* 卡片内引文条：颜色随卡片走，不再用固定的品牌色。
   字号/行高保持原值（11.5px / 1.5）—— 这次只动笔记字体，引文不碰。 */
.dr-note-q{font-size:11.5px;line-height:1.5;border-left:2.5px solid var(--dsw-alias-border-l2);padding-left:7px;margin-bottom:5px;white-space:pre-wrap}
.dr-note.is-amber .dr-note-q{border-left-color:var(--dr-amber)}
.dr-note.is-green .dr-note-q{border-left-color:var(--dr-green)}
.dr-note.is-blue .dr-note-q{border-left-color:var(--dr-blue)}
.dr-note.is-rose .dr-note-q{border-left-color:var(--dr-rose)}
/* 页码那行的色名也染色，让「黄色」两个字本身就是黄的 */
/* 页码 + 色名那一行。基类规则曾在改样式时被整段带走，
   只剩下面按颜色染「黄色」两个字的后代规则 —— 于是这行的字号/颜色全丢了。 */
.dr-note-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.dr-note.is-amber .dr-note-meta b{color:var(--dr-amber)}
.dr-note.is-green .dr-note-meta b{color:var(--dr-green)}
.dr-note.is-blue .dr-note-meta b{color:var(--dr-blue)}
.dr-note.is-rose .dr-note-meta b{color:var(--dr-rose)}
/* 笔记正文：只把字体调大、调粗一点点，其它保持原样。
   原值 11.5px + secondary 灰 → 12.5px + 500 字重，颜色略提一档但仍比引文浅，
   让「我写的」比「引文」稍微显眼，又不至于抢过正文引文的位置。 */
.dr-note-t{font-size:12.5px;line-height:1.65;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
/* 缩略态：全部页面视图里按章堆几十条，必须收紧；引文与笔记**同时**截断，
   只截一个会让卡片高度忽高忽低，扫一眼看不出哪条是哪条。
   悬停展开全文（title 属性也带着，触屏靠长按/点开）。
   用 -webkit-line-clamp 而不是 text-overflow：多行截断只有它能做。 */
.dr-note.is-mini .dr-note-q,
.dr-note.is-mini .dr-note-t{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.dr-note.is-mini .dr-note-q{margin-bottom:3px}
.dr-note.is-mini .dr-note-meta{margin-bottom:3px}
/* 深色主题下 secondary 本身够亮，字重别再加重，否则发糊 */
@media (prefers-color-scheme: dark){
  .dr-note-t{font-weight:400;color:var(--dsw-alias-label-primary)}
}

.dr-note-acts{display:flex;gap:6px;margin-top:7px}
.dr-note-acts button{font-size:11px;padding:2px 7px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.dr-note-acts button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}

/* ── 侧栏「问答」页签：小型对话框 ────────────────────────────────────
   结构：历史区（flex:1 可滚动）+ 输入区（固定在底部）。

   上一版把输入框放在**顶部**，每问一次都要把视线往上拽回输入框；
   真正像对话框的排布是「记录在上、输入在下」—— 这也是所有 IM 的做法。

   注意：这是**页签内**的布局，不是第二个滚动容器。
   .dr-side-body 本身已经在滚，所以这里改用 flex 列并让历史区自己滚，
   父级不能再滚，否则会出现两条滚动条打架。 */

/* 外层：撑满侧栏正文，列布局，输入区贴底 */
.dr-qa{display:flex;flex-direction:column;gap:0;min-height:0;height:100%}

/* 历史区：占满剩余高度，自己滚 */
.dr-qa-scroll{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:2px 2px 10px}

/* 空态：居中一句引导，不写长文 */
.dr-qa-empty{display:flex;align-items:center;justify-content:center;text-align:center;padding:22px 10px;flex:1}
.dr-qa-empty .dr-dim{max-width:230px}

/* 一轮：用户靠右、助手靠左。用对齐区分角色，比在气泡里写"我/你"清楚得多 */
.dr-qa-turn{display:flex;flex-direction:column;gap:4px;max-width:100%}
.dr-qa-turn.is-user{align-items:flex-end}
.dr-qa-turn.is-assistant{align-items:flex-start}

/* 用户轮引用提示：小字，跟着气泡靠右 */
.dr-qa-turn-ref{font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary);max-width:92%;text-align:right;word-break:break-word}

.dr-qa-bubble{font-size:12.5px;line-height:1.72;word-break:break-word;border-radius:9px;padding:7px 10px;max-width:94%;white-space:pre-wrap}
/* 用户气泡：纯文本，保留用户自己的换行（所以这里 pre-wrap 是对的） */
.dr-qa-turn.is-user .dr-qa-bubble{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-base));border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);color:var(--dsw-alias-label-primary)}
/* 助手气泡：Markdown 渲染，分段由渲染器负责，所以**不能** pre-wrap */
.dr-qa-turn.is-assistant .dr-qa-bubble{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);white-space:normal}

.dr-qa-dots{color:var(--dsw-alias-label-secondary);font-size:11.5px}

/* 输入区：不滚、贴底，上方一条分隔线把它和记录分开 */
.dr-qa-composer{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:9px 0 0;margin-top:auto}

/* 引用条：这一发的附件。整条可点掉，比在气泡里找 × 直观 */
.dr-qa-chip{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 7px;margin-bottom:7px;background:var(--dsw-alias-bg-layer-2);min-width:0}
.dr-qa-chip.is-empty{background:transparent;border-style:dashed}
.dr-qa-chip-t{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
.dr-qa-chip-x{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-qa-chip-add{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-family:inherit;font-size:10.5px;padding:1px 0;text-align:left}

/* 输入行：文本框 + 发送按钮 */
.dr-qa-inputrow{display:flex;align-items:flex-end;gap:7px}
.dr-qa-input{flex:1;min-width:0;min-height:38px;max-height:132px;resize:none;line-height:1.6}
.dr-qa-send{flex:none;width:32px;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center}
.dr-qa-send:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dr-qa-send:disabled{opacity:.45;cursor:not-allowed}
.dr-qa-send.is-stop{border-color:#d05555;color:#d05555}

.dr-qa-foot{display:flex;align-items:center;gap:8px;margin-top:5px}
.dr-qa-hint{font-size:10px;color:var(--dsw-alias-label-secondary)}
.dr-qa-clear{margin-left:auto;border:none;background:transparent;font-family:inherit;font-size:10px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dr-qa-clear:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dr-qa-clear:disabled{opacity:.5;cursor:not-allowed}

/* 旧样式里有几条现在不再使用（dr-qa-ref / dr-qa-answer / dr-qa-ref-*），
   保留它们的等价能力已并入上面的气泡与引用条，这里不再重复定义。 */

/* ── 笔记范围切换：全部 / 当页 ─────────────────────────────────────
   胶囊式两段开关。用 background 底槽 + 高亮块，而不是两个独立按钮：
   两个按钮在深色模式下会各自变成实心块，视觉噪音太大。
   ⚠️ 这套规则曾经被误删（见本文件上方问答样式处的说明），
   删掉后这些按钮会回落到浏览器默认样式 —— 浅灰实心块，深色下很刺眼。 */
.dr-scope{display:flex;gap:2px;margin:0 0 10px;padding:2px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);width:max-content}
.dr-scope button{font-size:11.5px;padding:3px 10px;border-radius:5px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;line-height:1.4;white-space:nowrap}
.dr-scope button:hover{color:var(--dsw-alias-label-primary)}
.dr-scope button.is-on{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgba(0,0,0,.12)}

/* 「当页」模式下本页为空时的提示 + 回到全部的出口 */
.dr-scope-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:-2px 0 10px}
.dr-scope-hint button{border:none;background:transparent;padding:0;margin-left:4px;font-family:inherit;font-size:11px;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline}

/* ── 批量清除 ───────────────────────────────────────────────────────
   危险操作两段式：先「清除全部」→ 变成「清除全部 N 条？不可恢复 / 确定清除 / 取消」。
   红色只在**确认之后**出现 —— 常态下按钮是灰的，否则整页都在喊"危险"，
   警告就贬值了。 */
.dr-clear-row{display:flex;justify-content:flex-end;margin:-4px 0 10px}
.dr-clear-btn{font-size:10.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.dr-clear-btn:hover{border-color:#d05555;color:#d05555}
.dr-confirm{display:flex;align-items:center;gap:6px;font-size:10.5px;color:#d05555;line-height:1.5;flex-wrap:wrap}
.dr-confirm button{font-size:10.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
/* 危险按钮同理：底色与文字色都要来自 token。
   固定 #d05555 在深色下偏暗、白字对比不足；用 error-primary 做底、
   label-primary-foreground 做字，两套主题都由宿主保证对比度。 */
.dr-confirm button.is-danger{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
/* hover 也走 token：硬编码 #bb3f3f 在深色下比底色更暗，看起来像按钮被按灭了 */
.dr-confirm button.is-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 82%,black)}

/* 章节级「清除本章」：常态极淡，hover 组头才显现 —— 组头已经很挤，
   常驻按钮会让列表变成按钮墙。 */
.dr-group-clear{font-size:10px;font-weight:400;padding:0 5px;margin-left:8px;border-radius:4px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;opacity:0;flex:none;transition:opacity .12s ease}
.dr-group:hover .dr-group-clear{opacity:1}
.dr-group-clear:hover{border-color:#d05555;color:#d05555}
.dr-group-confirm{display:flex;gap:4px;margin-left:8px;flex:none}
.dr-group-confirm button{font-size:10px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.dr-group-confirm button.is-danger{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}

/* 确认态提示：说明「即将删掉几条、范围是什么」，别让人凭记忆点确认 */
.dr-clear-hint{font-size:10.5px;color:#d05555;line-height:1.55;margin:-4px 0 10px}

/* 分组容器：组与组之间要有明显间隔，否则读完一章直接接上一章、
   分组的边界就看不出来了。基类规则曾在改样式时被带走，只剩组头那些后代规则。 */
.dr-group{margin-bottom:18px}
.dr-group:last-child{margin-bottom:0}

/* ── 按章分组的组头 ─────────────────────────────────────────────────
   三级：章号（小字灰）→ 章名（加粗）→ 条数（右贴）。
   为什么不用段名当组头：AI 框架里 chapter.no 全为 null，段名回答不了
   「这是第几章」，而按书读的人记的就是章号 —— 所以章号由程序按全书顺序自己编。 */
.dr-group-head{border-left:2.5px solid var(--dsw-alias-brand-primary);padding-left:8px;margin-bottom:7px}
.dr-group-title{display:flex;align-items:baseline;gap:6px;line-height:1.45}
.dr-group-no{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap}
.dr-group-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-group-count{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:auto;flex:none}

/* ── Markdown 渲染出来的元素 ────────────────────────────────────────
   回答区不再用 pre-wrap（分段由 renderMarkdown 负责），所以这些块
   需要自己带边距，否则段落会挤在一起。 */
.dr-md-p{margin:0 0 8px}
.dr-md-p:last-child,.dr-md-list:last-child{margin-bottom:0}
.dr-md-list{margin:0 0 8px;padding-left:18px}
/* 标题：1~3 级只差字号。模型用 ### 就已经很深了。 */
.dr-md-h{margin:10px 0 6px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.4}
/* 引用块：左侧细线，与正文区分 */
.dr-md-quote{border-left:2.5px solid var(--dsw-alias-border-l2);padding-left:8px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}
/* 行内代码：模型常用它框住变量名。等宽字体 + 浅底，别和普通文字混在一起 */
.dr-md-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-primary)}

/* 取消引用的 × */
.dr-qa-x{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;font-family:inherit;flex:none}
.dr-qa-x:hover{color:var(--dsw-alias-label-primary)}

.dr-dim{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:10px 0;line-height:1.6}
.dr-err{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:7px;padding:8px 10px;margin:8px 0}

/* 阅读中的操作错误条：贴在阅读栏下方，不占据正文区高度。
   带关闭按钮 —— 操作错误多数是暂时的（比如网络抖一下），
   留一条永久红字会让人以为界面坏了。 */
.dr-err-bar{display:flex;align-items:flex-start;gap:10px;margin:0;border-radius:0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);flex:none}
.dr-err-text{flex:1;min-width:0;word-break:break-word}
.dr-err-close{border:none;background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:15px;line-height:1;padding:0 2px;font-family:inherit;flex:none;opacity:.75}
.dr-err-close:hover{opacity:1}
.dr-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dr-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dr-pill.is-run{color:var(--dsw-alias-brand-primary)}
.dr-sep{width:1px;height:18px;background:var(--dsw-alias-border-l1);margin:0 2px}
/* ── 扩大视图：整块框架画布 ─────────────────────────────────────────────
   设计取自 nndl-ge全书框架.html 的版式语义（archify 生成的图）：
     · 每一「段」是一个横条大区（圆角框 + 段名）；
     · 段内章节排成一行，卡片上有章名 / 章号 / 要点；
     · 段与段之间用「↓ 进入下一段」的细线表示阅读顺序。

   **刻意不复刻**的是它那份固定坐标的 SVG：那张图坐标是画死的，
   而这里的章节来自 AI 生成、数量与标题都不定。所以只借版式语义，
   用 flex 让卡片自然排布 —— 8 章的段落一行放不下会自动换行。

   配色也不抄它的 #020617 那套：一个插件在宿主界面里必须穿宿主的衣服，
   用 --dsw-alias-* token，亮暗主题自动跟着走。 */
.dr-fwcanvas{position:absolute;inset:0;z-index:11;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column}
.dr-fwcanvas-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;background:var(--dsw-alias-bg-layer-1)}
.dr-fwcanvas-title{font-size:14px;font-weight:600}
.dr-fwcanvas-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dr-fwcanvas-body{flex:1;min-height:0;overflow:auto;padding:20px 22px 40px}
.dr-fwcanvas-inner{max-width:1180px;margin:0 auto}
.dr-fwcanvas-summary{font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary);margin:0 0 20px;padding:12px 14px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border-radius:0 8px 8px 0}
.dr-fwcanvas-howto{margin:22px 0 0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dr-fwcanvas-howto h4{margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dr-fwcanvas-howto ul{margin:0;padding-left:17px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.dr-fwcanvas-howto li{margin-bottom:5px}
/* ── 框架图（SVG）────────────────────────────────────────────────────
   颜色全部走 --dsw-alias-* token：亮暗主题切换时图自动跟着变。
   那份参考 HTML 用的是固定 #020617 深蓝，嵌进来会与宿主界面割裂，
   所以只借它的**版式语义**（框 = 分段 / 箭头 = 顺序 / 标签 = 递进），
   不借它的配色。 */
.dr-graph{width:100%;overflow:auto;padding:4px 0}


/* ① 分段区域框 */
.dr-g-band{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2);stroke-width:1}
.dr-g-band.is-here{fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1));stroke:var(--dsw-alias-brand-primary);stroke-width:1.5}
.dr-g-mask{fill:var(--dsw-alias-bg-base)}
.dr-g-bandname{fill:var(--dsw-alias-label-primary);font-weight:600}
.dr-g-bandq{fill:var(--dsw-alias-label-secondary)}

/* ②③ 箭头 */
.dr-g-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.dr-g-edge.is-cross{stroke:var(--dsw-alias-brand-primary);stroke-width:1.6}
.dr-g-arrowhead{fill:var(--dsw-alias-border-l2)}
.dr-g-joint{fill:var(--dsw-alias-border-l2)}
.dr-g-elabel{fill:var(--dsw-alias-brand-primary);font-weight:600;paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3;stroke-linejoin:round}

/* ④ 章节卡片 */
.dr-g-card{fill:var(--dsw-alias-bg-base);stroke:var(--dsw-alias-border-l1);stroke-width:1}
.dr-g-node:hover .dr-g-card{stroke:var(--dsw-alias-brand-primary)}
.dr-g-card.is-here{stroke:var(--dsw-alias-brand-primary);stroke-width:2;fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-base))}
.dr-g-idx{fill:var(--dsw-alias-label-secondary)}
.dr-g-here{fill:var(--dsw-alias-brand-primary);font-weight:600}
.dr-g-title{fill:var(--dsw-alias-label-primary);font-weight:600}
.dr-g-gist{fill:var(--dsw-alias-label-secondary)}
.dr-g-keybg{fill:var(--dsw-alias-bg-layer-2)}
.dr-g-key{fill:var(--dsw-alias-label-secondary)}
.dr-g-node{cursor:pointer}


`;

    function installStyles(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.id = 'dsh-reader-styles';
        style.textContent = CSS;
        document.head.append(style);
        return () => {
          style.remove();
        };
      }, 'dsh-reader: styles');
    }

    function ReaderIcon(props) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: (props && props.size) || 16,
          height: (props && props.size) || 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M8 3.4C6.7 2.2 4.6 2.1 3 2.1v10.4c1.6 0 3.7.1 5 1.3 1.3-1.2 3.4-1.3 5-1.3V2.1c-1.6 0-3.7.1-5 1.3z' }),
        h('path', { d: 'M8 3.4v10.4' }),
      );
    }

    /* ═══ 后端信封与 REST 客户端 ═════════════════════════════════════════ */
    function routeMessage(body) {
      const error = body && typeof body.error === 'object' && body.error !== null ? body.error : null;
      if (error && error.message) return String(error.message);
      return (body && (body.message || (typeof body.error === 'string' ? body.error : ''))) || '';
    }

    const API_BASE = '/api/dsh-reader';

    async function requestJson(path, init) {
      const res = await fetch(API_BASE + path, init);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('响应不是 JSON（HTTP ' + res.status + '）');
      }
      if (!res.ok || !body || body.ok !== true) {
        throw new Error(routeMessage(body) || '请求失败（HTTP ' + res.status + '）');
      }
      return body;
    }

    const api = {
      status: () => requestJson('/status'),
      books: () => requestJson('/books'),
      book: (id) => requestJson('/book?id=' + encodeURIComponent(id)),
      fileUrl: (id) => API_BASE + '/file?id=' + encodeURIComponent(id),
      coverUrl: (id) => API_BASE + '/cover?id=' + encodeURIComponent(id),
      vendorUrl: (name) => API_BASE + '/vendor/' + name,
      importPdf(file) {
        return fetch(API_BASE + '/import?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: file,
        }).then(async (res) => {
          let body;
          try {
            body = await res.json();
          } catch {
            throw new Error('导入响应异常（HTTP ' + res.status + '）');
          }
          if (!res.ok || !body || body.ok !== true) throw new Error(routeMessage(body) || '导入失败');
          return body.book;
        });
      },
      post: (path, payload) =>
        requestJson(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      // scale 可选：只在**要改缩放**时传。页码保存是高频的，绝不带 scale，
      // 否则每次翻页都会把用户刚设的缩放覆盖成旧值。
      saveProgress: (id, page, pct, pages, scale) =>
        api.post('/progress', scale === undefined ? { id, page, pct, pages } : { id, page, pct, pages, scale }),
      saveMark: (id, mark) => api.post('/mark', { id, mark }),
      deleteMark: (id, markId) => api.post('/mark', { id, deleteMarkId: markId }),
      saveNote: (id, note) => api.post('/note', { id, note }),
      /**
       * 批量清除。
       * @param {string} id
       * @param {{from:number, to:number}|null} range
       *   - null → 清空全部（**必须**显式传 null，不能省成 {}）
       *   - {from, to} → 只清页码区间（0 起，闭区间）
       */
      clearMarks: (id, range) => api.post('/clear', range === null ? { id, range: null } : { id, range }),
      removeBook: (id) => api.post('/delete', { id }),
      /** 重命名。后端会 trim + 合并连续空格，并把空/超长挡掉。 */
      renameBook: (id, title) => api.post('/rename', { id, title }),
      /**
       * 上传封面（PNG 字节），PUT 在宿主里不可用（FetchMethod 只允许 GET/HEAD/POST），
       * 所以后端把「写封面」挂在同一条 /cover 路由的 POST 上。
       */
      async uploadCover(id, blob) {
        const res = await fetch(API_BASE + '/cover?id=' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: blob,
        });
        if (!res.ok) throw new Error('封面保存失败（HTTP ' + res.status + '）');
        return true;
      },
      /** 打开 NDJSON 流，逐事件回调。 */
      async stream(path, payload, onEvent, signal) {
        const res = await fetch(API_BASE + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
        if (!res.ok) {
          let body;
          try {
            body = await res.json();
          } catch {
            throw new Error('请求失败（HTTP ' + res.status + '）');
          }
          throw new Error(routeMessage(body) || '请求失败（HTTP ' + res.status + '）');
        }
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader) throw new Error('响应没有可读流');
        const decoder = new TextDecoder();
        let buffer = '';
        const drain = (text) => {
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            try {
              onEvent(JSON.parse(trimmed));
            } catch {
              /* 半截行：丢掉，下一轮会补全 */
            }
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const cut = buffer.lastIndexOf('\n');
          if (cut === -1) continue;
          drain(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 1);
        }
        drain(buffer);
      },
    };

    /* ═══ pdf.js 载入（单例，从本插件的 vendor 路由动态 import）═══════════
       两条关键决策（都在 Node 里实测过，不是猜的）：

       1. **不建 Worker，走主线程 fake worker**。pdf.js 的 `PDFWorker._setupFakeWorker`
          只在 `globalThis.pdfjsWorker?.WorkerMessageHandler` 已有值时直接用主线程版本；
          把 worker 模块 import 进来挂到 globalThis，就完全不需要 `workerSrc`、不需要
          `new Worker(...)`。好处是少一次跨线程初始化、也不需要 worker 文件能作为模块加载
          （后者在带鉴权的路由上最容易出岔子）。代价是解码在 UI 线程上，单页书够快。
       2. **workerSrc 仍然赋一个值**。万一上面那条路失效（别处动过 globalThis），
          pdf.js 会退回 `new Worker(workerSrc)`；给它一个本插件的真实 URL，那条退路才是活的。
    */
    let pdfjsPromise = null;
    function loadPdfjs() {
      if (pdfjsPromise) return pdfjsPromise;
      pdfjsPromise = (async () => {
        const lib = await import(/* @vite-ignore */ api.vendorUrl('pdf.min.mjs'));
        try {
          const worker = await import(/* @vite-ignore */ api.vendorUrl('pdf.worker.min.mjs'));
          globalThis.pdfjsWorker = worker;
        } catch (error) {
          console.error('[dsh-reader] worker 模块没载入，将由 pdf.js 自己起 Worker', error);
        }
        lib.GlobalWorkerOptions.workerSrc = api.vendorUrl('pdf.worker.min.mjs');
        return lib;
      })().catch((error) => {
        pdfjsPromise = null;
        throw error;
      });
      return pdfjsPromise;
    }

    /* ═══ 页文本工具（与 host 半 lib 的定位逻辑同源，内联一份给浏览器）══════ */

    /** 6 元仿射矩阵复合。 */
    function composeTransform(m1, m2) {
      return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
      ];
    }

    /** 文字项 → viewport 空间盒子。 */
    function itemBox(item, viewportTransform, scale) {
      const tx = composeTransform(
        viewportTransform,
        item.transform && item.transform.length >= 6 ? item.transform.slice(0, 6) : [1, 0, 0, 1, 0, 0],
      );
      const height = Math.max(0.5, Math.hypot(tx[2], tx[3]));
      const width = Math.max(0, (item.width || 0) * scale);
      return [tx[4], tx[5] - height, tx[4] + width, tx[5]];
    }

    /** 项列表 → 页文本 + 偏移表。 */
    function buildPageText(items) {
      const chunks = [];
      const spans = [];
      let cursor = 0;
      for (const item of items) {
        if (!item.str) continue;
        if (chunks.length > 0) {
          chunks.push('\n');
          cursor += 1;
        }
        const start = cursor;
        chunks.push(item.str);
        cursor += item.str.length;
        spans.push({ start, end: cursor, item });
      }
      return { text: chunks.join(''), spans };
    }


    /**
     * 选区 → 页内偏移（**精确到字符**，不按文本项边界扩）。
     *
     * ## 旧版为什么会「标出来的比选中的多」
     *
     * 旧逻辑用矩形去猜：矩形与文本项**横向重叠 > 0** 即命中整项，然后
     * `offset = 首项开头`、`length = 末项结尾 − 首项开头`。
     *
     * pdf.js 会把一行切成很长的项（`这被称为涌现（E` 可能就是一项）。
     * 用户只选了该项中间几个字，但「沾到一点」→ 整项纳入 → 首尾扩到项边界。
     * 于是黄线比选区**两侧各多出半句**。
     *
     * ## 新逻辑：用浏览器算好的字符边界
     *
     * 文字层里每个文本项就是一个 span，`Range` 的 `startOffset/endOffset`
     * 直接给出「在第几个 span 的第几个字符起止」——浏览器已经算准了。
     * 矩形从此只用于定位浮层工具条，不再参与偏移计算。
     *
     * @param {{spans:any[], text:string}} page
     * @param {Range} range - 落在本页文字层内的选区
     * @returns {{offset:number, length:number, text:string}|undefined}
     */
    function offsetFromRange(page, range) {
      if (!page || !range) return undefined;
      const spans = page.spans;
      if (!spans || spans.length === 0) return undefined;

      /** 文本节点/元素 → 它属于 spans 里的哪一项（用 dataset.drStart 反查）。 */
      const indexOfNode = (node) => {
        let el = node && node.nodeType === 3 ? node.parentNode : node;
        while (el && !(el.dataset && el.dataset.drStart !== undefined)) el = el.parentNode;
        if (!el) return -1;
        const start = Number(el.dataset.drStart);
        for (let index = 0; index < spans.length; index += 1) {
          if (spans[index].start === start) return index;
        }
        return -1;
      };

      const firstIndex = indexOfNode(range.startContainer);
      const lastIndex = indexOfNode(range.endContainer);
      if (firstIndex < 0 || lastIndex < 0 || lastIndex < firstIndex) return undefined;

      const firstSpan = spans[firstIndex];
      const lastSpan = spans[lastIndex];
      // 夹到该项实际字符长度内：浏览器给的 offset 理论上不会越界，
      // 但跨行选中时末项可能带尾部空白，夹一下更稳。
      const startIn = Math.max(0, Math.min(range.startOffset, firstSpan.item.str.length));
      const endIn = Math.max(0, Math.min(range.endOffset, lastSpan.item.str.length));
      // 未经修正的精确区间（可能含项间分隔符）
      const offset = firstSpan.start + startIn;
      const end = lastSpan.start + endIn;

      // ## 起点落在项尾 / 终点落在项首时，要跳过项间的分隔符
      //
      // `buildPageText` 在文本项之间插了 `'\n'` 作为分隔（这样整页拼成一个字符串
      // 便于按偏移切片）。用户从「上一项的最后」拖到「下一项的开头」时，
      // Range 给出的 startOffset 正好等于上一项长度 —— 直接算下去，
      // 切出来的东西会**多带一个换行符**（实测 C4 就是 `"\n下一项"`）。
      // 那个 '\n' 不是用户选中的字符，只是我们自己拼文本时塞的。
      //
      // 所以：起点落在项尾 → 推进到下一项的开头；终点落在项首 → 退回上一项末尾。
      // 这是防御性的处理，代价是「只选了空隙」这种零字符选区会被判为无效（length<=0），
      // 这本来就是应该忽略的。
      let startAt = offset;
      let endAt = end;
      if (startIn >= firstSpan.item.str.length && firstIndex < lastIndex) {
        startAt = spans[firstIndex + 1].start;
      }
      if (endIn === 0 && lastIndex > firstIndex) {
        endAt = spans[lastIndex - 1].end;
      }

      const length = endAt - startAt;
      if (length <= 0) return undefined;
      return { offset: startAt, length, text: page.text.slice(startAt, startAt + length) };
    }
    /** `[offset, length)` → 要高亮的盒子。 */
    /** 一次渲染需要的整页数据：canvas 尺寸、文字层 span 列表、页文本。 */
    async function renderPageData(pageProxy, scale) {
      const viewport = pageProxy.getViewport({ scale });
      const content = await pageProxy.getTextContent();
      const items = [];
      for (const raw of content.items) {
        const str = typeof raw.str === 'string' ? raw.str : '';
        if (str === '') continue;
        items.push({
          str,
          transform: Array.isArray(raw.transform) ? raw.transform : [1, 0, 0, 1, 0, 0],
          width: typeof raw.width === 'number' ? raw.width : 0,
          box: itemBox(raw, viewport.transform, scale),
        });
      }
      return { viewport, items, pageText: buildPageText(items) };
    }

    /* ═══ 全书抽样：给「生成框架」喂结构信号 ═══════════════════════════════ */

    /** 每页留多少字。章节标题与关键概念几乎总在页首，塞整页只会烧 token。 */
    const SAMPLE_CHARS_PER_PAGE = 420;
    /** 最多抽多少页（再多模型也读不完，反而把输入挤爆）。 */
    const SAMPLE_MAX_PAGES = 90;

    /**
     * 一行字是否像页眉/页脚：极短、或几乎是纯数字/页码。
     * @param {string} line
     */
    function looksLikeFurniture(line) {
      const text = line.trim();
      if (text === '') return true;
      if (text.length <= 2) return true;
      if (/^[\s\-\u2013\u2014·|]*[0-9ivxlcdmIVXLCDM]{1,6}[\s\-\u2013\u2014·|]*$/.test(text)) return true;
      return false;
    }

    /**
     * 抽全书结构信号。
     *
     * 三条处理：
     * 1. **均匀抽样**：去头去尾各 4%，中间等距取 SAMPLE_MAX_PAGES 页 —— 章节边界在全书里
     *    均匀出现，按比例跳页比"前 N 页"更能覆盖全书。
     * 2. **剥离页眉页脚**：每页的首尾两行，如果像页码/极短行就丢掉。
     * 3. **每页截 420 字**：标题在前面，尾巴多半是习题和参考。
     *
     * @param {any} pdf - pdf.js 文档对象
     * @returns {Promise<Array<{page:number, text:string}>>}
     */
    async function samplePages(pdf) {
      const total = pdf.numPages;
      if (!total) return [];
      const pad = Math.floor(total * 0.04);
      const from = Math.min(pad, Math.max(0, total - 1));
      const to = Math.max(from, total - 1 - pad);
      const span = to - from + 1;
      const step = Math.max(1, Math.floor(span / SAMPLE_MAX_PAGES));
      const samples = [];
      for (let pageNumber = from + 1; pageNumber <= to + 1; pageNumber += step) {
        try {
          const pageProxy = await pdf.getPage(pageNumber);
          const content = await pageProxy.getTextContent();
          const lines = [];
          for (const raw of content.items) {
            if (typeof raw.str !== 'string' || raw.str.trim() === '') continue;
            lines.push(raw.str.trim());
          }
          if (lines.length === 0) continue;
          // 首尾各去一行家具；中间若也有纯页码行一并剔掉
          let body = lines;
          if (body.length > 4) {
            if (looksLikeFurniture(body[0])) body = body.slice(1);
            if (body.length > 3 && looksLikeFurniture(body[body.length - 1])) body = body.slice(0, -1);
          }
          body = body.filter((line) => !looksLikeFurniture(line) || line.length > 6);
          const text = body.join(' ').replace(/\s+/g, ' ').trim().slice(0, SAMPLE_CHARS_PER_PAGE);
          if (text.length < 12) continue;
          samples.push({ page: pageNumber, text });
        } catch {
          /* 单页抽不出来不致命：跳过，别让整次生成失败 */
        }
        if (samples.length >= SAMPLE_MAX_PAGES) break;
      }
      return samples;
    }

    /* ═══ 主页面 ═══════════════════════════════════════════════════════════ */
    function ReaderPage(props) {
      const [books, setBooks] = useState([]);
      const [loaded, setLoaded] = useState(false);
      const [activeId, setActiveId] = useState(null);
      const [error, setError] = useState('');
      const [dragOver, setDragOver] = useState(false);
      const [importing, setImporting] = useState('');
      const fileInput = useRef(null);

      const refresh = useCallback(async () => {
        try {
          const body = await api.books();
          setBooks(body.books || []);
          setError('');
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoaded(true);
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const doImport = useCallback(
        async (files) => {
          const list = Array.from(files || []).filter((file) => /\.pdf$/i.test(file.name));
          if (list.length === 0) {
            setError('第一版只收 PDF 文件');
            return;
          }
          for (const file of list) {
            setImporting(file.name);
            try {
              await api.importPdf(file);
            } catch (e) {
              setError(file.name + '：' + (e instanceof Error ? e.message : String(e)));
            }
          }
          setImporting('');
          await refresh();
        },
        [refresh],
      );

      const remove = useCallback(
        async (book) => {
          try {
            await api.removeBook(book.id);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
          await refresh();
        },
        [refresh],
      );

      /**
       * 重命名：返回 true 表示成功。
       *
       * 为什么要返回布尔而不是「fire-and-forget」：卡片在失败时要**留在编辑态**。
       * 悄悄失败的话，用户以为改成功了，下次打开发现还是旧名字 ——
       * 这跟上一版「写笔记点了没反应」是同一类体验问题。
       */
      const rename = useCallback(
        async (book, title) => {
          try {
            const result = await api.renameBook(book.id, title);
            // 局部更新，不整表刷新：刷新会让书架闪一下，且正在编辑的卡片会被重建
            setBooks((prev) =>
              prev.map((item) => (item.id === book.id ? { ...item, title: result.title } : item)),
            );
            return true;
          } catch (e) {
            setError(e instanceof Error ? e.message : '重命名失败');
            return false;
          }
        },
        [],
      );

      /* ── 封面补生成 ─────────────────────────────────────────────────────
         `hasCover: false` 的书，在书架空闲时**一本一本**补封面。

         为什么要串行 + 空闲：渲染一页 PDF 要几百毫秒到一两秒。
         一次导入 20 本书，若并发全部渲染，主线程会卡住好几秒，书架像死了。
         串行 + 一本失败就跳过，保证：① 界面始终能响应 ② 不会因为某一本
         坏文件让后面 19 本永远生成不出来。 */
      const coveringRef = useRef(false);
      useEffect(() => {
        if (!loaded || books.length === 0) return;
        const missing = books.filter((book) => !book.hasCover);
        if (missing.length === 0) return;
        if (coveringRef.current) return;
        coveringRef.current = true;
        let cancelled = false;
        (async () => {
          for (const book of missing) {
            if (cancelled) break;
            const blob = await renderCoverBlob(book.id);
            if (!blob) continue;
            try {
              await api.uploadCover(book.id, blob);
              if (cancelled) break;
              setBooks((prev) =>
                prev.map((item) => (item.id === book.id ? { ...item, hasCover: true } : item)),
              );
            } catch {
              // 单本上传失败不影响其它书
            }
          }
          coveringRef.current = false;
        })();
        return () => {
          cancelled = true;
        };
      }, [loaded, books]);

      if (activeId) {
        return h(ReaderView, {
          key: activeId,
          bookId: activeId,
          onBack: () => {
            setActiveId(null);
            refresh();
          },
        });
      }

      return h(
        'div',
        {
          className: 'dr-root',
          onDragOver: (e) => {
            e.preventDefault();
            setDragOver(true);
          },
          onDragLeave: (e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            setDragOver(false);
          },
          onDrop: (e) => {
            e.preventDefault();
            setDragOver(false);
            doImport(e.dataTransfer && e.dataTransfer.files);
          },
        },
        h(
          'div',
          { className: 'dr-shelf' },
          h(
            'div',
            { className: 'dr-shelf-head' },
            h('h2', { className: 'dr-shelf-title' }, '书架'),
            h('span', { className: 'dr-shelf-sub' }, loaded ? books.length + ' 本' : '载入中'),
            h(
              'div',
              { className: 'dr-shelf-tools' },
              importing ? h('span', { className: 'dr-pill is-run' }, '导入 ' + importing + '…') : null,
              h(
                'button',
                { className: 'dr-btn is-primary', onClick: () => fileInput.current && fileInput.current.click() },
                '导入 PDF',
              ),
              h('input', {
                ref: fileInput,
                type: 'file',
                accept: 'application/pdf,.pdf',
                multiple: true,
                style: { display: 'none' },
                onChange: (e) => {
                  doImport(e.target.files);
                  e.target.value = '';
                },
              }),
            ),
          ),
          error ? h('div', { className: 'dr-err', style: { margin: '0 20px' } }, error) : null,
          h(
            'div',
            { className: 'dr-grid-scroll' },
            books.length === 0
              ? h(
                  'div',
                  { className: 'dr-empty' },
                  h('h3', null, loaded ? '书架还空着' : '正在读书架…'),
                  h(
                    'div',
                    null,
                    loaded ? '把 PDF 拖进来，或点右上角「导入 PDF」' : '',
                  ),
                  loaded
                    ? h('div', { className: 'dr-hint' }, '书会被复制进插件数据目录，原文件挪走也不影响；标注与进度跟着书走。')
                    : null,
                )
              : h(
                  'div',
                  { className: 'dr-grid' },
                  books.map((book) =>
                    h(BookCard, {
                      key: book.id,
                      book,
                      onOpen: () => setActiveId(book.id),
                      onRemove: remove,
                      onRename: rename,
                    }),
                  ),
                ),
          ),
          dragOver ? h('div', { className: 'dr-drop' }, '松手导入 PDF') : null,
        ),
      );
    }

    /** 封面色：按书名哈希取色相（书的内容色，不随明暗主题变）。 */
    function coverGradient(title) {
      let hash = 0;
      for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) % 360;
      const a = hash;
      const b = (hash + 42) % 360;
      return 'linear-gradient(150deg,hsl(' + a + ' 44% 42%),hsl(' + b + ' 46% 28%))';
    }

    /* ═══ 封面生成 ═════════════════════════

       封面就是书的**第一页**。看起来理所当然，但有个硬约束：
       宿主侧的 Node 没有 canvas 模块（`@napi-rs/canvas` / `node-canvas` 都没装），
       pdf.js 的 `page.render()` 拿不到真正的绘图上下文 —— 服务端渲染封面这条路不通。

       所以封面只能在**浏览器**里画一次，然后上传成 PNG 存进书目录，
       书架下次直接读这张图。一定要"只画一次"：
       书架一次显示几十本，每次打开都现渲染几十份 PDF，主线程会直接卡死。

       参数都是经验值，不是随手写的：
       · 宽 480px —— 卡片在书架上约 110~160px 宽，480 给 3 倍余量，Retina 也够
       · 高度随页面比例（大多是 2:3），不写死，横版书就不会被拉扁
       · 画完 `doc.destroy()` —— 不销毁的话 pdf.js 会一直占着那份文件句柄与内存 */
    const COVER_WIDTH = 480;
    /** 单张封面图的字节上限，与 store.js 的 MAX_COVER_BYTES 对齐。 */
    const COVER_MAX_BYTES = 2 * 1024 * 1024;

    /**
     * 把一本书的第一页渲染成 PNG Blob。
     * @param {string} bookId
     * @returns {Promise<Blob|undefined>} 失败返回 undefined（书架退回渐变占位）
     */
    async function renderCoverBlob(bookId) {
      let doc = null;
      try {
        const lib = await loadPdfjs();
        doc = await lib.getDocument({ url: api.fileUrl(bookId) }).promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        if (!(base.width > 0)) return undefined;
        const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) return undefined;
        // 白底：PDF 页面本身是透明的，不铺白底的话 PNG 会是黑底
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        const blob = await new Promise((resolve) => {
          canvas.toBlob((result) => resolve(result || undefined), 'image/png');
        });
        if (blob && blob.size > COVER_MAX_BYTES) {
          // 太大说明这页有整页大图，压不住就放弃 —— 后端也会拒收
          return undefined;
        }
        return blob;
      } catch (error) {
        console.error('[dsh-reader] 封面生成失败', bookId, error);
        return undefined;
      } finally {
        if (doc) {
          try {
            doc.destroy();
          } catch {
            /* 已经销毁过了 */
          }
        }
      }
    }

    function BookCard(props) {
      const { book, onOpen, onRemove, onRename } = props;
      const [renaming, setRenaming] = useState(false);
      const [draft, setDraft] = useState(book.title);
      const [coverFailed, setCoverFailed] = useState(false);
      const pct = book.progress && book.progress.pct ? Math.min(100, book.progress.pct) : 0;

      // 书名可能在外部被改（重命名成功后父组件刷新了列表），草稿要跟上。
      // 只在没进入编辑态时同步，否则会打断用户正在输入的内容。
      useEffect(() => {
        if (!renaming) setDraft(book.title);
      }, [book.title, renaming]);

      const commitRename = useCallback(async () => {
        const next = draft.trim();
        if (next === '' || next === book.title) {
          setRenaming(false);
          setDraft(book.title);
          return;
        }
        const ok = await onRename(book, next);
        // 失败时保持编辑态，让用户看到错误并改回来（而不是悄悄丢掉输入）
        if (ok) setRenaming(false);
      }, [draft, book, onRename]);

      /**
       * 封面图。`?v=` 带上「有没有封面」的状态和书名 —— 重命名或重新生成后
       * 浏览器不会拿旧缓存。后端本身是 no-store，这里只是双保险。
       */
      const coverSrc = book.hasCover
        ? api.coverUrl(book.id) + '?v=' + encodeURIComponent(book.title).slice(0, 24)
        : '';

      return h(
        'div',
        { className: 'dr-book' },
        h(
          'button',
          {
            className: 'dr-book-open',
            onClick: onOpen,
            title: book.fileName + (book.hasCover ? '' : '（封面待生成）'),
          },
          h(
            'div',
            {
              className: 'dr-cover' + (book.hasCover && !coverFailed ? ' has-image' : ''),
              style: book.hasCover && !coverFailed ? undefined : { background: coverGradient(book.title) },
            },
            book.hasCover && !coverFailed
              ? h('img', {
                  className: 'dr-cover-img',
                  src: coverSrc,
                  alt: book.title,
                  loading: 'lazy',
                  decoding: 'async',
                  onError: () => setCoverFailed(true),
                })
              : null,
            h('div', { className: 'dr-cover-spine' }),
            // 有真封面时不再压标题文字：那会把书自己的封面盖住
            book.hasCover && !coverFailed ? null : h('div', { className: 'dr-cover-title' }, book.title),
            book.markCount ? h('div', { className: 'dr-cover-mark' }, book.markCount + ' 标注') : null,
            pct > 0 ? h('div', { className: 'dr-cover-progress' }, h('i', { style: { width: pct + '%' } })) : null,
          ),
        ),
        renaming
          ? h(
              'div',
              { className: 'dr-book-rename' },
              h('input', {
                className: 'dr-rename-input',
                value: draft,
                autoFocus: true,
                maxLength: 80,
                onChange: (e) => setDraft(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(false);
                    setDraft(book.title);
                  }
                },
                onBlur: () => commitRename(),
              }),
            )
          : h(
              'div',
              { className: 'dr-book-name-row' },
              h('div', { className: 'dr-book-name' }, book.title),
              h(
                'button',
                {
                  className: 'dr-icon-btn dr-book-rename-btn',
                  title: '重命名',
                  onClick: (e) => {
                    e.stopPropagation();
                    setDraft(book.title);
                    setRenaming(true);
                  },
                },
                '✎',
              ),
            ),
        h(
          'div',
          { className: 'dr-book-meta' },
          h('span', null, pct > 0 ? Math.round(pct) + '%' : '新书'),
          h('span', null, book.framework && book.framework.status === 'done' ? '有框架' : '无框架'),
        ),
        h(
          'button',
          {
            className: 'dr-icon-btn dr-book-del',
            title: '从书架删除',
            onClick: (e) => {
              e.stopPropagation();
              if (window.confirm('删除《' + book.title + '》？标注、笔记、框架会一起删掉，不可恢复。'))
                onRemove(book);
            },
          },
          '×',
        ),
      );
    }

    /* ═══ 框架 → 章节归属（纯函数）══════════════════════════════════════════ */

    /**
     * 页码（1 起）落在框架的哪一章。
     *
     * 抽成模块级纯函数而不是留在组件里，是因为有三处在用：
     * `ReaderView` 判「读到哪」、`FrameworkCanvas` 高亮当前章、
     * `NotesTab` 把标注按章分组。三份各写一遍就会各自漂移。
     *
     * @param {object|undefined} data - framework.data（parts → chapters）
     * @param {number} pageNumber - 1 起的页码
     * @returns {{part:object, chapter:object}|undefined}
     */
    function chapterForPage(data, pageNumber) {
      if (!data || !data.parts) return undefined;
      for (const part of data.parts) {
        for (const chapter of part.chapters || []) {
          if (!chapter.pages || chapter.pages.length < 1) continue;
          const start = chapter.pages[0];
          const end = chapter.pages[1] == null ? start : chapter.pages[1];
          if (pageNumber >= start && pageNumber <= end) return { part, chapter };
        }
      }
      return undefined;
    }

    /* ═══ 阅读器 ═══════════════════════════════════════════════════════════ */
    function ReaderView(props) {
      const { bookId, onBack } = props;
      const [book, setBook] = useState(null);
      const [error, setError] = useState('');
      const [pdf, setPdf] = useState(null);
      const [pageCount, setPageCount] = useState(0);
      const [page, setPage] = useState(0);
      const [scale, setScale] = useState(DEFAULT_SCALE);
      const [sideOpen, setSideOpen] = useState(true);
      const [sideTab, setSideTab] = useState('framework');
      /** 框架是否处于「扩大」态：扩大后画布铺满阅读区，PDF 暂时让位。 */
      const [fwExpanded, setFwExpanded] = useState(false);
      const [marks, setMarks] = useState([]);
      const [notes, setNotes] = useState([]);
      const [framework, setFramework] = useState({ status: 'none', data: null, error: '' });

      /** 页码的同步镜像：wheel/键盘连发时 React state 还没更新，靠它自增。 */
      const pageRef = useRef(0);

      // ── 打开书：读 meta + 载 pdf ──────────────────────────────────────
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const body = await api.book(bookId);
            if (!alive) return;
            const state = body.book;
            setBook(state);
            setMarks(state.marks || []);
            setNotes(state.notes || []);
            setFramework(state.framework || { status: 'none', data: null, error: '' });
            /**
             * 缩放回填。`scale: 0` 表示这本书从没设置过（见 store.js 注释），
             * 这时保持组件默认值 —— 不能拿 0 去 clamp，那会变成下限 0.5，
             * 老书一打开就被缩小，用户会以为设置坏了。
             */
            const savedScale = state.progress && state.progress.scale;
            if (Number.isFinite(savedScale) && savedScale > 0) {
              setScale(clampScale(savedScale));
            }
            const startPage = Math.max(0, Math.min((state.progress && state.progress.page) || 0, Math.max(0, (state.pages || 1) - 1)));
            pageRef.current = startPage;
            setPage(startPage);
          } catch (e) {
            if (alive) setError(e instanceof Error ? e.message : String(e));
            return;
          }
          try {
            const lib = await loadPdfjs();
            const doc = await lib.getDocument({ url: api.fileUrl(bookId) }).promise;
            if (!alive) {
              doc.destroy();
              return;
            }
            setPdf(doc);
            setPageCount(doc.numPages);
            // 页码以 pageRef 为准（它已在读 meta 时被设为「上次读到的位置」）。
            const clamped = Math.max(0, Math.min(pageRef.current, doc.numPages - 1));
            pageRef.current = clamped;
            setPage(clamped);
            // 首次打开就把真实总页数落盘：书架的进度百分比要它，否则要等第一次翻页才有。
            api
              .saveProgress(bookId, clamped, ((clamped + 1) / doc.numPages) * 100, doc.numPages)
              .catch(() => {});
          } catch (e) {
            if (alive) setError('PDF 载入失败：' + (e instanceof Error ? e.message : String(e)));
          }
        })();
        return () => {
          alive = false;
        };
      }, [bookId]);

      // ── 缩放落盘 ─────────────────────────────────────────────────────
      //
      // ## 为什么单独一条通道，不塞进下面的「进度落盘」
      //
      // 进度落盘那个 `lastSaved` 结构是 { at, page, pages }，它只关心页码。
      // 如果把 scale 塞进去，会立刻死在一个具体场景：
      //   设成 1.8 → 写入 → 滚动翻页 → 进度落盘用 `lastSaved` 里的旧 page/pages
      //   拼出请求，而这个请求**不带 scale**……
      // 后端那边已经做了「不传 scale 就不改 scale」（见 store.js saveProgress），
      // 所以数据不会坏；但前端这边把两件事塞进一个节流器会让「哪个字段该写」
      // 变得依赖时序，调试时极难复现。
      //
      // 缩放是**低频**操作（用户点几下 +/− 就停），用简单防抖足够：
      // 连点五下只写一次，停手 800ms 后落盘。
      // 卸载时补一次 fire-and-forget（与页码那条一样，保证关页面不丢）。
      const scaleTimer = useRef(null);
      const scaleRef = useRef(DEFAULT_SCALE);
      // 记住上次真正写盘的倍数：避免 mount 时那次"回填"被当成用户操作又写一遍。
      const savedScaleRef = useRef(DEFAULT_SCALE);

      useEffect(() => {
        scaleRef.current = scale;
      }, [scale]);

      useEffect(() => {
        // mount / 回填阶段不写：那时 scale 还是从磁盘读回来的值，写一遍纯属噪音。
        if (Math.abs(scale - savedScaleRef.current) < 0.001) return;
        if (scaleTimer.current) clearTimeout(scaleTimer.current);
        scaleTimer.current = setTimeout(() => {
          scaleTimer.current = null;
          savedScaleRef.current = scale;
          api.saveProgress(bookId, pageRef.current, 0, pageCount, scale).catch(() => {});
        }, 800);
        return () => {
          if (scaleTimer.current) {
            clearTimeout(scaleTimer.current);
            scaleTimer.current = null;
          }
        };
      }, [scale, bookId, pageCount]);

      // 关书/切走：把没落盘的那次缩放补上。
      // 注意这里**不传页码**（page 用 0 会让后端把进度归零），
      // 所以直接走 POST，只带 scale —— 后端对缺省字段是"保持不变"。
      useEffect(
        () => () => {
          if (scaleTimer.current) {
            clearTimeout(scaleTimer.current);
            scaleTimer.current = null;
          }
          const pending = scaleRef.current;
          if (Math.abs(pending - savedScaleRef.current) < 0.001) return;
          fetch(API_BASE + '/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: bookId, scale: pending }),
          }).catch(() => {});
        },
        [bookId],
      );

      // ── 进度落盘 ─────────────────────────────────────────────────────
      //
      // 连续滚动之后「翻页」变成了「滚过一页就换 current」，每秒可能触发好几次。
      // 纯防抖（每次重排 reset 定时器）在长时间连续滚动下会一直不写，
      // 关页面时那次就白读了。所以用**节流 + 尾随**：
      //   · 距上次写盘 ≥1.2s → 立刻写
      //   · 否则记下来，等安静下来再补一次（尾随保证最后的位置一定落盘）
      const saveTimer = useRef(null);
      const lastSaved = useRef({ at: 0, page: -1, pages: 0 });
      const flushSave = useCallback(() => {
        const { page: pendingPage, pages } = lastSaved.current;
        if (pendingPage < 0) return;
        const total = pages || pageCount || 0;
        const pct = total > 0 ? ((pendingPage + 1) / total) * 100 : 0;
        api.saveProgress(bookId, pendingPage, pct, total).catch(() => {});
        lastSaved.current = { at: Date.now(), page: -1, pages: total };
      }, [bookId, pageCount]);

      const persist = useCallback(
        (nextPage, total) => {
          const pages = total || pageCount || 0;
          // 页码没变就不折腾
          if (nextPage === lastSaved.current.page && pages === lastSaved.current.pages && lastSaved.current.page >= 0) {
            return;
          }
          lastSaved.current = { ...lastSaved.current, page: nextPage, pages };
          const gap = Date.now() - lastSaved.current.at;
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          if (gap >= 1200) {
            flushSave();
            return;
          }
          saveTimer.current = setTimeout(() => {
            saveTimer.current = null;
            flushSave();
          }, 1200 - gap + 60);
        },
        [pageCount, flushSave],
      );

      // 关书 / 切走时把没落盘的那次补上（否则读到一半直接点返回，进度就丢了）
      useEffect(
        () => () => {
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          const { page: pendingPage, pages } = lastSaved.current;
          if (pendingPage < 0) return;
          const total = pages || 0;
          if (total <= 0) return;
          const pct = ((pendingPage + 1) / total) * 100;
          // 卸载阶段不能靠 state，直接发一次 fire-and-forget
          fetch(API_BASE + '/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: bookId, page: pendingPage, pct, pages: total }),
          }).catch(() => {});
        },
        [bookId],
      );

      /**
       * 滚动判定出的页码回调：**必须是稳定引用**。
       *
       * 内联箭头函数会让父组件每次 setPage 之后给子组件换一个全新的回调对象；
       * 子组件（ContinuousPdf）里只要有任何 effect 依赖它，就会「父渲染 → 子 effect 重跑」。
       * 上一版的「自动跳」正是这条回路：重跑的那个 effect 里有 `stage.scrollTop = …`。
       */
      /**
       * 待送进「问答」页签的引用：{ page, offset, length, text, question? } 或 null。
       *
       * 正文浮动条 → 侧栏页签 的桥梁。AskTab 消费后回调 onConsumeQA 清空，
       * 否则切页签时会重复注入同一条引用。
       */
      const [pendingQA, setPendingQA] = useState(null);

      /**
       * 把当前位置送进「问答」页签。
       *
       * payload 里已经带着 offset/length —— 这两个数就是要发给后端的「位置」，
       * 后端据此自己去 PDF 里切原文。text 只用于界面预览。
       */
      const sendToQA = useCallback((payload) => {
        if (!payload) return;
        setPendingQA({
          page: Number.isFinite(payload.page) ? payload.page : pageRef.current,
          offset: Number.isFinite(payload.offset) ? payload.offset : undefined,
          length: Number.isFinite(payload.length) ? payload.length : undefined,
          text: typeof payload.text === 'string' ? payload.text : '',
          question: typeof payload.question === 'string' ? payload.question : '',
        });
        setSideTab('qa');
        setSideOpen(true);
      }, []);

      const consumeQA = useCallback(() => setPendingQA(null), []);

      const onScrollPage = useCallback(
        (next) => {
          if (next === pageRef.current) return;
          pageRef.current = next;
          setPage(next);
          persist(next, pageCount);
        },
        [persist, pageCount],
      );

      /**
       * 跳到某一页（框架、笔记里点「定位」走这里）。
       * 连续滚动之后「翻页」= 滚到那一页的顶部，由 ContinuousPdf 自己滚；
       * 这里只更新页码并递增 jumpToken 触发它。
       */
      const jumpRef = useRef({ token: 0, page: 0 });
      const [jump, setJump] = useState({ token: 0, page: 0 });
      const goPage = useCallback(
        (target, total) => {
          const pages = total || pageCount || 1;
          const next = Math.max(0, Math.min(pages - 1, target));
          pageRef.current = next;
          setPage(next);
          jumpRef.current = { token: jumpRef.current.token + 1, page: next };
          setJump(jumpRef.current);
          persist(next, pages);
        },
        [pageCount, persist],
      );

      // ── 键盘：翻的是「一屏」，不是「一页」─────────────────────────────
      //
      // 连续滚动下按箭头就整页跳，会把人扔出上下文（一段话常跨两页）。
      // 但 PageUp/PageDown 的语义本来就是翻屏，所以：
      //   方向键 → 滚一页（延续原先的翻页手感，且便于对页定位）
      //   空格/PgUp/PgDn → 交给浏览器原生翻屏（不拦，最自然）
      useEffect(() => {
        const onKey = (e) => {
          if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            goPage(pageRef.current + 1);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            goPage(pageRef.current - 1);
          } else if (e.key === 'Escape') {
            onBack();
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            goPage(e.key === 'Home' ? 0 : pageCount - 1);
          }
        };
        document.addEventListener('keydown', onKey);
        // 滚轮完全交给浏览器：连续阅读里「用户自己滚」才是正确的交互，
        // 插件去接管 wheel 只会让人滚不动、还容易和触控板惯性打架。
        return () => document.removeEventListener('keydown', onKey);
      }, [goPage, onBack, pageCount]);

      // ── 标注写入 ──────────────────────────────────────────────────────
      //
      // ⚠️ 依赖里**不能**放 `book`。上一版是 `[bookId, book]`，而这里又会 setBook，
      // 于是「标注一次 → book 换新 → addMark 换新引用 → 传给子组件的新 props」。
      // 现在子组件没把 onMark 放进任何 effect 依赖，所以只是白重渲染；
      // 但这条回路一旦有人往依赖里加一项，就会重演「父渲染 → 子 effect 重跑」的死循环。
      // 所以用**函数式更新**把 book 从依赖里彻底摘掉。
      const addMark = useCallback(
        async (draft) => {
          try {
            const body = await api.saveMark(bookId, draft);
            const nextMarks = body.marks || [];
            setMarks(nextMarks);
            setBook((prev) => (prev ? { ...prev, markCount: nextMarks.length } : prev));
          } catch (e) {
            setError('标注保存失败：' + (e instanceof Error ? e.message : String(e)));
          }
        },
        [bookId],
      );

      /**
       * 更新一条标注（改笔记 / 改颜色）。
       *
       * **返回 true/false**：调用方（笔记编辑器）要靠它决定「能不能关编辑器」。
       * 上一版返回 undefined，调用方无从判断，于是不论成败都关掉编辑框，
       * 失败时用户写的内容就白写了。
       */
      const updateMark = useCallback(
        async (markId, patch) => {
          try {
            const body = await api.saveMark(bookId, { id: markId, ...patch });
            setMarks(body.marks || []);
            setError('');
            return true;
          } catch (e) {
            setError('标注更新失败：' + (e instanceof Error ? e.message : String(e)));
            return false;
          }
        },
        [bookId],
      );

      const removeMark = useCallback(
        async (markId) => {
          try {
            const body = await api.deleteMark(bookId, markId);
            setMarks(body.marks || []);
          } catch (e) {
            setError('标注删除失败：' + (e instanceof Error ? e.message : String(e)));
          }
        },
        [bookId],
      );

      /**
       * 批量清除。`range === null` 清全书，否则清该页码区间。
       *
       * 成功后用响应里的 marks/notes 覆盖本地状态 —— 不信「本地过滤一遍」
       * 那种做法：清完之后本地和磁盘就该完全一致，否则下次刷新会「复活」残留。
       */
      const clearMarks = useCallback(
        async (range) => {
          try {
            const body = await api.clearMarks(bookId, range);
            setMarks(body.marks || []);
            setNotes(body.notes || []);
            setBook((prev) => (prev ? { ...prev, markCount: (body.marks || []).length } : prev));
          } catch (e) {
            setError('清除失败：' + (e instanceof Error ? e.message : String(e)));
          }
        },
        [bookId],
      );

      const saveNote = useCallback(
        async (note) => {
          try {
            const body = await api.saveNote(bookId, note);
            setNotes(body.notes || []);
          } catch (e) {
            setError('笔记保存失败：' + (e instanceof Error ? e.message : String(e)));
          }
        },
        [bookId],
      );

      const onFramework = useCallback((next) => setFramework(next), []);

      /** 当前页落在框架的哪一章 —— 侧栏与扩大画布都要它，所以提到外面算一次。 */
      const currentChapter = useMemo(
        () => chapterForPage(framework && framework.data, page + 1),
        [framework, page],
      );

      /* ── AI 生成全书框架：前端抽页内文本 → Host 半调模型 → 流式进度 ────────
         为什么抽取在浏览器而不是 Host：Host 半是 vm 沙箱、没有计时器也不该扛
         pdf.js 的重活；页面这边本来就已经按页取过 textContent，顺手就能抽。
         抽样纪律：均匀覆盖全书 + 每页去掉页眉页脚（用「按行重复出现」判定），
         每页只留 400 字 —— 章节标题与关键概念几乎总在开头，塞整页只会烧 token。 */
      const generateFramework = useCallback(async () => {
        if (!pdf || framework.status === 'running') return;
        setFramework({ ...framework, status: 'running', error: '' });
        setSideTab('framework');
        try {
          const samples = await samplePages(pdf);
          if (samples.length === 0) throw new Error('这本书没有可抽的文字层（可能是扫描版图片 PDF）');
          await api.stream(
            '/framework',
            { id: bookId, samples },
            (event) => {
              if (event.type === 'done') {
                setFramework({ status: 'done', data: event.framework, error: '', generatedAt: Date.now() });
              } else if (event.type === 'error') {
                setFramework({ status: 'failed', data: null, error: event.message || '生成失败' });
              }
            },
            undefined,
          );
        } catch (e) {
          setFramework({ status: 'failed', data: null, error: e instanceof Error ? e.message : String(e) });
        }
      }, [pdf, framework, bookId]);

      if (error && !pdf) {
        return h(
          'div',
          { className: 'dr-root' },
          h('div', { className: 'dr-reader' },
            h('div', { className: 'dr-reader-bar' }, h('button', { className: 'dr-btn is-ghost', onClick: onBack }, '‹ 书架')),
            h('div', { className: 'dr-loading' }, h('div', { className: 'dr-err' }, error)),
          ),
        );
      }

      const title = book ? book.title : '载入中…';

      return h(
        'div',
        { className: 'dr-root' },
        h(
          'div',
          { className: 'dr-reader' },
          h(
            'div',
            { className: 'dr-reader-bar' },
            h('button', { className: 'dr-btn is-ghost', onClick: onBack, title: '返回书架（Esc）' }, '‹ 书架'),
            h('div', { className: 'dr-reader-title' }, title),
            h('div', { className: 'dr-spacer' }),
            h('span', { className: 'dr-page-ind' }, pageCount ? page + 1 + ' / ' + pageCount : '…'),
            h('div', { className: 'dr-sep' }),
            h('button', { className: 'dr-icon-btn', title: '缩小', onClick: () => setScale((s) => clampScale(s - SCALE_STEP)) }, '−'),
            h('span', { className: 'dr-page-ind', style: { minWidth: 34, textAlign: 'center' } }, Math.round(scale * 100) + '%'),
            h('button', { className: 'dr-icon-btn', title: '放大', onClick: () => setScale((s) => clampScale(s + SCALE_STEP)) }, '+'),
            h('div', { className: 'dr-sep' }),
            h(
              'button',
              { className: 'dr-btn is-ghost', onClick: () => setSideOpen((v) => !v), title: '框架 / 进度 / 笔记' },
              sideOpen ? '收起侧栏' : '侧栏',
            ),
          ),
          /**
           * 操作类错误条（标注/笔记/清除失败）。
           *
           * ⚠️ 这里必须**独立于 PDF 载入**显示。上一版只在上面的 `error && !pdf`
           * 分支里渲染错误，而「写笔记失败」时 PDF 早就载入成功了 ——
           * 所以错误文案永远不显示，用户点「保存」什么也看不到，
           * 体验就是「点了没反应」。
           */
          error
            ? h(
                'div',
                { className: 'dr-err dr-err-bar' },
                h('div', { className: 'dr-err-text' }, error),
                h('button', { className: 'dr-err-close', title: '关闭提示', onClick: () => setError('') }, '×'),
              )
            : null,
          h(
            'div',
            { className: 'dr-viewer' },
            pdf
              ? h(ContinuousPdf, {
                  pdf,
                  scale,
                  pageCount,
                  marks,
                  initialPage: pageRef.current,
                  jumpToken: jump.token,
                  jumpPage: jump.page,
                  onCurrentPage: onScrollPage,
                  onMark: addMark,
                  // 送到侧栏「问答」页签：唯一的提问入口
                  onSendToQA: sendToQA,
                })
              : h('div', { className: 'dr-stage' }, h('div', { className: 'dr-loading' }, h('div', { className: 'dr-spinner' }), '正在载入 PDF…')),
            sideOpen && book
              ? h(SidePanel, {
                  tab: sideTab,
                  onTab: setSideTab,
                  book,
                  page,
                  pageCount,
                  framework,
                  onFramework,
                  marks,
                  notes,
                  onGotoMark: (mark) => goPage(mark.page),
                  onSaveNote: saveNote,
                  onDeleteMark: removeMark,
                  // 返回 Promise<boolean>：编辑器要据此决定是否关闭（见 NotesTab.commitEdit）。
                  onMarkNote: (mark, text) => updateMark(mark.id, { note: text }),
                  onClearMarks: clearMarks,
                  onGenerateFramework: generateFramework,
                  onExpandFramework: () => setFwExpanded(true),
                  currentChapter,
                  pendingQA,
                  onConsumeQA: consumeQA,
                })
              : null,
            // 扩大态：框架画布铺满阅读区（盖在 PDF 上），PDF 暂时让位。
            // 用绝对定位覆盖而不是替换 PDF，是为了**保住滚动位置与已渲染的页**——
            // 缩回去的时候不需要重新加载、也不会跳回页首。
            fwExpanded && book
              ? h(FrameworkCanvas, {
                  framework,
                  currentChapter,
                  onGotoMark: (payload) => {
                    setFwExpanded(false);
                    goPage(payload.page);
                  },
                  onGenerate: generateFramework,
                  bookTitle: book.title,
                  page,
                  pageCount,
                  onCollapse: () => setFwExpanded(false),
                })
              : null,
          ),
        ),
      );
    }

    /* ═══ 单页视图：canvas + 文字层 + 高亮层 + 选区工具条 ═══════════════════ */
    /* ═══ 连续滚动阅读 ═══════════════════════════════════════════════════
       不是「一页一页换」的幻灯片，而是像纸书那样上下连读。

       三条设计取舍（每条都有代价，先说清）：

       1. **先量尺寸、再占位、后渲染**。滚动容器里每一页是个固定高度的占位块，
          `getViewport({scale})` 只算尺寸不画像素，所以布局高度**一开始就是定值**。
          不做这一步的话，页面会随着渲染完成不断「长高」，滚动位置一路上跳。

       2. **只渲染窗口内的页**（可见页 ±2）。300 页的书如果全画 canvas，
          光位图就是几百 MB，浏览器会直接卡死或在移动端被 OOM 杀掉。
          窗口外的页保留占位高度，所以滚动条长度始终正确。

       3. **当前页靠滚动位置判定**，不靠「点下一页」。进度、框架高亮、
          标注卡片全跟着这个页码走 —— 手指滑两页，它们就该跟着变。
    */

    /** 窗口外缓冲多少页（上下各 2 页：滑起来不闪白，又不浪费内存）。 */
    const WINDOW_RADIUS = 2;

    /** 相邻页之间的间隙（纸书的页与页不会严丝合缝贴在一起）。 */
    const PAGE_GAP = 14;

    /**
     * 连续滚动的整本书视图。
     *
     * @param {{pdf:any, scale:number, pageCount:number, marks:any[],
     *   onMark:Function, onSendToQA:Function,
     *   initialPage:number, onCurrentPage:(n:number)=>void, jumpToken:number, jumpPage:number}} props
     */
    function ContinuousPdf(props) {
      const { pdf, scale, pageCount, marks, onMark, onSendToQA, initialPage, onCurrentPage } = props;
      const stageRef = useRef(null);
      /** 外层容器：量可用宽度做窄屏等比缩小。 */
      const wrapRef = useRef(null);
      /** 每页的尺寸表（一次算好，缩放变化才重算）。 */
      const [layout, setLayout] = useState(null);
      /**
       * 滚动容器是否已经真实存在于 DOM。
       *
       * 这个布尔量是**必需的 effect 依赖**，不是装饰：`layout` 为 null 时组件返回 loading div，
       * 页面上没有 `.dr-stage`，任何「挂滚动监听 / 观察容器尺寸」的 effect 在那时执行都只能
       * 拿到 null 并提前 return。若依赖里没有它，那批 effect 就再也不会重跑 ——
       * 表现正是「只加载了几页，怎么滚都不再加载」。
       */
      const containerReady = layout !== null;
      /** 当前要渲染的页区间（闭区间，1 起）。 */
      const [windowRange, setWindowRange] = useState({ from: 0, to: 0 });
      const [bubble, setBubble] = useState(null);
      /** 滚动节流用：最后一帧时间与待处理的句柄。 */
      const rafRef = useRef(null);
      const currentRef = useRef(initialPage || 0);

      // ── 2. 滚动 → 判定当前页 + 决定渲染窗口 ──────────────────────────
      //
      // 这里**绝不能**碰 scrollTop。它每帧都会跑；一旦在这里写滚动位置，
      // 就成了「用户滚 → 程序拽回去」的死循环，表现就是「自动跳」。
      /** 上一次通知过的页码，只在变化时通知父级。 */
      const lastReportedPage = useRef(initialPage || 0);

      /** 父组件的回调存进 ref：**永不进入依赖数组**，否则父级一渲染就重挂监听。 */
      const onCurrentPageRef = useRef(onCurrentPage);
      useEffect(() => {
        onCurrentPageRef.current = onCurrentPage;
      }, [onCurrentPage]);

      /**
       * 重算当前页与渲染窗口。
       * @param {boolean} report - 是否把页码变化通知父级
       *   （重排保位时传 false：那时页码不该变，也就没必要惊动父级状态）
       */
      const recompute = useCallback(
        (report) => {
          const stage = stageRef.current;
          const current = layoutRef.current;
          if (!stage || !current) return;
          const scrollTop = stage.scrollTop;
          const viewportHeight = stage.clientHeight;
          const heights = current.heights;
          // 每页占位高度 = 页高 + 间隙
          const pitch = heights.map((height) => height + PAGE_GAP);
          const offsets = [];
          let acc = 0;
          for (const step of pitch) {
            offsets.push(acc);
            acc += step;
          }
          // 当前页：**视口顶部**落在哪一页。
          // 不用「中线」判据 —— 中线会让页码在当前页还没读完、下一页只露出一点时就提前跳，
          // 那种「页码自己变了」在连续滚动里同样会被感知成"跳"。
          let page = 0;
          for (let index = 0; index < offsets.length; index += 1) {
            if (scrollTop >= offsets[index]) page = index;
            else break;
          }
          currentRef.current = page;
          if (report && page !== lastReportedPage.current) {
            lastReportedPage.current = page;
            if (typeof onCurrentPageRef.current === 'function') onCurrentPageRef.current(page);
          }
          // 渲染窗口：可见范围内所有页 + 上下缓冲
          let firstVisible = 0;
          for (let index = 0; index < offsets.length; index += 1) {
            if (scrollTop >= offsets[index] + pitch[index]) continue;
            firstVisible = index;
            break;
          }
          let lastVisible = firstVisible;
          const bottom = scrollTop + viewportHeight;
          for (let index = firstVisible; index < offsets.length; index += 1) {
            lastVisible = index;
            if (offsets[index] + pitch[index] >= bottom) break;
          }
          const from = Math.max(0, firstVisible - WINDOW_RADIUS);
          const to = Math.min(pageCount - 1, lastVisible + WINDOW_RADIUS);
          setWindowRange((prev) => (prev.from === from && prev.to === to ? prev : { from, to }));
        },
        [pageCount],
      );

      // ── 1. 量尺寸：给每页算出宽高，占位块据此排布 ────────────────────
      //
      // 实测（360 页的 nndl-ge.pdf）：`getPage` + `getViewport` 只算尺寸**不画像素**，
      // 100 页只要 5ms。所以这里直接量全书，不做「前 3 页猜比例」那套估算 ——
      // 估算法在有横页/异形页的书上会把占位高度算错，滚动位置跟着跳。
      /** 原始页高（未乘适配系数），供容器变化时重算。 */
      const rawHeights = useRef(null);
      /** 原始页宽。 */
      const rawWidth = useRef(0);
      /** 最新 layout 的同步镜像：回调里读它，免得闭包拿到旧值。 */
      const layoutRef = useRef(null);
      /** 重排后要还原的锚点；null = 不做保位。 */
      const pendingAnchor = useRef(null);
      /** 是否已经做过「初次定位」。只做一次，之后绝不再碰 scrollTop。 */
      const hasPositioned = useRef(false);

      // 镜像同步放在 **render 期间**而不是 effect 里：ResizeObserver 的回调随时可能
      // 在两次 commit 之间触发，它要读到的一定是「刚提交的那个 layout」。
      // 放 effect 的话存在一个窗口：ref 还是旧的、DOM 已是新的。
      //
      // ⚠️ 这一行必须写在 `const layoutRef = useRef(null)` **之后**：
      // 写前面会命中 `const` 的暂时性死区（TDZ）→ ReferenceError → 组件渲染即抛错 →
      // 整个面板被卸载，用户看到的是「什么都看不到」。这条血泪教训的回归断言见
      // scripts/render-order-check.mjs。
      layoutRef.current = layout;

      /**
       * 提交布局（宽度 × 适配系数）。
       * @param {{page:number, offsetInPage:number, pageHeight:number}|null} anchor
       *   - 非空：重排后按锚点还原位置
       *   - null：交给「初次定位」分支处理
       */
      const commitLayout = useCallback((heights, width, anchor) => {
        // 窄屏适配：容器不够宽时等比缩小（不是压扁 canvas —— 压扁会让位图与
        // 文字层盒子不同尺度，选区整体错位且不报错）。
        const wrapWidth = wrapRef.current ? wrapRef.current.clientWidth : null;
        const available = Math.max(240, (wrapWidth ?? width) - 44);
        const fit = width > available ? available / width : 1;
        pendingAnchor.current = anchor;
        setLayout({ width: width * fit, heights: heights.map((height) => height * fit), fit });
      }, []);

      // 首次量尺寸：pdf / 缩放 / 页数变了才重量整本
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const heights = [];
            let width = 0;
            for (let index = 0; index < pageCount; index += 1) {
              const pageProxy = await pdf.getPage(index + 1);
              const viewport = pageProxy.getViewport({ scale });
              heights.push(viewport.height);
              width = Math.max(width, viewport.width);
            }
            if (!alive) return;
            rawHeights.current = heights;
            rawWidth.current = width || 595 * scale;
            // 换了缩放/换了书：锚点作废，允许重新做一次初次定位
            pendingAnchor.current = null;
            hasPositioned.current = false;
            commitLayout(heights, rawWidth.current, null);
          } catch (error) {
            if (alive) console.error('[dsh-reader] 量页失败', error);
          }
        })();
        return () => {
          alive = false;
        };
      }, [pdf, pageCount, scale, commitLayout]);

      // 容器尺寸变化（侧栏开合 / 窗口缩放 / 只变高）：
      //   · 变宽变窄 → 重算 fit 并按锚点保位
      //   · 只变高（视口高度变了）→ 可见页数变了，必须重算渲染窗口
      //
      // 与滚动监听同一个坑：`wrapRef` 在 layout 就绪前是 null，这个 effect 若那时
      // 跑一遍就永远挂不上观察器。所以依赖里带上容器就绪标记。
      useEffect(() => {
        if (!containerReady) return;
        const wrap = wrapRef.current;
        if (!wrap || typeof ResizeObserver === 'undefined') return;
        let lastWidth = wrap.clientWidth;
        let lastHeight = wrap.clientHeight;
        const observer = new ResizeObserver(() => {
          const nextWidth = wrap.clientWidth;
          const nextHeight = wrap.clientHeight;
          // 阈值 8px：滚动条出现/消失会带来一两像素抖动，别为它重排整本
          const widthChanged = Math.abs(nextWidth - lastWidth) >= 8;
          const heightChanged = Math.abs(nextHeight - lastHeight) >= 8;
          if (!widthChanged && !heightChanged) return;
          lastWidth = nextWidth;
          lastHeight = nextHeight;

          const stage = stageRef.current;
          const current = layoutRef.current;
          const heights = rawHeights.current;

          if (widthChanged && stage && current && heights) {
            // 记下「视口顶部在第几页、页内偏移多少、那一页原本多高」
            const probe = stage.scrollTop;
            let page = 0;
            let offsetInPage = 0;
            let pageHeight = current.heights[0] || 1;
            let acc = 0;
            for (let index = 0; index < current.heights.length; index += 1) {
              const height = current.heights[index];
              const pitch = height + PAGE_GAP;
              if (probe >= acc && probe < acc + pitch) {
                page = index;
                offsetInPage = probe - acc;
                pageHeight = height;
                break;
              }
              acc += pitch;
              page = index;
              offsetInPage = Math.max(0, probe - acc);
              pageHeight = height;
            }
            commitLayout(heights, rawWidth.current, { page, offsetInPage, pageHeight });
          } else if (heightChanged) {
            // 只变高：不重排，只把可见范围补上
            recompute(false);
          }
        });
        observer.observe(wrap);
        return () => observer.disconnect();
      }, [containerReady, commitLayout, recompute]);


      // ── 3. 滚动监听：rAF 节流 ────────────────────────────────────────
      //
      // **依赖必须含「容器就绪」这个状态**，这是上一版「只加载几页、怎么滚都不动」的根因：
      // `layout` 为 null 时组件返回的是 loading div，页面上**根本没有 `dr-stage` 元素**，
      // `stageRef.current` 是 null，effect 里的 `if (!stage) return` 直接退出；
      // 而依赖只有 `[recompute]`（它只依赖 pageCount）——永远不再重跑，
      // 于是滚动监听从未挂上，窗口区间停在那一次算出来的几页。
      //
      // 用布尔量而不是整个 layout 对象：fit 变化时 DOM 元素还是同一个，
      // 没必要反复拆装监听（拆装本身没错，但少一层动作就少一处出错机会）。
      useEffect(() => {
        if (!containerReady) return;
        const stage = stageRef.current;
        if (!stage) return;
        const onScroll = () => {
          if (rafRef.current !== null) return;
          rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = null;
            recompute(true);
          });
        };
        stage.addEventListener('scroll', onScroll, { passive: true });
        // 挂上后补算一次：把「容器已就绪」这一刻的可见范围补上。
        // 走 rAF 而不是同步调用 —— effect 执行时 DOM 虽已提交，但排版/尺寸
        // 未必已经稳定（`clientHeight` 有可能是 0），同步算出来的窗口会偏小。
        const warm = window.requestAnimationFrame(() => {
          recompute(true);
        });
        return () => {
          stage.removeEventListener('scroll', onScroll);
          window.cancelAnimationFrame(warm);
          if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        };
      }, [containerReady, recompute]);

      /** 把「第 page 页 + 页内 offset」换成 scrollTop。 */
      const offsetFor = useCallback((heights, page, offsetInPage) => {
        let acc = 0;
        for (let index = 0; index < Math.min(page, heights.length); index += 1) {
          acc += heights[index] + PAGE_GAP;
        }
        return Math.max(0, acc + (offsetInPage || 0));
      }, []);

      // ── 4. 定位：只在「该发生」时发生 ────────────────────────────────
      //
      // 这是上一版「自动跳」的第二个根因：定位写在 layout 的 effect 里，
      // 而那个 effect 又依赖「每次渲染都会新建」的对象/回调，于是它反复执行、
      // 反复设 scrollTop —— 你滚走它拽回。
      // 现在三条入口互不干扰，且都不出现在滚动路径上：
      //   a) 初次定位：打开书 / 换缩放，只做一次
      //   b) 重排保位：容器变宽变窄
      //   c) 外部跳页：框架、笔记里点「定位」
      useEffect(() => {
        if (!layout) return;
        const stage = stageRef.current;
        if (!stage) return;

        const anchor = pendingAnchor.current;
        pendingAnchor.current = null;

        if (anchor) {
          // b) 重排保位：页内偏移按「新页高 / 旧页高」等比换算。
          //    不换算的话，fit 一变页高就变了，同一个像素偏移落在不同行上，看着像漂。
          const page = Math.max(0, Math.min(anchor.page, layout.heights.length - 1));
          const newHeight = layout.heights[page] || 1;
          const ratio = anchor.pageHeight > 0 ? newHeight / anchor.pageHeight : 1;
          const target = offsetFor(layout.heights, page, anchor.offsetInPage * ratio);
          stage.scrollTop = Math.min(target, Math.max(0, stage.scrollHeight - stage.clientHeight));
          recompute(false);
          return;
        }

        // a) 初次定位：只在第一次做
        if (!hasPositioned.current) {
          hasPositioned.current = true;
          const page = Math.max(0, Math.min(initialPage || 0, layout.heights.length - 1));
          stage.scrollTop = offsetFor(layout.heights, page, 0);
          recompute(true);
        }
      }, [layout, initialPage, offsetFor, recompute]);

      // c) 外部跳页：只有 token 变了才动
      const { jumpToken, jumpPage } = props;
      const lastJumpRef = useRef(jumpToken);
      useEffect(() => {
        if (!layout) return;
        if (jumpToken === lastJumpRef.current) return;
        lastJumpRef.current = jumpToken;
        const stage = stageRef.current;
        if (!stage) return;
        stage.scrollTop = offsetFor(layout.heights, Math.max(0, jumpPage), 0);
        recompute(true);
      }, [jumpToken, jumpPage, layout, offsetFor, recompute]);

      if (!layout) {
        return h('div', { className: 'dr-loading' }, h('div', { className: 'dr-spinner' }), '正在排版…');
      }

      const sheets = [];
      for (let index = 0; index < pageCount; index += 1) {
        const height = layout.heights[index];
        const inWindow = index >= windowRange.from && index <= windowRange.to;
        const isLast = index === pageCount - 1;
        sheets.push(
          h(
            'div',
            {
              key: index,
              className: 'dr-vsheet',
              // 占位高度 = 页高 + 页间隙。
              //
              // **间隙必须算进这个块自身**，不能靠父容器 `gap`：JS 里
              // `offsetFor` 用的是 `heights[i] + PAGE_GAP`，只要 DOM 的间距来源
              // 不是同一个数（比如 CSS gap 改成 16），两套坐标就错开，页码判定
              // 与实际位置逐页累积偏差 —— 表现正是「滚着滚着页码乱了、位置自己跳」。
              // 所以这里只有一处来源：本块的 height 含间隙，父容器不设 gap。
              style: {
                height: (height + (isLast ? 0 : PAGE_GAP)) + 'px',
                width: layout.width + 'px',
              },
              'data-dr-page': index,
            },
            inWindow
              ? h(PageCanvas, {
                  pdf,
                  pageIndex: index,
                  // 有效缩放 = 用户缩放 × 窄屏适配系数：占位高度就是按它算的，
                  // 这里若传原始 scale，canvas 会比占位块大一圈，页面直接溢出重叠。
                  scale: scale * (layout.fit ?? 1),
                  width: layout.width,
                  marks,
                  onBubble: setBubble,
                  onCommitMark: onMark,
                  onSendToQA,
                })
              : null,
          ),
        );
      }

      return h(
        'div',
        { className: 'dr-scrollwrap', ref: wrapRef },
        h(
          'div',
          { className: 'dr-stage is-scroll', ref: stageRef },
          h('div', { className: 'dr-pages' }, sheets),
        ),
        // 选区工具条跟着页码走，锚定在选区右上角
        bubble
          ? h(
              'div',
              {
                className: 'dr-bubble dr-bubble-fixed',
                style: { left: bubble.clientLeft, top: bubble.clientTop, transform: 'translateX(-50%)' },
              },
              // 唯一的选区动作：「送到问答页签」，把**位置**（page/offset/length）送过去，
              // 后端据此自己读原文，可以接着连问、翻看之前的回答。
              h(
                'button',
                {
                  title: '把这段送到侧栏「问答」',
                  onClick: () => {
                    if (typeof onSendToQA === 'function') {
                      onSendToQA({
                        page: bubble.page,
                        offset: bubble.offset,
                        length: bubble.length,
                        text: bubble.text,
                      });
                      const selection = window.getSelection();
                      if (selection) selection.removeAllRanges();
                      setBubble(null);
                    }
                  },
                },
                h(
                  'svg',
                  { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
                  h('path', { d: 'M2 3h6M2 8h4M2 13h3M11 6.5l3 3-3 3M9 9.5h5' }),
                ),
              ),
              h('div', { className: 'dr-sep' }),
              COLOR_NAMES.map((color) =>
                h(
                  'button',
                  {
                    key: color,
                    title: '标为' + COLOR_LABELS[color] + '色',
                    onClick: () => {
                      onMark({ page: bubble.page, offset: bubble.offset, length: bubble.length, text: bubble.text, color, note: '' });
                      const selection = window.getSelection();
                      if (selection) selection.removeAllRanges();
                      setBubble(null);
                    },
                  },
                  h('span', { className: 'dr-swatch is-' + color }),
                ),
              ),
            )
          : null,
      );
    }

    /**
     * 一页的 canvas + 透明文字层 + 高亮层。
     *
     * 只在滚动窗口内挂载；卸载时把 canvas 尺寸清零，让位图能被回收 ——
     * 不这么做的话，滚过的页会把 canvas 留在内存里（300 页 = 上百 MB）。
     */
    function PageCanvas(props) {
      const { pdf, pageIndex, scale, width, marks, onBubble, onCommitMark, onSendToQA } = props;
      const canvasRef = useRef(null);
      const layerRef = useRef(null);
      const hostRef = useRef(null);
      const [pageText, setPageText] = useState(null);
      const renderToken = useRef(0);
      /**
       * 正在跑的 pdf.js 渲染任务。
       *
       * ## 为什么必须存它（放大后画面翻转的根因）
       *
       * 渲染是**异步**的：设好 `canvas.width/height` → `await render().promise`。
       * 而 `canvas.width = …` 这个赋值会**立刻清空整块位图**。
       *
       * 连续点「放大」（scale 每次 +0.15）时，effect 会被连续重跑：
       *   旧 render 还在往 canvas 上画（旧尺寸、旧变换）
       *   新 effect 已经把 canvas 尺寸重置成新值
       * 两套尺寸/变换写进同一块位图，结果就是画面**翻转、错位、撕裂**。
       *
       * `renderToken` 只能在**画完之后**判断「我是不是过期了」，拦不住已经在写像素的那一帧。
       * 唯一能拦住的是 `renderTask.cancel()` —— 它在 pdf.js 内部逐段检查取消标志，
       * 立刻停止后续绘制，并让 promise 以 RenderingCancelledException 收尾。
       */
      const renderTaskRef = useRef(null);

      useEffect(() => {
        let alive = true;
        const token = ++renderToken.current;
        (async () => {
          try {
            const pageProxy = await pdf.getPage(pageIndex + 1);
            const { viewport, items, pageText: text } = await renderPageData(pageProxy, scale);
            if (!alive || token !== renderToken.current) return;
            const canvas = canvasRef.current;
            const layer = layerRef.current;
            if (!canvas || !layer) return;

            const dpr = Math.min(2, window.devicePixelRatio || 1);
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = viewport.width + 'px';
            canvas.style.height = viewport.height + 'px';
            const context = canvas.getContext('2d');
            if (!context) return;
            context.setTransform(dpr, 0, 0, dpr, 0, 0);

            // 开新的之前先把旧的掐掉：否则旧任务会继续往这块刚被重置的位图上画，
            // 两套 viewport 变换叠加 → 画面翻转/撕裂（放大时的那个 bug）。
            if (renderTaskRef.current) {
              try {
                renderTaskRef.current.cancel();
              } catch {
                /* 已经结束的任务 cancel 会抛，忽略 */
              }
              renderTaskRef.current = null;
            }
            const task = pageProxy.render({ canvasContext: context, viewport });
            renderTaskRef.current = task;
            await task.promise;
            if (renderTaskRef.current === task) renderTaskRef.current = null;
            if (!alive || token !== renderToken.current) return;

            setPageText(text);
            // 文字层：每个文本项一个绝对定位 span，三条对位纪律见下 ——
            // 1. top 用盒子顶、fontSize 用盒子高度，让字形与盒子等高；
            // 2. span 默认基线定位，要补一个「实测高 − 目标高」的垂直补偿，否则整体偏低半行；
            // 3. 按实测宽度做 scaleX，字体不是原始嵌入字体时行尾会累积偏移。
            // 每个文本项在页文本里的字符区间存在 `text.spans` 里（不是 items 上）。
            // 建一张 反查表，渲染时把区间写到 span 的 dataset 上 ——
            // 第二个 effect（染色）只拿得到 DOM 和 pageText，拿不到 items。
            const spanOfItem = new Map();
            for (const span of text.spans) spanOfItem.set(span.item, span);

            layer.textContent = '';
            for (const item of items) {
              const span = document.createElement('span');
              span.textContent = item.str;
              const range = spanOfItem.get(item);
              if (range) {
                span.dataset.drStart = String(range.start);
                span.dataset.drEnd = String(range.end);
              }
              const box = item.box;
              const height = Math.max(1, box[3] - box[1]);
              span.style.left = box[0] + 'px';
              span.style.top = box[1] + 'px';
              span.style.fontSize = height + 'px';
              span.style.lineHeight = '1';
              layer.append(span);
              const natural = span.getBoundingClientRect();
              const target = Math.max(1, box[2] - box[0]);
              if (natural.width > 0.5 && Math.abs(natural.width - target) > 0.5) {
                span.style.transform = 'scaleX(' + target / natural.width + ')';
              }
              const delta = natural.height - height;
              if (delta > 0.5) {
                span.style.top = box[1] + Math.min(delta, height * 0.4) + 'px';
              }
            }
          } catch (error) {
            // 主动取消（连续缩放/翻页）不是失败。pdf.js 用 RenderingCancelledException
            // 表达取消，它会在放大时每点一次就抛一次 —— 若当成错误记日志，
            // 控制台会被刷满，真正的问题反而看不见。
            const name = error && error.name;
            if (name !== 'RenderingCancelledException' && alive) {
              console.error('[dsh-reader] 第 ' + (pageIndex + 1) + ' 页渲染失败', error);
            }
          }
        })();
        return () => {
          alive = false;
          // 卸载/重跑前先取消正在写的任务：否则它会继续往这块 canvas 上画，
          // 而下面正要把它清零 —— 两件事同时发生就是花屏。
          if (renderTaskRef.current) {
            try {
              renderTaskRef.current.cancel();
            } catch {
              /* 已结束 */
            }
            renderTaskRef.current = null;
          }
          // 释放位图：卸载即清零，别让 canvas 留在内存里
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
        };
      }, [pdf, pageIndex, scale]);

      /* ── 标注染色：只给 span 加类，不重画 canvas ──────────────────────
         ## 为什么必须独立成一个 effect
         渲染那个 effect 的依赖是 `[pdf, pageIndex, scale]`，**不含 marks**。
         若把染色写在那里，标注后划线不会出现（要等翻页/缩放才刷新）。
         但把 marks 加进渲染依赖更糟：一条标注就重画整页位图，滚动时掉帧。

         所以染色单独跑：它只碰 DOM 的 className，代价接近零。

         ## 为什么划线画在 span 上，而不是旁边另铺一层
         文字层的 span 会做**垂直补偿**（delta），而独立的坐标框不会。
         两者一错开，线就压在文字中间 —— 这就是「标线遮挡文字」的根因。
         线长在文字自己身上，就没有第二次对位。 */
      useEffect(() => {
        const layer = layerRef.current;
        if (!layer || !pageText) return;
        const children = layer.children;
        // 先清掉上一次的染色（marks 被删/改色时）
        const clearSpan = (span) => {
          span.classList.remove('is-marked', 'is-marked-partial');
          for (const color of COLOR_NAMES) span.classList.remove('is-' + color);
          span.style.removeProperty('--mk-l');
          span.style.removeProperty('--mk-w');
          span.style.removeProperty('--mk-c');
        };
        for (const span of children) clearSpan(span);
        for (const mark of marks) {
          if (mark.page !== pageIndex) continue;
          const end = mark.offset + mark.length;
          for (const span of children) {
            const from = Number(span.dataset.drStart);
            const to = Number(span.dataset.drEnd);
            if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
            if (to <= mark.offset || from >= end) continue;
            // 先把 span 上已有的色类清掉再上色：两条标注重叠时，
            // 直接 add 会让同一个 span 同时挂 `is-amber` 和 `is-rose`，
            // 颜色取决于 CSS 里哪条规则排最后 —— 那是不可预测的。
            // 后一条覆盖前一条是明确规则，所以这里必须先移除。
            for (const color of COLOR_NAMES) span.classList.remove('is-' + color);
            // 这个 span 的字符区间从 from 到 to（左闭右开），与标注区间求交集：
            const cover = Math.min(to, end) - Math.max(from, mark.offset);
            const self = to - from;
            if (cover >= self) {
              // 整项都在标注内：整条下划线
              span.classList.add('is-marked', 'is-' + mark.color);
              span.style.removeProperty('--mk-l');
              span.style.removeProperty('--mk-w');
              span.style.removeProperty('--mk-c');
            } else {
              // 只覆盖一部分：按字符比例算位置与长度，画一段线
              // （用户选几个字就只标几个字，两侧不再各多出半句）
              const left = (Math.max(from, mark.offset) - from) / self;
              const width = cover / self;
              span.classList.add('is-marked-partial', 'is-' + mark.color);
              span.style.setProperty('--mk-l', (left * 100).toFixed(3) + '%');
              span.style.setProperty('--mk-w', (width * 100).toFixed(3) + '%');
              span.style.setProperty('--mk-c', 'var(--dr-' + mark.color + ')');
            }
          }
        }
      }, [marks, pageText, pageIndex]);

      // ── 选区 → 页内偏移 → 浮动工具条（用 client 坐标，因为容器在滚）──
      //
      // ## 这条监听最容易写错的地方：**多页同时挂着**
      //
      // 连续滚动时窗口内有 5~7 页同时挂载，每页都注册一个 `selectionchange`。
      // 它们共享同一个 `setBubble`。所以「选区不在我这页」时的动作必须是**什么都不做**，
      // 绝不能 `onBubble(undefined)` —— 那样其它 4~6 页的监听会在同一 tick 里
      // 把刚算好的工具条覆盖成空，表现就是「选中了文字，工具条闪一下就没了」，
      // 从用户视角看等于**标注功能整个消失**。
      //
      // 谁来负责清空？由「选区的锚点节点是否落在我这一页」的那一页来清（见下）：
      // 选区清空 / 移到别处时，原来那一页应当收到一次 `undefined`。
      useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        // 记住「上一次是不是我这页在展示工具条」，只有它才负责撤回
        let mine = false;
        const sync = () => {
          const selection = window.getSelection();
          const text = selection ? selection.toString().trim() : '';
          if (!selection || selection.rangeCount === 0 || text === '') {
            // 没有选区：只有原本归我的那条才清，别去动别人的
            if (mine) {
              mine = false;
              onBubble(undefined);
            }
            return;
          }
          const range = selection.getRangeAt(0);
          const inThisPage = layer.contains(range.commonAncestorContainer);
          if (!inThisPage) {
            // **关键**：选区不在本页，保持沉默。多页共享一个 bubble，
            // 这里一旦上报 undefined 就会把真正命中的那页覆盖掉。
            if (mine) {
              mine = false;
              onBubble(undefined);
            }
            return;
          }
          const layerRect = layer.getBoundingClientRect();
          const rects = [];
          for (const clientRect of Array.from(range.getClientRects())) {
            if (clientRect.width <= 0 || clientRect.height <= 0) continue;
            rects.push({
              left: clientRect.left - layerRect.left,
              top: clientRect.top - layerRect.top,
              right: clientRect.right - layerRect.left,
              bottom: clientRect.bottom - layerRect.top,
            });
          }
          if (rects.length === 0) return;
          // 文字层还没就绪时不算：算不出偏移，画了工具条也标不对
          if (!pageText) return;
          // 用 Range 的字符边界算偏移（精确），矩形只留作工具条锚点
          const hit = offsetFromRange(pageText, range);
          if (!hit) return;
          const anchor = rects[0];
          // 本页在「工具条的定位祖先」里的位置。用 closest 找最近的定位祖先，
          // 而不是假定它就是 dr-scrollwrap —— 布局一旦调整，这里自动跟着对。
          const host = layer.parentElement;
          const anchorRect = host && host.getBoundingClientRect ? host.getBoundingClientRect() : layerRect;
          const stage = layer.closest('.dr-scrollwrap') || layer.closest('.dr-stage');
          const stageRect = stage && stage.getBoundingClientRect ? stage.getBoundingClientRect() : { left: 0, top: 0 };
          const pageOffset = { left: anchorRect.left - stageRect.left, top: anchorRect.top - stageRect.top };
          mine = true;
          onBubble({
            page: pageIndex,
            offset: hit.offset,
            length: hit.length,
            text: hit.text,
            // 工具条是 `position:absolute`，挂在 `dr-scrollwrap`（它是 position:relative），
            // 而这里的 anchor 是**相对文字层/本页**的坐标。所以换算成两段：
            //   本页相对视口的偏移  −  容器相对视口的偏移  +  页内偏移
            // 少减容器那一项就会整体偏一个侧栏宽度；用视口坐标则偏一个滚动量。
            clientLeft: pageOffset.left + Math.min(anchor.right, layerRect.width - 8),
            clientTop: Math.max(2, pageOffset.top + anchor.top - 40),
          });
        };
        document.addEventListener('selectionchange', sync);
        return () => {
          document.removeEventListener('selectionchange', sync);
          // 卸载时若工具条归我，撤回它（否则切页后残留一条指向已消失的页）
          if (mine) onBubble(undefined);
        };
      }, [pageText, pageIndex, onBubble]);

      // ── 高亮层 ───────────────────────────────────────────────────────
      return h(
        'div',
        { className: 'dr-sheet is-flow', ref: hostRef, style: { width: width + 'px' } },
        h('canvas', { ref: canvasRef }),
        // 标注线画在这个层里的 span 上（见 CSS 与上面的 markSpans），
        // 所以这里不再需要独立的 .dr-marks 容器。
        h('div', { className: 'dr-textlayer', ref: layerRef }),
      );
    }


    /* ═══ 右侧栏：框架 / 进度 / 笔记 ═══════════════════════════════════════ */
    function SidePanel(props) {
      const {
        tab,
        onTab,
        book,
        page,
        pageCount,
        framework,
        marks,
        notes,
        onGotoMark,
        onSaveNote,
        onDeleteMark,
        onMarkNote,
        onClearMarks,
        onGenerateFramework,
        onExpandFramework,
        currentChapter,
        // 正文浮动条带过来的「待引用」请求（{page, offset, length, text}）
        pendingQA,
        onConsumeQA,
      } = props;
      // pageCount 要传给 FrameworkTab（进度条用），所以这里保留 total。
      // 原来的 pct / data 是「读到哪」页签用的，该页签已并入框架页，不再需要。
      const total = pageCount || book.pages || 0;

      return h(
        'div',
        { className: 'dr-side' },
        h(
          'div',
          { className: 'dr-side-tabs' },
          /*
           * 「读到哪」已并入「整体框架」：两者回答的是同一个问题（我在全书哪个位置），
           * 分成两个页签时要来回点才能把「第几页」和「框架里哪一章」对上号。
           *
           * 兼容：老状态（或外部跳转）可能仍传 tab==='where'，
           * 这里把它当 'framework' 处理 —— 否则会渲染出一个没有任何页签高亮的空面板。
           */
          h('button', { className: 'dr-side-tab' + (tab === 'framework' || tab === 'where' ? ' is-on' : ''), onClick: () => onTab('framework') }, '整体框架'),
          h('button', { className: 'dr-side-tab' + (tab === 'qa' ? ' is-on' : ''), onClick: () => onTab('qa') }, '问答'),
          h('button', { className: 'dr-side-tab' + (tab === 'notes' ? ' is-on' : ''), onClick: () => onTab('notes') }, '标注笔记 ' + (marks.length + notes.length)),
          tab === 'framework' || tab === 'where'
            ? h(
                'button',
                {
                  className: 'dr-icon-btn',
                  style: { marginLeft: 'auto', alignSelf: 'center' },
                  title: '扩大到整块画布',
                  onClick: () => onExpandFramework && onExpandFramework(),
                },
                h(
                  'svg',
                  { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' },
                  h('path', { d: 'M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4' }),
                ),
              )
            : null,
        ),
        h(
          'div',
          {
            // 问答页签自己管滚动（见 .dr-side-body.is-fixed-shell 的注释）
            className: 'dr-side-body' + (tab === 'qa' ? ' is-fixed-shell' : ''),
            'data-dr-scrollable': '1',
          },
          // 「读到哪」已并入「整体框架」顶部（FrameworkTab 里的 progressBlock）。
          // 现在三个分支：问答 / 标注笔记 / 整体框架。
          // tab==='where' 的旧路径不再存在；若还有外部跳转传它，
          // 页签高亮条件已把它当 'framework' 处理。
          tab === 'qa'
            ? h(AskTab, {
                book,
                framework,
                page,
                pageCount: total,
                pending: pendingQA,
                onConsumePending: onConsumeQA,
              })
            : tab === 'notes'
            ? h(NotesTab, {
                marks,
                notes,
                page,
                // 按章分组要用它把页码映射成章节。没生成框架时是 undefined，
                // 列表退化成「未分章」一组 —— 内容照常显示，不能因为缺框架就不给看。
                framework,
                onGotoMark,
                onSaveNote,
                onDeleteMark,
                onMarkNote,
                onClearMarks,
              })
            : h(FrameworkTab, {
                framework,
                currentChapter,
                onGotoMark,
                onGenerate: onGenerateFramework,
                hasPdf: true,
                // 「读到哪」的数据：进度条与当前章节详情要用
                page,
                pageCount: total,
                book,
              }),
        ),
      );
    }

    /* ═══ 扩大后的框架画布 ══════════════════════════════════════════════
       版式参照 nndl-ge全书框架.html（archify 生成的全书框架图）：
         · 每一「段」是横条大区，带段名与它要回答的问题；
         · 段内章节排成一行，每张卡片有章名 / 章号 / "一句话说啥" / 要点标签；
         · 段与段之间用细竖线 + 下一段的提示，表达「读完这段往下走」。

       不复刻它那份 SVG 的原因写在 CSS 注释里：那张图坐标画死，
       而这里的章节来自 AI 生成，数量不定、标题长度不定。
       用 flex 排布，8 章的段落一行放不下会自动换行，不会溢出错位。
    */
/**
 * 框架图的布局引擎（纯函数，无 React、无 DOM，可直接在 Node 里测）。
 *
 * 输入：AI 生成的框架数据（parts → chapters）。
 * 输出：一份「画法」—— 节点盒子、段落区域框、连线路径、文字标签。
 * 渲染层只管把这些坐标画成 SVG，不做任何计算。
 *
 * ## 为什么布局要独立成纯函数
 *
 * 排版是这张图最容易出错的部分（重叠、越界、箭头穿过卡片），
 * 而它一旦和 React / DOM 缠在一起就只能靠眼睛验。抽出来之后：
 * 同样的输入一定得到同样的坐标，可以在 Node 里断言「没有重叠」「都在画布内」。
 *
 * ## 版式（对齐 nndl-ge全书框架.html 的四层表达）
 *
 * ```text
 *   ┌─ 第一段 · 打地基 ─────────────────┐      ① 圆角框 = 分段
 *   │  [第1章] ──→ [第2章] ──→ [第3章]  │      ② 段内箭头 = 章与章的顺序
 *   └───────────────┬───────────────────┘
 *                   │ 打基础                    ③ 跨段箭头 + 边标签 = 递进的含义
 *   ┌─ 第二段 · 核心机制 ───────────────┐
 *   │  [第4章] ──→ [第5章]               │      ④ 卡片内 = 章名 / 章号 / 要点
 *   └───────────────────────────────────┘
 * ```
 *
 * 只有箭头会丢掉「分段」这层信息；只有框会丢掉「顺序与递进」。
 * 所以四层一起画。
 */

/** 卡片尺寸与间距（单位：SVG 用户单位，最终按 viewBox 缩放）。 */
const METRICS = {
  cardW: 176,
  cardH: 92,
  gapX: 26, // 段内卡片水平间距（也是箭头长度）
  gapY: 74, // 段与段之间的垂直间距（跨段箭头在这里走）
  bandPadX: 20,
  bandPadTop: 44, // 留出段名标题的高度
  bandPadBottom: 20,
  canvasPad: 28,
};

/**
 * 估算一行文字在给定字号下占多少宽度。
 *
 * 为什么不用 canvas 量：这里必须是纯函数。中文字宽约等于字号，
 * 拉丁字母约 0.55 倍；混排取保守值。宁可估宽一点（卡片留白多一点），
 * 也不要估窄导致文字溢出卡片。
 *
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
function estimateTextWidth(text, fontSize) {
  let width = 0;
  for (const ch of String(text)) {
    // 中日韩统一表意文字 + 全角标点：一个字一个方
    const isWide = /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
    width += isWide ? fontSize : fontSize * 0.55;
  }
  return width;
}

/**
 * 把一段文字按「最大宽度」截成若干行（按字符切，中文不需要按词）。
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} fontSize
 * @param {number} maxLines
 * @returns {string[]}
 */
function wrapText(text, maxWidth, fontSize, maxLines) {
  const source = String(text ?? '');
  if (source === '') return [];
  const lines = [];
  let current = '';
  for (const ch of source) {
    const next = current + ch;
    if (estimateTextWidth(next, fontSize) > maxWidth && current !== '') {
      lines.push(current);
      current = ch;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current !== '') lines.push(current);
  // 超出行数就用省略号收尾
  if (lines.length === maxLines) {
    const consumed = lines.join('').length;
    if (consumed < source.length) {
      let last = lines[maxLines - 1];
      while (last.length > 1 && estimateTextWidth(last + '…', fontSize) > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = last + '…';
    }
  }
  return lines;
}

/**
 * 计算整张图的布局。
 *
 * @param {any} framework - `{ title, summary, parts: [{ name, question, transition, chapters: [...] }], howToRead }`
 * @param {{maxRowWidth?: number}} [options]
 * @returns {{
 *   width:number, height:number,
 *   bands:Array<{x,y,w,h,name:string,question:string,index:number}>,
 *   nodes:Array<{id:string,x,y,w,h,index:number,title:string,titleLines:string[],gistLines:string[],keys:string[],bandIndex:number,chapter:any}>,
 *   edges:Array<{from:string,to:string,path:string,kind:'in-band'|'cross-band',label?:string,labelX?:number,labelY?:number}>,
 *   bandsWithoutNodes:number,
 * }}
 */
function layoutFramework(framework, options = {}) {
  const m = METRICS;
  const parts = (framework && framework.parts) || [];

  // 一行最多放几张卡：受 maxRowWidth 约束，至少 1 张。
  const maxRowWidth = options.maxRowWidth || 1180;
  const perRow = Math.max(1, Math.floor((maxRowWidth - m.bandPadX * 2 + m.gapX) / (m.cardW + m.gapX)));

  const bands = [];
  const nodes = [];
  const edges = [];
  let cursorY = m.canvasPad;

  parts.forEach((part, partIndex) => {
    const chapters = (part.chapters || []).filter((ch) => ch && typeof ch.title === 'string');
    const rows = Math.max(1, Math.ceil(chapters.length / perRow));
    const colsInWidestRow = Math.min(chapters.length || 1, perRow);

    const bandW = colsInWidestRow * m.cardW + (colsInWidestRow - 1) * m.gapX + m.bandPadX * 2;
    const bandH = m.bandPadTop + rows * m.cardH + (rows - 1) * 18 + m.bandPadBottom;

    bands.push({
      index: partIndex,
      x: 0,
      y: cursorY,
      w: bandW,
      h: bandH,
      name: part.name || `第 ${partIndex + 1} 部分`,
      question: part.question || '',
    });

    // 段内卡片：从左上向、按行排
    chapters.forEach((chapter, chapterIndex) => {
      const row = Math.floor(chapterIndex / perRow);
      const col = chapterIndex % perRow;
      const x = m.bandPadX + col * (m.cardW + m.gapX);
      const y = cursorY + m.bandPadTop + row * (m.cardH + 18);
      const prev = chapters[chapterIndex - 1];
      const nodeId = `ch-${partIndex}-${chapterIndex}`;

      nodes.push({
        id: nodeId,
        bandIndex: partIndex,
        chapter,
        x,
        y,
        w: m.cardW,
        h: m.cardH,
        index: chapter.index,
        title: chapter.title,
        // 卡片内文字：章名最多两行、gist 两行、要点一行
        titleLines: wrapText(chapter.title, m.cardW - 22, 12, 2),
        gistLines: wrapText(chapter.gist || '', m.cardW - 22, 10.5, 2),
        keys: Array.isArray(chapter.keyPoints) ? chapter.keyPoints.slice(0, 3) : [],
      });

      // 段内箭头：相邻两章之间**都要**连上。
      //
      // 分两种情况：
      //   · 同一行 —— 水平箭头；
      //   · 折行处（这一行排满、下一章从新行开头起）—— 用折线（L 形）：
      //     从上一张卡底部中点向下，再横向接到这张卡左边。
      //
      // 折行处不画的话，5 章以上的段落看起来就是「几个孤立盒子」，
      // 这正是「只有卡片、没有关系」的毛病。段落越长越明显。
      if (prev) {
        const prevNode = nodes[nodes.length - 2];
        if (prevNode) {
          const sameRow = row === Math.floor((chapterIndex - 1) / perRow);
          if (sameRow) {
            const yMid = y + m.cardH / 2;
            edges.push({
              from: prevNode.id,
              to: nodeId,
              kind: 'in-band',
              path: `M ${prevNode.x + m.cardW} ${yMid} L ${x} ${yMid}`,
            });
          } else {
            const fromX = prevNode.x + prevNode.w / 2;
            const fromY = prevNode.y + prevNode.h;
            const toX = x;
            const toY = y + m.cardH / 2;
            edges.push({
              from: prevNode.id,
              to: nodeId,
              kind: 'in-band-wrap',
              path: `M ${fromX} ${fromY} L ${fromX} ${toY} L ${toX} ${toY}`,
            });
          }
        }
      }
    });

    cursorY += bandH;
    bands[partIndex].y = bands[partIndex].y; // 保持显式

    // 跨段箭头：末段不画
    if (partIndex < parts.length - 1) {
      const lastNode = nodes.filter((n) => n.bandIndex === partIndex).pop();
      const nextPartIndex = partIndex + 1;
      const label = (part.transition || '').trim();
      const arrowTop = cursorY + 4;
      const arrowBottom = cursorY + m.gapY - 8;
      // 从本段最后一章的底部，竖直向下指到下一段的顶部
      const fromX = lastNode ? lastNode.x + m.cardW / 2 : m.bandPadX + m.cardW / 2;
      edges.push({
        from: lastNode ? lastNode.id : `band-${partIndex}`,
        to: `band-${nextPartIndex}`,
        kind: 'cross-band',
        path: `M ${fromX} ${cursorY - 2} L ${fromX} ${arrowBottom}`,
        label,
        labelX: fromX + 10,
        labelY: arrowTop + (arrowBottom - arrowTop) / 2 + 4,
      });
      cursorY += m.gapY;
    }
  });

  // 画布尺寸：取最宽的分段 + 一点内边距
  const maxBandW = bands.reduce((acc, band) => Math.max(acc, band.w), 0);
  const width = Math.max(maxBandW + m.canvasPad * 2, 320);
  const height = Math.max(cursorY + m.canvasPad, 200);

  // 分段水平居中：不同段宽度不同，居中比左对齐好看
  const centeredBands = bands.map((band) => ({ ...band, x: (width - band.w) / 2 }));
  const bandOffset = new Map(centeredBands.map((band) => [band.index, band.x]));

  // 把卡片和箭头一起平移到居中后的坐标
  const shiftedNodes = nodes.map((node) => ({ ...node, x: node.x + (bandOffset.get(node.bandIndex) || 0) }));
  const nodeById = new Map(shiftedNodes.map((node) => [node.id, node]));
  const shiftedEdges = edges.map((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    let path = edge.path;
    if (edge.kind === 'in-band' && from && to) {
      const yMid = from.y + from.h / 2;
      path = `M ${from.x + from.w} ${yMid} L ${to.x} ${yMid}`;
    } else if (edge.kind === 'cross-band' && from) {
      const x = from.x + from.w / 2;
      const tailY = from.y + from.h + 2;
      // 箭头终点 = 下一段区域框的上沿；取不到就按间距推一个
      const nextBand = centeredBands.find((b) => b.index === (from.bandIndex + 1));
      const headY = nextBand ? nextBand.y - 6 : tailY + m.gapY - 12;
      path = `M ${x} ${tailY} L ${x} ${headY}`;
      return { ...edge, path, labelX: x + 10, labelY: (tailY + headY) / 2 + 4 };
    }
    return { ...edge, path };
  });

  return {
    width,
    height,
    bands: centeredBands,
    nodes: shiftedNodes,
    edges: shiftedEdges,
    bandsWithoutNodes: bands.filter((band) => !nodes.some((n) => n.bandIndex === band.index)).length,
  };
}

    /* ═══ 框架图（SVG）渲染 ══════════════════════════════════════════════
       版式对齐 nndl-ge全书框架.html 的四层表达，但**不用 iframe**：

         ① 圆角区域框      = 分段（哪几章是一组）
         ② 段内箭头        = 章与章的顺序
         ③ 跨段箭头 + 标签 = 段落之间的递进（"打基础"→"装上引擎"）
         ④ 卡片内文字      = 章名 / 章号 / 一句话 / 要点

       为什么不用 iframe 嵌那个 HTML：
         · iframe 是独立文档，**拿不到 --dsw-alias-* token**，亮暗主题不会跟着走；
         · 点击节点无法联动跳页，得额外补 postMessage 通道；
         · 那份 HTML 的节点坐标是写死的，换一本书（章数变）就废。
       所以这里自己画 SVG：坐标由 layoutFramework 现算，颜色走宿主 token，
       点击直接调 goPage。

       坐标全部来自纯函数布局引擎（lib/client/framework-layout.js），
       这一层只负责把数字画出来，不做任何排版判断。
    */
    function FrameworkGraph(props) {
      const { framework, hereChapter, onJump, height } = props;
      const data = framework && framework.data;
      const graph = useMemo(() => {
        if (!data) return null;
        return layoutFramework(data);
      }, [data]);

      if (!graph) return null;

      // 等比缩放到可用宽度：viewBox 用布局坐标，宽度自适应容器
      const scaleHint = graph.width > 0 ? 100 : 100;
      const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

      return h(
        'div',
        { className: 'dr-graph', style: height ? { height } : undefined },
        h(
          'svg',
          {
            viewBox: '0 0 ' + graph.width + ' ' + graph.height,
            // 宽度跟随容器、高度按比例：preserveAspectRatio 默认即可
            style: { width: '100%', height: 'auto', display: 'block' },
            role: 'img',
            'aria-label': '全书框架图',
          },
          // ── ① 分段区域框 ──────────────────────────────────────────
          graph.bands.map((band) =>
            h(
              'g',
              { key: 'band-' + band.index },
              h('rect', {
                x: band.x,
                y: band.y,
                width: band.w,
                height: band.h,
                rx: 12,
                className: 'dr-g-band' + (hereChapter && hereChapter.bandIndex === band.index ? ' is-here' : ''),
              }),
              // 段名：左上角压在框线上，加一条遮罩背景让线不穿字
              h('rect', {
                x: band.x + 14,
                y: band.y - 8,
                width: Math.min(band.w - 28, Math.max(60, estimateTextWidth(band.name, 12) + 16)),
                height: 17,
                rx: 4,
                className: 'dr-g-mask',
              }),
              h(
                'text',
                { x: band.x + 22, y: band.y + 4, className: 'dr-g-bandname', fontSize: 12 },
                band.name,
              ),
              band.question
                ? h(
                    'text',
                    { x: band.x + 22, y: band.y + 22, className: 'dr-g-bandq', fontSize: 10.5 },
                    band.question,
                  )
                : null,
            ),
          ),

          // ── ②③ 箭头（先画线，后画卡，免得线压住卡片文字）───────────
          graph.edges.map((edge, index) => {
            const to = nodeById.get(edge.to);
            const isCross = edge.kind === 'cross-band';
            return h(
              'g',
              { key: 'edge-' + index },
              h('path', {
                d: edge.path,
                className: 'dr-g-edge' + (isCross ? ' is-cross' : ''),
                markerEnd: 'url(#dr-g-arrow)',
              }),
              // 跨段箭头旁边的过渡文字
              isCross && edge.label
                ? h(
                    'text',
                    {
                      x: edge.labelX,
                      y: edge.labelY,
                      className: 'dr-g-elabel',
                      fontSize: 10.5,
                      textAnchor: 'start',
                    },
                    edge.label,
                  )
                : null,
              // 段内折行箭头的拐角加个小圆点，视觉上更好读
              edge.kind === 'in-band-wrap'
                ? h('circle', { cx: Number(edge.path.split(' ')[1]), cy: Number(edge.path.split(' ')[4]), r: 2.2, className: 'dr-g-joint' })
                : null,
            );
          }),

          // 箭头标记定义
          h(
            'defs',
            null,
            h(
              'marker',
              { id: 'dr-g-arrow', markerWidth: 8, markerHeight: 6, refX: 7, refY: 3, orient: 'auto' },
              h('polygon', { points: '0 0, 8 3, 0 6', className: 'dr-g-arrowhead' }),
            ),
          ),

          // ── ④ 章节卡片 ─────────────────────────────────────────────
          graph.nodes.map((node) => {
            const here = hereChapter && hereChapter.chapter === node.chapter;
            let textY = node.y + 20;
            return h(
              'g',
              {
                key: node.id,
                className: 'dr-g-node' + (here ? ' is-here' : ''),
                onClick: () => onJump(node.chapter),
                style: { cursor: node.chapter.pages && node.chapter.pages.length ? 'pointer' : 'default' },
                role: 'button',
                'aria-label':
                  '第 ' + node.index + ' 章 ' + node.title + (here ? '（正在读）' : ''),
              },
              h('rect', {
                x: node.x,
                y: node.y,
                width: node.w,
                height: node.h,
                rx: 8,
                className: 'dr-g-card' + (here ? ' is-here' : ''),
              }),
              // 章号
              h(
                'text',
                { x: node.x + 11, y: node.y + 17, className: 'dr-g-idx', fontSize: 9.5 },
                '第 ' + node.index + ' 章',
              ),
              here
                ? h(
                    'text',
                    { x: node.x + node.w - 11, y: node.y + 17, className: 'dr-g-here', fontSize: 9.5, textAnchor: 'end' },
                    '在读',
                  )
                : null,
              // 章名（最多两行）
              ...node.titleLines.map((line, i) =>
                h(
                  'text',
                  {
                    key: 't' + i,
                    x: node.x + 11,
                    y: node.y + 33 + i * 15,
                    className: 'dr-g-title',
                    fontSize: 12,
                  },
                  line,
                ),
              ),
              // 一句话摘要（最多两行）
              ...(() => {
                const start = node.y + 33 + node.titleLines.length * 15 + 2;
                return node.gistLines.map((line, i) =>
                  h(
                    'text',
                    {
                      key: 'g' + i,
                      x: node.x + 11,
                      y: start + i * 13,
                      className: 'dr-g-gist',
                      fontSize: 10.5,
                    },
                    line,
                  ),
                );
              })(),
              // 要点标签（底部，最多三个，超宽就截断）
              ...(() => {
                const keys = node.keys || [];
                let cursorX = node.x + 11;
                const y = node.y + node.h - 10;
                const out = [];
                for (const key of keys) {
                  const w = Math.min(node.w - 22, estimateTextWidth(key, 9.5) + 10);
                  if (cursorX + w > node.x + node.w - 11) break;
                  out.push(
                    h('rect', {
                      key: 'kr' + key,
                      x: cursorX,
                      y: y - 8,
                      width: w,
                      height: 12,
                      rx: 3,
                      className: 'dr-g-keybg',
                    }),
                  );
                  out.push(
                    h(
                      'text',
                      {
                        key: 'kt' + key,
                        x: cursorX + 5,
                        y: y + 1,
                        className: 'dr-g-key',
                        fontSize: 9.5,
                      },
                      key,
                    ),
                  );
                  cursorX += w + 5;
                }
                return out;
              })(),
            );
          }),
        ),
      );
    }

    function FrameworkCanvas(props) {
      const { framework, currentChapter, onGotoMark, onGenerate, bookTitle, page, pageCount, onCollapse } = props;
      const data = framework && framework.data;
      const running = !!framework && framework.status === 'running';

      /** 当前页在第几章：用于给对应段落/卡片加高亮。 */
      const hereChapter = currentChapter ? currentChapter.chapter : undefined;

      const head = h(
        'div',
        { className: 'dr-fwcanvas-head' },
        h('div', null,
          h('div', { className: 'dr-fwcanvas-title' }, '整体框架'),
          h(
            'div',
            { className: 'dr-fwcanvas-sub' },
            (bookTitle || '这本书') +
              (pageCount ? ' · 共 ' + pageCount + ' 页 · 现在第 ' + (page + 1) + ' 页' : ''),
          ),
        ),
        h('div', { className: 'dr-spacer' }),
        running ? h('span', { className: 'dr-pill is-run' }, '正在生成…') : null,
        h(
          'button',
          {
            className: 'dr-btn',
            disabled: running || typeof onGenerate !== 'function',
            onClick: () => onGenerate && onGenerate(),
          },
          data ? '重新生成' : '生成框架',
        ),
        h('button', { className: 'dr-btn is-ghost', title: '缩回侧栏', onClick: onCollapse }, '缩略'),
      );

      if (!data) {
        return h(
          'div',
          { className: 'dr-fwcanvas' },
          head,
          h(
            'div',
            { className: 'dr-fwcanvas-body' },
            h(
              'div',
              { className: 'dr-fwcanvas-inner' },
              h(
                'div',
                { className: 'dr-dim' },
                running
                  ? '正在从全书抽出的结构信号里还原框架，可以稍等一下。'
                  : '这本书还没有框架。点右上角「生成框架」，AI 会分部分、列章节、给每章一句话摘要。',
              ),
              framework && framework.status === 'failed'
                ? h('div', { className: 'dr-err' }, framework.error || '上次生成失败')
                : null,
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'dr-fwcanvas' },
        head,
        h(
          'div',
          { className: 'dr-fwcanvas-body', 'data-dr-scrollable': '1' },
          h(
            'div',
            { className: 'dr-fwcanvas-inner' },
            data.title ? h('div', { className: 'dr-fwcanvas-sub', style: { marginBottom: 6 } }, data.title) : null,
            data.summary ? h('p', { className: 'dr-fwcanvas-summary' }, data.summary) : null,
            // ── 主图：SVG（分段框 + 段内箭头 + 跨段箭头带标签 + 章卡）──
            h(FrameworkGraph, {
              framework: { data, status: 'done' },
              hereChapter,
              onJump: (chapter) => {
                if (chapter && chapter.pages && chapter.pages.length > 0) onGotoMark({ page: chapter.pages[0] - 1 });
              },
            }),
            data.howToRead && data.howToRead.length
              ? h(
                  'div',
                  { className: 'dr-fwcanvas-howto' },
                  h('h4', null, '怎么读这本书'),
                  h('ul', null, data.howToRead.map((item) => h('li', { key: item }, item))),
                )
              : null,
          ),
        ),
      );
    }

    function FrameworkTab(props) {
      /**
       * `page` / `pageCount` 从 SidePanel 传下来 —— 原本这三样是「读到哪」页签的，
       * 现在并进「整体框架」的顶部，所以这里需要它们。
       */
      const { framework, currentChapter, onGotoMark, onGenerate, page, pageCount, book } = props;
      const data = framework && framework.data;
      const running = !!framework && framework.status === 'running';

      const total = pageCount || (book && book.pages) || 0;
      const current = page + 1;
      const pct = total > 0 ? (current / total) * 100 : 0;

      /**
       * 当前进度块。**合并前这是「读到哪」页签的全部内容**。
       *
       * 合并理由：这两件事本来就是同一个问题 ——「我在全书的哪个位置」。
       * 分成两个页签时，用户要来回点才能把「读到第几章」和「框架里这一章在哪」
       * 对上号；并进框架顶部后，看到进度条的同时下面就是按段/章排的结构，
       * 当前章还有高亮与「在读」标记。
       *
       * 框架还没生成时也要显示（那是「读了多少」的事实，与有没有框架无关），
       * 只是没有「当前章节」那一段。
       */
      const progressBlock = h(
        'div',
        { className: 'dr-fw-progress' },
        h(
          'div',
          { className: 'dr-here' },
          h('div', null, '当前 ', h('b', null, '第 ' + current + ' / ' + (total || '?') + ' 页')),
          h('div', { className: 'dr-bar' }, h('i', { style: { width: Math.min(100, pct) + '%' } })),
          h('div', null, '全书进度 ', h('b', null, pct.toFixed(1) + '%')),
        ),
        // 当前章节的详情：只在框架已生成且这一页落在某章时出现
        currentChapter
          ? h(
              'div',
              { className: 'dr-fw-here' },
              h('div', { className: 'dr-fw-partname' }, currentChapter.part.name),
              h('div', { className: 'dr-fw-here-title' }, currentChapter.chapter.title),
              currentChapter.chapter.gist
                ? h('div', { className: 'dr-dim' }, currentChapter.chapter.gist)
                : null,
              (currentChapter.chapter.keyPoints || []).map((point) =>
                h('span', { key: point, className: 'dr-fw-key' }, point),
              ),
            )
          : null,
      );

      /** 生成 / 重生成按钮。 */
      const generateButton = h(
        'button',
        {
          className: 'dr-btn' + (data ? '' : ' is-primary'),
          disabled: running || typeof onGenerate !== 'function',
          onClick: () => onGenerate && onGenerate(),
          style: { marginTop: 10 },
        },
        running ? '生成中…' : data ? '重新生成框架' : '生成全书框架',
      );

      if (!data) {
        return h(
          'div',
          null,
          // 框架没有也要显示进度：读了多少页是事实，与有没有框架无关
          progressBlock,
          running
            ? h(
                'div',
                null,
                h('div', { className: 'dr-pill is-run' }, '正在生成框架…'),
                h('div', { className: 'dr-dim' }, '抽取页内文本 → 调模型 → 落盘。你可以继续读书，生成完这里会自动出现。'),
              )
            : h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dr-dim' },
                  '这本书还没有框架。点下面的按钮，AI 会从全书抽出的结构信号里还原：分部分 → 章 → 每章在讲什么，生成后能随时看到「现在读到全书哪个位置」。',
                ),
                framework && framework.status === 'failed'
                  ? h('div', { className: 'dr-err' }, framework.error || '上次生成失败')
                  : null,
              ),
          generateButton,
        );
      }
      return h(
        'div',
        null,
        // 进度条 + 当前章节详情放在最上面：先回答「我在哪」，再给全书结构
        progressBlock,
        data.summary ? h('p', { className: 'dr-fw-summary' }, data.summary) : null,
        (data.parts || []).map((part) =>
          h(
            'div',
            { key: part.name, className: 'dr-fw-part' },
            h('div', { className: 'dr-fw-partname' }, part.name),
            part.question ? h('div', { className: 'dr-fw-q' }, part.question) : null,
            (part.chapters || []).map((chapter) => {
              const here = currentChapter && currentChapter.chapter === chapter;
              return h(
                'button',
                {
                  key: chapter.index + '-' + chapter.title,
                  className: 'dr-fw-ch' + (here ? ' is-here' : ''),
                  onClick: () => chapter.pages && chapter.pages.length > 0 && onGotoMark({ page: chapter.pages[0] - 1 }),
                  title: chapter.pages && chapter.pages.length > 0 ? '跳到第 ' + chapter.pages[0] + ' 页' : '',
                },
                h('span', { className: 'dr-fw-ch-idx' }, String(chapter.index)),
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', { className: 'dr-fw-ch-title' }, chapter.title),
                  chapter.gist ? h('div', { className: 'dr-fw-ch-gist' }, chapter.gist) : null,
                  (chapter.keyPoints || []).map((point) => h('span', { key: point, className: 'dr-fw-key' }, point)),
                ),
                here ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-brand-primary)' } }, '在读') : null,
              );
            }),
          ),
        ),
        data.howToRead && data.howToRead.length
          ? h(
              'div',
              { style: { marginTop: 16 } },
              h('div', { className: 'dr-fw-partname' }, '怎么读这本书'),
              h('ul', { className: 'dr-fw-howto' }, data.howToRead.map((item) => h('li', { key: item }, item))),
            )
          : null,
        generateButton,
      );
    }
    function NotesTab(props) {
      const { marks, notes, page, framework, onGotoMark, onSaveNote, onDeleteMark, onMarkNote, onClearMarks } = props;
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState('');
      const [newNote, setNewNote] = useState('');
      /**
       * 列表范围：'all' = 全书，'page' = 只看当前页。
       *
       * 默认 'all'。理由：这个页签的标题就是「标注笔记 N」——N 是全书总数，
       * 点进来看见的却只有当前页，数字和列表对不上才是困惑来源。
       * 想聚焦当前页的人，翻一页就点一下开关，成本很小。
       *
       * ⚠️ 这里不能按 `page` 去「自动切换」范围：连续滚动下页码每一屏都在变，
       * 自动切会让列表在用户滚动时自己换内容，比不筛选更烦人。
       * 范围只由用户显式点击决定。
       */
      const [scope, setScope] = useState('all');
      /**
       * 待确认的清除请求：`{ range, label, count }` 或 null。
       *
       * 破坏性操作一律二段式：先点 → 变成「确定清除 N 条？」→ 再点才执行。
       * 不用 `window.confirm`：那是模态对话框，会打断阅读，而且在面板里
       * 弹系统框的观感和这个界面完全不搭。
       *
       * 也不用两段式计时（3 秒内再点确认）—— 用户可能正在犹豫，
       * 计时到了就变回「清除」，反而更容易误点。
       */
      const [confirmClear, setConfirmClear] = useState(null);

      const startEdit = (mark) => {
        setEditing(mark.id);
        setDraft(mark.note || '');
      };
      /**
       * 保存这条标注的笔记。
       *
       * ## 必须 await，不能「通知完就关编辑器」
       *
       * 上一版是：
       *     onMarkNote(mark, draft);   // 不 await
       *     setEditing(null);          // 立刻关
       *     setDraft('');              // 立刻清空
       *
       * 而后端那时还在校验（并且因为一条校验 bug 必然失败）。
       * 结果：编辑器关了、草稿清了、**用户写的内容直接丢了**，
       * 界面上连个错误都没有 —— 这就是「点击写入后感觉无效」。
       *
       * 现在：只在真正写成功后关闭并清空；失败则保留编辑态与草稿，
       * 让用户能改完重试（错误条会说明原因）。
       */
      const [saving, setSaving] = useState(null);
      const commitEdit = async (mark) => {
        setSaving(mark.id);
        try {
          const ok = await onMarkNote(mark, draft);
          // onMarkNote 约定：成功返回 true，失败返回 false（错误由上层显示）
          if (ok === false) return;
          setEditing(null);
          setDraft('');
        } finally {
          setSaving(null);
        }
      };

      // 按范围过滤。排序放在过滤之后：两种范围都用同一套「页码 → 页内偏移」顺序，
      // 用户切来切去时，同一批条目的相对顺序不会变。
      const onlyPage = scope === 'page';
      const shownMarks = marks.filter((mark) => !onlyPage || mark.page === page);
      const shownNotes = notes.filter((note) => !onlyPage || note.page === page);

      /**
       * 「全部」模式按章分组。
       *
       * 分组依据：每条标注/笔记的页码 → `chapterForPage` → 所属章节。
       * 这一步**只在 own framework 存在时**才可能分组；框架还没生成时
       * 退化成单一「未分章」组 —— 不能因为没框架就不显示内容。
       *
       * 组的顺序跟框架的书写顺序（段 → 章），不是页码顺序：一本书的章节
       * 本来就有先后，按框架走读起来才顺。页码只用于组内排序。
       */
      const grouped = [];
      if (!onlyPage) {
        const data = framework && framework.data;
        /**
         * 章节 → 全书序号。**必须跨段连续编**，不能只算段内下标。
         *
         * 上一版用 `part.chapters.indexOf(chapter)`：段 A 的第 2 章得 0、
         * 段 B 的第 8 章也得 0，排序时第 3 章（下标 1）反而排到第 8 章后面 ——
         * 列表顺序变成 2→8→9→3，完全乱套（实测被回归断言逮住）。
         */
        const chapterIndex = new Map();
        if (data && data.parts) {
          let seq = 0;
          for (const part of data.parts) {
            for (const chapter of part.chapters || []) {
              chapterIndex.set(chapter, seq);
              seq += 1;
            }
          }
        }
        /** key → 组，用 Map 保插入顺序。 */
        const buckets = new Map();
        const push = (item, kind) => {
          const hit = chapterForPage(data, item.page + 1);
          const key = hit ? hit.chapter.title || hit.chapter.no || '未命名章' : '\u0000none';
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              key,
              // 「第 N 章」的 N：框架里 chapter.no 全是 null（AI 不吐章号），
              // 所以由程序按全书顺序自己编。直接用章的标题分组，标题在这里
              // 才是唯一可靠的标识。
              seq: hit ? chapterIndex.get(hit.chapter) + 1 : 0,
              chapter: hit ? hit.chapter : undefined,
              /**
               * 这一章覆盖的页码区间（0 起闭区间），供「清除本章标注」用。
               *
               * 框架的 `chapter.pages` 是 1 起闭区间 `[start, end]`；
               * 而 mark/note 的 `page` 是 0 起。所以换算成 `[start-1, end-1]`。
               * 少减这一位，清除范围就会整体错一页 —— 用户会看到
               * 「清了第 9 章，第 8 章最后一条也没了」。
               *
               * 未分章组没有区间（null）→ 不提供按章清除。
               */
              range: hit && hit.chapter.pages && hit.chapter.pages.length > 0
                ? {
                    from: Math.max(0, hit.chapter.pages[0] - 1),
                    to: Math.max(0, (hit.chapter.pages[1] == null ? hit.chapter.pages[0] : hit.chapter.pages[1]) - 1),
                  }
                : null,
              marks: [],
              notes: [],
              // 框架外的内容永远排最后；有框架的按全书章序
              order: hit ? chapterIndex.get(hit.chapter) : Infinity,
            };
            buckets.set(key, bucket);
          }
          if (kind === 'mark') bucket.marks.push(item);
          else bucket.notes.push(item);
        };
        for (const mark of shownMarks) push(mark, 'mark');
        for (const note of shownNotes) push(note, 'note');
        grouped.push(...buckets.values());
        // 有框架的组按全书章序；「未分章」（order=Infinity）永远最后。
        // ⚠️ 不能写成 `a.order - b.order`：Infinity − Infinity = NaN，
        // 比较器返回 NaN 时排序行为未定义（各引擎实现不同），
        // 未分章组之间的顺序就会漂移。
        grouped.sort((a, b) => {
          if (a.order === Infinity && b.order === Infinity) return a.key.localeCompare(b.key);
          if (a.order === Infinity) return 1;
          if (b.order === Infinity) return -1;
          return a.order - b.order;
        });
      }

      /** 全书一条都没有 —— 这才是真正的空书，给引导语。 */
      const isEmptyBook = marks.length === 0 && notes.length === 0;

      /**
       * 「当页」筛选开关。
       *
       * 只在**全书有内容**时显示：空书时先教人怎么标，别先甩个筛选器让人困惑。
       * 两个计数都显示实数值 —— 用户点「当页」前就能看出这一页有几条，
       * 避免点进去发现是空的还得再点回来。
       */
      const scopeSwitch =
        !isEmptyBook
          ? h(
              'div',
              { className: 'dr-scope' },
              h(
                'button',
                { className: scope === 'all' ? 'is-on' : '', onClick: () => setScope('all') },
                '全部 ' + (marks.length + notes.length),
              ),
              h(
                'button',
                { className: scope === 'page' ? 'is-on' : '', onClick: () => setScope('page') },
                '当页 ' + (marks.filter((m) => m.page === page).length + notes.filter((n) => n.page === page).length),
              ),
            )
          : null;

      /**
       * 执行清除。`confirmClear` 存的是「用户正在确认的那个范围」，
       * 所以真正的参数从它来，不从按钮闭包来 —— 用户在确认态下滚页了，
       * 也不该把范围带偏。
       */
      const doClear = async () => {
        const target = confirmClear;
        if (!target) return;
        setConfirmClear(null);
        try {
          await onClearMarks(target.range);
        } catch (e) {
          // 失败时不要静默：删不掉比删错更让人困惑
          console.error('[dsh-reader] 清除失败', e);
        }
      };

      /**
       * 一键清除全部。放在开关条**最右边**，和左边的筛选按钮视觉分开：
       * 左边是「看什么」，右边是「删东西」，混在一起容易点错。
       *
       * 破坏性操作永远走两段式（见 confirmClear 的注释）。
       */
      const clearAllButton =
        !isEmptyBook && !onlyPage
          ? h(
              'div',
              { className: 'dr-clear-row' },
              confirmClear && confirmClear.scope === 'all'
                ? h(
                    'div',
                    { className: 'dr-confirm' },
                    h('span', null, '清除全部 ' + (marks.length + notes.length) + ' 条？不可恢复'),
                    h('button', { className: 'is-danger', onClick: doClear }, '确定清除'),
                    h('button', { onClick: () => setConfirmClear(null) }, '取消'),
                  )
                : h(
                    'button',
                    {
                      className: 'dr-clear-btn',
                      onClick: () => setConfirmClear({ scope: 'all', range: null, count: marks.length + notes.length }),
                    },
                    '清除全部',
                  ),
            )
          : null;

      if (isEmptyBook) {
        return h(
          'div',
          null,
          h('div', { className: 'dr-dim' }, '还没有标注。在正文里拖选一段文字，浮动条里点色块就能标；标注会在这里和页面上同时出现。'),
          h(NewNoteBox, { page, onSave: onSaveNote, value: newNote, onChange: setNewNote }),
        );
      }

      /** 全书有内容、但当前页一条都没有（且选了「当页」）。 */
      const emptyThisPage = onlyPage && shownMarks.length === 0 && shownNotes.length === 0;

      /* ── 单条标注卡 ────────────────────────────────────────────
         两种形态共用同一份结构，只靠 `is-mini` 类切换显示密度：
         · 全部模式 → 缩略（正文 2 行截断，hover 展开）—— 一屏要看十几条，不能每条都撑开
         · 当页模式 → 完整（就几条，没必要收着） */
      const markCard = (mark, mini) =>
        h(
          'div',
          {
            key: mark.id,
            // `is-<color>` 让侧栏卡片的左侧色条与 PDF 里那条划线**同色**。
            // 上一版这里没有颜色类，`.dr-note-q` 一律用 brand-primary，
            // 四色标注在侧栏看起来完全一样 —— 想找「黄的那条」只能靠读文字。
            className: 'dr-note is-' + mark.color + (mini ? ' is-mini' : ''),
            // 缩略态靠 hover 展开。用 CSS 而非 state：展开只是视觉，不必触发重渲染。
            title: mini ? '悬停展开全文' : undefined,
          },
          h('div', { className: 'dr-note-q' }, mark.text),
          h(
            'div',
            { className: 'dr-note-meta' },
            '第 ' + (mark.page + 1) + ' 页 · ',
            // 色名单独包一层，方便 CSS 按卡片颜色染它（见 .dr-note-meta b）
            h('b', null, COLOR_LABELS[mark.color] + '色'),
          ),
          editing === mark.id
            ? h(
                'div',
                null,
                h('textarea', {
                  className: 'dr-input',
                  style: { width: '100%', minHeight: 58, resize: 'vertical' },
                  value: draft,
                  autoFocus: true,
                  onChange: (e) => setDraft(e.target.value),
                  placeholder: '这条标注的笔记…',
                }),
                h(
                  'div',
                  { className: 'dr-note-acts' },
                  h(
                    'button',
                    {
                      // 保存中禁用，防止连点导致重复请求
                      disabled: saving === mark.id,
                      onClick: () => commitEdit(mark),
                    },
                    saving === mark.id ? '保存中…' : '保存',
                  ),
                  h(
                    'button',
                    {
                      disabled: saving === mark.id,
                      onClick: () => {
                        setEditing(null);
                        setDraft('');
                      },
                    },
                    '取消',
                  ),
                ),
              )
            : mark.note
              ? h('div', { className: 'dr-note-t' }, mark.note)
              : null,
          h(
            'div',
            { className: 'dr-note-acts' },
            h('button', { onClick: () => onGotoMark(mark) }, '定位'),
            h('button', { onClick: () => startEdit(mark) }, mark.note ? '改笔记' : '写笔记'),
            h('button', { onClick: () => onDeleteMark(mark.id) }, '删除'),
          ),
        );

      /* ── 单条散记卡 ───────────────────────────────────────────── */
      const noteCard = (note, mini) =>
        h(
          'div',
          { key: note.id, className: 'dr-note' + (mini ? ' is-mini' : ''), title: mini ? '悬停展开全文' : undefined },
          h('div', { className: 'dr-note-t' }, note.text),
          h(
            'div',
            { className: 'dr-note-acts' },
            h('button', { onClick: () => onGotoMark({ page: note.page }) }, '第 ' + (note.page + 1) + ' 页'),
            h('button', { onClick: () => onSaveNote({ id: note.id, page: note.page, text: '' }) }, '删除'),
          ),
        );

      /** 「全部」模式：一条分组都算不上的时候（没有框架），不显示组标题，等价于平铺。 */
      const showGroupHeads = grouped.length > 1 || (grouped.length === 1 && grouped[0].chapter !== undefined);

      const body = onlyPage
        ? h(
            'div',
            null,
            shownMarks.length > 0
              ? h(
                  'div',
                  null,
                  h('div', { className: 'dr-fw-partname', style: { marginBottom: 8 } }, '本页标注'),
                  shownMarks
                    .slice()
                    .sort((a, b) => a.page - b.page || a.offset - b.offset)
                    .map((mark) => markCard(mark, false)),
                )
              : null,
            shownNotes.length > 0
              ? h(
                  'div',
                  { style: { marginTop: shownMarks.length > 0 ? 16 : 0 } },
                  h('div', { className: 'dr-fw-partname', style: { marginBottom: 8 } }, '本页散记'),
                  shownNotes
                    .slice()
                    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                    .map((note) => noteCard(note, false)),
                )
              : null,
          )
        : grouped.map((group) =>
            h(
              'div',
              { key: group.key, className: 'dr-group' },
              showGroupHeads
                ? h(
                    'div',
                    { className: 'dr-group-head' },
                    h(
                      'div',
                      { className: 'dr-group-title' },
                      // 章号后面跟标题。章号是程序编的（第 N 章），标题来自 AI。
                      // 只看章号认不出是哪一章，只看标题又不知道读到了哪 —— 两个都要。
                      h('span', { className: 'dr-group-no' }, group.chapter ? '第 ' + group.seq + ' 章' : '未分章'),
                      h('span', { className: 'dr-group-name' }, group.chapter ? (group.chapter.title || '未命名章') : ''),
                      h(
                        'span',
                        { className: 'dr-group-count' },
                        (group.marks.length + group.notes.length) + ' 条',
                      ),
                      // 「清除本章」只在有章页码范围时出现：未分章组没有区间，
                      // 硬给一个「清除未分章」既说不清范围，也可能连带删掉
                      // 散落在框架外的标注 —— 那种删除不可预期，所以不给入口。
                      group.range
                        ? confirmClear && confirmClear.scope === group.key
                          ? h(
                              'span',
                              { className: 'dr-group-confirm' },
                              h(
                                'button',
                                {
                                  className: 'is-danger',
                                  onClick: () => {
                                    const target = confirmClear;
                                    setConfirmClear(null);
                                    if (target) onClearMarks(target.range);
                                  },
                                },
                                '确定',
                              ),
                              h('button', { onClick: () => setConfirmClear(null) }, '取消'),
                            )
                          : h(
                              'button',
                              {
                                className: 'dr-group-clear',
                                title: '清除这一章的全部标注与笔记',
                                onClick: () =>
                                  setConfirmClear({
                                    scope: group.key,
                                    range: group.range,
                                    count: group.marks.length + group.notes.length,
                                  }),
                              },
                              '清除本章',
                            )
                        : null,
                    ),
                  )
                : null,
              // 组内：先标注（按页内位置），再散记（按更新时间）
              group.marks
                .slice()
                .sort((a, b) => a.page - b.page || a.offset - b.offset)
                .map((mark) => markCard(mark, true)),
              group.notes
                .slice()
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .map((note) => noteCard(note, true)),
            ),
          );

      return h(
        'div',
        null,
        scopeSwitch,
        clearAllButton,
        // 确认态提示：说明「即将删掉几条、范围是什么」，避免用户凭记忆点确认
        confirmClear
          ? h(
              'div',
              { className: 'dr-clear-hint' },
              '即将清除 ' + confirmClear.count + ' 条（' +
                (confirmClear.range
                  ? '第 ' + (confirmClear.range.from + 1) + '–' + (confirmClear.range.to + 1) + ' 页'
                  : '全书') +
                '），不可恢复。',
            )
          : null,
        emptyThisPage
          ? h(
              'div',
              { className: 'dr-scope-hint' },
              '第 ' + (page + 1) + ' 页还没有标注或笔记。',
              h('button', { onClick: () => setScope('all') }, '看全部'),
            )
          : null,
        body,
        h(NewNoteBox, { page, onSave: onSaveNote, value: newNote, onChange: setNewNote }),
      );
    }

    /** 「给这一页记一条」的小盒子。 */
    function NewNoteBox(props) {
      const { page, onSave, value, onChange } = props;
      return h(
        'div',
        { style: { marginTop: 16 } },
        h('div', { className: 'dr-fw-partname', style: { marginBottom: 6 } }, '写一条笔记'),
        h('textarea', {
          className: 'dr-input',
          style: { width: '100%', minHeight: 62, resize: 'vertical' },
          placeholder: '记在第 ' + (page + 1) + ' 页…',
          value,
          onChange: (e) => onChange(e.target.value),
        }),
        h(
          'div',
          { className: 'dr-note-acts' },
          h(
            'button',
            {
              disabled: value.trim() === '',
              onClick: () => {
                if (value.trim() === '') return;
                onSave({ page, text: value });
                onChange('');
              },
            },
            '记下',
          ),
        ),
      );
    }

    /* ═══ 最小 Markdown 渲染（问答回答专用）═══════════════════════════════
       模型的回答是 Markdown：**结论**、`readAt`、- 列表项。
       上一版直接 white-space:pre-wrap 把纯文本倒出来，于是星号和反引号
       原样露在界面上（用户原话「有一些不明所以的符号」）。

       只覆盖问答真正会用到的语法。遇到不认识的标记**原样保留文本** ——
       渲染器的失败模式应当是「少渲染」，绝不能是「吃掉内容」。
       比如表格、嵌套列表就干脆不认，显示成原文也不影响读。 */

    /** 行内：**粗** / *斜* / `代码` / ~~删~~。返回 React 元素数组。 */
    function renderInline(text, keyPrefix) {
      const nodes = [];
      // 用一串有序的扫描，而不是层层 replace（replace 会把已插入的标签再处理一遍）
      const pattern = /(\*\*[^\n]+?\*\*)|(\*[^\n*]+?\*)|(`[^`\n]+?`)|(~~[^\n]+?~~)/g;
      let cursor = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const token = match[0];
        const key = keyPrefix + '-' + index;
        index += 1;
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)));
        } else if (token.startsWith('~~')) {
          nodes.push(h('span', { key, style: { textDecoration: 'line-through', opacity: 0.72 } }, token.slice(2, -2)));
        } else if (token.startsWith('`')) {
          nodes.push(h('code', { key, className: 'dr-md-code' }, token.slice(1, -1)));
        } else {
          nodes.push(h('em', { key }, token.slice(1, -1)));
        }
        cursor = match.index + token.length;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /**
     * 逐行解析成元素。
     *
     * 分段规则：**连续的非空行**属于同一段（Markdown 里换行不等于分段，
     * 空行才是）。模型经常在句子中间硬换行，按行分段会切得七零八落。
     */
    function renderMarkdown(source) {
      if (!source) return null;
      const lines = String(source).split('\n');
      const out = [];
      let para = [];
      let list = null; // { ordered:boolean, items:string[] }

      const flushPara = () => {
        if (para.length === 0) return;
        out.push(
          h('p', { key: 'p' + out.length, className: 'dr-md-p' }, renderInline(para.join(' '), 'p' + out.length)),
        );
        para = [];
      };
      const flushList = () => {
        if (!list) return;
        const items = list.items.map((item, i) =>
          h('li', { key: 'li' + i }, renderInline(item, 'li' + out.length + '-' + i)),
        );
        out.push(
          h(
            list.ordered ? 'ol' : 'ul',
            { key: 'l' + out.length, className: 'dr-md-list' },
            items,
          ),
        );
        list = null;
      };

      for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (line.trim() === '') {
          flushPara();
          flushList();
          continue;
        }
        // 标题：1~3 级。模型用 ### 就已经很深了。
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
          flushPara();
          flushList();
          const level = heading[1].length;
          out.push(
            h(
              'div',
              { key: 'h' + out.length, className: 'dr-md-h dr-md-h' + level },
              renderInline(heading[2], 'h' + out.length),
            ),
          );
          continue;
        }
        // 引用
        const quote = line.match(/^>\s*(.*)$/);
        if (quote) {
          flushPara();
          flushList();
          out.push(
            h(
              'div',
              { key: 'q' + out.length, className: 'dr-md-quote' },
              renderInline(quote[1], 'q' + out.length),
            ),
          );
          continue;
        }
        // 无序列表：- * •
        const bullet = line.match(/^[-*•]\s+(.*)$/);
        if (bullet) {
          flushPara();
          if (!list || list.ordered) {
            flushList();
            list = { ordered: false, items: [] };
          }
          list.items.push(bullet[1]);
          continue;
        }
        // 有序列表：1. 2)
        const numbered = line.match(/^(\d+)[.)]\s+(.*)$/);
        if (numbered) {
          flushPara();
          if (!list || !list.ordered) {
            flushList();
            list = { ordered: true, items: [] };
          }
          list.items.push(numbered[2]);
          continue;
        }
        // 普通文本行：并进当前段
        flushList();
        para.push(line);
      }
      flushPara();
      flushList();
      return out;
    }

    /* ═══ 侧栏「问答」页签 ═════════════════════════════════════════════════
       常驻的一栏，可以连问、可以翻看之前的回答。
       后端走 /ask：前端只发位置（page/offset/length），后端自己读原文。

       ## 核心设计：传**位置**，不传文字

       用户要求「选中的语句位置一并传给 AI，AI 收到位置后自行读取书文件」。
       所以这里存的不是 quote 字符串，而是 { page, offset, length } 三个数。

       好处不只是省带宽 —— 更关键的是**一致性**：
       后端拿着位置去 PDF 里切出来的，一定是文件里真实的那段；
       而如果传文字，客户端与文件一旦不同步（比如换了书、或标注区间按旧逻辑记的），
       AI 就会基于一段并不存在于书里的「引文」作答。
       所以界面上显示的那段原文只是**预览**，真正的引用由后端重新读出。

       ## 选中 → 传进来的路径

       正文里的浮动条有三个入口会落到这里：
         · 「?」按钮（就这段提问）
         · 侧栏框架页的「就这段提问」
         · 直接在侧栏勾选后点「引用当前选中」
       它们都只需给出 { page, offset, length, text }，其余由 AskTab 负责。 */
    function AskTab(props) {
      const { book, framework, page, pageCount, pending, onConsumePending } = props;

      /**
       * 对话轮次：`[{ role:'user'|'assistant', text, refText?, page? }]`。
       *
       * ## 为什么是数组而不是「一问一答两个 state」
       *
       * 用户要的是「像一个小型对话框」—— 那意味着**可以连问**：
       * 上一轮的回答会被下一轮引用（「那它和 X 有什么区别」这种追问）。
       * 单轮 state 做不到，因为每一轮都要把前面的上下文交给模型。
       *
       * 所以这里维护完整轮次列表，发给后端时截取最近若干轮。
       */
      const [turns, setTurns] = useState([]);
      /** 当前引用：{ page, offset, length, text } 或 null。 */
      const [ref, setRef] = useState(null);
      const [question, setQuestion] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const abortRef = useRef(null);
      const scrollRef = useRef(null);

      // 外部（正文浮动条）塞进来的引用：接住并清空 pending
      useEffect(() => {
        if (!pending) return;
        setRef(pending);
        if (pending.question) setQuestion(pending.question);
        onConsumePending && onConsumePending();
      }, [pending, onConsumePending]);

      // 卸载即停掉在跑的请求（否则关了面板请求还在烧 token）
      useEffect(
        () => () => {
          if (abortRef.current) abortRef.current.abort();
        },
        [],
      );

      /** 取「当前页」整页作为引用（没有选中时用这个）。 */
      const useWholePage = () => {
        setRef({ page, offset: undefined, length: undefined, text: '' });
      };

      const outline = useMemo(() => {
        const data = framework && framework.data;
        if (!data || !data.parts) return '';
        return data.parts
          .map((part) => part.name + '：' + (part.chapters || []).map((c) => c.title).join('、'))
          .join('\n');
      }, [framework]);

      /** 滚到底：新消息或流式增量都要跟着走。 */
      const scrollToBottom = () => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      };

      const ask = useCallback(async () => {
        if (busy) return;
        const q = question.trim();
        if (q === '') return;

        // 本轮引用快照：引用可能在流式期间被改，必须固定下来
        const refSnapshot = ref ? { page: ref.page, offset: ref.offset, length: ref.length, text: ref.text } : null;
        // 先把「用户这一问」推进列表，界面立刻有反馈（不必等模型）
        const userTurn = { role: 'user', text: q, refText: refSnapshot ? refSnapshot.text : '', page: refSnapshot ? refSnapshot.page : page };
        const historyForRequest = turns.map((t) => ({ role: t.role, text: t.text }));
        setTurns((prev) => [...prev, userTurn, { role: 'assistant', text: '' }]);
        setQuestion('');
        setBusy(true);
        setError('');
        const controller = new AbortController();
        abortRef.current = controller;

        /** 追加到**最后一条**助手消息（流式增量）。 */
        const appendToLast = (delta) => {
          setTurns((prev) => {
            if (prev.length === 0) return prev;
            const copy = prev.slice();
            const last = copy[copy.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            copy[copy.length - 1] = { ...last, text: last.text + delta };
            return copy;
          });
        };

        try {
          await api.stream(
            '/ask',
            {
              // 只发位置：后端自己去 PDF 里读（见 /ask 路由的注释）
              id: book && book.id,
              page: refSnapshot ? refSnapshot.page : page,
              offset: refSnapshot ? refSnapshot.offset : undefined,
              length: refSnapshot ? refSnapshot.length : undefined,
              neighbor: 1,
              question: q,
              bookTitle: book ? book.title : '',
              outline,
              // 多轮：把这之前的历史一起发（后端会截断与校验 role）
              history: historyForRequest,
            },
            (event) => {
              if (event.type === 'delta') {
                appendToLast(event.text);
                scrollToBottom();
              } else if (event.type === 'error') {
                setError(event.message || '回答失败');
              }
            },
            controller.signal,
          );
        } catch (e) {
          if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
          abortRef.current = null;
          scrollToBottom();
        }
      }, [busy, question, ref, book, page, outline, turns]);

      const stop = () => {
        if (abortRef.current) abortRef.current.abort();
      };

      /** 清空这段对话（不删笔记，只清屏）。 */
      const clearTurns = () => {
        if (busy) return;
        setTurns([]);
        setError('');
      };

      const isEmpty = turns.length === 0;

      return h(
        'div',
        { className: 'dr-qa' },
        /* ── 历史区：可滚动，占满剩余高度 ──────────────────────────
           空态时给一点引导，但不要长篇——这里是对话框，不是说明书。 */
        h(
          'div',
          { className: 'dr-qa-scroll', ref: scrollRef, 'data-dr-scrollable': '1' },
          isEmpty
            ? h(
                'div',
                { className: 'dr-qa-empty' },
                h('div', { className: 'dr-dim' }, '在正文里选中一段，点浮动条上的 ➜ 把这段带过来；或直接提问，我会按当前页读上下文。'),
              )
            : turns.map((turn, index) =>
                h(
                  'div',
                  {
                    key: 'turn' + index,
                    className: 'dr-qa-turn is-' + turn.role,
                  },
                  // 用户轮：显示它引用了哪一页的哪段（便于回看自己问的是哪句）
                  turn.role === 'user' && turn.refText
                    ? h(
                        'div',
                        { className: 'dr-qa-turn-ref' },
                        '引用 · 第 ' + ((turn.page ?? 0) + 1) + ' 页：',
                        turn.refText.length > 80 ? turn.refText.slice(0, 80) + '…' : turn.refText,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'dr-qa-bubble' },
                    // 助手消息走 Markdown（模型会输出 **粗体** 与列表）；
                    // 用户消息是纯文本，原样显示 —— 用户输入里的星号就该是星号。
                    turn.role === 'assistant'
                      ? turn.text
                        ? renderMarkdown(turn.text)
                        : busy && index === turns.length - 1
                          ? h('span', { className: 'dr-qa-dots' }, '正在读这一页并作答…')
                          : null
                      : turn.text,
                  ),
                ),
              ),
          // 流式期间贴底：内容变长时滚动位置要跟上
        ),

        error ? h('div', { className: 'dr-err' }, error) : null,

        /* ── 输入区：**固定在底部**（原来在顶部，写问题时要往上找）──── */
        h(
          'div',
          { className: 'dr-qa-composer' },
          // 引用条紧贴输入框上方：它是这一发的附件，属于输入区的一部分
          ref
            ? h(
                'div',
                { className: 'dr-qa-chip' },
                h('span', { className: 'dr-qa-chip-t' }, '第 ' + (ref.page + 1) + ' 页'),
                h(
                  'span',
                  { className: 'dr-qa-chip-x' },
                  ref.text ? (ref.text.length > 40 ? ref.text.slice(0, 40) + '…' : ref.text) : '整页',
                ),
                h('button', { className: 'dr-qa-x', title: '取消引用', onClick: () => setRef(null) }, '×'),
              )
            : h(
                'div',
                { className: 'dr-qa-chip is-empty' },
                h(
                  'button',
                  { className: 'dr-qa-chip-add', onClick: useWholePage },
                  '引用当前页 · 第 ' + (page + 1) + ' 页',
                ),
              ),
          h(
            'div',
            { className: 'dr-qa-inputrow' },
            h('textarea', {
              className: 'dr-input dr-qa-input',
              placeholder: isEmpty ? '问这一页…' : '接着问…',
              value: question,
              rows: 1,
              onChange: (e) => setQuestion(e.target.value),
              onKeyDown: (e) => {
                // Enter 发送 / Shift+Enter 换行：对话框的常见手感。
                // 这里和之前不同 —— 之前是「多行输入，⌘+Enter 才发」，
                // 但用户要的是「像小型对话框」，那种手感就是回车即发。
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  ask();
                }
              },
            }),
            busy
              ? h('button', { className: 'dr-qa-send is-stop', onClick: stop, title: '停止' }, '■')
              : h(
                  'button',
                  {
                    className: 'dr-qa-send',
                    disabled: question.trim() === '',
                    onClick: ask,
                    title: '发送（Enter）',
                  },
                  '↑',
                ),
          ),
          h(
            'div',
            { className: 'dr-qa-foot' },
            h('span', { className: 'dr-qa-hint' }, 'Enter 发送 · Shift+Enter 换行'),
            turns.length > 0
              ? h('button', { className: 'dr-qa-clear', disabled: busy, onClick: clearTurns }, '清空对话')
              : null,
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          installStyles(ctx);
        } catch (error) {
          console.error('[dsh-reader] 样式注入失败', error);
        }
        try {
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: '阅读' }, ReaderIcon),
          );
        } catch (error) {
          console.error('[dsh-reader] 侧栏入口注册失败', error);
        }
        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ api }) }, ReaderPage),
          );
        } catch (error) {
          console.error('[dsh-reader] 主面板注册失败', error);
        }
      },
    };
  },
});
