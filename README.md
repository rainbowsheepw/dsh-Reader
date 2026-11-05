# dsh-reader

[English](README.en.md) · 简体中文

[![CI](https://github.com/rainbowsheepw/dsh-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/rainbowsheepw/dsh-reader/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：**宫格书架 + PDF 精读**。
为长时间读技术书（教材、论文、手册）设计，不是走马观花用的预览器。

从侧栏「阅读」进入，书架以 2:3 封面宫格排布；点开一本书进入连续滚动阅读，
可以在正文上做**精确到字**的四色标注、写笔记、让 AI 生成整书框架、
以及选中一段话直接问 AI（AI 自己回 PDF 里读原文，不靠前端传字）。

---

## 功能

### 书架
- **宫格布局**，每本书用**真实封面**（取 PDF 第一页渲染，一次生成后缓存，不重复消耗）
- 封面图在浏览器端渲染、上传后落盘，书架直接读图 —— 几十本书不会卡主线程
- 拖拽导入 PDF；书会被复制进插件数据目录，**原文件挪走也不影响**
- **阅读进度百分比**、标注数量、是否有框架，一眼可见
- **随时重命名**（悬停书名出现 ✎，回车保存 / Esc 取消）；只改显示名，不改原始文件名

### 阅读
- **连续滚动**，不是一页一页的幻灯片：像纸书那样上下连读
- 只渲染窗口内的页（可见页 ±2），300 页的书也不会吃光内存
- **缩放倍数按书记忆**：每本书记住自己的倍数，下次打开还是那个大小
- 阅读位置记忆（节流 + 尾随写盘，连续滚动不会丢最后位置）

### 标注
- 基于 **PDF 真实文字层**，不是框选坐标 —— 文字可选中、可复制
- **精确到字**：选几个字就只标几个字，不会扩到整句
- 四色（黄 / 绿 / 蓝 / 粉），下划线画在文字盒**外侧**，字号变大也不会压住字形
- 选中文字即刻浮现工具条：标注 / 送到「问答」

### 侧栏（三个页签）
- **整体框架**：AI 读全书生成的 篇 → 章 → 节 结构树，可展开为全屏画布；顶部合并了「读到哪」
- **问答**：小型多轮对话框，输入框贴底。选中正文后「送进来」的引用带**位置信息**
  （页码 + 字符区间），由后端直接回 PDF 里切原文，不依赖前端转述
- **标注笔记**：按章分组、可切「全部 / 当页」、缩略态悬停展开；支持清空当页 / 单章 / 全书

### 主题
- 全部颜色走宿主 `--dsw-alias-*` token，**亮暗主题自动跟随**，深色模式无白底白字
- 无硬编码色值（唯一例外是封面渐变底：它恒为深色，因此固定白字）

---

## 安装

```bash
# 在 DSH profile 目录下
dsh plugin add @rainbowsheepw/dsh-reader
```

或本地链接开发：

```bash
cd <你的 DSH profile>
pnpm add link:/path/to/dsh-reader
```

装好后重启 DSH，侧栏出现「阅读」入口。

> **改代码后需要重启 DSH。** client 半的变更受宿主 release 门控（见「开发」一节）。

---

## 使用

1. 侧栏点「阅读」→ 书架
2. 「导入 PDF」或把文件拖进来
3. 点封面打开书
4. 选中文字 → 工具条 → 选颜色标注，或「送到问答」
5. 侧栏「整体框架」可让 AI 读全书、生成结构树（需要配置模型）

---

## 数据存放

```
~/.dsh/dsh-reader/library/<book-id>/
├── book.pdf      原始字节副本
├── cover.png     封面缩略图（浏览器渲染第一页后上传）
└── meta.json     书名、进度、缩放、标注、笔记、框架
```

- **没有全局索引文件**：书目靠扫目录得出，少一份会被双写的真相
- 写入一律**原子**（先写 `.tmp` 再 rename），进程中途挂掉不会留下半截坏文件
- 同一本书的写操作**串行排队**，避免进度与标注互相覆盖

备份就复制这个目录；删书就是删这个目录。

---

## 开发

### 项目结构

```
index.js              Host 半入口：挂载 /api 路由
client.js             Client 半（单文件，DSH 插件形态要求）
lib/
├── store.js          存储层：书目录、meta、标注、笔记、封面
├── http.js           16 条精确 /api 路由（含 2 条 vendor 静态资源）
├── llm.js            框架生成与问答的提示词与流式调用
├── book-text.js      按「页码 + 字符区间」从 PDF 读原文
├── paths.js          路径解析与 book-id 校验
└── client/
    └── framework-layout.js   框架树的纯布局引擎（Node 可测）
scripts/             25 个回归脚本
vendor/              pdf.js 4.10.38（含 LICENSE）
```

### 为什么 `client.js` 是单文件

DSH 的 client 半只接受一个入口文件；宿主虽支持 `client.<name>.js` 分块，
但那需要构建工具生成带 `rev` 的 URL，手写 `import` 拿不到正确地址。
所以保持单文件，用**分区注释**组织，而不是硬拆。

### 跑测试

```bash
node scripts/run-all.mjs          # 全部 25 个脚本
node scripts/run-all.mjs --verbose
```

单个脚本也可单独跑，例如：

```bash
# 用真实 PDF 验证「精确到字」的切原文
DR_SAMPLE_PDF="/path/to/any.pdf" node scripts/mark-range-check.mjs
```

### 开发时必须知道的几件事

写在这里的都是**踩过坑**的，不是理论：

1. **改 client 半后必须重启 DSH。**
   宿主的 `rebuilt` 帧只在页面与宿主 release 一致时才被接受
   （`dsh-client-modules` 的 `reload()` 首行就是 `if (!this.release.matches) return`）。
   插件重载会改变 release → 已打开的页面永久失联 → 看起来"代码没生效"。

2. **CSS 在模板字符串里，注释中禁止出现反引号。**
   一个反引号就会提前终止 CSS，`node --check` 可能还能过，
   错误变成运行时 ReferenceError。`mark-style-check` 的 E 段会扫出具体行号。

3. **Hook 声明顺序必须是**：`useState/useRef` → `useCallback/useMemo` → `useEffect`。
   顺序反了会撞 TDZ（`Cannot access X before initialization`），面板直接不渲染。
   
4. **`/api` 路由必须走 `connection.fetch.register` 的精确路径。**
   `webServer.register({kind:'prefix'})` 在 `/api` 下会被网关拦成 401。
   且方法只允许 **GET / HEAD / POST**，没有 PUT。

5. **URL 拼查询参数用 `&`。** `coverUrl()` 已含 `?`，再拼 `?v=` 会拼成 `?id=x?v=y`，
   id 被污染 → 400 → `<img>` 静默 `onError` → 功能永不出现却不报任何错。

6. **测试断言要断行为，不要断实现。**
   `cover-rename-check` 的 F 段会真跑一遍路由；
   只断"代码里有某个字符串"的断言，在功能坏掉时依然全绿。

更多细节见 [`DEV-NOTES.md`](DEV-NOTES.md)。

---

## 已知边界

- 封面在**浏览器端**渲染（宿主 Node 侧没有 canvas，pdf.js `render()` 无法运行），
  因此首次打开书架时新书封面会**一本一本**补生成，能看到陆续出现
- 只支持 PDF
- 框架生成与问答需在 DSH 里配置可用模型
- 标注定位依赖 PDF 内嵌文字层；扫描版（纯图片）PDF 无法选中文字

---

## 许可

代码 MIT。`vendor/` 下的 pdf.js 为 Apache-2.0，见 [`vendor/pdfjs-LICENSE`](vendor/pdfjs-LICENSE)。
