import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RvcVenv } from '../src/venv.ts';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-venv-'));
  roots.push(dir);
  return dir;
};

describe('派生 venv', () => {
  it('初始是未安装', () => {
    const dir = tempDir();
    const venv = new RvcVenv({ pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'), basePython: join(dir, 'runtime', 'python.exe') });
    expect(venv.state()).toEqual({ phase: 'absent', detail: null });
  });

  it('没有 base 运行时就把原因说清楚，不去跑 pip', async () => {
    const dir = tempDir();
    const venv = new RvcVenv({ pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'), basePython: join(dir, 'runtime', 'python.exe') });
    await venv.ensure();
    const state = venv.state();
    expect(state.phase).toBe('error');
    expect(state.detail).toContain('gpt-sovits 运行时');
  });

  it('取消未开始的任务不会改状态', () => {
    const dir = tempDir();
    const venv = new RvcVenv({ pythonPath: join(dir, 'venv'), basePython: '' });
    venv.cancel();
    expect(venv.state().phase).toBe('absent');
  });

  it('重复 ensure 共用同一个任务', async () => {
    const dir = tempDir();
    const venv = new RvcVenv({ pythonPath: join(dir, 'venv', 'Scripts', 'python.exe'), basePython: '' });
    await Promise.all([venv.ensure(), venv.ensure()]);
    expect(venv.state().phase).toBe('error');
  });
});
