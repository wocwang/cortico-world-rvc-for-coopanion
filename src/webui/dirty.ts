/**
 * 翻唱面板的「上次生效值」比对：变调/索引率/保护/长音频/音色需要重跑变声，
 * 增益/淡入淡出/格式只影响混音。改了又改回去不算改动。
 */

export interface CoverParams {
  pitch: number;
  indexRate: number;
  protect: number;
  chunk: boolean;
  voice: string;
  vocalGainDb: number;
  instGainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  format: string;
}

export interface CoverDirty {
  inference: boolean;
  mix: boolean;
}

/** 第一次翻唱；出结果后按改动决定只重混还是重跑变声。 */
export type CoverAction = 'cover' | 'rerun' | 'remix' | 'rerunMix';

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

export function coverDirty(current: CoverParams, applied: CoverParams): CoverDirty {
  return {
    inference:
      current.pitch !== applied.pitch ||
      !same(current.indexRate, applied.indexRate) ||
      !same(current.protect, applied.protect) ||
      current.chunk !== applied.chunk ||
      current.voice !== applied.voice,
    mix:
      !same(current.vocalGainDb, applied.vocalGainDb) ||
      !same(current.instGainDb, applied.instGainDb) ||
      !same(current.fadeInSec, applied.fadeInSec) ||
      !same(current.fadeOutSec, applied.fadeOutSec) ||
      current.format !== applied.format,
  };
}

/** 有结果时：只改混音 → 重新混音；改了变声参数 → 重新翻唱（两组都改则先变声再重混）。 */
export function coverAction(dirty: CoverDirty, hasResult: boolean): CoverAction {
  if (!hasResult) return 'cover';
  if (dirty.inference) return dirty.mix ? 'rerunMix' : 'rerun';
  return dirty.mix ? 'remix' : 'rerun';
}

/**
 * 哪几种动作必须有原声：重新翻唱要用分轨重跑变声，没原声就得让用户先补一份。
 * 「重新混音」只读会话里的 conv.wav + 伴奏，不碰原声，所以不在此列。
 */
export function actionNeedsSource(action: CoverAction): boolean {
  return action === 'rerun' || action === 'rerunMix';
}
