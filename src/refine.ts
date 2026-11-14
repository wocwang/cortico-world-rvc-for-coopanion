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
import { existsSync } from 'node:fs';
import type { ConvertDone, PeaksDone, RangeConvertRequest, ReconvertRequest, RestoreRangeRequest } from './engine.ts';
import {
  defaultSegments,
  readSession,
  sessionDir,
  writeSession,
  type RefineSegment,
  type RefineSession,
  type SegmentParams,
} from './session.ts';

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
  restoreRange(req: RestoreRangeRequest): Promise<ConvertDone>;
}

/** 原地重新翻唱需要的能力：复用分轨重跑变声。 */
export interface CoverEngineAdapter extends EngineAdapter {
  reconvert(req: ReconvertRequest): Promise<ConvertDone>;
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

function clampParams(
  defaults: SegmentParams,
  opts: { pitch?: number; indexRate?: number; protect?: number },
): SegmentParams {
  return {
    pitch: Math.round(clamp(numberOr(opts.pitch, defaults.pitch), -24, 24)),
    indexRate: clamp(numberOr(opts.indexRate, defaults.indexRate), 0, 1),
    protect: clamp(numberOr(opts.protect, defaults.protect), 0, 0.5),
  };
}

function mustRead(dataDir: string, id: string): { dir: string; session: RefineSession } {
  const dir = sessionDir(dataDir, id);
  const session = dir ? readSession(dataDir, id) : null;
  if (!dir || !session) throw new Error(`找不到会话：${id || '(空)'}`);
  return { dir, session };
}

/** 调引擎重跑一段：窗口、峰值补偿、交叉淡化都在 worker 里完成。 */
function convertSpan(
  engine: EngineAdapter,
  dir: string,
  session: RefineSession,
  startSec: number,
  endSec: number,
  params: SegmentParams,
  backupPath?: string,
): Promise<ConvertDone> {
  return engine.convertRange({
    stem: join(dir, session.stems.vocals),
    conv: join(dir, session.converted.path),
    startSec,
    endSec,
    contextSec: RANGE_CONTEXT_SEC,
    seamSec: RANGE_SEAM_SEC,
    outSr: session.converted.sampleRate,
    voice: session.engine.voice,
    inputPeak: session.source.inputPeak,
    backupPath,
    ...params,
  });
}

/** 校验会话与选区 → 调引擎重跑 → 记录 segments 并原子写回 session.json。 */
export async function rerunRange(
  dataDir: string,
  engine: EngineAdapter,
  id: string,
  opts: RangeOptions,
): Promise<RangeResult> {
  const { dir, session } = mustRead(dataDir, id);

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

  const params = clampParams(session.converted.defaults, opts);
  const done = await convertSpan(engine, dir, session, clampedStart, clampedEnd, params);

  const segment = appendSegment(session, clampedStart, clampedEnd, params);
  writeSession(dataDir, id, session);
  return { id, session, segment, done };
}

/**
 * 原地重新翻唱：复用会话里的分轨重跑整首变声（不重新分离），
 * `vocals/conv.wav` 原地替换，旧结果由 worker 备份成 `conv.bak.wav`。
 *
 * 段落参数、静音状态、成品历史、母带记录都不动；只更新默认参数、音色与
 * 冻结的电平比例（新变声结果的 RMS 与旧的不同，不更新会让重混音量跳变）。
 */
export interface RerunOptions {
  pitch?: number;
  indexRate?: number;
  protect?: number;
  chunk?: boolean;
  voice?: string;
}

export async function rerunSession(
  dataDir: string,
  engine: CoverEngineAdapter,
  id: string,
  opts: RerunOptions = {},
): Promise<{ session: RefineSession; done: ConvertDone }> {
  const { dir, session } = mustRead(dataDir, id);
  for (const rel of [session.stems.vocals, session.stems.inst, session.converted.path]) {
    if (!existsSync(join(dir, rel))) {
      throw new Error(`会话缺少 ${rel}，无法原地重跑；请重新上传原声翻唱一次`);
    }
  }
  const params = clampParams(session.converted.defaults, opts);
  const chunk = opts.chunk === undefined ? session.converted.defaults.chunk : Boolean(opts.chunk);
  const voice = (opts.voice ?? '').trim() || session.engine.voice;
  const done = await engine.reconvert({
    stem: join(dir, session.stems.vocals),
    inst: join(dir, session.stems.inst),
    conv: join(dir, session.converted.path),
    voice,
    pitch: params.pitch,
    indexRate: params.indexRate,
    protect: params.protect,
    chunk,
    expectedSec: session.source.durationSec,
  });

  const at = new Date().toISOString();
  session.converted.defaults = { ...params, chunk };
  if (voice) session.engine.voice = voice;
  if (typeof done.modelSampleRate === 'number' && done.modelSampleRate > 0) {
    session.engine.modelSampleRate = done.modelSampleRate;
  }
  // 新结果的 RMS 比例必须立刻冻结进会话，后续重混才和这次翻唱同一电平。
  if (typeof done.rmsRatio === 'number' && Number.isFinite(done.rmsRatio) && done.rmsRatio > 0) {
    session.mix.rmsRatio = done.rmsRatio;
    session.mix.rmsFrozen = true;
  }
  session.updatedAt = at;
  writeSession(dataDir, id, session);
  return { session, done };
}

/**
 * 老会话没有段落网格时补一份（P1 只存过 `range` 记录）。
 * 返回是否改动；调用方据此决定要不要回写 session.json。
 */
export function ensureSegments(session: RefineSession, at = new Date().toISOString()): boolean {
  if (session.segments.some((item) => item.kind === 'segment')) return false;
  const grid = defaultSegments(session.source.durationSec, session.converted.defaults, at);
  if (!grid.length) return false;
  session.segments = [...session.segments, ...grid].sort((a, b) => a.start - b.start);
  session.updatedAt = at;
  return true;
}

/** 静音段落只影响混音：把区间收集出来交给 remix，不改 conv.wav。 */
export function mutedRanges(segments: RefineSegment[]): Array<{ start: number; end: number }> {
  return segments
    .filter((item) => item.kind === 'segment' && item.muted)
    .map((item) => ({ start: item.start, end: item.end }));
}

function segmentIndex(session: RefineSession, segmentId: string): number {
  const index = session.segments.findIndex((item) => item.id === segmentId && item.kind === 'segment');
  if (index < 0) throw new Error(`找不到段落：${segmentId || '(空)'}`);
  return index;
}

function nextSegmentId(segments: RefineSegment[]): string {
  let max = 0;
  for (const item of segments) {
    const match = /^s(\d+)$/.exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `s${max + 1}`;
}

/** 在段落内部切一刀；两段都继承参数，备份作废（长度已经对不上）。 */
export function splitSegmentIn(
  session: RefineSession,
  segmentId: string,
  atSec: number,
  at = new Date().toISOString(),
): RefineSegment {
  const index = segmentIndex(session, segmentId);
  const segment = session.segments[index];
  const cut = Number(atSec);
  if (!Number.isFinite(cut) || cut - segment.start < MIN_RANGE_SEC || segment.end - cut < MIN_RANGE_SEC) {
    throw new Error(`切割点要离段落两端至少 ${MIN_RANGE_SEC} 秒`);
  }
  const left: RefineSegment = { ...segment, end: cut, backup: undefined, at };
  const right: RefineSegment = {
    id: nextSegmentId(session.segments),
    start: cut,
    end: segment.end,
    params: { ...segment.params },
    revision: 0,
    at,
    kind: 'segment',
    muted: false,
  };
  const rest = session.segments.slice();
  rest.splice(index, 1, left, right);
  session.segments = rest;
  session.updatedAt = at;
  return left;
}

/** 合并下一段（必须首尾相接）；合并后的备份作废。 */
export function mergeSegmentWithNext(
  session: RefineSession,
  segmentId: string,
  at = new Date().toISOString(),
): RefineSegment {
  const index = segmentIndex(session, segmentId);
  const segment = session.segments[index];
  const next = session.segments[index + 1];
  if (!next || next.kind !== 'segment' || Math.abs(next.start - segment.end) > 1e-6) {
    throw new Error('下一段不存在或与当前段不相接');
  }
  const merged: RefineSegment = { ...segment, end: next.end, backup: undefined, at };
  const rest = session.segments.slice();
  rest.splice(index, 2, merged);
  session.segments = rest;
  session.updatedAt = at;
  return merged;
}

export interface SegmentOptions {
  pitch?: number;
  indexRate?: number;
  protect?: number;
}

export interface SegmentActionResult {
  session: RefineSession;
  segment: RefineSegment;
}

/** 重做一段：首次重做前把原始音频写进 `segments/<id>.bak.wav`，还原用它。 */
export async function redoSegment(
  dataDir: string,
  engine: EngineAdapter,
  id: string,
  segmentId: string,
  opts: SegmentOptions = {},
): Promise<SegmentActionResult & { done: ConvertDone }> {
  const { dir, session } = mustRead(dataDir, id);
  ensureSegments(session);
  const index = segmentIndex(session, segmentId);
  const segment = session.segments[index];
  const params = clampParams(segment.params, opts);
  const backupRel = `segments/${segment.id}.bak.wav`;
  const done = await convertSpan(
    engine, dir, session, segment.start, segment.end, params, join(dir, backupRel),
  );
  const at = new Date().toISOString();
  const updated: RefineSegment = {
    ...segment,
    params,
    revision: segment.revision + 1,
    muted: false,
    backup: segment.backup ?? backupRel,
    at,
  };
  const rest = session.segments.slice();
  rest[index] = updated;
  session.segments = rest;
  session.updatedAt = at;
  writeSession(dataDir, id, session);
  return { session, segment: updated, done };
}

/** 静音/取消静音：只改 session.json，不碰音频。 */
export function muteSegment(
  dataDir: string,
  id: string,
  segmentId: string,
  muted: boolean,
  at = new Date().toISOString(),
): SegmentActionResult {
  const { session } = mustRead(dataDir, id);
  ensureSegments(session);
  const index = segmentIndex(session, segmentId);
  const updated: RefineSegment = { ...session.segments[index], muted: Boolean(muted), at };
  const rest = session.segments.slice();
  rest[index] = updated;
  session.segments = rest;
  session.updatedAt = at;
  writeSession(dataDir, id, session);
  return { session, segment: updated };
}

/**
 * 还原一段：有备份就用备份逐样本写回；没有备份才按会话默认参数重跑。
 * 还原后保留备份，重复还原是幂等的。
 */
export async function revertSegment(
  dataDir: string,
  engine: EngineAdapter,
  id: string,
  segmentId: string,
): Promise<SegmentActionResult & { restored: boolean }> {
  const { dir, session } = mustRead(dataDir, id);
  ensureSegments(session);
  const index = segmentIndex(session, segmentId);
  const segment = session.segments[index];
  const backupAbs = segment.backup ? join(dir, segment.backup) : '';
  const restored = Boolean(backupAbs && existsSync(backupAbs));
  if (restored) {
    await engine.restoreRange({
      conv: join(dir, session.converted.path),
      backup: backupAbs,
      start: Math.round(segment.start * session.converted.sampleRate),
      end: Math.round(segment.end * session.converted.sampleRate),
    });
  } else {
    await convertSpan(engine, dir, session, segment.start, segment.end, session.converted.defaults);
  }
  const at = new Date().toISOString();
  const updated: RefineSegment = {
    ...segment,
    params: { ...session.converted.defaults },
    muted: false,
    revision: segment.revision + 1,
    at,
  };
  const rest = session.segments.slice();
  rest[index] = updated;
  session.segments = rest;
  session.updatedAt = at;
  writeSession(dataDir, id, session);
  return { session, segment: updated, restored };
}

/** 在段落内切一刀并回写。 */
export function cutSegment(dataDir: string, id: string, segmentId: string, atSec: number): SegmentActionResult {
  const { session } = mustRead(dataDir, id);
  ensureSegments(session);
  const segment = splitSegmentIn(session, segmentId, atSec);
  writeSession(dataDir, id, session);
  return { session, segment };
}

/** 合并下一段并回写。 */
export function mergeSegments(dataDir: string, id: string, segmentId: string): SegmentActionResult {
  const { session } = mustRead(dataDir, id);
  ensureSegments(session);
  const segment = mergeSegmentWithNext(session, segmentId);
  writeSession(dataDir, id, session);
  return { session, segment };
}
