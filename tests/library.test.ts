import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultLibraryDir,
  deleteLibraryEntry,
  findLibraryEntry,
  readLibrary,
  saveToLibrary,
  songKey,
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
});
