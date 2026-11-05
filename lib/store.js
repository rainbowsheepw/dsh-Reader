/**
 * 存储层：一本书 = `library/<id>/` 一个目录。
 *
 * ```text
 * library/<id>/book.pdf     原始字节副本（导入即复制，原文件删了书还在）
 * library/<id>/meta.json    书名、格式、进度、标注、笔记、框架
 * ```
 *
 * 设计纪律（每一条都有代价换来的）：
 * - **不维护全局 index.json**：书目靠扫目录得出，少一份会被双写的真相。
 * - **原子写**：先写 `.tmp` 再 rename，进程中途挂掉不会留下半截坏文件。
 * - **同一本书的写操作串行**：内存里按 id 排队，避免「进度写回」与「新建标注」交错覆盖。
 * - **沙箱纪律**：没有 `Buffer`，字节处理一律 `TextEncoder` / `TextDecoder`。
 */
import { mkdir, readFile, writeFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 每本书的默认骨架。 */
function emptyMeta(id, fields) {
  return {
    schema: 1,
    id,
    title: fields.title,
    fileName: fields.fileName,
    format: fields.format ?? 'pdf',
    bytes: fields.bytes ?? 0,
    pages: 0,
    addedAt: Date.now(),
    lastOpenedAt: 0,
    progress: { page: 0, pct: 0, updatedAt: 0, scale: 0 },
    marks: [],
    notes: [],
    framework: { status: 'none', generatedAt: 0, data: null, error: '' },
  };
}

/** 逐 id 的串行队列。 */
const queues = new Map();

/**
 * 在某个 id 的独占队列里跑一次读-改-写。
 * @param {string} id
 * @param {() => Promise<any>} work
 * @returns {Promise<any>}
 */
function serialized(id, work) {
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(work);
  queues.set(
    id,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/** 书目目录。 */
function bookDir(paths, id) {
  return join(paths.libraryDir, id);
}

/** meta 路径。 */
function metaPath(paths, id) {
  return join(bookDir(paths, id), 'meta.json');
}

/** 原文件路径（统一叫 book.pdf，格式记在 meta 里）。 */
function bookFile(paths, id) {
  return join(bookDir(paths, id), 'book.pdf');
}

/**
 * 原子写 JSON。
 * @param {string} file
 * @param {unknown} value
 */
async function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

/** 读 JSON；不存在返回 undefined，坏文件也返回 undefined（调用方当作空）。 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 把磁盘上的 meta 规整成当前 schema（老数据缺字段就补默认值，不改语义）。
 * @param {any} raw
 * @returns {any}
 */
function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  const framework = raw.framework && typeof raw.framework === 'object' ? raw.framework : {};
  return {
    ...emptyMeta(raw.id, { title: raw.title, fileName: raw.fileName, format: raw.format }),
    ...raw,
    pages: Number.isInteger(raw.pages) ? raw.pages : 0,
    bytes: Number.isFinite(raw.bytes) ? raw.bytes : 0,
    progress: {
      page: Number.isInteger(progress.page) ? progress.page : 0,
      pct: Number.isFinite(progress.pct) ? progress.pct : 0,
      updatedAt: Number.isFinite(progress.updatedAt) ? progress.updatedAt : 0,
      /**
       * 缩放倍数。0 表示"从未设置过"，由前端回落到 DEFAULT_SCALE。
       * 不在这里夹成 1 之类的"合理值"：那会把"没设置"和"设成 1 倍"混成同一状态，
       * 老书下次打开就会被强行改成 100%，用户会觉得设置没保存。
       */
      scale: Number.isFinite(progress.scale) ? clampScale(progress.scale) : 0,
    },
    marks: Array.isArray(raw.marks) ? raw.marks : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    framework: {
      status: framework.status ?? 'none',
      generatedAt: Number.isFinite(framework.generatedAt) ? framework.generatedAt : 0,
      data: framework.data ?? null,
      error: typeof framework.error === 'string' ? framework.error : '',
    },
  };
}

/**
 * 新建一本书：建目录、落原始字节、写 meta。
 * @param {{dir:string, libraryDir:string}} paths
 * @param {{title:string, fileName:string, bytes:Uint8Array, format?:string}} input
 */
export async function createBook(paths, input) {
  const id = randomUUID().replace(/-/g, '').slice(0, 24);
  if (input.bytes === undefined || input.bytes.length === 0) throw new Error('空文件，无法导入');
  await mkdir(bookDir(paths, id), { recursive: true });
  await writeFile(bookFile(paths, id), input.bytes);
  const meta = emptyMeta(id, {
    title: input.title,
    fileName: input.fileName,
    format: input.format ?? 'pdf',
    bytes: input.bytes.length,
  });
  await writeJsonAtomic(metaPath(paths, id), meta);
  return meta;
}

/** 列出全部书目（按最近打开倒序，未打开过的按导入时间倒序）。 */
export async function listBooks(paths) {
  let entries = [];
  try {
    entries = await readdir(paths.libraryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = normalizeMeta(await readJson(metaPath(paths, entry.name)));
    if (!meta || meta.id !== entry.name) continue;
    // 只暴露读取端需要的字段，路径不外泄（阅读器经 /file 路由取字节）。
    books.push({
      id: meta.id,
      title: meta.title,
      fileName: meta.fileName,
      format: meta.format,
      bytes: meta.bytes,
      pages: meta.pages,
      addedAt: meta.addedAt,
      lastOpenedAt: meta.lastOpenedAt,
      progress: meta.progress,
      markCount: meta.marks.length,
      noteCount: meta.notes.length,
      framework: {
        status: meta.framework.status,
        generatedAt: meta.framework.generatedAt,
        title: meta.framework.data?.title ?? '',
      },
    });
  }
  books.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
  return books;
}

/** 读一本书的完整 meta。 */
export async function readMeta(paths, id) {
  const meta = normalizeMeta(await readJson(metaPath(paths, id)));
  return meta && meta.id === id ? meta : undefined;
}

/** 读一本书的原始字节。 */
export async function readBookBytes(paths, id) {
  const bytes = await readFile(bookFile(paths, id));
  return bytes;
}

/** 判一本书的文件是否真的还在。 */
export async function bookFileExists(paths, id) {
  try {
    const info = await stat(bookFile(paths, id));
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * 读-改-写一本书的 meta。改函数必须原地改并返回要落盘的对象。
 * @param {{dir:string, libraryDir:string}} paths
 * @param {string} id
 * @param {(meta:any) => any} mutate
 */
export async function updateMeta(paths, id, mutate) {
  return serialized(id, async () => {
    const meta = normalizeMeta(await readJson(metaPath(paths, id)));
    if (!meta || meta.id !== id) throw new Error('书不存在');
    const result = mutate(meta) ?? meta;
    await writeJsonAtomic(metaPath(paths, id), result);
    return result;
  });
}

/** 覆盖写框架字段（生成是长任务，单独一条，避免与进度写冲突被挤掉）。 */
export async function saveFramework(paths, id, framework) {
  return updateMeta(paths, id, (meta) => {
    meta.framework = {
      status: framework.status,
      generatedAt: framework.generatedAt ?? meta.framework.generatedAt ?? 0,
      data: framework.data ?? meta.framework.data ?? null,
      error: framework.error ?? '',
    };
    return meta;
  });
}

/** 删除一本书（目录整棵删掉）。 */
export async function deleteBook(paths, id) {
  return serialized(id, async () => {
    await rm(bookDir(paths, id), { recursive: true, force: true });
    return true;
  });
}

/**
 * 缩放的合法区间。
 *
 * 下限 0.5 是"再小就看不清正文"，上限 4.0 是"再大 pdf.js 渲染就卡"。
 * 这两个数是**产品判断**，不是技术极限 —— 技术上 pdf.js 能到 10 倍，
 * 但那时一页的位图就是几百 MB，滚两下浏览器就喘。
 */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 4;

/** 把任意输入夹到合法缩放区间；非数字原样返回 0（表示"未设置"）。 */
function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
}

/** 保存阅读进度（含缩放倍数）。 */
export async function saveProgress(paths, id, progress) {
  return updateMeta(paths, id, (meta) => {
    // 缩放只在**明确传了**的时候更新：页码保存是高频的，缩放是低频的，
    // 若每次读盘都写一遍 scale，翻页时那些没带 scale 的请求会把上次设的值抹掉。
    const nextScale =
      progress.scale === undefined ? meta.progress.scale : clampScale(progress.scale);
    meta.progress = {
      page: Math.max(0, Math.trunc(progress.page ?? meta.progress.page)),
      pct: Math.max(0, Math.min(100, Number(progress.pct ?? meta.progress.pct))),
      updatedAt: Date.now(),
      scale: nextScale ?? 0,
    };
    meta.lastOpenedAt = Date.now();
    if (Number.isInteger(progress.pages) && progress.pages > 0) meta.pages = progress.pages;
    return meta;
  });
}

/** 合法的高亮色板：四色。 */
export const MARK_COLORS = ['amber', 'green', 'blue', 'rose'];

/** 新建或更新一条标注（带 id 就是更新）。 */
export async function upsertMark(paths, id, mark) {
  return updateMeta(paths, id, (meta) => {
    const now = Date.now();
    const existing = mark.id ? meta.marks.find((item) => item.id === mark.id) : undefined;
    if (existing) {
      if (typeof mark.note === 'string') existing.note = mark.note;
      if (typeof mark.color === 'string' && MARK_COLORS.includes(mark.color)) existing.color = mark.color;
      existing.updatedAt = now;
      return meta;
    }
    meta.marks.push({
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      page: Math.max(0, Math.trunc(mark.page ?? 0)),
      offset: Math.max(0, Math.trunc(mark.offset ?? 0)),
      length: Math.max(1, Math.trunc(mark.length ?? 1)),
      text: String(mark.text ?? ''),
      color: MARK_COLORS.includes(mark.color) ? mark.color : 'amber',
      note: typeof mark.note === 'string' ? mark.note : '',
      createdAt: now,
      updatedAt: now,
    });
    return meta;
  });
}

/** 删一条标注。 */
export async function deleteMark(paths, id, markId) {
  return updateMeta(paths, id, (meta) => {
    meta.marks = meta.marks.filter((item) => item.id !== markId);
    return meta;
  });
}

/**
 * 批量清除标注与笔记。
 *
 * 两种范围都走**页码区间**，不走「章节 id」：
 * 章节归属是前端用框架算出来的（Host 半不该依赖前端传来的章名/章号），
 * 而且框架重生成一次，页码区间可能变 —— 让前端算好 [from, to] 传过来，
 * Host 只做纯粹的「删掉落在区间里的东西」。
 *
 * @param {{from:number, to:number}|null} range
 *   - null：清空**全部**标注与笔记
 *   - {from, to}：只清页码落在 [from, to] 的（0 起，闭区间）
 *   - 区间传 null 是「全清」，这个语义必须靠**显式**的 null 表达，
 *     不能靠 `from=0,to=0` 之类缺省值 —— 那样「只清第 1 页」和「清全部」就分不清了
 *
 * 返回删掉了多少条，UI 要用它在确认框里说「已清除 N 条」。
 */
export async function clearMarks(paths, id, range) {
  return updateMeta(paths, id, (meta) => {
    const inRange = (item) => {
      if (!range) return true;
      const page = Math.trunc(item.page ?? 0);
      return page >= range.from && page <= range.to;
    };
    const removedMarks = meta.marks.filter(inRange).length;
    const removedNotes = meta.notes.filter(inRange).length;
    meta.marks = meta.marks.filter((item) => !inRange(item));
    meta.notes = meta.notes.filter((item) => !inRange(item));
    // 把实际删除数挂到返回值上：`updateMeta` 返回的就是 meta 对象，
    // 但调用方还要知道删了多少 —— 用一个不可枚举的临时字段带回去，
    // 免得污染要写盘的 JSON（JSON.stringify 会跳过不可枚举属性）。
    Object.defineProperty(meta, '__cleared', {
      value: { marks: removedMarks, notes: removedNotes, total: removedMarks + removedNotes },
      enumerable: false,
      configurable: true,
    });
    return meta;
  });
}

/** 新建一条独立笔记（不绑标注）。 */
export async function addNote(paths, id, note) {
  return updateMeta(paths, id, (meta) => {
    const now = Date.now();
    meta.notes.push({
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      page: Math.max(0, Math.trunc(note.page ?? 0)),
      text: String(note.text ?? ''),
      createdAt: now,
      updatedAt: now,
    });
    return meta;
  });
}

/** 更新或删除笔记（text 为空串即删除）。 */
export async function editNote(paths, id, note) {
  return updateMeta(paths, id, (meta) => {
    const target = meta.notes.find((item) => item.id === note.id);
    if (!target) return meta;
    if (typeof note.text === 'string' && note.text.trim() === '') {
      meta.notes = meta.notes.filter((item) => item.id !== note.id);
    } else {
      target.text = String(note.text ?? target.text);
      target.updatedAt = Date.now();
    }
    return meta;
  });
}

/**
 * 阅读端要的那一份「整本状态」：元信息 + 进度 + 标注 + 笔记 + 框架。
 * @param {{dir:string, libraryDir:string}} paths
 * @param {string} id
 */
export async function readBookState(paths, id) {
  const meta = await readMeta(paths, id);
  if (!meta) return undefined;
  return {
    id: meta.id,
    title: meta.title,
    fileName: meta.fileName,
    format: meta.format,
    bytes: meta.bytes,
    pages: meta.pages,
    addedAt: meta.addedAt,
    progress: meta.progress,
    marks: meta.marks,
    notes: meta.notes,
    framework: meta.framework.status === 'done' ? meta.framework : { ...meta.framework, data: null },
  };
}
