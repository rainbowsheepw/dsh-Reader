/**
 * dsh-reader 的数据目录解析。
 *
 * DSH 把插件 Host 半放进 vm 沙箱执行，沙箱里**没有 `process`**（取值就是 undefined），
 * 所以绝不能读 `process.env`。需要覆盖目录时由 index.js 从 ctx 服务里取好再传进来，
 * 拿不到就回落 `~/.dsh`（`homedir()` 在沙箱里可用）。
 */
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** 书本 id 的形状（也是目录名）：只允许小写十六进制与短横线，天然挡住路径穿越。 */
export const BOOK_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

/**
 * 解析插件数据路径。
 * @param {string} [dshHome] - DSH 数据根目录，缺省 `~/.dsh`。
 * @returns {{dir:string, libraryDir:string}}
 */
export function resolvePaths(dshHome) {
  const root = dshHome ?? homedir() + sep + '.dsh';
  const dir = join(root, 'dsh-reader');
  return { dir, libraryDir: join(dir, 'library') };
}

/**
 * 判一个 id 是否合法（防止 `../` 之类的目录穿越）。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isBookId(id) {
  return typeof id === 'string' && BOOK_ID_RE.test(id);
}
