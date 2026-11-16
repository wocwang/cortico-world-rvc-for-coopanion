import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveToLibrary, type LibraryKind } from '../src/library.ts';
import { pickSong } from '../src/sing.ts';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function library(songs: Array<{ title: string; kind: LibraryKind; ext?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'rvc-sing-'));
  roots.push(root);
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  songs.forEach((song, at) => {
    const path = join(src, `${at}${song.ext ?? '.wav'}`);
    writeFileSync(path, Buffer.alloc(256 + at));
    saveToLibrary({ root: join(root, 'library'), kind: song.kind, title: song.title, sourcePath: path });
  });
  return join(root, 'library');
}

const codes = (result: ReturnType<typeof pickSong>): string =>
  'issue' in result ? result.issue.code : 'ambiguous' in result ? 'ambiguous' : result.entry.kind;

describe('rvc_sing 选歌', () => {
  it('按歌名找清唱版：书名号、扩展名都能去掉', () => {
    const root = library([
      { title: '起风了', kind: 'cover' },
      { title: '起风了', kind: 'clean' },
      { title: '晴天', kind: 'clean' },
    ]);
    for (const song of ['起风了', '《起风了》', '起风了.mp3']) {
      const picked = pickSong(root, { song });
      expect('entry' in picked && picked.entry.kind).toBe('clean');
      expect('entry' in picked && picked.entry.title).toBe('起风了');
    }
  });

  it('明确要翻唱才取翻唱版；默认清唱', () => {
    const root = library([
      { title: '起风了', kind: 'cover' },
      { title: '起风了', kind: 'clean' },
    ]);
    const clean = pickSong(root, { song: '起风了' });
    expect('entry' in clean && clean.entry.kind).toBe('clean');
    const cover = pickSong(root, { song: '起风了', kind: 'cover' });
    expect('entry' in cover && cover.entry.kind).toBe('cover');
  });

  it('不给歌名时随机挑同类型的歌', () => {
    const root = library([
      { title: '起风了', kind: 'clean' },
      { title: '晴天', kind: 'cover' },
      { title: '稻香', kind: 'clean' },
    ]);
    const first = pickSong(root, {}, () => 0);
    expect('entry' in first && first.entry.title).toBe('起风了');
    const last = pickSong(root, {}, () => 0.999);
    expect('entry' in last && last.entry.title).toBe('稻香');
    const cover = pickSong(root, { kind: 'cover' }, () => 0);
    expect('entry' in cover && cover.entry.title).toBe('晴天');
  });

  it('库为空只给说明，不抛错', () => {
    const root = library([]);
    const picked = pickSong(root, {});
    expect(codes(picked)).toBe('empty');
    expect('issue' in picked && picked.issue.message).toContain('empty');
  });

  it('只有翻唱版时，默认清唱不会偷偷放翻唱', () => {
    const root = library([{ title: '起风了', kind: 'cover' }]);
    const random = pickSong(root, {});
    expect(codes(random)).toBe('kind-missing');
    const named = pickSong(root, { song: '起风了' });
    expect(codes(named)).toBe('kind-missing');
    expect('issue' in named && named.issue.message).toContain('only as cover');
  });

  it('精确命中优先，不会被更长的相近版本抢走', () => {
    const root = library([
      { title: '雨爱', kind: 'clean' },
      { title: '雨爱 司凤版', kind: 'clean' },
    ]);
    const picked = pickSong(root, { song: '雨爱' });
    expect('entry' in picked && picked.entry.title).toBe('雨爱');
  });

  it('只是包含关系 / 版本后缀不同时先问，不直接播', () => {
    const root = library([{ title: '雨爱 司凤版', kind: 'clean' }]);
    const picked = pickSong(root, { song: '雨爱' });
    expect(codes(picked)).toBe('ambiguous');
    expect('ambiguous' in picked && picked.ambiguous.entries.map((entry) => entry.title)).toEqual(['雨爱 司凤版']);
    expect('ambiguous' in picked && picked.ambiguous.message).toContain('source "bilibili"');
  });

  it('歌名对不上时回可选歌名', () => {
    const root = library([
      { title: '起风了', kind: 'clean' },
      { title: '晴天', kind: 'clean' },
    ]);
    const picked = pickSong(root, { song: '七里香' });
    expect(codes(picked)).toBe('not-found');
    expect('issue' in picked && picked.issue.message).toContain('起风了');
    expect('issue' in picked && picked.issue.message).toContain('晴天');
  });
});
