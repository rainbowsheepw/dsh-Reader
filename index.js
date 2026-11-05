/**
 * dsh-reader — Host 半入口。
 *
 * 职责：把 `/api/dsh-reader/*` 路由族挂到宿主，并给出模型调用句柄。
 *
 * ## 为什么只有 `connection.fetch` 一条通道
 *
 * 这是装机后实测撞出来的，不是设计洁癖：
 *
 * - `webServer.register({ kind: 'exact' })` 在 `/api/*` 下**确实能通**（`/status`、`/books`
 *   都实测 200 过），但 `kind: 'prefix'` 一律被宿主 API 网关拦成 `401 unauthorized`。
 *   pdf.js 那一对约 1.7MB 的静态文件如果用前缀路由，页面永远拿不到。
 * - `connection.fetch.register` 才是 `/api` 的正式入口：精确路径 + 浏览器凭据校验，
 *   `fetch(Request) → Response`；注册归插件 fiber，卸载即消失。
 *
 * 两套通道同时注册同一路径时宿主会抛「duplicate route」，而用微任务竞速去猜谁先到
 * 等于拿启动时序赌博。所以只保留一条通道，挂不上就打一句能诊断的日志。
 *
 * ## 两条会把整条 fiber 判 FAILED 的坑（都是实测换来的）
 *
 * 1. **沙箱没有 `process` / `Buffer`**：顶层读 `process.env` 直接 `ReferenceError`，
 *    此后**一条路由都不存在**（用户看到整个面板 404）。所以一行都不碰 process，
 *    字节一律 `Uint8Array` + `TextEncoder`。
 * 2. **读到没写进 inject 的服务是抛异常，不是给 undefined**：于是 `if (ctx.x === undefined)`
 *    自己就会炸；炸在 `ctx.effect` 回调里 try/catch 兜不住（cordis 直接判 fiber FAILED）。
 *    所以：硬依赖一律为空，`connection` 走 `ctx.inject([...], …)`，其余一律 `ctx.get` 且显式兜住。
 *
 * `llm` / `agentDefaultModel` **绝不写 inject**：没配模型时 cordis 会把 fiber 停在 pending，
 * 路由一条都不注册 —— 「没配模型」应当只让 AI 功能不可用，不能让书架一起消失。
 */
import { resolvePaths, isBookId } from './lib/paths.js';
import { makeRoutes } from './lib/http.js';
import { resolveLlm } from './lib/llm.js';

/** cordis 插件名（= 包名，patch 里那一行按它 import）。 */
export const name = 'dsh-reader';

/**
 * 硬依赖为空：`connection` 用 `ctx.inject(['connection'], …)` 显式依赖 —— 它缺失时
 * 只让路由挂不上并留下日志，不会把 fiber 停在 pending。
 */
export const inject = [];

/**
 * 从 ctx 服务里找出 DSH 数据根目录。
 * 只用 `ctx.get`（沙箱 Proxy 对 get 不做 inject 校验）；拿不到返回 undefined，
 * 由 store 回落 `~/.dsh`。
 * @param {any} ctx
 * @returns {string|undefined}
 */
function resolveDshHome(ctx) {
  if (typeof ctx.get !== 'function') return undefined;
  for (const serviceName of ['sandbox', 'storage', 'workspace']) {
    let service;
    try {
      service = ctx.get(serviceName);
    } catch {
      continue;
    }
    if (service === null || typeof service !== 'object') continue;
    const value = service.dshHome ?? service.dataDir ?? service.homeDir;
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * 挂载路由族与能力句柄。
 * @param {any} ctx - Host 插件上下文
 * @param {{dshHome?:string, enabled?:boolean}} [config]
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return;

  const paths = resolvePaths(config?.dshHome ?? resolveDshHome(ctx));

  /** 每次用时现解析：模型路由可能在会话中间被用户改过。 */
  const llmHandle = () => resolveLlm(ctx);

  let routes;
  try {
    routes = makeRoutes({
      paths,
      llmHandle,
      logger: { warn: (error) => ctx.logger.warn(error) },
    });
  } catch (error) {
    ctx.logger.warn(error);
    ctx.logger.warn('dsh-reader: 路由构造失败，插件未生效');
    return;
  }

  /** 是否已经成功挂上路由（用于给一句可诊断的日志，而不是静默什么都不做）。 */
  let mounted = false;

  // ── `/api` 的唯一正确通道：connection.fetch ────────────────────────────
  //
  // 为什么不留 `webServer.register` 的退路：实测过，`kind:'exact'` 在 `/api` 下能通，
  // 但两套通道注册同一路径时宿主会抛「duplicate route」；而用微任务竞速去猜哪一套先到，
  // 就是在拿启动时序赌一把。宁可只有一条通道 + 一句能诊断的日志，也不要一个会随机
  // 半死不活的双通道。（profile 里没有 connection 的情形不属于本插件的目标形态：
  //  Web GUI 的 /api 本来就由它提供。）
  if (typeof ctx.inject !== 'function') {
    ctx.logger.warn('dsh-reader: 宿主没有 ctx.inject，/api 路由无法挂载（插件未生效）');
    return;
  }

  try {
    ctx.inject(['connection'], (connectionCtx) => {
      const registry = connectionCtx?.connection?.fetch;
      if (!registry || typeof registry.register !== 'function') {
        ctx.logger.warn('dsh-reader: connection.fetch 不可用，/api 路由无法挂载');
        return;
      }
      if (typeof connectionCtx.effect !== 'function') {
        ctx.logger.warn('dsh-reader: connection 上下文没有 effect，路由无法挂载');
        return;
      }
      for (const route of routes) {
        // 每条路由各挂各的 effect：一条失败不影响其余路由。
        try {
          connectionCtx.effect(() => registry.register(route), `dsh-reader: ${route.path}`);
          mounted = true;
        } catch (error) {
          ctx.logger.warn(error);
          ctx.logger.warn(`dsh-reader: 路由 ${route.path} 没挂上`);
        }
      }
      if (mounted) {
        ctx.logger.info?.(`dsh-reader: ${routes.length} 条 /api 路由已挂载`);
      }
    });
  } catch (error) {
    ctx.logger.warn(error);
    ctx.logger.warn('dsh-reader: connection 注入失败，/api 路由未挂载');
  }
}

