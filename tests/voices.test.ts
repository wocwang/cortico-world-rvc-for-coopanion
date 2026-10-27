import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importVoiceFile, listVoices } from '../src/voices.ts';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-voices-'));
  roots.push(dir);
  return dir;
};

/** 造一个「看起来像」的 torch 存档：zip 头 + 凑够 1 MB。 */
function pth(size = (1 << 20) + 32): Buffer {
  const data = Buffer.alloc(size, 0x11);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(data, 0);
  return data;
}

/** 造一个「看起来像」的 faiss 索引：`IwFl` + 凑够 64 KB。 */
function index(size = 64 << 10): Buffer {
  const data = Buffer.alloc(size, 0x22);
  Buffer.from([0x49, 0x77, 0x46, 0x6c]).copy(data, 0);
  return data;
}

describe('音色导入与列表', () => {
  it('导入 .pth 后能在列表里看到，且没有 index', () => {
    const dir = tempDir();
    const got = importVoiceFile(dir, 'my-voice.pth', pth());
    expect(got).toEqual({ name: 'my-voice.pth', kind: 'pth', bytes: (1 << 20) + 32 });
    expect(listVoices(dir)).toEqual([{ name: 'my-voice', bytes: (1 << 20) + 32, index: null }]);
  });

  it('同名 .index 与 .pth 配对，列表报索引字节数', () => {
    const dir = tempDir();
    importVoiceFile(dir, 'my-voice.pth', pth());
    importVoiceFile(dir, 'my-voice.index', index());
    expect(listVoices(dir)).toEqual([{ name: 'my-voice', bytes: (1 << 20) + 32, index: 64 << 10 }]);
  });

  it('上传路径只取文件名，不会写到目录外', () => {
    const dir = tempDir();
    const got = importVoiceFile(dir, '..\\..\\evil.pth', pth());
    expect(got.name).toBe('evil.pth');
    expect(readdirSync(dir)).toEqual(['evil.pth']);
  });

  it('拒绝不认识的扩展名', () => {
    const dir = tempDir();
    expect(() => importVoiceFile(dir, 'voice.zip', pth())).toThrow('只接受 .pth 或 .index');
    expect(readdirSync(dir).length).toBe(0);
  });

  it('拒绝改错扩展名的大文件', () => {
    const dir = tempDir();
    expect(() => importVoiceFile(dir, 'fake.pth', Buffer.alloc(2 << 20, 0x00))).toThrow('不是 torch 存档');
    expect(() => importVoiceFile(dir, 'fake.index', Buffer.alloc(128 << 10, 0x00))).toThrow('不是 faiss 索引');
  });

  it('拒绝下了一半的小文件', () => {
    const dir = tempDir();
    expect(() => importVoiceFile(dir, 'half.pth', pth(4096))).toThrow('不像是训练好的权重');
    expect(() => importVoiceFile(dir, 'half.index', index(1024))).toThrow('不像是 faiss 索引');
  });

  it('拒绝隐藏文件与非法字符', () => {
    const dir = tempDir();
    expect(() => importVoiceFile(dir, '.hidden.pth', pth())).toThrow('文件名不合法');
    expect(() => importVoiceFile(dir, 'a<b>.pth', pth())).toThrow('不允许的字符');
    expect(() => importVoiceFile(dir, '   ', pth())).toThrow('文件名不合法');
    expect(readdirSync(dir).length).toBe(0);
  });

  it('目录不存在或为空时列表为空', () => {
    expect(listVoices(join(tempDir(), 'nope'))).toEqual([]);
    expect(listVoices(tempDir())).toEqual([]);
  });

  it('列表忽略 0 字节的 .pth，并按名字排序', () => {
    const dir = tempDir();
    importVoiceFile(dir, 'b.pth', pth());
    importVoiceFile(dir, 'a.pth', pth());
    writeFileSync(join(dir, 'broken.pth'), '');
    expect(statSync(join(dir, 'broken.pth')).size).toBe(0);
    expect(listVoices(dir).map((v) => v.name)).toEqual(['a', 'b']);
  });
});
