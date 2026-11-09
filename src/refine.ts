/**
 * 精修编排：把「选段重跑」的校验、区间换算、会话回写放在一处。
 *
 * 真正的推理在 worker（`convertRange`），这里只做 Node 侧该做的事：
 * 1. 读会话、把秒换算成整数样本（浮点先落地，避免累计误差）；
 * 2. 调引擎重跑选段（worker 负责窗口读取、重采样、峰值补偿、交叉淡化与原子替换）；
 * 3. 把这次重跑记进 `session.json.segments[]` 并更新 `updatedAt`。
 *
 * 纯计算（`rangeSamples` / `appendSegment`）与引擎解耦，方便单测。
 */
import { join } from 'node:path';
import type { ConvertDone, PeaksDone, RangeConvertRequest } from './engine.ts';
import { readSession, sessionDir, writeSession, type RefineSegment, type RefineSession } from './session.ts';

/** 窗口上下文：选区前后各多读 0.5 秒给模型，只写回选区。 */
export const RANGE_CONTEXT_SEC = 0.5;
/** 选区边缘交叉淡化；在选区内部完成，因此选区外样本不变。 */
export const RANGE_SEAM_SEC = 0.3;
/** 面板波形桶数：一屏约 900 像素，1200 个桶足够细。 */
export const PEAK_BUCKETS = 1200;
/** 太短的选区听不出内容，也容易让交叉淡化占满整段。 */
export const MIN_RANGE_SEC = 0.05;

/** 精修需要的引擎能力；`RvcEngine` 直接满足。 */
export interface EngineAdapter {
  peaks(req: { path: string; buckets?: number }): Promise<PeaksDone>;
  convertRange(req: RangeConvertRequest): Promise<ConvertDone>;
}

export interface RangeSamples {
  /** 选区起点（整数样本）。 */
  start: number;
  /** 选区终点（整数样本，不含）。 */
  end: number;
  /** `end - start`。 */
  length: number;
}

/**
 * 秒 → 整数样本。起点夹到 0；给了 `totalFrames` 时终点不许越过文件末尾。
 * 不合法的区间直接抛，让面板显示原因，而不是写坏文件。
 */
export function rangeSamples(
  startSec: number,
  endSec: number,
  sampleRate: number,
  totalFrames?: number,
): RangeSamples {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw new Error('选段必须是数字');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('采样率无效');
  const start = Math.max(0, Math.round(startSec * sampleRate));
  const end = Math.round(endSec * sampleRate);
  if (end - start < 1) throw new Error('结束时间必须大于开始时间');
  if (totalFrames !== undefined && end > totalFrames) {
    throw new Error(`选段超出音频长度（共 ${(totalFrames / sampleRate).toFixed(2)} 秒）`);
  }
  return { start, end, length: end - start };
}

/** 把这次重跑追加进会话；返回新记录，并把 `updatedAt` 一起刷新。 */
export function appendSegment(
  session: RefineSession,
  startSec: number,
  endSec: number,
  params: RefineSegment['params'],
  at = new Date().toISOString(),
): RefineSegment {
  const revision = session.segments.reduce((max, item) => Math.max(max, item.revision), 0) + 1;
  const segment: RefineSegment = {
    id: `r${revision}`,
    start: startSec,
    end: endSec,
    params: { ...params },
    revision,
    at,
    kind: 'range',
  };
  session.segments = [...session.segments, segment];
  session.updatedAt = at;
  return segment;
}

export interface PeaksWithId extends PeaksDone {
  id: string;
}

/** 读某个会话变声结果的波形包络；会话不存在或文件缺失时抛。 */
export async function readPeaks(
  dataDir: string,
  engine: EngineAdapter,
  id: string,
  buckets = PEAK_BUCKETS,
): Promise<PeaksWithId> {
  const dir = sessionDir(dataDir, id);
  const session = dir ? readSession(dataDir, id) : null;
  if (!dir || !session) throw new Error(`找不到会话：${id || '(空)'}`);
  const result = await engine.peaks({ path: join(dir, session.converted.path), buckets });
  return { ...result, id };
}

export interface RangeOptions {
  startSec: number;
  endSec: number;
  /** 留空则沿用会话里的默认参数。 */
  pitch?: number;
  indexRate?: number;
  protect?: number;
}

export interface RangeResult {
  id: string;
  session: RefineSession;
  segment: RefineSegment;
  done: ConvertDone;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 校验会话与选区 → 调引擎重跑 → 记录 segments 并原子写回 session.json。 */
export async function rerunRange(
  dataDir: string,
  engine: EngineAdapter,
  id: string,
  opts: RangeOptions,
): Promise<RangeResult> {
  const dir = sessionDir(dataDir, id);
  const session = dir ? readSession(dataDir, id) : null;
  if (!dir || !session) throw new Error(`找不到会话：${id || '(空)'}`);

  const startSec = Number(opts.startSec);
  const endSec = Number(opts.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw new Error('选段必须是数字');
  // 会话时长是四舍五入到毫秒的；终点越界只夹到时长，剩下的零头交给 worker 按实际帧数截断。
  const durationSec = session.source.durationSec > 0 ? session.source.durationSec : endSec;
  const clampedStart = clamp(startSec, 0, durationSec);
  const clampedEnd = clamp(endSec, 0, durationSec);
  if (clampedEnd - clampedStart < MIN_RANGE_SEC) {
    throw new Error(`选段至少 ${MIN_RANGE_SEC} 秒，且在音频范围内`);
  }
  rangeSamples(clampedStart, clampedEnd, session.converted.sampleRate);

  const defaults = session.converted.defaults;
  const params = {
    pitch: Math.round(clamp(numberOr(opts.pitch, defaults.pitch), -24, 24)),
    indexRate: clamp(numberOr(opts.indexRate, defaults.indexRate), 0, 1),
    protect: clamp(numberOr(opts.protect, defaults.protect), 0, 0.5),
  };

  const done = await engine.convertRange({
    stem: join(dir, session.stems.vocals),
    conv: join(dir, session.converted.path),
    startSec: clampedStart,
    endSec: clampedEnd,
    contextSec: RANGE_CONTEXT_SEC,
    seamSec: RANGE_SEAM_SEC,
    outSr: session.converted.sampleRate,
    voice: session.engine.voice,
    inputPeak: session.source.inputPeak,
    ...params,
  });

  const segment = appendSegment(session, clampedStart, clampedEnd, params);
  writeSession(dataDir, id, session);
  return { id, session, segment, done };
}
