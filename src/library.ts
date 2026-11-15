/**
 * 翻唱库：独立于会话目录的成品副本，按清唱 / 翻唱两类存放。
 *
 * 目录默认落在 Coopanion 扩展根下（`data/extensions/rvc-library`），
 * 不写 `data/home/...` 的用户数据目录；索引一律原子写。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { parseWav } from './wav.ts';

export type LibraryKind = 'clean' | 'cover';

export interface LibraryEntry {
  id: string;
  kind: LibraryKind;
  /** 规范化后的检索名。 */
  song: string;
  /** 展示名。 */
  title: string;
  /** 相对库根目录的路径。 */
  file: string;
  bytes: number;
  durationSec: number;
  format: string;
  createdAt: string;
  sessionId?: string;
  sourceHash: string;
  voice?: string;
  mastered?: boolean;
}

export interface LibraryIndex {
  version: 1;
  updatedAt: string;
  maxBytes: number;
  entries: LibraryEntry[];
}

export interface LibraryStats {
  root: string;
  totalBytes: number;
  maxBytes: number;
  count: number;
}

export interface SaveLibraryOptions {
  root: string;
  kind: LibraryKind;
  title: string;
  sourcePath: string;
  sessionId?: string;
  voice?: string;
  mastered?: boolean;
  /** 成品时长（秒）；面板列表要显示。 */
  durationSec?: number;
  maxBytes?: number;
}

export interface SaveLibraryResult {
  entry: LibraryEntry;
  duplicate: boolean;
  stats: LibraryStats;
}

/** 2 GB；库是副本，不能无限涨。 */
export const LIBRARY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** 默认库根：`<dataDir>/../../../../extensions/rvc-library`。 */
export function defaultLibraryDir(dataDir: string): string {
  return normalize(join(dataDir, '..', '..', '..', '..', 'extensions', 'rvc-library'));
}

export function libraryDirs(root: string): { clean: string; cover: string } {
  return { clean: join(root, 'clean'), cover: join(root, 'cover') };
}

export function ensureLibrary(root: string): void {
  const dirs = libraryDirs(root);
  mkdirSync(dirs.clean, { recursive: true });
  mkdirSync(dirs.cover, { recursive: true });
}

/** 检索用：去《》、扩展名、空格与常见标点，统一小写。 */
export function songKey(title: string): string {
  return title
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[《》「」『』【】()（）[\]\s]+/g, '')
    .replace(/[，。！？、,.!?;；:：'"“”‘’\-_/\\]+/g, '')
    .trim()
    .toLowerCase();
}

/** 文件名用：保留中文，清掉 Windows 不允许的字符。 */
export function safeSongName(title: string): string {
  const cleaned = title
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || '未命名';
}

export function entryFileName(title: string, kind: LibraryKind, ext: string): string {
  const suffix = kind === 'clean' ? '清唱cover' : '翻唱cover';
  return `${safeSongName(title)}_${suffix}${ext || '.wav'}`;
}

function emptyIndex(maxBytes = LIBRARY_MAX_BYTES): LibraryIndex {
  return { version: 1, updatedAt: new Date().toISOString(), maxBytes, entries: [] };
}

function readIndexFile(root: string): LibraryIndex | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as LibraryIndex;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return null;
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      maxBytes: Number.isFinite(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : LIBRARY_MAX_BYTES,
      entries: raw.entries.filter((item) => item && typeof item.id === 'string'),
    };
  } catch {
    return null;
  }
}

/** 索引坏了就从目录里的文件名恢复；恢复不了的文件跳过，不影响其它条目。 */
function rebuildIndex(root: string, maxBytes: number): LibraryIndex {
  const index = emptyIndex(maxBytes);
  for (const kind of ['clean', 'cover'] as const) {
    const dir = join(root, kind);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const suffix = kind === 'clean' ? '_清唱cover' : '_翻唱cover';
      const at = name.lastIndexOf(suffix);
      if (at <= 0) continue;
      const ext = extname(name);
      if (!ext) continue;
      const full = join(dir, name);
      let bytes = 0;
      let atTime = new Date().toISOString();
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        bytes = st.size;
        atTime = st.mtime.toISOString();
      } catch { continue; }
      const title = name.slice(0, at);
      index.entries.push({
        id: `scan-${createHash('sha1').update(`${kind}/${name}`).digest('hex').slice(0, 12)}`,
        kind,
        song: songKey(title),
        title,
        file: `${kind}/${name}`,
        bytes,
        durationSec: 0,
        format: ext.slice(1).toLowerCase(),
        createdAt: atTime,
        sourceHash: `scan:${bytes}`,
      });
    }
  }
  return index;
}

export function readLibrary(root: string, maxBytes = LIBRARY_MAX_BYTES): LibraryIndex {
  ensureLibrary(root);
  const index = readIndexFile(root);
  if (index) return index;
  const rebuilt = rebuildIndex(root, maxBytes);
  writeLibrary(root, rebuilt);
  return rebuilt;
}

export function writeLibrary(root: string, index: LibraryIndex): void {
  ensureLibrary(root);
  index.updatedAt = new Date().toISOString();
  const target = join(root, 'index.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, target);
  } catch {
    try { rmSync(target, { force: true }); } catch { /* ignore */ }
    renameSync(tmp, target);
  }
}

/** 给缺时长的 WAV 条目补时长（老索引、手工放进来的文件）；返回是否有改动。 */
export function backfillDurations(root: string, index: LibraryIndex): boolean {
  let changed = false;
  for (const entry of index.entries) {
    if (entry.durationSec > 0 || entry.format !== 'wav') continue;
    const full = join(root, entry.file);
    let fd: number | null = null;
    try {
      fd = openSync(full, 'r');
      const head = Buffer.alloc(64 * 1024);
      const got = readSync(fd, head, 0, head.length, 0);
      const info = parseWav(head.subarray(0, got));
      if (info && info.durationSec > 0) {
        entry.durationSec = Math.round(info.durationSec * 1000) / 1000;
        changed = true;
      }
    } catch {
      // 文件不在或读不了就跳过，列表仍按「—」显示。
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* 已关闭 */ }
      }
    }
  }
  return changed;
}

export function libraryStats(root: string, index?: LibraryIndex): LibraryStats {
  const data = index ?? readLibrary(root);
  return {
    root,
    totalBytes: data.entries.reduce((sum, item) => sum + (Number.isFinite(item.bytes) ? item.bytes : 0), 0),
    maxBytes: data.maxBytes,
    count: data.entries.length,
  };
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function nextFileName(root: string, base: string, ext: string): string {
  let name = `${base}${ext}`;
  let n = 2;
  while (existsSync(join(root, name))) {
    name = `${base} (${n})${ext}`;
    n += 1;
  }
  return name;
}

/** 把一份会话成品复制进库；同内容只保留一条，不同内容追加序号，不覆盖。 */
export function saveToLibrary(opts: SaveLibraryOptions): SaveLibraryResult {
  const root = opts.root;
  const sourcePath = opts.sourcePath;
  if (!sourcePath || !existsSync(sourcePath)) throw new Error('要保存的文件已经不存在了');
  const st = statSync(sourcePath);
  if (!st.isFile() || st.size <= 0) throw new Error('要保存的文件是空的');
  ensureLibrary(root);
  const index = readLibrary(root, opts.maxBytes ?? LIBRARY_MAX_BYTES);
  if (opts.maxBytes !== undefined) index.maxBytes = opts.maxBytes;
  const hash = hashFile(sourcePath);
  const title = safeSongName(opts.title);
  const song = songKey(title);
  const duplicate = index.entries.find(
    (item) => item.kind === opts.kind && item.song === song && item.sourceHash === hash,
  );
  if (duplicate) {
    return { entry: duplicate, duplicate: true, stats: libraryStats(root, index) };
  }
  if (index.entries.reduce((sum, item) => sum + item.bytes, 0) + st.size > index.maxBytes) {
    throw new Error(`翻唱库超过 ${Math.round(index.maxBytes / 1024 / 1024)} MB 上限，先删掉几首再保存`);
  }
  const ext = extname(sourcePath).toLowerCase() || '.wav';
  const folder = opts.kind;
  const base = `${safeSongName(title)}_${opts.kind === 'clean' ? '清唱' : '翻唱'}cover`;
  const fileName = nextFileName(join(root, folder), base, ext);
  const rel = `${folder}/${fileName}`;
  copyFileSync(sourcePath, join(root, rel));
  const entry: LibraryEntry = {
    id: `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}-${hash.slice(0, 6)}-${randomBytes(2).toString('hex')}`,
    kind: opts.kind,
    song,
    title,
    file: rel,
    bytes: st.size,
    durationSec: Math.max(0, opts.durationSec ?? 0),
    format: ext.slice(1).toLowerCase() || 'wav',
    createdAt: new Date().toISOString(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    sourceHash: hash,
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.mastered ? { mastered: true } : {}),
  };
  index.entries.push(entry);
  writeLibrary(root, index);
  return { entry, duplicate: false, stats: libraryStats(root, index) };
}

export function deleteLibraryEntry(root: string, id: string): LibraryStats {
  const index = readLibrary(root);
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) throw new Error('翻唱库里没有这一条');
  const full = join(root, entry.file);
  rmSync(full, { force: true });
  index.entries = index.entries.filter((item) => item.id !== id);
  writeLibrary(root, index);
  return libraryStats(root, index);
}

export function resolveLibraryFile(root: string, id: string): LibraryEntry & { fullPath: string } {
  const index = readLibrary(root);
  const entry = index.entries.find((item) => item.id === id);
  if (!entry) throw new Error('翻唱库里没有这一条');
  const fullPath = join(root, entry.file);
  if (!existsSync(fullPath)) throw new Error('翻唱库文件不在了，可能被手动删除了');
  return { ...entry, fullPath };
}

/** 按歌名找：先精确，再包含；同歌优先清唱，其次最新。 */
export function findLibraryEntry(
  root: string,
  title: string,
  kind: 'auto' | LibraryKind = 'auto',
): LibraryEntry | null {
  const key = songKey(title);
  if (!key) return null;
  const entries = readLibrary(root).entries.filter((item) => kind === 'auto' || item.kind === kind);
  const rank = (item: LibraryEntry): number => {
    const exact = item.song === key ? 0 : item.song.includes(key) || key.includes(item.song) ? 1 : 9;
    const clean = item.kind === 'clean' ? 0 : 1;
    return exact * 10 + clean;
  };
  const hits = entries.filter((item) => rank(item) < 20);
  hits.sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return hits[0] ?? null;
}
