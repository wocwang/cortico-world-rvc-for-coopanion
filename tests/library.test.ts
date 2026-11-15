import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillDurations,
  defaultLibraryDir,
  deleteLibraryEntry,
  findLibraryEntry,
  readLibrary,
  saveToLibrary,
  songKey,
  writeLibrary,
} from '../src/library.ts';

const roots: string[] = [];
const sourceDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-library-'));
  roots.push(dir);
  return dir;
}

function source(bytes: number, name = 'song.wav'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-library-src-'));
  sourceDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of sourceDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('翻唱库', () => {
  it('默认落在扩展目录，不落到用户数据目录', () => {
    expect(defaultLibraryDir('D:\\Coopanion\\data\\home\\companion\\data\\rvc'))
      .toBe('D:\\Coopanion\\data\\extensions\\rvc-library');
  });

  it('按清唱/翻唱分目录，写入索引并可删除', () => {
    const root = tempRoot();
    const clean = saveToLibrary({ root, kind: 'clean', title: '起风了', sourcePath: source(1024) });
    const cover = saveToLibrary({ root, kind: 'cover', title: '起风了', sourcePath: source(2048) });
    expect(clean.entry.file).toBe('clean/起风了_清唱cover.wav');
    expect(cover.entry.file).toBe('cover/起风了_翻唱cover.wav');
    expect(clean.stats.count).toBe(1);
    expect(cover.stats.count).toBe(2);
    expect(cover.stats.totalBytes).toBe(3072);

    const index = readLibrary(root);
    expect(index.entries.map((item) => item.kind)).toEqual(['clean', 'cover']);
    expect(readFileSync(join(root, clean.entry.file)).length).toBe(1024);

    const after = deleteLibraryEntry(root, clean.entry.id);
    expect(after.count).toBe(1);
    expect(readLibrary(root).entries[0]?.kind).toBe('cover');
  });

  it('同内容去重，不同内容追加序号不覆盖', () => {
    const root = tempRoot();
    const src = source(100);
    const first = saveToLibrary({ root, kind: 'cover', title: '后来', sourcePath: src });
    expect(first.duplicate).toBe(false);
    const again = saveToLibrary({ root, kind: 'cover', title: '后来', sourcePath: src });
    expect(again.duplicate).toBe(true);
    expect(again.stats.count).toBe(1);

    const second = saveToLibrary({ root, kind: 'cover', title: '后来', sourcePath: source(200) });
    expect(second.duplicate).toBe(false);
    expect(second.entry.file).toBe('cover/后来_翻唱cover (2).wav');
    expect(readLibrary(root).entries).toHaveLength(2);
  });

  it('超过上限时拒绝保存，不偷偷删旧条目', () => {
    const root = tempRoot();
    saveToLibrary({ root, kind: 'clean', title: 'A', sourcePath: source(100) });
    expect(() => saveToLibrary({
      root, kind: 'cover', title: 'B', sourcePath: source(50), maxBytes: 120,
    })).toThrow('上限');
    expect(readLibrary(root).entries).toHaveLength(1);
  });

  it('索引损坏时按文件名重建', () => {
    const root = tempRoot();
    saveToLibrary({ root, kind: 'clean', title: '晴天', sourcePath: source(64) });
    writeFileSync(join(root, 'index.json'), '{bad json', 'utf8');
    const rebuilt = readLibrary(root);
    expect(rebuilt.entries).toHaveLength(1);
    expect(rebuilt.entries[0]).toMatchObject({ kind: 'clean', title: '晴天', format: 'wav' });
  });

  it('按歌名找：精确优先，同歌优先清唱', () => {
    const root = tempRoot();
    saveToLibrary({ root, kind: 'cover', title: '起风了', sourcePath: source(10, 'a.wav') });
    saveToLibrary({ root, kind: 'clean', title: '起风了', sourcePath: source(11, 'b.wav') });
    expect(findLibraryEntry(root, '《起风了》')?.kind).toBe('clean');
    expect(findLibraryEntry(root, '起风', 'cover')?.kind).toBe('cover');
    expect(findLibraryEntry(root, '不存在')).toBeNull();
  });

  it('歌名规范化去掉标点与大小写差异', () => {
    expect(songKey('《起风了》')).toBe('起风了');
    expect(songKey('Hello, World!')).toBe('helloworld');
    expect(songKey(' 少年 (Live) ')).toBe('少年live');
  });

  it('保存时记时长；老 WAV 条目从文件头补一次并写回', () => {
    const root = tempRoot();
    const saved = saveToLibrary({ root, kind: 'clean', title: '稻香', sourcePath: source(32), durationSec: 12.5 });
    expect(saved.entry.durationSec).toBe(12.5);

    // 0.1 秒、8 kHz、单声道 PCM16：16-bit 头 + 1600 字节数据。
    const frames = 800;
    const data = Buffer.alloc(frames * 2);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8, 'ascii');
    head.write('fmt ', 12, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(8000, 24);
    head.writeUInt32LE(16000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    const wav = Buffer.concat([head, data]);

    const index = readLibrary(root);
    const old = { ...saved.entry, id: 'old', file: 'clean/旧歌_清唱cover.wav', durationSec: 0 };
    index.entries.push(old);
    writeFileSync(join(root, old.file), wav);
    writeLibrary(root, index);
    expect(readLibrary(root).entries.find((entry) => entry.id === 'old')?.durationSec).toBe(0);

    const index2 = readLibrary(root);
    const changed = backfillDurations(root, index2);
    expect(changed).toBe(true);
    writeLibrary(root, index2);
    expect(readLibrary(root).entries.find((entry) => entry.id === 'old')?.durationSec).toBeCloseTo(0.1, 3);
  });
});
