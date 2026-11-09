/**
 * 翻唱会话：把一次翻唱的人声、伴奏、变声结果留在 `<dataDir>/sessions/<id>/`，
 * 面板之后可以只重做混音，不用重新分离/变声。
 *
 * 目录只属于 RVC：清理只动 `sessions/`，不碰用户主动保存的 `out/`。
 * `session.json` 一律原子写（先 `.tmp` 再替换），避免面板读到半截 JSON。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_VERSION = 1;
/** `<yyyyMMdd-HHmmss>-<4hex>`；也用于挡住 `../` 之类的路径穿越。 */
export const SESSION_ID_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;

export interface SessionMix {
  vocalGainDb: number;
  instGainDb: number;
  rmsRatio: number;
  /** 电平比例是否已冻结；重混沿用首次翻唱的比例，避免整首音量跳变。 */
  rmsFrozen: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  peakScale: number;
}

export interface SessionOutput {
  format: 'wav' | 'mp3';
  path: string;
  at: string;
}

export interface RefineSession {
  version: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  engine: { kind: string; voice: string; modelSampleRate: number };
  source: { durationSec: number; inputPeak: number; format: string };
  stems: { vocals: string; inst: string };
  converted: {
    path: string;
    sampleRate: number;
    channels: number;
    defaults: { pitch: number; indexRate: number; protect: number; chunk: boolean };
  };
  /** P2 才用；P0 先留空数组，字段定好后面只加不改。 */
  segments: unknown[];
  mix: SessionMix;
  outputs: SessionOutput[];
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
  durationSec: number;
  voice: string;
  outputs: number;
}

export interface GcOptions {
  /** 保留天数；0 表示不按时间清理。 */
  days: number;
  /** 总容量上限（GB）；0 表示不按容量清理。 */
  maxGb: number;
  /** 正在使用的 session，任何规则都不删。 */
  keep?: string[];
}

export interface GcResult {
  removed: string[];
  freed: number;
}

export function sessionsRoot(dataDir: string): string {
  return join(dataDir, 'sessions');
}

/** 新建一个空会话目录（stems / vocals / out 一次建好）。 */
export function createSession(dataDir: string): { id: string; dir: string } {
  const root = sessionsRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const id = `${stamp()}-${randomBytes(2).toString('hex')}`;
  const dir = join(root, id);
  mkdirSync(join(dir, 'stems'), { recursive: true });
  mkdirSync(join(dir, 'vocals'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  return { id, dir };
}

/** id 不合法或目录不存在时返回 null；不抛。 */
export function sessionDir(dataDir: string, id: string): string | null {
  if (!SESSION_ID_RE.test(id)) return null;
  const dir = join(sessionsRoot(dataDir), id);
  return existsSync(dir) ? dir : null;
}

export function readSession(dataDir: string, id: string): RefineSession | null {
  const dir = sessionDir(dataDir, id);
  if (!dir) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as RefineSession;
    if (!raw || raw.version !== SESSION_VERSION || raw.id !== id) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 原子写：先写 `.tmp`，再替换 `session.json`；Windows 下替换失败时退化成先删再改名。 */
export function writeSession(dataDir: string, id: string, data: RefineSession): void {
  const dir = sessionDir(dataDir, id);
  if (!dir) throw new Error(`session 不存在：${id}`);
  const target = join(dir, 'session.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, target);
  } catch {
    rmSync(target, { force: true });
    renameSync(tmp, target);
  }
}

/** 按最近修改倒序；读不懂的目录直接跳过，不影响其它会话。 */
export function listSessions(dataDir: string): SessionSummary[] {
  const root = sessionsRoot(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const id of entries) {
    if (!SESSION_ID_RE.test(id)) continue;
    const s = readSession(dataDir, id);
    if (!s) continue;
    out.push({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      bytes: dirBytes(join(root, id)),
      durationSec: s.source.durationSec,
      voice: s.engine.voice,
      outputs: s.outputs.length,
    });
  }
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return out;
}

export function removeSession(dataDir: string, id: string): boolean {
  const dir = sessionDir(dataDir, id);
  if (!dir) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 双阈值清理：先按天数删，再按总容量从旧到新删，直到不超过上限。
 * 只处理 `sessions/`；10 分钟内更新过的会话视为「可能正在用」，一律跳过。
 */
export function gcSessions(dataDir: string, opts: GcOptions): GcResult {
  const root = sessionsRoot(dataDir);
  const all = listSessions(dataDir);
  const keep = new Set(opts.keep ?? []);
  const now = Date.now();
  const guardMs = 10 * 60 * 1000;
  const removed: string[] = [];
  let freed = 0;

  const deletable = all.filter((s) => !keep.has(s.id) && now - Date.parse(s.updatedAt) > guardMs);
  const drop = (s: SessionSummary): void => {
    try {
      rmSync(join(root, s.id), { recursive: true, force: true });
      removed.push(s.id);
      freed += s.bytes;
    } catch {
      // 删不掉（被占用）就留到下次
    }
  };

  if (opts.days > 0) {
    const cutoff = now - opts.days * 86_400_000;
    for (const s of deletable) {
      if (Date.parse(s.updatedAt) < cutoff) drop(s);
    }
  }

  if (opts.maxGb > 0) {
    let total = all.reduce((sum, s) => sum + s.bytes, 0) - freed;
    const rest = deletable
      .filter((s) => !removed.includes(s.id))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const s of rest) {
      if (total <= opts.maxGb * 1_000_000_000) break;
      drop(s);
      total -= s.bytes;
    }
  }

  for (const s of all) {
    if (!removed.includes(s.id)) purgeStaleTmp(join(root, s.id));
  }
  return { removed, freed };
}

/** 递归统计目录字节数；读不到的文件跳过，不抛。 */
export function dirBytes(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // 正在写/已删就不计入
        }
      }
    }
  }
  return total;
}

/** 上次异常退出留下的混音临时件：超过 10 分钟就删。 */
function purgeStaleTmp(dir: string): void {
  const out = join(dir, 'out');
  let names: string[];
  try {
    names = readdirSync(out);
  } catch {
    return;
  }
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith('.tmp.wav')) continue;
    const full = join(out, name);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
    } catch {
      // 忽略
    }
  }
}

/** `20261109-221501`。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
