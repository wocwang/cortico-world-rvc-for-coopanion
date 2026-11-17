import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAudio, extractBvid, isBvid, pickCandidates, rankHits, songTitleFromBili, type SearchHit,
} from '../src/bili.ts';

const hit = (bvid: string, title: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  bvid,
  title,
  author: 'UP主',
  durationSec: 200,
  play: 1000,
  ...extra,
});

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('B 站候选打分', () => {
  it('从视频标题洗出干净曲名', () => {
    expect(songTitleFromBili('【4K】起风了 百万录音棚')).toBe('起风了');
    expect(songTitleFromBili('《晴天》官方MV 1080P')).toBe('晴天');
    expect(songTitleFromBili('起风了 - 买辣椒也用券 [MV]')).toBe('起风了 - 买辣椒也用券');
  });

  it('认 BV 号与整条链接', () => {
    expect(isBvid('BV1xx411c7mD')).toBe(true);
    expect(isBvid('bv1xx411c7mD')).toBe(false);
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD?p=1')).toBe('BV1xx411c7mD');
    expect(extractBvid('没有编号')).toBeNull();
  });

  it('原唱 / 官方标题排在教程、钢琴、翻唱前面', () => {
    const ranked = rankHits([
      hit('BV0000000001', '【钢琴】起风了'),
      hit('BV0000000002', '起风了（翻唱）'),
      hit('BV0000000003', '起风了 买辣椒也用券 官方MV'),
    ], '起风了');
    expect(ranked.map((item) => item.bvid)).toEqual(['BV0000000003', 'BV0000000002', 'BV0000000001']);
    expect(ranked[0]!.score!).toBeGreaterThan(ranked[1]!.score!);
  });

  it('明确原唱时直接确定', () => {
    const pick = pickCandidates([
      hit('BV0000000003', '起风了 买辣椒也用券 官方MV', { play: 5_000_000 }),
      hit('BV0000000002', '起风了（翻唱）'),
      hit('BV0000000001', '【钢琴】起风了'),
    ], '起风了');
    expect(pick.confident).toBe(true);
    expect(pick.reason).toBe('ok');
    expect(pick.candidates[0]!.bvid).toBe('BV0000000003');
  });

  it('没有结果 / 标题匹配不全都返回候选，不硬挑', () => {
    const empty = pickCandidates([], '起风了');
    expect(empty.confident).toBe(false);
    expect(empty.reason).toBe('no-result');
    expect(empty.candidates).toEqual([]);

    const weak = pickCandidates([hit('BV0000000001', '起风 现场版')], '起风了');
    expect(weak.confident).toBe(false);
    expect(weak.reason).toBe('weak-match');
    expect(weak.candidates).toHaveLength(1);
  });

  it('伴奏 / 纯音乐 / 非官方翻唱 / 片段时长都算低置信', () => {
    const version = pickCandidates([hit('BV0000000001', '起风了（翻唱）')], '起风了');
    expect(version.confident).toBe(false);
    expect(version.reason).toBe('version');

    const short = pickCandidates([hit('BV0000000001', '起风了 官方MV', { durationSec: 30 })], '起风了');
    expect(short.confident).toBe(false);
    expect(short.reason).toBe('version');
  });

  it('点名版本后缀时，没带后缀的候选不进首选', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '春日影 官方MV', { play: 8_000_000, durationSec: 240 }),
      hit('BV0000000002', '🐧春日影 | 司凤版🐧', { play: 1_000_000, durationSec: 494 }),
      hit('BV0000000003', '《又三郎》司凤版'),
    ], '春日影 司凤版');
    expect(pick.confident).toBe(true);
    expect(pick.reason).toBe('ok');
    expect(pick.candidates.map((item) => item.bvid)).toEqual(['BV0000000002']);
  });

  it('标题党「这才是原版」不压过真正的目标', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '这才是《雨爱司凤版》原版MV', { play: 3_900_000, durationSec: 124 }),
      hit('BV0000000002', '「雨爱 (司凤版)」', { play: 9_800_000, durationSec: 140 }),
    ], '雨爱 司凤版');
    expect(pick.confident).toBe(true);
    expect(pick.candidates[0]!.bvid).toBe('BV0000000002');
  });

  it('「不是司凤版」这类否定标题直接排除', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '不是司凤版！雨爱 DJ 降调循环'),
    ], '雨爱 司凤版');
    expect(pick.confident).toBe(false);
    expect(pick.reason).toBe('weak-match');
  });

  it('未收录的新后缀也按附加片段处理', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '晴天 原版', { play: 5_000_000 }),
      hit('BV0000000002', '晴天 某某自定义'),
    ], '晴天 某某自定义');
    expect(pick.confident).toBe(true);
    expect(pick.reason).toBe('ok');
    expect(pick.candidates.map((item) => item.bvid)).toEqual(['BV0000000002']);
  });

  it('倍率后缀（0.9x版）不依赖版本词表', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '晴天 原版', { play: 5_000_000 }),
      hit('BV0000000002', '晴天 0.9x版'),
    ], '晴天 0.9x版');
    expect(pick.confident).toBe(true);
    expect(pick.candidates[0]!.bvid).toBe('BV0000000002');
  });

  it('歌手名在 UP 主字段里也算命中附加片段', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '晴天', { author: '周杰伦', play: 5_000_000 }),
      hit('BV0000000002', '晴天 翻唱', { author: '某UP' }),
    ], '晴天 周杰伦');
    expect(pick.confident).toBe(true);
    expect(pick.reason).toBe('ok');
    expect(pick.candidates.map((item) => item.bvid)).toEqual(['BV0000000001']);
  });

  it('团体名附加片段同样生效', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '春日影', { author: 'MyGO!!!!!' }),
      hit('BV0000000002', '春日影 原版', { author: '某UP', play: 5_000_000 }),
    ], '春日影 MyGO');
    expect(pick.confident).toBe(true);
    expect(pick.candidates[0]!.bvid).toBe('BV0000000001');
  });

  it('对任意附加片段的否定都排除', () => {
    const pick = pickCandidates([
      hit('BV0000000001', '不是某某自定义！雨爱'),
    ], '雨爱 某某自定义');
    expect(pick.confident).toBe(false);
    expect(pick.reason).toBe('weak-match');
  });

  it('同一录音的不同搬运可以确定，不同演绎（现场 / MV）分数接近时列候选', () => {
    const same = pickCandidates([
      hit('BV0000000001', '起风了 高音质'),
      hit('BV0000000002', '起风了 无损'),
    ], '起风了');
    expect(same.confident).toBe(true);

    const pick = pickCandidates([
      hit('BV0000000001', '起风了 官方现场版'),
      hit('BV0000000002', '起风了 官方MV'),
    ], '起风了');
    expect(pick.confident).toBe(false);
    expect(pick.reason).toBe('ambiguous');
    expect(pick.candidates).toHaveLength(2);
  });
});

describe('B 站下载重试', () => {
  it('412 后重新取 playurl 再下一次；最终写到目标文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-bili-'));
    roots.push(dir);
    const dest = join(dir, 'song.m4a');
    let playCalls = 0;
    let downloads = 0;
    const audio = Buffer.alloc(64 * 1024, 0x11);
    const respond = (body: unknown, status = 200): Response => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => (body instanceof Uint8Array ? body : Buffer.concat([audio])),
    }) as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/view')) {
        return respond({ code: 0, data: { cid: 42, title: '起风了', owner: { name: 'UP' }, duration: 200 } });
      }
      if (url.includes('/playurl')) {
        playCalls += 1;
        return respond({ code: 0, data: { dash: { audio: [{ baseUrl: `https://audio/${playCalls}`, mimeType: 'audio/mp4' }] } } });
      }
      downloads += 1;
      if (downloads === 1) return respond({}, 412);
      return respond(audio);
    }));

    const got = await downloadAudio('BV0000000001', dest, 10 * 1024 * 1024);
    expect(got.bytes).toBe(audio.length);
    expect(got.title).toBe('起风了');
    expect(playCalls).toBe(2);
    expect(downloads).toBe(2);
    expect(readFileSync(dest).length).toBe(audio.length);
  });
});
