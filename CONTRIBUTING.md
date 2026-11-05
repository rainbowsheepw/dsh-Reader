# 贡献指南

## 环境

- Node.js >= 22
- 一个可用的 DSH 安装（开发时需要把插件 link 进某个 profile）

## 开发流程

```bash
git clone <repo> dsh-reader
cd dsh-reader

# 在 DSH profile 目录下 link 本仓库
pnpm add link:/path/to/dsh-reader

# 改完代码后重启 DSH（client 半的变更受宿主 release 门控，见下）
```

## 提交前必须通过

```bash
node scripts/run-all.mjs
```

25 个脚本、600+ 条断言必须全绿。如果某项失败，先看它打印的 ❌ 行，
每一条断言都对应一个曾经真实发生过的故障。

## 测试的写作约定

1. **断行为，不要只断实现。**
   只检查"源码里有某个字符串"的断言，在功能坏掉时依然会绿
   （本项目就发生过：封面功能完全失效，而 50 条结构断言全过）。
   涉及运行时的，尽量把真实函数抽出来跑，或直接调用路由的 `fetch`。

2. **不要写永远为真的断言。**
   写完先反向验证一遍：把代码改回错误写法，确认这条断言真的会红。

3. **不要用某个具体数值钉住"手感"参数。**
   样式微调（比如下划线偏移）很频繁，写死 `0.18em` 会让每次调样式都变红。
   改成区间断言（`0.15em ≤ x ≤ 0.40em`），并保住有物理含义的上下限。

4. **区间的两端要用稳定锚点。**
   不要拿「某个组件名/某段注释」当截取边界 —— 组件删掉后锚点消失，
   断言会切成空字符串而集体假红。用文件级骨架（比如工厂的 `return {`）。

## 代码约定

- 单引号、4 空格缩进、语句以分号结尾
- 注释写**为什么**，不写**是什么**（代码已经说了是什么）
- 每个不明显的常量都要说明取值理由，尤其是凭经验定的数值

### 必须遵守的硬约束

这些不是风格偏好，违反会直接出故障：

1. **Css 在模板字符串里 → 注释中禁止出现反引号**
   一个反引号就会提前终止 CSS。`node --check` 可能还能过，
   错误变成运行时 ReferenceError。

2. **Hook 声明顺序**：`useState/useRef` → `useCallback/useMemo` → `useEffect`
   顺序反了会撞 TDZ（`Cannot access X before initialization`），面板直接不渲染。
   `scripts/render-smoke-check.mjs` 是唯一能自动抓到的脚本，改完必跑。

3. **Host 沙箱里没有** `Buffer` / `process` / `setTimeout`
   字节一律 `TextEncoder` / `Uint8Array`。

4. **`/api` 路由必须 `connection.fetch.register` 精确路径**
   `webServer` 前缀路由在 `/api` 下会被网关拦成 401。
   方法只允许 **GET / HEAD / POST**。

5. **URL 拼查询参数用 `&`**
   已有 `?` 的 URL 再拼 `?v=` 会污染参数，后端 400，
   而 `<img>` 失败是静默的 —— 功能永不出现却不报错。

## 提交信息

用 `type: 摘要` 的形式，说明**为什么**改：

```
feat: 每本书记住自己的缩放倍数
fix: 封面 URL 用 & 追加参数（双问号导致 400 且静默失败）
check: 补部分覆盖的行为断言
```

## 报告问题

请附上：
- 复现步骤
- 期望行为 vs 实际行为
- 若涉及渲染：浏览器控制台输出
- 若涉及书籍数据：`~/.dsh/dsh-reader/library/<id>/meta.json`（注意先删掉隐私内容）
