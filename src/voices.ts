/**
 * 音色目录：列出已有音色、导入用户自备的 `.pth` / `.index`。
 *
 * 校验只做便宜但有效的两道：文件头（torch 存的是 zip，faiss 的索引以 `Iw`/`Ix` 开头）
 * 与大小下限，挡住改错扩展名、下了一半的文件；真正的权重结构由推理时 `torch.load` 判定。
 */
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

export interface VoiceInfo {
  /** `.pth` 文件名去掉扩展名。 */
  name: string;
  /** `.pth` 字节数。 */
  bytes: number;
  /** 同名 `.index` 的字节数；没有为 null。 */
  index: number | null;
}

/** `.pth` 下限 1 MB；`.index` 下限 64 KB —— 都比正常文件小一个数量级以上。 */
const PTH_MIN_BYTES = 1 << 20;
const INDEX_MIN_BYTES = 64 << 10;

/** torch.save 出来的是 zip（`PK\x03\x04`）；很老的权重是 pickle（`\x80`）。 */
function looksLikePth(data: Buffer): boolean {
  return data.length >= 4 && ((data[0] === 0x50 && data[1] === 0x4b) || data[0] === 0x80);
}

/** faiss 索引文件头是 ASCII 四字符，`IwFl` / `IxFl` / `IxF2` 之类。 */
function looksLikeFaissIndex(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x49 && (data[1] === 0x77 || data[1] === 0x78);
}

/** 列表：按 `.pth` 收集，同名 `.index` 顺带报字节数。 */
export function listVoices(dir: string): VoiceInfo[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: VoiceInfo[] = [];
  for (const file of names.filter((n) => n.toLowerCase().endsWith('.pth')).sort()) {
    const bytes = sizeOf(join(dir, file));
    if (!bytes) continue;
    const indexBytes = sizeOf(join(dir, `${file.slice(0, -4)}.index`));
    out.push({ name: file.slice(0, -4), bytes, index: indexBytes || null });
  }
  return out;
}

/** 导入一个文件：`fileName` 来自上传，只取文件名部分；返回落盘后的名字。 */
export function importVoiceFile(dir: string, fileName: string, data: Buffer): { name: string; kind: 'pth' | 'index'; bytes: number } {
  const name = safeName(fileName);
  const lower = name.toLowerCase();
  const kind = lower.endsWith('.index') ? 'index' : lower.endsWith('.pth') ? 'pth' : null;
  if (!kind) throw new Error('只接受 .pth 或 .index 文件');
  if (kind === 'pth') validatePth(data);
  else validateIndex(data);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  return { name, kind, bytes: data.length };
}

/**
 * 添加一个音色：`.pth` 必填，`.index` 可选。
 * 按用户填的音色名统一命名，保证 `<name>.pth` 与 `<name>.index` 一定成对；
 * 同名音色已存在时由调用方先确认，这里不静默覆盖。
 */
export function importVoicePair(
  dir: string,
  name: string,
  pth: Buffer,
  index?: Buffer | null,
): { name: string; bytes: number; index: number | null } {
  const base = voiceBaseName(name);
  validatePth(pth);
  if (index?.length) validateIndex(index);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${base}.pth`), pth);
  const indexPath = join(dir, `${base}.index`);
  if (index?.length) writeFileSync(indexPath, index);
  else rmSync(indexPath, { force: true });
  return { name: base, bytes: pth.length, index: index?.length ?? null };
}

/** 删除一个音色：`.pth` 与同名 `.index` 一起删；找不到 `.pth` 时报错。 */
export function deleteVoice(dir: string, name: string): { name: string; removed: string[] } {
  const base = voiceBaseName(name);
  const removed: string[] = [];
  for (const ext of ['.pth', '.index']) {
    const path = join(dir, `${base}${ext}`);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(`${base}${ext}`);
  }
  if (!removed.some((file) => file.endsWith('.pth'))) throw new Error(`找不到音色：${base}`);
  return { name: base, removed };
}

/** 音色名规范化：去路径、去 `.pth`/`.index` 扩展名、限长。 */
export function voiceBaseName(name: string): string {
  const base = safeName(name).replace(/\.(pth|index)$/i, '').trim();
  if (!base) throw new Error('音色名称不能为空');
  if (base.length > 64) throw new Error('音色名称最长 64 个字符');
  return base;
}

function validatePth(data: Buffer): void {
  if (data.length < PTH_MIN_BYTES) throw new Error(`.pth 只有 ${data.length} 字节，不像是训练好的权重`);
  if (!looksLikePth(data)) throw new Error('.pth 文件头不是 torch 存档（应为 zip 或 pickle）');
}

function validateIndex(data: Buffer): void {
  if (data.length < INDEX_MIN_BYTES) throw new Error(`.index 只有 ${data.length} 字节，不像是 faiss 索引`);
  if (!looksLikeFaissIndex(data)) throw new Error('.index 文件头不是 faiss 索引');
}

/** 去掉路径、禁止隐藏文件与超长名字；保留中文。 */
function safeName(fileName: string): string {
  const name = basename(fileName.replace(/\\/g, '/')).trim();
  if (!name || name.startsWith('.') || name.length > 96) throw new Error(`文件名不合法：${fileName}`);
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error(`文件名里有不允许的字符：${name}`);
  return name;
}

const sizeOf = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};
