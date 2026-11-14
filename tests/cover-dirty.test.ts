import { describe, expect, it } from 'vitest';
import { coverAction, coverDirty, type CoverParams } from '../src/webui/dirty.ts';

const base: CoverParams = {
  pitch: 0,
  indexRate: 0.3,
  protect: 0.33,
  chunk: true,
  voice: 'daifeiyu',
  vocalGainDb: 0,
  instGainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  format: 'wav',
};

const with_ = (patch: Partial<CoverParams>): CoverParams => ({ ...base, ...patch });

describe('翻唱按钮的 dirty 判定', () => {
  it('没改动时两组都不脏，动作是完整重跑', () => {
    expect(coverDirty(base, base)).toEqual({ inference: false, mix: false });
    expect(coverAction(coverDirty(base, base), true)).toBe('rerun');
  });

  it('变调/索引率/保护/长音频/音色都会让推理组变脏', () => {
    for (const patch of [
      { pitch: 12 },
      { indexRate: 0.6 },
      { protect: 0.5 },
      { chunk: false },
      { voice: 'xll' },
    ] satisfies Array<Partial<CoverParams>>) {
      expect(coverDirty(with_(patch), base).inference).toBe(true);
      expect(coverDirty(with_(patch), base).mix).toBe(false);
    }
  });

  it('增益/淡入淡出/格式只让混音组变脏', () => {
    for (const patch of [
      { vocalGainDb: 3 },
      { instGainDb: -2 },
      { fadeInSec: 1.5 },
      { fadeOutSec: 2 },
      { format: 'mp3' },
    ] satisfies Array<Partial<CoverParams>>) {
      expect(coverDirty(with_(patch), base)).toEqual({ inference: false, mix: true });
    }
  });

  it('改了又改回去不算改动', () => {
    const applied = with_({ pitch: 5, indexRate: 0.5, vocalGainDb: 2, format: 'mp3' });
    const edited = with_({ pitch: 12, indexRate: 0.2, vocalGainDb: -4, format: 'wav' });
    expect(coverDirty(edited, applied)).toEqual({ inference: true, mix: true });
    expect(coverDirty(applied, applied)).toEqual({ inference: false, mix: false });
    // 浮点滑杆的等值按容差比较，0.1+0.2 这种误差不算改动。
    expect(coverDirty(with_({ indexRate: 0.30000000000000004 }), base).inference).toBe(false);
  });

  it('没有结果时永远是「开始翻唱」；有结果后按改动选动作', () => {
    expect(coverAction({ inference: true, mix: true }, false)).toBe('cover');
    expect(coverAction({ inference: false, mix: true }, true)).toBe('remix');
    expect(coverAction({ inference: true, mix: false }, true)).toBe('rerun');
    expect(coverAction({ inference: true, mix: true }, true)).toBe('rerunMix');
  });
});
