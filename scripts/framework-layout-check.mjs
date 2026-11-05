// 框架图布局回归：四层表达必须齐全，且几何不重叠、不越界。
//
// 版式参照一份真实教材的「全书框架」页面的四层手段：
//   ① 圆角框 = 分段   ② 段内箭头 = 章序   ③ 跨段箭头+标签 = 递进   ④ 卡内文字 = 章名/要点
// 只有箭头会丢「分段」，只有框会丢「顺序」，所以四层一起断言。
//
// 用法：node scripts/framework-layout-check.mjs
import { layoutFramework, wrapText, estimateTextWidth, METRICS } from '../lib/client/framework-layout.js';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log('FAIL ' + name + ' ' + (detail ?? ''));
  }
};

/** 真实形状：4 段，章数分别是 1 / 3 / 6 / 2（含一段宽到会换行的）。 */
const framework = {
  title: '《神经网络与深度学习（通识版）》',
  summary: '从历史与浪潮讲起，进入机器学习基础，再到大模型与前沿。',
  parts: [
    {
      name: '第 1 章 绪论',
      question: '深度学习从哪里来？',
      transition: '打基础',
      chapters: [{ index: 1, title: '智能的第三次浪潮', pages: [10, 30], gist: '历史脉络', keyPoints: ['三次浪潮', '端到端'] }],
    },
    {
      name: '第一段 · 打地基（第 2–4 章）',
      question: '机器怎么自己学？',
      transition: '装上引擎',
      chapters: [
        { index: 2, title: '机器如何自己学习', pages: [31, 60], gist: '三要素', keyPoints: ['模型', '损失', '优化'] },
        { index: 3, title: '从神经元到深度网络', pages: [61, 90], gist: '结构', keyPoints: ['前馈', '卷积', '循环'] },
        { index: 4, title: '把网络训好的艺术', pages: [91, 130], gist: '训练技巧', keyPoints: ['过拟合', '正则化'] },
      ],
    },
    {
      name: '第三段 · 大模型与广义应用（第 8–13 章）',
      question: '怎么落地？',
      transition: '走向物理',
      chapters: [
        { index: 8, title: '语言的魔法', pages: [161, 200], gist: '大语言模型', keyPoints: ['分词'] },
        { index: 9, title: '钢与硅', pages: [201, 240], gist: '算力基础设施', keyPoints: ['GPU'] },
        { index: 10, title: '智能的延伸', pages: [241, 280], gist: '智能体', keyPoints: ['ReAct', 'RAG'] },
        { index: 11, title: '从噪声中创造', pages: [281, 310], gist: '扩散模型', keyPoints: ['去噪'] },
        { index: 12, title: '看听说一体', pages: [311, 340], gist: '多模态', keyPoints: ['跨模态'] },
        { index: 13, title: 'AI 遇上科学', pages: [341, 370], gist: 'AI4Science', keyPoints: ['AlphaFold'] },
      ],
    },
    {
      name: '第四段 · 物理世界、风险与未来（第 14–16 章）',
      question: '边界在哪？',
      transition: '',
      chapters: [
        { index: 14, title: '走进物理世界', pages: [371, 400], gist: '具身智能', keyPoints: ['VLA'] },
        { index: 15, title: '脆弱的巨人', pages: [401, 430], gist: '安全问题', keyPoints: ['对抗样本'] },
      ],
    },
  ],
};

const L = layoutFramework(framework);

// ── ① 分段层：段落框 ──────────────────────────────────────────────
t('每段一个区域框', L.bands.length === framework.parts.length, `${L.bands.length} vs ${framework.parts.length}`);
t('区域框都有名字', L.bands.every((b) => typeof b.name === 'string' && b.name.length > 0), '');
t('区域框都有尺寸', L.bands.every((b) => b.w > 0 && b.h > 0), '');

// ── ② 顺序层：段内箭头 ────────────────────────────────────────────
const inBand = L.edges.filter((e) => e.kind === 'in-band' || e.kind === 'in-band-wrap');
const crossBand = L.edges.filter((e) => e.kind === 'cross-band');
const totalChapters = framework.parts.reduce((n, p) => n + p.chapters.length, 0);
t('节点数 = 总章数', L.nodes.length === totalChapters, `${L.nodes.length} vs ${totalChapters}`);
// 段内箭头 = 每段内「章数−1」之和
const expectInBand = framework.parts.reduce((n, p) => n + Math.max(0, p.chapters.length - 1), 0);
t('段内箭头数 = 各段章数差之和', inBand.length === expectInBand, `${inBand.length} vs ${expectInBand}`);

// ── ③ 递进层：跨段箭头 + 标签 ─────────────────────────────────────
t('跨段箭头数 = 段数−1', crossBand.length === framework.parts.length - 1, `${crossBand.length}`);
const labeled = crossBand.filter((e) => typeof e.label === 'string' && e.label.length > 0);
const expectLabels = framework.parts.filter((p) => typeof p.transition === 'string' && p.transition.length > 0).length;
t('跨段箭头带过渡标签', labeled.length === expectLabels, `带标签 ${labeled.length}，期望 ${expectLabels}（末段 transition 为空）`);
t('标签就是 transition 原文', labeled.every((e, i) => e.label === framework.parts[i].transition), '');

// ── ④ 卡片层：章名分行了 ─────────────────────────────────────────
t('长章名被折行', (() => {
  const longTitle = '这是一个特别长的章标题用来验证折行是否真的发生'; 
  const L2 = layoutFramework({ parts: [{ name: '段', chapters: [{ index: 1, title: longTitle, pages: [1, 9] }] }] });
  return L2.nodes[0].titleLines.length >= 2;
})(), '用一个真的长标题验证');
t('章名不超两行', L.nodes.every((n) => n.titleLines.length <= 2), '');
t('每张卡都有章号', L.nodes.every((n) => typeof n.index === 'number'), '');
t('有 gist 的卡有文字行', L.nodes.filter((n) => n.chapter.gist).every((n) => n.gistLines.length > 0), '');

// ── 几何正确性 ────────────────────────────────────────────────────
// 同一段内，节点不得互相重叠
let overlaps = 0;
for (let i = 0; i < L.nodes.length; i += 1) {
  for (let j = i + 1; j < L.nodes.length; j += 1) {
    const a = L.nodes[i];
    const b = L.nodes[j];
    const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    if (hit) overlaps += 1;
  }
}
t('节点之间无重叠', overlaps === 0, '重叠对数 ' + overlaps);

// 所有节点必须落在画布内
const outOfCanvas = L.nodes.filter((n) => n.x < 0 || n.y < 0 || n.x + n.w > L.width || n.y + n.h > L.height);
t('节点全在画布内', outOfCanvas.length === 0, outOfCanvas.length + ' 个越界');

// 每张卡必须落在它所属段落的框内
const nodeOutOfBand = L.nodes.filter((n) => {
  const band = L.bands[n.bandIndex];
  return !band || n.x < band.x - 1 || n.x + n.w > band.x + band.w + 1 || n.y < band.y - 1 || n.y + n.h > band.y + band.h + 1;
});
t('卡片全在所属段落框内', nodeOutOfBand.length === 0, nodeOutOfBand.length + ' 张出框');

// 段落框之间不得重叠（纵向）
let bandOverlaps = 0;
for (let i = 0; i < L.bands.length; i += 1) {
  for (let j = i + 1; j < L.bands.length; j += 1) {
    const a = L.bands[i];
    const b = L.bands[j];
    if (a.y < b.y + b.h && b.y < a.y + a.h) bandOverlaps += 1;
  }
}
t('段落框之间不重叠', bandOverlaps === 0, String(bandOverlaps));

// 跨段箭头必须真的向下（不能在原地打转）
t('跨段箭头向下指', crossBand.every((e) => {
  const m = e.path.match(/M (\S+) (\S+) L (\S+) (\S+)/);
  return m && Number(m[4]) > Number(m[2]);
}), '');

// 段内箭头必须水平（同一行内）
t('同行箭头水平', L.edges.filter((e) => e.kind === 'in-band').every((e) => {
  const m = e.path.match(/M (\S+) (\S+) L (\S+) (\S+)/);
  return m && Math.abs(Number(m[4]) - Number(m[2])) < 0.5;
}), 'in-band 箭头必须水平');
t('折行箭头是折线', L.edges.filter((e) => e.kind === 'in-band-wrap').every((e) => e.path.split('L').length === 3), '');

// ── 换行与文字估算 ────────────────────────────────────────────────
t('wrapText 会截断并加省略号', (() => {
  const lines = wrapText('这是一段非常非常非常长的文字用来测试折行逻辑是否正确工作', 60, 12, 2);
  return lines.length === 2 && lines[1].endsWith('…');
})(), '');
t('wrapText 短文本不折行', wrapText('短标题', 200, 12, 2).length === 1, '');
t('estimateTextWidth 中文更宽', estimateTextWidth('中文', 12) > estimateTextWidth('ab', 12), '');

// ── 边界情况 ─────────────────────────────────────────────────────
const empty = layoutFramework({ parts: [] });
t('空框架不崩', empty.nodes.length === 0 && empty.bands.length === 0, '');
const single = layoutFramework({ parts: [{ name: '全书', chapters: [{ index: 1, title: '唯一一章', pages: [1, 9] }] }] });
t('单章单段不画跨段箭头', single.edges.filter((e) => e.kind === 'cross-band').length === 0, '');
t('单段无跨段箭头但仍有画布尺寸', single.width > 0 && single.height > 0, '');

// 超长一段（12 章）必须换行，且不越界
const many = layoutFramework({
  parts: [{ name: '大段', chapters: Array.from({ length: 12 }, (_, i) => ({ index: i + 1, title: '第' + (i + 1) + '章', pages: [i * 10 + 1, i * 10 + 9] })) }],
});
t('12 章会自动折行', many.nodes.some((n) => n.y > many.nodes[0].y), '');
t('折行后仍在画布内', many.nodes.every((n) => n.x + n.w <= many.width && n.y + n.h <= many.height), '');
t('折行后不重叠', (() => {
  for (let i = 0; i < many.nodes.length; i += 1) {
    for (let j = i + 1; j < many.nodes.length; j += 1) {
      const a = many.nodes[i];
      const b = many.nodes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
    }
  }
  return true;
})(), '');

console.log(`\n${pass} pass, ${fail} fail`);
console.log('画布尺寸', Math.round(L.width) + '×' + Math.round(L.height), '· 段落', L.bands.length, '· 节点', L.nodes.length, '· 箭头', L.edges.length);
process.exitCode = fail ? 1 : 0;
