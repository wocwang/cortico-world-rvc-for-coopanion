import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAudio, extractBvid, isBvid, pickCandidates, rankHits, type SearchHit,
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
