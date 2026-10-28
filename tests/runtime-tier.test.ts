import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRuntimeDir } from '../src/world.ts';

/** 造一个 `<root>/gpt-sovits/<version>/<tier>/runtime/python.exe`。 */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'rvc-tier-'));
}

function addTier(root: string, version: string, tier: 'cuda' | 'cpu'): string {
  const dir = join(root, 'gpt-sovits', version, tier);
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  writeFileSync(join(dir, 'runtime', 'python.exe'), '');
  return dir;
}

describe('推理档选择', () => {
  it('auto 优先 CUDA，没有 CUDA 回退 CPU', () => {
    const root = makeRoot();
    try {
      const cuda = addTier(root, 'v1', 'cuda');
      const cpu = addTier(root, 'v1', 'cpu');
      expect(findRuntimeDir(root, 'auto')).toEqual({ dir: cuda, tier: 'cuda' });
      rmSync(join(root, 'gpt-sovits', 'v1', 'cuda'), { recursive: true, force: true });
      expect(findRuntimeDir(root, 'auto')).toEqual({ dir: cpu, tier: 'cpu' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cpu 档只选 CPU；cuda 档没有 CUDA 时回退 CPU', () => {
    const root = makeRoot();
    try {
      const cpu = addTier(root, 'v1', 'cpu');
      expect(findRuntimeDir(root, 'cpu')).toEqual({ dir: cpu, tier: 'cpu' });
      expect(findRuntimeDir(root, 'cuda')).toEqual({ dir: cpu, tier: 'cpu' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('没有任何运行时返回空目录', () => {
    const root = makeRoot();
    try {
      expect(findRuntimeDir(root, 'auto')).toEqual({ dir: '', tier: 'cuda' });
      expect(findRuntimeDir(root, 'cpu')).toEqual({ dir: '', tier: 'cpu' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
