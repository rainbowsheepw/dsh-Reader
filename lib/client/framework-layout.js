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
export const METRICS = {
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
export function estimateTextWidth(text, fontSize) {
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
export function wrapText(text, maxWidth, fontSize, maxLines) {
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
export function layoutFramework(framework, options = {}) {
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
