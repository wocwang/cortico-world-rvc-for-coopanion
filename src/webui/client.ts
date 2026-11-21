/**
 * 浏览器端面板：`service`（状态 / 一键安装 / 日志尾部）、`convert`（上传 → 试听 → 落盘）、
 * `voices`（列表 / 导入 / 设为默认）。三个面板的数据都走 `ctx.invoke`，定时拉一次状态。
 *
 * 上传的音频只在浏览器与本地 World 之间走：base64 进 `convert`，回的是 `$binary`，
 * 不经 gpt-sovits、也不联网。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext, WebUi, Disposable } from 'cortico/web/shared/client-panel.ts';
import { panelText } from './text.ts';
import { abRange, abSeek, carryPosition } from './ab.ts';
import { actionNeedsSource, coverAction, coverDirty, type CoverAction, type CoverParams } from './dirty.ts';
import { segmentWindow } from './preview.ts';
import type { PitchAnalysis } from '../pitch.ts';
import './style.css';

/** 本地版本的 `toDisposable`：浏览器 bundle 只允许 import type 框架，运行时要自带。 */
function disposable(cleanup: () => void): Disposable {
  let done = false;
  return { dispose() { if (!done) { done = true; cleanup(); } } };
}

interface JobState {
  phase: 'absent' | 'working' | 'ready' | 'error';
  done?: number;
  total?: number;
  detail?: string | null;
}
interface ConvertDone {
  at: number;
  ms: number;
  bytes: number;
  savedPath: string | null;
  voice: string;
  format: string;
}
interface CoverDone extends ConvertDone {
  stages?: { separate?: number; convert?: number; mix?: number };
  peakScale?: number;
  sessionId?: string;
  /** 这次实际用的分离档：`mel_band` 为高质量，`mdx` 为默认。 */
  separator?: 'mel_band' | 'mdx';
  /** 高质量档没跑成（下载/显存/加载失败）时回退默认档的原因。 */
  separatorNote?: string;
  /** 勾了「完成后保存到翻唱库」并成功时的结果。 */
  library?: { id: string; title: string; kind: 'clean' | 'cover'; file: string; duplicate: boolean };
  /** 勾了入库但失败的原因。 */
  libraryError?: string;
}
interface BiliCandidate {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  play: number;
  score?: number;
  /** 标题与歌名的匹配级别；partial 表示标题只是包含这个词。 */
  matchLevel?: 'exact' | 'suffix' | 'partial' | 'none';
  /** 标题里认出来的歌手，用来区分同名曲。 */
  artist?: string;
}
interface BiliPickResp {
  confident: boolean;
  reason: string;
  candidates: BiliCandidate[];
}
interface MixDone {
  at: number;
  ms: number;
  bytes: number;
  savedPath: string | null;
  format: string;
  peakScale?: number;
}
interface RangeDone {
  at: number;
  ms: number;
  bytes: number;
  savedPath: string | null;
  format: string;
  start: number;
  end: number;
  pitch: number;
}
interface MasterDone extends MixDone {
  targetLufs: number;
  ceilingDb: number;
  inputLufs: number;
  inputTruePeakDb: number;
  outputLufs: number;
  outputTruePeakDb: number;
  gainDb: number;
  limitedDb: number;
}
interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
  durationSec: number;
  voice: string;
  outputs: number;
  source: { file: string; bytes: number; name?: string } | null;
  outputFiles: Array<{ format: string; path: string; bytes: number; at: string; kind?: 'cover' | 'clean' }>;
}
interface SessionMix {
  vocalGainDb: number;
  instGainDb: number;
  rmsRatio: number;
  rmsFrozen: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  peakScale: number;
  withBgm?: boolean;
}
interface RefineSession {
  id: string;
  engine: { kind: string; voice: string; modelSampleRate: number };
  source: { durationSec: number; inputPeak: number; format: string; name?: string; file?: string; bytes?: number };
  converted: {
    path: string;
    sampleRate: number;
    channels: number;
    defaults: { pitch: number; indexRate: number; protect: number; chunk: boolean };
  };
  segments: Array<{
    id: string;
    start: number;
    end: number;
    revision: number;
    kind: string;
    params: { pitch: number; indexRate: number; protect: number };
    muted?: boolean;
    backup?: string;
  }>;
  mix: SessionMix;
  outputs: Array<{ format: string; path: string; at: string; kind?: 'cover' | 'clean' }>;
  masters?: Array<{
    format: string; path: string; at: string; targetLufs: number;
    inputLufs: number; inputTruePeakDb: number; outputLufs: number; outputTruePeakDb: number;
  }>;
}
interface PeaksResp {
  id?: string;
  sampleRate: number;
  frames: number;
  durationSec: number;
  buckets: number;
  min: number[];
  max: number[];
}
/** 会话里登记的成品：混音（outputs）或母带（masters）。`index` 是对应数组的下标。 */
interface SessionOutputFile {
  kind: 'output' | 'master';
  index: number;
  format: string;
  path: string;
  at: string;
  bytes: number;
  targetLufs?: number;
  mediaKind?: 'cover' | 'clean';
}
/** 翻唱库列表：条目来自 World 的 `libraryState`，试听走 `libraryFile` 的 `$file`。 */
interface LibraryEntryView {
  id: string;
  kind: 'clean' | 'cover';
  title: string;
  file: string;
  bytes: number;
  durationSec: number;
  format: string;
  createdAt: string;
  sessionId?: string;
  voice?: string;
  mastered?: boolean;
}
interface LibraryState {
  root: string;
  totalBytes: number;
  maxBytes: number;
  count: number;
  entries: LibraryEntryView[];
}
/** 入库目标：会话成品（outputs）或母带（masters），index 为其在对应数组里的下标。 */
interface LibraryTarget {
  media: 'output' | 'master';
  index: number;
  format: string;
  /** 跟随所选版本的类型；旧成品按文件名兜底。 */
  kind: 'cover' | 'clean';
}
interface RefineState {
  root: string;
  keep: boolean;
  days: number;
  maxGb: number;
  active: string | null;
  sessions: SessionSummary[];
  session: RefineSession | null;
  /** 当前会话的成品清单（混音 + 母带，时间升序）；旧版 World 没有这个字段。 */
  files?: SessionOutputFile[];
  cleaned?: number;
  freed?: number;
}
interface PanelState {
  phase: 'stopped' | 'starting' | 'ready' | 'error';
  ready: boolean;
  device: string | null;
  model: string | null;
  startMs: number | null;
  queue: number;
  port: number | null;
  detail: string;
  tail: string[];
  uvr5: boolean;
  /** 高质量分离权重（Mel-Band RoFormer）的下载状态；默认档不需要。 */
  melband: JobState;
  /** 配置里是否选了高质量分离档。 */
  highSeparator: boolean;
  venv: JobState;
  uvr: JobState;
  install: JobState;
  voiceCount: number;
  defaultVoice: string;
  /** 当前播放音量 0–100；老版本 World 可能没有这个字段。 */
  volume?: number;
  /** 配置里的初始值；老版本 World 可能没有这个字段。 */
  defaults?: {
    singKind: 'clean' | 'cover';
    panelKind: 'clean' | 'cover';
    saveToLibrary: boolean;
    keepSource: boolean;
    /** 上次成功用过的推理参数；老版本 World 可能没有这三项。 */
    pitch?: number;
    indexRate?: number;
    protect?: number;
  };
  lastConvert: ConvertDone | null;
  lastCover: CoverDone | null;
  lastMix: MixDone | null;
  lastRange: RangeDone | null;
  lastMaster: MasterDone | null;
  job: { kind: 'convert' | 'cover' | 'remix' | 'range' | 'master'; at: number; phase: 'working' | 'done' | 'error'; detail: string; error?: string; ms?: number } | null;
  resultReady: boolean;
}
interface JobResult {
  mime?: string;
  base64?: string;
  savedPath?: string | null;
  ms?: number;
  error?: string;
}
interface StorageItem {
  id: string;
  bytes: number;
  shared: boolean;
}

/** base64 → Blob：后台任务的结果从 `takeResult` 拿回来，不再用 `invokeBinary`。 */
function blobFromBase64(base64: string, mime: string): Blob {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
interface VoiceRow {
  name: string;
  bytes: number;
  index: number | null;
  /** 权重自带的音高分箱行数；sidecar 未生成时为 null。 */
  bin?: number | null;
  /** 分箱音高上限 Hz；未知为 null。 */
  f0Max?: number | null;
}

/** 权重类型标签：360 bin 权重比上游默认的 256 bin 覆盖更高音域。 */
const binTag = (v: VoiceRow): string => (v.bin ? ` · ${v.bin} bin` : '');
interface VoicesResp {
  voices: VoiceRow[];
}
interface ImportResp {
  error?: string;
  name?: string;
  voices?: VoiceRow[];
  removed?: string[];
}

type Tone = 'on' | 'off' | 'warn' | 'bad';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 大块二进制转 base64：分块拼，别把整个文件塞进一次调用。 */
function toBase64(buf: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 面板里选过的音色；刷新/切页后仍然保留。空串表示「默认」。 */
const PANEL_VOICE_KEY = 'rvc.panel.voice';
function savedPanelVoice(): string | null {
  try { return localStorage.getItem(PANEL_VOICE_KEY); } catch { return null; }
}
function savePanelVoice(value: string): void {
  try { localStorage.setItem(PANEL_VOICE_KEY, value); } catch { /* 隐私模式等忽略 */ }
}

const toneOf = (phase: string): Tone =>
  phase === 'ready' ? 'on' : phase === 'working' || phase === 'starting' ? 'warn' : phase === 'error' ? 'bad' : 'off';

/** Fisher–Yates：翻唱库的「随机」只洗一次，轮询刷新不重排。 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 相位 → 通用文案键；未知值按「未安装」显示。 */
type PhaseKey = 'ready' | 'starting' | 'stopped' | 'error' | 'absent' | 'working';
const phaseKey = (phase: string): PhaseKey =>
  phase === 'ready' || phase === 'starting' || phase === 'stopped' || phase === 'error' || phase === 'working' ? phase : 'absent';

/** 状态行：名字 + 标签 + 说明 + 操作。 */
function row(host: HTMLElement, ui: WebUi, name: string): { pill: HTMLSpanElement; detail: HTMLElement; acts: HTMLElement } {
  const line = ui.h('div', 'rvc-row');
  const label = ui.h('span', 'rvc-name', name);
  const pill = ui.pill('', 'plain');
  const detail = ui.h('span', 'rvc-detail');
  const acts = ui.h('span', 'rvc-acts');
  line.append(label, pill, detail, acts);
  host.append(line);
  return { pill, detail, acts };
}

function setPill(el: HTMLSpanElement, text: string, tone: Tone): void {
  el.textContent = text;
  el.dataset.tone = tone;
}

/** 按 value 重建下拉；值没变时不动，避免每次轮询把用户的选择重置。 */
function fillSelect(ui: WebUi, select: HTMLSelectElement, items: Array<{ value: string; label: string }>): void {
  const same = select.options.length === items.length && items.every((o, i) => {
    const option = select.options[i];
    return option?.value === o.value && option?.textContent === o.label;
  });
  if (same) return;
  const keep = select.value;
  select.textContent = '';
  for (const item of items) {
    const opt = ui.h('option', null, item.label);
    opt.value = item.value;
    select.append(opt);
  }
  if (items.some((o) => o.value === keep)) select.value = keep;
}

/**
 * 自定义滑杆轨道：把已填充比例写成 CSS 变量。
 * 原生 accent-color 在 100% 时滑块右侧还会留一截灰色轨道，看起来「没顶满」；
 * 自己画轨道就能让填充一直铺到右端。
 */
function syncSliderFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Math.max(min, Math.min(max, Number(input.value) || 0));
  input.style.setProperty('--rvc-fill', `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`);
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const servicePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    let expanded = false;

    const call = async (method: string): Promise<void> => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        render(await ctx.invoke<PanelState>(method));
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    };

    const sheet = ui.section(t.serviceTitle, t.serviceHint);
    const engineRow = row(sheet, ui, t.rowEngine);
    const depsRow = row(sheet, ui, t.rowDeps);
    const weightsRow = row(sheet, ui, t.rowWeights);
    const uvrRow = row(sheet, ui, t.rowUvr);
    const melbandRow = row(sheet, ui, t.rowMelband);
    const voiceRow = row(sheet, ui, t.rowVoice);
    const apiRow = row(sheet, ui, t.rowApi);

    // 播放音量：滑杆直接调 World，正在播的歌会在原位置按新音量重开。
    const volumeWrap = ui.h('div', 'rvc-slider');
    const volumeInput = ui.input({ value: '100' });
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '100';
    volumeInput.step = '1';
    const volumeReadout = ui.h('span', 'rvc-slider-value', '100');
    volumeWrap.append(volumeInput, volumeReadout);
    syncSliderFill(volumeInput);
    const volumeField = ui.field(t.rowVolume, volumeWrap);
    sheet.append(volumeField);
    let volumeTimer: number | undefined;
    volumeInput.addEventListener('input', () => {
      volumeReadout.textContent = volumeInput.value;
      syncSliderFill(volumeInput);
      if (volumeTimer) window.clearTimeout(volumeTimer);
      volumeTimer = window.setTimeout(() => {
        volumeTimer = undefined;
        void (async () => {
          try {
            render(await ctx.invoke<PanelState>('setVolume', [Number(volumeInput.value)]));
          } catch (err) {
            msg.textContent = errText(err);
            msg.classList.add('bad');
          }
        })();
      }, 150);
    });

    // 高质量分离档：和默认模型一样有下载 / 取消 / 卸载与进度。
    let melArmed = false;
    const melbandDownload = ui.button(t.sepDownload, { size: 'sm', onClick: () => void call('downloadSeparator') });
    const melbandCancel = ui.button(t.cancel, { size: 'sm', onClick: () => void call('cancelSeparator') });
    const melbandRemove = ui.button(t.melbandUninstall, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          if (!melArmed) {
            melArmed = true;
            msg.textContent = t.storeConfirmHint;
            msg.classList.remove('bad');
            melbandRemove.textContent = t.storeConfirm;
            return;
          }
          melArmed = false;
          melbandRemove.textContent = t.melbandUninstall;
          try {
            render(await ctx.invoke<PanelState>('removeSeparator'));
            msg.textContent = t.storeRemoved;
          } catch (err) {
            msg.textContent = errText(err);
            msg.classList.add('bad');
          }
        })();
      },
    });
    melbandRow.acts.append(melbandDownload, melbandCancel, melbandRemove);
    const sepBar = ui.progress({ tone: 'warn' });
    sepBar.el.hidden = true;

    const uvr5Warn = ui.msgline(t.uvr5Off, true);
    const bar = ui.progress({ tone: 'warn' });
    bar.el.hidden = true;
    sheet.append(sepBar.el, bar.el, uvr5Warn, ui.h('div', 'rvc-detail', t.sepHint), ui.h('div', 'rvc-detail', t.voiceNotice));

    const installBtn = ui.button(t.install, { variant: 'primary', size: 'sm', onClick: () => void call('install') });
    const cancelBtn = ui.button(t.cancel, { size: 'sm', onClick: () => void call('cancel') });
    const restartBtn = ui.button(t.restart, { size: 'sm', onClick: () => void call('restart') });
    const startBtn = ui.button(t.startEngine, { variant: 'primary', size: 'sm', onClick: () => void call('start') });
    const stopBtn = ui.button(t.stopEngine, { size: 'sm', onClick: () => void call('stop') });
    const acts = ui.actions();
    acts.append(installBtn, cancelBtn, restartBtn, startBtn, stopBtn);

    const log = ui.h('pre', 'rvc-log');
    log.hidden = true;
    const logToggle = ui.button(t.showLog, {
      size: 'sm',
      onClick: () => {
        expanded = !expanded;
        logToggle.textContent = expanded ? t.hideLog : t.showLog;
        log.hidden = !expanded;
        if (expanded && state) log.textContent = state.tail.join('\n');
      },
    });

    // 占用与清理：列 RVC 自己的文件与可释放空间；共享运行时只显示、不提供卸载。
    const store = ui.section(t.storageTitle, t.storageHint);
    const storeList = ui.h('div');
    const storeTotal = ui.h('div', 'rvc-detail');
    store.append(storeList, storeTotal);

    let armed: string | null = null;
    const storeNames: Record<string, string> = {
      runtime: t.storeRuntime,
      venv: t.storeVenv,
      assets: t.storeAssets,
      voices: t.storeVoices,
      uvr5: t.storeUvr,
      sessions: t.storeSessions,
    };

    function renderStorage(items: StorageItem[]): void {
      storeList.textContent = '';
      let free = 0;
      for (const item of items) {
        const line = row(storeList, ui, storeNames[item.id] ?? item.id);
        setPill(line.pill, ui.fmt.bytes(item.bytes), item.shared ? 'warn' : 'off');
        if (item.shared) {
          line.detail.textContent = t.storeShared;
          continue;
        }
        free += item.bytes;
        const btn = ui.button(armed === item.id ? t.storeConfirm : t.storeUninstall, {
          size: 'sm',
          onClick: () => void remove(item.id),
        });
        line.acts.append(btn);
      }
      storeTotal.textContent = `${t.storeFree} ${ui.fmt.bytes(free)}`;
    }

    async function loadStorage(): Promise<void> {
      try {
        const res = await ctx.invoke<{ items: StorageItem[] }>('storage');
        renderStorage(res.items ?? []);
      } catch (err) {
        storeTotal.textContent = errText(err);
      }
    }

    /** 两段式卸载：第一次点只进入「确认」，再点一次才真的删。 */
    async function remove(id: string): Promise<void> {
      if (armed !== id) {
        armed = id;
        msg.textContent = t.storeConfirmHint;
        msg.classList.remove('bad');
        await loadStorage();
        return;
      }
      armed = null;
      msg.textContent = '';
      try {
        const res = await ctx.invoke<PanelState & { storage?: StorageItem[] }>('uninstall', [id]);
        render(res);
        if (res.storage) renderStorage(res.storage);
        msg.textContent = t.storeRemoved;
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
      await loadStorage();
    }

    ctx.root.append(sheet, acts, logToggle, log, store, msg);
    void loadStorage();

    function render(s: PanelState): void {
      state = s;
      if (s.volume != null && document.activeElement !== volumeInput) {
        volumeInput.value = String(s.volume);
        volumeReadout.textContent = String(s.volume);
        syncSliderFill(volumeInput);
      }
      const busy = s.venv.phase === 'working' || s.install.phase === 'working';
      // 引擎
      const running = s.phase === 'ready' || s.phase === 'starting';
      setPill(engineRow.pill, t[phaseKey(s.phase)], toneOf(s.phase));
      const who = [s.device, s.model].filter(Boolean).join(' · ');
      const started = s.phase === 'ready' && s.startMs ? t.startedIn(Math.round(s.startMs / 1000)) : '';
      engineRow.detail.textContent = [who || s.detail, started].filter(Boolean).join(' · ');
      restartBtn.disabled = s.phase === 'starting' || busy;
      // 未跑着（或启动中）时给「启动」；跑着时给「停止」——用户自行启停，装依赖期间不让点。
      startBtn.hidden = running;
      startBtn.disabled = busy;
      stopBtn.hidden = !running;
      // 依赖（派生 venv）
      setPill(depsRow.pill, t[phaseKey(s.venv.phase)], toneOf(s.venv.phase));
      depsRow.detail.textContent = s.venv.detail ?? (s.venv.phase === 'ready' ? '' : t.depsAbsent);
      // 权重
      setPill(
        weightsRow.pill,
        s.install.phase === 'working' ? `${t.working} ${s.install.total ? `${Math.round((s.install.done ?? 0) / s.install.total * 100)}%` : ''}` : t[phaseKey(s.install.phase)],
        toneOf(s.install.phase),
      );
      weightsRow.detail.textContent = s.install.detail ?? `${ui.fmt.bytes(s.install.done)} / ${ui.fmt.bytes(s.install.total)}`;
      bar.el.hidden = s.install.phase !== 'working';
      if (s.install.phase === 'working') bar.setValue(s.install.done ?? 0, s.install.total || 1);
      // 分离模型：默认 Inst_HQ_3 + 可选的高质量 Mel-Band；两个都在位时状态写「两个」。
      const defaultReady = s.uvr.phase === 'ready';
      const highReady = s.melband.phase === 'ready';
      const bothReady = defaultReady && highReady;
      setPill(
        uvrRow.pill,
        bothReady
          ? t.sepBoth
          : s.uvr.phase === 'working' ? `${t.working} ${s.uvr.total ? `${Math.round((s.uvr.done ?? 0) / s.uvr.total * 100)}%` : ''}` : t[phaseKey(s.uvr.phase)],
        bothReady ? 'on' : toneOf(s.uvr.phase),
      );
      uvrRow.detail.textContent = bothReady
        ? t.sepBothDetail
        : s.uvr.detail ?? `${ui.fmt.bytes(s.uvr.done)} / ${ui.fmt.bytes(s.uvr.total)}`;
      setPill(
        melbandRow.pill,
        s.melband.phase === 'working' ? `${t.working} ${s.melband.total ? `${Math.round((s.melband.done ?? 0) / s.melband.total * 100)}%` : ''}` : t[phaseKey(s.melband.phase)],
        toneOf(s.melband.phase),
      );
      melbandRow.detail.textContent = s.melband.detail
        ?? (highReady ? t.sepHighSize : `${ui.fmt.bytes(s.melband.done)} / ${ui.fmt.bytes(s.melband.total)}`);
      melbandDownload.hidden = s.melband.phase === 'working' || highReady;
      melbandCancel.hidden = s.melband.phase !== 'working';
      melbandRemove.hidden = !highReady;
      if (!highReady) {
        melArmed = false;
        melbandRemove.textContent = t.melbandUninstall;
      }
      sepBar.el.hidden = s.melband.phase !== 'working';
      if (s.melband.phase === 'working') sepBar.setValue(s.melband.done ?? 0, s.melband.total || 1);
      const allReady = s.venv.phase === 'ready' && s.install.phase === 'ready';
      installBtn.textContent = allReady ? t.install : t.installSize(ui.fmt.bytes(s.install.total ?? 0));
      installBtn.disabled = busy || allReady;
      cancelBtn.hidden = !busy;
      // 音色
      setPill(voiceRow.pill, s.voiceCount ? t.voicesCount(s.voiceCount) : t.noVoice, s.voiceCount ? 'on' : 'off');
      voiceRow.detail.textContent = s.voiceCount ? t.voiceLabel(s.defaultVoice) : t.noVoiceHint;
      // 接口
      setPill(apiRow.pill, s.port ? t.apiOn(s.port) : t.apiOff, s.port ? 'on' : 'off');
      apiRow.detail.textContent = s.queue ? t.queueText(s.queue) : '';
      uvr5Warn.hidden = s.uvr5;
      if (expanded) log.textContent = s.tail.join('\n');
    }

    const refresh = async (): Promise<void> => {
      try { render(await ctx.invoke<PanelState>('state')); } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 1000);
  },
};

// ---------------------------------------------------------------------------
// 变声
// ---------------------------------------------------------------------------

const convertPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    let file: File | null = null;
    let url: string | null = null;
    /** 推理三参数只在首帧套一次默认值，之后跟随用户在面板上的修改。 */
    let paramsInitialized = false;
    /** 面板选过的音色；首次渲染时套用，之后不覆盖用户当前选择。 */
    let voiceInitialized = false;
    const preferredVoice = savedPanelVoice();
    ctx.own(disposable(() => { if (url) URL.revokeObjectURL(url); }));

    const sheet = ui.section(t.convertTitle, t.convertHint);
    const fileInput = ui.input({});
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.wav,.flac,.mp3,.ogg,.m4a';
    const voiceSelect = ui.select({ options: [] });
    voiceSelect.addEventListener('change', () => savePanelVoice(voiceSelect.value));

    const pitch = ui.input({ type: 'number', value: '0' });
    pitch.min = '-24';
    pitch.max = '24';
    pitch.step = '1';
    const indexRate = ui.input({ type: 'number', value: '0.3' });
    indexRate.min = '0';
    indexRate.max = '1';
    indexRate.step = '0.05';
    const protect = ui.input({ type: 'number', value: '0.33' });
    protect.min = '0';
    protect.max = '0.5';
    protect.step = '0.01';
    const format = ui.select({ value: 'wav', options: [{ value: 'wav' }, { value: 'mp3' }] });
    const chunk = ui.select({
      value: 'chunk',
      options: [{ value: 'chunk', label: t.chunkSlice }, { value: 'full', label: t.chunkFull }],
    });

    const knobs = ui.h('div', 'rvc-grid');
    knobs.append(
      ui.field(t.pitch, pitch),
      ui.field(t.indexRate, indexRate),
      ui.field(t.protect, protect),
      ui.field(t.format, format),
      ui.field(t.chunkMode, chunk),
    );

    const paramHint = ui.h('div', 'rvc-detail');
    paramHint.hidden = true;
    const convertBtn = ui.button(t.convert, { variant: 'primary', size: 'sm', onClick: () => void run() });
    const acts = ui.actions();
    acts.append(convertBtn);

    sheet.append(
      ui.field(t.file, fileInput),
      ui.h('div', 'rvc-detail', t.fileHint),
      ui.field(t.voice, voiceSelect),
      knobs,
      paramHint,
      acts,
    );

    const audio = ui.h('audio', 'rvc-audio');
    audio.controls = true;
    audio.hidden = true;
    const resultLine = ui.h('div', 'rvc-detail');
    const dl = ui.h('a', 'btn sm', t.download);
    dl.hidden = true;

    ctx.root.append(sheet, audio, resultLine, dl, msg);

    fileInput.addEventListener('change', () => {
      file = fileInput.files?.[0] ?? null;
      msg.textContent = '';
      msg.classList.remove('bad');
      if (file) resultLine.textContent = `${file.name} · ${ui.fmt.bytes(file.size)}`;
    });

    function render(s: PanelState, voices: VoiceRow[]): void {
      state = s;
      // 「默认」是跟随配置/目录第一个的动态项，把实际音色带上，免得和下面的显式项看起来一样。
      const fallback = s.defaultVoice ? `${t.defaultVoice}（${t.voiceLabel(s.defaultVoice)}）` : t.defaultVoice;
      fillSelect(ui, voiceSelect, [{ value: '', label: fallback }, ...voices.map((v) => ({ value: v.name, label: t.voiceLabel(v.name) + binTag(v) }))]);
      if (!voiceInitialized) {
        voiceInitialized = true;
        voiceSelect.value = preferredVoice != null && (preferredVoice === '' || voices.some((v) => v.name === preferredVoice))
          ? preferredVoice
          : '';
      } else if (voiceSelect.value !== '' && !voices.some((v) => v.name === voiceSelect.value)) {
        voiceSelect.value = '';
      }
      if (!paramsInitialized) {
        paramsInitialized = true;
        const d = s.defaults;
        pitch.value = String(d?.pitch ?? 0);
        indexRate.value = String(d?.indexRate ?? 0.3);
        protect.value = String(d?.protect ?? 0.33);
      }
      paramHint.hidden = !s.defaults;
      if (s.defaults) {
        paramHint.textContent = t.paramDefaults(
          s.defaults.pitch ?? 0,
          s.defaults.indexRate ?? 0.3,
          s.defaults.protect ?? 0.33,
        );
      }
      convertBtn.disabled = !s.ready || s.job?.phase === 'working';
      if (!s.ready && s.detail) msg.textContent = s.detail;
    }

    let tookResult = false;

    async function run(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!file) { msg.textContent = t.pickFileFirst; msg.classList.add('bad'); return; }
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      tookResult = false;
      msg.textContent = t.converting;
      convertBtn.disabled = true;
      try {
        const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
        // 后台跑：这里立刻返回，用户可以切到别的页；结果由定时刷新取回。
        await ctx.invoke('convert', [file.name, base64, {
          voice: voiceSelect.value,
          pitch: Number(pitch.value),
          indexRate: Number(indexRate.value),
          protect: Number(protect.value),
          format: format.value,
          chunk: chunk.value === 'chunk',
        }]);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        convertBtn.disabled = !state?.ready;
      }
    }

    /** 轮询状态时把后台任务收尾：出错显示原因，完成就把音频取回来。 */
    async function settle(s: PanelState): Promise<void> {
      const job = s.job;
      if (!job || job.kind !== 'convert') return;
      if (job.phase === 'working') {
        msg.textContent = job.detail || t.converting;
        msg.classList.remove('bad');
        return;
      }
      if (tookResult) return;
      tookResult = true;
      if (job.phase === 'error') {
        msg.textContent = job.error || '转换失败';
        msg.classList.add('bad');
        return;
      }
      if (!s.resultReady) return;
      const r = await ctx.invoke<JobResult>('takeResult');
      if (r.error || !r.base64) {
        msg.textContent = r.error ?? '没有拿到音频';
        msg.classList.add('bad');
        return;
      }
      msg.textContent = '';
      const blob = blobFromBase64(r.base64, r.mime ?? 'audio/wav');
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      audio.src = url;
      audio.hidden = false;
      dl.href = url;
      dl.download = `rvc.${format.value}`;
      dl.hidden = false;
      const done = s.lastConvert;
      resultLine.textContent = done
        ? [t.convertDone(ui.fmt.duration(done.ms), ui.fmt.bytes(done.bytes)), done.savedPath ? t.saved(done.savedPath) : ''].filter(Boolean).join(' · ')
        : '';
    }

    const refresh = async (): Promise<void> => {
      try {
        const [s, v] = await Promise.all([ctx.invoke<PanelState>('state'), ctx.invoke<VoicesResp>('voices')]);
        render(s, v.voices ?? []);
        await settle(s);
      } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 3000);
  },
};

// ---------------------------------------------------------------------------
// 翻唱（整首歌）
// ---------------------------------------------------------------------------

const coverPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    /** 配置里的默认值只在第一次拿到状态时套用，之后保留用户本次的手动选择。 */
    let defaultsApplied = false;
    let pickedPath: string | null = null;
    let pickedName = '';
    let url: string | null = null;
    ctx.own(disposable(() => { if (url) URL.revokeObjectURL(url); }));

    const sheet = ui.section(t.coverTitle, t.coverHint);
    // 整首歌几十 MB，走浏览器上传会撞到 World 的请求体上限（HTTP 413）。
    // 这里直接让宿主弹本机文件框，只把路径交给后端读取。
    const fileShell = ui.h('div', 'rvc-file');
    fileShell.tabIndex = 0;
    const fileBadge = ui.h('span', 'rvc-file-badge');
    const fileName = ui.h('span', 'rvc-file-name');
    const fileMeta = ui.h('span', 'rvc-file-meta');
    fileShell.append(fileBadge, fileName, fileMeta);
    fileShell.addEventListener('click', () => void chooseNative());
    fileShell.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        void chooseNative();
      }
    });
    const keepSource = ui.h('input') as HTMLInputElement;
    keepSource.type = 'checkbox';
    keepSource.checked = true;
    // 训完直接入库，省得再去「最近翻唱」里点保存；默认勾上。
    const toLibrary = ui.h('input') as HTMLInputElement;
    toLibrary.type = 'checkbox';
    toLibrary.checked = true;
    const sourceLine = ui.h('div', 'rvc-detail');
    const voiceSelect = ui.select({ options: [] });
    voiceSelect.addEventListener('change', () => savePanelVoice(voiceSelect.value));

    // B 站一键生成：歌名 → 搜索 → 下载 → 走现有按路径翻唱。
    const biliQuery = ui.input({ value: '' });
    biliQuery.type = 'search';
    biliQuery.placeholder = t.biliSongPlaceholder;
    const biliKind = ui.select({
      value: 'cover',
      options: [{ value: 'cover', label: t.biliKindCover }, { value: 'clean', label: t.biliKindClean }],
    });
    const biliBtn = ui.button(t.biliGenerate, { variant: 'primary', size: 'sm', onClick: () => void runBili() });
    const biliLine = ui.h('div', 'rvc-detail');
    const biliCandidates = ui.h('div', 'rvc-library');
    const biliRow = ui.h('div', 'rvc-grid');
    biliRow.append(ui.field(t.biliSong, biliQuery), ui.field(t.biliKind, biliKind));
    const biliActs = ui.actions();
    biliActs.append(biliBtn);

    // 第一组：会重跑变声的参数。
    const pitch = ui.input({ type: 'number', value: '0' });
    pitch.min = '-24';
    pitch.max = '24';
    pitch.step = '1';
    const indexRate = ui.input({ type: 'number', value: '0.3' });
    indexRate.min = '0';
    indexRate.max = '1';
    indexRate.step = '0.05';
    const protect = ui.input({ type: 'number', value: '0.33' });
    protect.min = '0';
    protect.max = '0.5';
    protect.step = '0.01';
    const chunk = ui.select({
      value: 'chunk',
      options: [{ value: 'chunk', label: t.chunkSlice }, { value: 'full', label: t.chunkFull }],
    });
    const inferKnobs = ui.h('div', 'rvc-grid');
    inferKnobs.append(
      ui.field(t.pitch, pitch),
      ui.field(t.indexRate, indexRate),
      ui.field(t.protect, protect),
      ui.field(t.chunkMode, chunk),
    );
    const paramHint = ui.h('div', 'rvc-detail');
    paramHint.hidden = true;

    // 第二组：只影响混音。首次出结果前隐藏，但仍参与「上次生效值」比对。
    const vocalGainDb = slider(t.vocalGain, -12, 12, 1);
    const instGainDb = slider(t.instGain, -12, 12, 1);
    const fadeIn = slider(t.fadeIn, 0, 10, 0.5);
    const fadeOut = slider(t.fadeOut, 0, 10, 0.5);
    const mixFormat = ui.select({ value: 'wav', options: [{ value: 'wav' }, { value: 'mp3' }] });
    const bgmMode = ui.select({
      value: 'bgm',
      options: [{ value: 'bgm', label: t.bgmWith }, { value: 'clean', label: t.bgmWithout }],
    });
    // 分离档：默认 Inst_HQ_3；选高质量才下 Mel-Band 权重，失败自动回退。
    const sepTier = ui.select({
      value: 'fast',
      options: [{ value: 'fast', label: t.sepFast }, { value: 'high', label: t.sepHigh }],
      onChange: (value) => void setSepTier(value),
    });
    const sepLine = ui.h('div', 'rvc-detail');
    sepLine.hidden = true;
    const mixKnobs = ui.h('div', 'rvc-grid');
    mixKnobs.append(vocalGainDb.field, instGainDb.field, fadeIn.field, fadeOut.field, ui.field(t.format, mixFormat));

    const coverBtn = ui.button(t.cover, { variant: 'primary', size: 'sm', onClick: () => void onCoverClick() });
    const acts = ui.actions();
    acts.append(coverBtn);
    const dirtyLine = ui.h('div', 'rvc-detail');
    const mixBlock = ui.h('div', 'rvc-mix');
    mixBlock.append(ui.h('div', 'rvc-detail', t.coverMixHint), mixKnobs);
    mixBlock.hidden = true;

    sheet.append(
      ui.h('div', 'rvc-detail', t.biliHint),
      biliRow,
      biliActs,
      biliLine,
      biliCandidates,
      ui.h('div', 'rvc-detail', t.coverStagesHint),
      ui.field(t.file, fileShell),
      ui.h('div', 'rvc-detail', t.fileHint),
      sourceLine,
      ui.field(t.keepSource, keepSource),
      ui.h('div', 'rvc-detail', t.keepSourceHint),
      ui.field(t.saveToLibrary, toLibrary),
      ui.h('div', 'rvc-detail', t.saveToLibraryHint),
      ui.field(t.voice, voiceSelect),
      ui.field(t.bgmMode, bgmMode),
      ui.h('div', 'rvc-detail', t.bgmHint),
      ui.field(t.sepModel, sepTier),
      ui.h('div', 'rvc-detail', t.sepHint),
      sepLine,
      ui.h('div', 'rvc-detail', t.coverInferHint),
      inferKnobs,
      paramHint,
      ui.h('div', 'rvc-detail', t.inferHint),
      acts,
      dirtyLine,
      mixBlock,
    );

    const audio = ui.h('audio', 'rvc-audio');
    audio.controls = true;
    audio.hidden = true;
    const resultLine = ui.h('div', 'rvc-detail');
    const dl = ui.h('a', 'btn sm', t.download);
    dl.hidden = true;

    // 结果编辑：只列会话元数据，不读音频；选中的会话决定「重新混音」的素材。
    let selectedId = '';
    /** 面板选过的音色；首次渲染时套用，之后不覆盖用户当前选择。 */
    let voiceInitialized = false;
    const preferredVoice = savedPanelVoice();
    let mixKey = '';
    let settledKey = '';
    /** 最近一次选段重跑生成的段 id：选段卡片里的「还原」退回到重跑之前的样本。 */
    let lastRangeSegId = '';
    /** 已经还原过的段 id：还原保留备份且幂等，但按钮不该一直亮着。 */
    const revertedRanges = new Set<string>();
    /** 上次生效的翻唱参数与它对应的会话：按钮文案与动作都按这两组的 dirty 决定。 */
    let applied: CoverParams | null = null;
    let appliedSessionId = '';
    let pendingApplied: CoverParams | null = null;
    /** 最近一次 refineState 的会话摘要；菜单「另存」要知道原声副本在不在。 */
    let summaries: SessionSummary[] = [];
    /** 结果编辑的成品清单与当前选择；用文件相对路径做稳定键（下标会随裁剪前移）。 */
    let outputFiles: SessionOutputFile[] = [];
    let pickedOutput = '';
    let outputLoadKey = '';
    let outputSeq = 0;
    let outputsSessionId = '';
    /** 只有刚跑完一次成品才自动选最新一条；切会话/换原声一律不自动亮播放条。 */
    let autoPickOutput = false;
    let currentSession: RefineSession | null = null;
    /** 只让最后一次 refineState 请求落地，避免切会话时被慢响应弹回去。 */
    let refineSeq = 0;
    /** 波形包络与当前拖选（秒）。 */
    let peaks: PeaksResp | null = null;
    let peaksKey = '';
    let peaksSeq = 0;
    let selStart = 0;
    let selEnd = 0;
    let rangeParamsKey = '';
    let previewTimer = 0;
    /** 段落列表的渲染键：数据没变就不重建 DOM，避免轮询打断正在编辑的参数。 */
    let segKey = '';
    /** 音高体检数据（源人声不变，按会话缓存）与请求序号。 */
    let pitchData: PitchAnalysis | null = null;
    let pitchKey = '';
    let pitchSeq = 0;
    /** A/B：当前音轨、正在载入的成品对、两个 object URL 与循环计时器。 */
    let abActive: 'A' | 'B' = 'A';
    let abKey = '';
    let abToken = 0;
    let abTimer = 0;
    let abUrlA: string | null = null;
    let abUrlB: string | null = null;
    let abLoaded = false;
    let abLabelA = '';
    let abLabelB = '';

    // 后期工具收进折叠卡：主卡上只留一次翻唱要用的东西，编辑/重跑/母带按需展开。
    const refineSheet = ui.foldSheet('rvc-post-refine', { title: t.refineTitle, desc: t.refineHint, defaultOpen: true });
    const sessionSelect = ui.select({
      options: [],
      onChange: (value) => chooseSession(value),
    });
    // 成品选择：一个会话可能有多条混音/母带，A/B、试听、下载与另存都跟着它走。
    const outputSelect = ui.select({
      options: [],
      onChange: (value) => chooseOutput(value),
    });
    const outputRow = ui.field(t.output, outputSelect);
    const outputLine = ui.h('div', 'rvc-detail', t.outputHint);
    outputRow.hidden = true;
    outputLine.hidden = true;

    // 选段重跑：波形上拖出 [a,b)，只重渲这一段，区间外样本保持不变。
    const waveSheet = ui.foldSheet('rvc-post-range', { title: t.rangeTitle, desc: t.rangeHint, defaultOpen: false });
    const canvas = ui.h('canvas', 'rvc-wave');
    const rangeLine = ui.h('div', 'rvc-detail');
    const rangePitch = ui.input({ value: '0' });
    rangePitch.type = 'number';
    rangePitch.min = '-24';
    rangePitch.max = '24';
    rangePitch.step = '1';
    const rangeIndex = ui.input({ value: '0.3' });
    rangeIndex.type = 'number';
    rangeIndex.min = '0';
    rangeIndex.max = '1';
    rangeIndex.step = '0.05';
    const rangeProtect = ui.input({ value: '0.33' });
    rangeProtect.type = 'number';
    rangeProtect.min = '0';
    rangeProtect.max = '0.5';
    rangeProtect.step = '0.01';
    const rangeKnobs = ui.h('div', 'rvc-grid');
    rangeKnobs.append(ui.field(t.pitch, rangePitch), ui.field(t.indexRate, rangeIndex), ui.field(t.protect, rangeProtect));
    const rerunRangeBtn = ui.button(t.rangeRerun, { variant: 'primary', size: 'sm', onClick: () => void runRange() });
    const rangeRevertBtn = ui.button(t.rangeRevert, { size: 'sm', onClick: () => void revertLastRange() });
    rangeRevertBtn.disabled = true;
    const auditionBtn = ui.button(t.rangeAudition, { size: 'sm', onClick: () => void auditionRange() });
    const f0Btn = ui.button(t.exportF0, { size: 'sm', onClick: () => void exportF0() });
    const rangeActs = ui.actions();
    rangeActs.append(rerunRangeBtn, rangeRevertBtn, auditionBtn, f0Btn);
    // 音高体检：曲线与热力条画在同一个波形画布上，下面只列跑调区间。
    const pitchLine = ui.h('div', 'rvc-detail', t.pitchHint);
    const pitchList = ui.h('div', 'rvc-pitch-regions');
    waveSheet.body.append(canvas, rangeLine, pitchLine, pitchList, rangeKnobs, rangeActs);

    // 一键母带：另存，不覆盖最近一次混音。
    const masterSheet = ui.foldSheet('rvc-post-master', { title: t.masterTitle, desc: t.masterHint, defaultOpen: false });
    const masterPreset = ui.select({
      value: '-14',
      options: [
        { value: '-14', label: '-14 LUFS' },
        { value: '-16', label: '-16 LUFS' },
        { value: '-23', label: '-23 LUFS' },
      ],
    });
    const masterFormat = ui.select({ value: 'wav', options: [{ value: 'wav' }, { value: 'mp3' }] });
    const masterBtn = ui.button(t.master, { variant: 'primary', size: 'sm', onClick: () => void runMaster() });
    const masterActs = ui.actions();
    masterActs.append(masterBtn);
    const masterLine = ui.h('div', 'rvc-detail');
    masterSheet.body.append(ui.field(t.masterPreset, masterPreset), ui.field(t.format, masterFormat), masterActs, masterLine);

    // 「重新混音」已经并到上面的主按钮（按 dirty 决定只重混还是先重跑变声），这里只留会话与清理。
    const deleteBtn = ui.button(t.sessionDelete, { size: 'sm', onClick: () => void deleteCurrent() });
    const cleanupBtn = ui.button(t.sessionCleanup, { size: 'sm', onClick: () => void cleanup() });
    const refineActs = ui.actions();
    refineActs.append(deleteBtn, cleanupBtn);

    const refineDisk = ui.h('div', 'rvc-detail');
    const refineLine = ui.h('div', 'rvc-detail');
    const mixLine = ui.h('div', 'rvc-detail');
    refineSheet.body.append(
      ui.field(t.session, sessionSelect),
      outputRow,
      outputLine,
      refineActs,
      refineDisk,
      refineLine,
      mixLine,
    );

    // 顶部「最近翻唱」：原声/成品、体积、时间、时长、音色，以及继续编辑 / 另存 / 删除与保留策略。
    const recentSheet = ui.foldSheet('rvc-cover-recent', { title: t.recentTitle, desc: t.recentHint });
    const recentList = ui.h('div');    const daysInput = ui.input({ type: 'number', value: '7' });
    daysInput.min = '0';
    daysInput.max = '365';
    daysInput.step = '1';
    const gbInput = ui.input({ type: 'number', value: '8' });
    gbInput.min = '0';
    gbInput.max = '1000';
    gbInput.step = '1';
    const retentionSave = ui.button(t.retentionSave, {
      size: 'sm', onClick: () => void saveRetention(),
    });
    const retentionLine = ui.h('div', 'rvc-detail');
    // 「打开最近翻唱目录」：所有会话都在这个目录下，方便手动找文件 / 备份。
    const recentOpenLine = ui.h('div', 'rvc-detail');
    const recentOpenActs = ui.actions();
    recentOpenActs.append(ui.button(t.recentOpenFolder, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          try {
            const r = await ctx.invoke<{ dir: string }>('sessionsOpen');
            recentOpenLine.textContent = t.recentOpenDone(r.dir);
            recentOpenLine.classList.remove('bad');
          } catch (err) {
            recentOpenLine.textContent = errText(err);
            recentOpenLine.classList.add('bad');
          }
        })();
      },
    }));
    const retentionRow = ui.h('div', 'rvc-grid');
    retentionRow.append(ui.field(t.retentionDays, daysInput), ui.field(t.retentionGb, gbInput));
    const retentionActs = ui.actions();
    retentionActs.append(retentionSave);
    recentSheet.body.append(
      recentList,
      recentOpenActs,
      recentOpenLine,
      ui.h('div', 'rvc-detail', t.retentionHint),
      retentionRow,
      retentionActs,
      retentionLine,
    );

    // 翻唱库：独立于会话的成品副本；列表、试听、删除、总占用与可调上限。
    const librarySheet = ui.foldSheet('rvc-cover-library', { title: t.libraryPanelTitle, desc: t.libraryPanelHint });
    const librarySummary = ui.h('div', 'rvc-detail');
    const libraryLine = ui.h('div', 'rvc-detail');
    const libraryList = ui.h('div', 'rvc-library');
    const libraryCapInput = ui.input({ type: 'number', value: '2' });
    libraryCapInput.min = '0';
    libraryCapInput.max = '1000';
    libraryCapInput.step = '1';
    const libraryCapSave = ui.button(t.libraryMaxSave, { size: 'sm', onClick: () => void saveLibraryCap() });
    const libraryRefreshBtn = ui.button(t.libraryRefresh, { size: 'sm', onClick: () => void loadLibrary(true) });
    const libraryOpenBtn = ui.button(t.libraryOpenFolder, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          try {
            const r = await ctx.invoke<{ dir: string }>('libraryOpen');
            libraryLine.textContent = t.libraryOpenDone(r.dir);
          } catch (err) {
            libraryLine.textContent = errText(err);
            libraryLine.classList.add('bad');
          }
        })();
      },
    });
    const libraryCapRow = ui.h('div', 'rvc-grid');
    libraryCapRow.append(ui.field(t.libraryMaxGb, libraryCapInput));
    const libraryActs = ui.actions();
    libraryActs.append(libraryCapSave, libraryRefreshBtn, libraryOpenBtn);

    // 排序：最近 / 名字 / 随机；分类筛选：全部 / 清唱 / 翻唱；每页 5 首。
    const libSortBar = ui.h('div', 'rvc-sortbar');
    const libFilterSel = ui.select({
      value: 'all',
      options: [
        { value: 'all', label: t.libraryFilterAll },
        { value: 'clean', label: t.libraryFilterClean },
        { value: 'cover', label: t.libraryFilterCover },
      ],
    });
    const sortBtn = (label: string, sort: 'recent' | 'name' | 'random'): HTMLButtonElement => {
      const btn = ui.button(label, { size: 'sm', onClick: () => setLibrarySort(sort) });
      btn.dataset.sort = sort;
      libSortBar.append(btn);
      return btn;
    };
    sortBtn(t.librarySortRecent, 'recent');
    sortBtn(t.librarySortName, 'name');
    sortBtn(t.librarySortRandom, 'random');
    const libFilterRow = ui.h('div', 'rvc-grid');
    libFilterRow.append(ui.field(t.libraryFilter, libFilterSel));
    const libPageRow = ui.actions();
    const libPrev = ui.button(t.libraryPrev, { size: 'sm', onClick: () => { libPage = Math.max(0, libPage - 1); renderLibrary(libState, true); } });
    const libPageLine = ui.h('span', 'rvc-detail');
    const libNext = ui.button(t.libraryNext, { size: 'sm', onClick: () => { libPage += 1; renderLibrary(libState, true); } });
    libPageRow.append(libPrev, libPageLine, libNext);
    libFilterSel.addEventListener('change', () => {
      libFilter = libFilterSel.value as 'all' | 'clean' | 'cover';
      libPage = 0;
      renderLibrary(libState, true);
    });
    librarySheet.body.append(
      librarySummary,
      libraryCapRow,
      libraryActs,
      libSortBar,
      libFilterRow,
      libraryLine,
      libraryList,
      libPageRow,
    );
    const libraryAudio = document.createElement('audio');
    libraryAudio.hidden = true;
    libraryAudio.addEventListener('ended', () => {
      libPlaying = '';
      libraryLine.textContent = '';
      renderLibrary(libState, true);
    });

    // 段落级参数：默认 20 秒网格，每段独立重做/静音/还原/切分/合并。
    const segmentSheet = ui.foldSheet('rvc-post-segment', { title: t.segmentTitle, desc: t.segmentHint, defaultOpen: false });
    const segmentList = ui.h('div', 'rvc-segments');
    const segmentLine = ui.h('div', 'rvc-detail', t.segmentCutHint);
    segmentSheet.body.append(segmentList, segmentLine);

    // A/B 试听：两个隐藏 audio，各自持有一条成品；切换只搬 currentTime。
    const abSheet = ui.foldSheet('rvc-post-ab', { title: t.abTitle, desc: t.abHint, defaultOpen: false });
    const abLine = ui.h('div', 'rvc-detail', t.abNeedTwo);
    const abABtn = ui.button('A', { size: 'sm', onClick: () => void abPlay('A') });
    const abBBtn = ui.button('B', { variant: 'primary', size: 'sm', onClick: () => void abPlay('B') });
    const abSwitchBtn = ui.button(t.abSwitch, { size: 'sm', onClick: () => void abPlay(abActive === 'A' ? 'B' : 'A') });
    const abStopBtn = ui.button(t.abStop, { size: 'sm', onClick: () => stopAB() });
    const abActs = ui.actions();
    abActs.append(abABtn, abBBtn, abSwitchBtn, abStopBtn);
    const abAudioA = document.createElement('audio');
    const abAudioB = document.createElement('audio');
    abAudioA.hidden = true;
    abAudioB.hidden = true;
    abSheet.body.append(abActs, abLine);

    ctx.root.append(
      recentSheet.el, sheet, audio, resultLine, dl,
      refineSheet.el, waveSheet.el, masterSheet.el, segmentSheet.el, abSheet.el,
      librarySheet.el,
      abAudioA, abAudioB, libraryAudio, msg,
    );
    ctx.own(disposable(() => {
      stopPreview();
      stopAB();
      stopLibraryPreview();
      if (previewCtx) void previewCtx.close();
      if (abUrlA) URL.revokeObjectURL(abUrlA);
      if (abUrlB) URL.revokeObjectURL(abUrlB);
    }));

    bindSource();

    /** 宿主原生文件框：只拿路径，不把整首歌塞进 invoke 请求体。 */
    async function chooseNative(): Promise<void> {
      try {
        const path = await ctx.pickPath({ kind: 'file', title: t.filePick });
        if (!path) return;
        pickedPath = path;
        pickedName = path.split(/[\\/]/).pop() || path;
        // 换原声等于重新加载一个工程：旧成品不该继续挂在播放条上。
        autoPickOutput = false;
        pickedOutput = '';
        outputLoadKey = '';
        outputSeq += 1;
        clearOutputPlayer();
        outputSelect.value = '';
        msg.textContent = '';
        msg.classList.remove('bad');
        bindSource();
        updateCoverButton();
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    // 任一参数变动都重算「本次会做什么」；改回去就恢复原样，不靠手点。
    for (const el of [pitch, indexRate, protect, vocalGainDb.input, instGainDb.input, fadeIn.input, fadeOut.input]) {
      el.addEventListener('input', updateCoverButton);
    }
    for (const el of [chunk, voiceSelect, mixFormat]) el.addEventListener('change', updateCoverButton);

    /** 一条 0..N 的滑杆，右侧显示当前值。 */
    function slider(label: string, min: number, max: number, step: number): {
      input: HTMLInputElement;
      field: HTMLLabelElement;
      update: () => void;
    } {
      const input = ui.input({ value: '0' });
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      const readout = ui.h('span', 'rvc-slider-value');
      const wrap = ui.h('div', 'rvc-slider');
      wrap.append(input, readout);
      const update = (): void => {
        readout.textContent = String(Number(input.value));
        syncSliderFill(input);
      };
      input.addEventListener('input', update);
      update();
      return { input, field: ui.field(label, wrap), update };
    }

    function setSlider(s: { input: HTMLInputElement; update: () => void }, value: number): void {
      s.input.value = String(value);
      s.update();
    }

    // ---- 翻唱按钮的语义与「最近翻唱」 -------------------------------------
    let recentKey = '';
    let exportForm: HTMLElement | null = null;
    let libraryForm: HTMLElement | null = null;
    /** 翻唱库列表与试听状态；试听复用同一个 audio，切歌先停上一首。 */
    let libState: LibraryState | null = null;
    let libKey = '';
    let libSeq = 0;
    let libPlaying = '';
    let libUrl: string | null = null;
    let libSort: 'recent' | 'name' | 'random' = 'recent';
    let libFilter: 'all' | 'clean' | 'cover' = 'all';
    let libPage = 0;
    let libShuffle: string[] = [];

    function currentParams(): CoverParams {
      return {
        pitch: Number(pitch.value),
        indexRate: Number(indexRate.value),
        protect: Number(protect.value),
        chunk: chunk.value !== 'full',
        voice: voiceSelect.value || state?.defaultVoice || '',
        vocalGainDb: Number(vocalGainDb.input.value),
        instGainDb: Number(instGainDb.input.value),
        fadeInSec: Number(fadeIn.input.value),
        fadeOutSec: Number(fadeOut.input.value),
        // 清唱固定 WAV；不把格式下拉的 mp3 算成「改动」。
        format: bgmMode.value === 'clean' ? 'wav' : mixFormat.value,
        withBgm: bgmMode.value !== 'clean',
      };
    }

    function lastFormatOf(session: RefineSession): string {
      return session.outputs.length ? session.outputs[session.outputs.length - 1]!.format : 'wav';
    }

    function appliedFromSession(session: RefineSession): CoverParams {
      const defaults = session.converted.defaults;
      return {
        pitch: defaults.pitch,
        indexRate: defaults.indexRate,
        protect: defaults.protect,
        chunk: defaults.chunk,
        voice: voiceSelect.value || state?.defaultVoice || session.engine.voice,
        vocalGainDb: session.mix.vocalGainDb,
        instGainDb: session.mix.instGainDb,
        fadeInSec: session.mix.fadeInSec,
        fadeOutSec: session.mix.fadeOutSec,
        format: lastFormatOf(session),
        withBgm: session.mix.withBgm !== false,
      };
    }

    function actionOf(): CoverAction {
      // 新选的文件优先：那是另一首歌，点按钮会新建一次翻唱，不走原地重跑。
      if (pickedPath) return 'cover';
      if (!selectedId || !applied) return 'cover';
      return coverAction(coverDirty(currentParams(), applied), true);
    }

    /** 音频输入与下方「当前音源」：新选的文件优先，其次会话原声，最后提示未选。 */
    function bindSource(): void {
      let mode: 'session' | 'picked' | 'empty' = 'empty';
      let badge = t.fileBadgeNone;
      let name = t.filePick;
      let meta = t.fileEmptyNote;
      if (pickedPath) {
        mode = 'picked';
        badge = t.fileBadgeNew;
        name = pickedName;
        meta = t.filePathNote;
        sourceLine.textContent = t.sourcePicked(pickedName, t.filePathNote);
      } else {
        const summary = selectedId ? summaries.find((s) => s.id === selectedId) : undefined;
        if (summary?.source) {
          mode = 'session';
          badge = t.fileBadgeSession;
          name = summary.source.file;
          meta = `${ui.fmt.bytes(summary.source.bytes)} · ${ui.fmt.duration(summary.durationSec * 1000)} · ${t.fileReuseNote}`;
          sourceLine.textContent = t.sourceFromSession(summary.source.file, ui.fmt.bytes(summary.source.bytes));
        } else {
          sourceLine.textContent = selectedId ? t.sourceMissing : '';
        }
      }
      fileShell.dataset.state = mode;
      fileBadge.textContent = badge;
      fileName.textContent = name;
      fileName.title = name;
      fileMeta.textContent = meta;
      fileShell.setAttribute('aria-label', mode === 'empty' ? t.filePick : `${t.file}：${badge} ${name}`);
    }

    // ---- 结果编辑的成品选择 ------------------------------------------------
    function outputKindLabel(item: SessionOutputFile): string {
      return item.kind === 'master' ? t.outputKindMaster : t.outputKindMix;
    }

    function outputLabel(item: SessionOutputFile): string {
      const time = new Date(item.at).toLocaleTimeString();
      return t.outputOption(time, item.format.toUpperCase(), ui.fmt.bytes(item.bytes), outputKindLabel(item));
    }

    /** 把所选成品载入顶部播放器与下载链接；切换会话/成品时都走这里。 */
    async function loadOutput(key: string): Promise<void> {
      const item = outputFiles.find((f) => f.path === key);
      if (!item || !selectedId) return;
      const token = ++outputSeq;
      try {
        const blob = await ctx.invokeBinary('refineAudio', [selectedId, item.index, item.kind]);
        if (token !== outputSeq) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        audio.src = url;
        audio.hidden = false;
        dl.href = url;
        dl.download = `${item.kind === 'master' ? 'master' : 'cover'}-${selectedId}.${item.format}`;
        dl.hidden = false;
      } catch (err) {
        if (token !== outputSeq) return;
        outputLoadKey = '';
        clearOutputPlayer();
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    /** 清空顶部播放器与下载链接，避免切会话/文件被删后还指着上一个文件。 */
    function clearOutputPlayer(): void {
      stopPreview();
      audio.pause();
      audio.removeAttribute('src');
      audio.hidden = true;
      dl.removeAttribute('href');
      dl.hidden = true;
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
    }

    /** 选了哪条成品：播放器、下载、另存与 A/B 的「改动后」一侧都指向它。 */
    function chooseOutput(key: string): void {
      pickedOutput = key;
      outputLoadKey = '';
      abKey = '';
      stopPreview();
      if (!key) {
        clearOutputPlayer();
        return;
      }
      void loadOutput(key);
      if (currentSession) renderAB(currentSession, state?.job?.phase === 'working');
    }

    /** 按 refineState 的 `files` 重建下拉；默认最近一条，用户选过的路径还在就保留。 */
    function renderOutputs(r: RefineState, busy: boolean): void {
      const files = r.files ?? [];
      if ((r.session?.id ?? '') !== outputsSessionId) {
        outputsSessionId = r.session?.id ?? '';
        pickedOutput = '';
        outputLoadKey = '';
        outputSeq += 1;
        // 不清 autoPickOutput：刚跑完任务时 settle() 会把它置 true，随后这里要落到最新成品。
        // 手动切会话时 chooseSession() 已经置 false，不会误选。
        clearOutputPlayer();
      }
      outputFiles = files;
      if (!files.some((f) => f.path === pickedOutput)) {
        // 切工程时只清空，不自动挑一条；只有刚跑完成品时才落到最新一条。
        pickedOutput = autoPickOutput && files.length ? files[files.length - 1]!.path : '';
        if (!pickedOutput) clearOutputPlayer();
        outputLoadKey = '';
      }
      autoPickOutput = false;
      const options = files.length ? [{ value: '', label: t.outputPick }, ...files.map((f) => ({ value: f.path, label: outputLabel(f) }))] : [];
      fillSelect(ui, outputSelect, options);
      outputSelect.value = pickedOutput;
      outputSelect.disabled = busy || !files.length;
      outputRow.hidden = !files.length;
      outputLine.hidden = !r.session;
      outputLine.textContent = files.length ? t.outputHint : t.outputNone;
      if (pickedOutput && outputLoadKey !== pickedOutput) {
        outputLoadKey = pickedOutput;
        void loadOutput(pickedOutput);
      }
    }

    /** 主按钮在「开始翻唱 / 重新翻唱 / 重新混音 / 重新翻唱混音」之间切换，并说明本次会做什么。 */
    function updateCoverButton(): void {
      const action = actionOf();
      coverBtn.textContent =
        action === 'cover' ? t.cover
          : action === 'remix' ? t.remix
            : action === 'rerunMix' ? t.coverRerunMix
              : t.coverRerun;
      mixBlock.hidden = !selectedId;
      const dirty = selectedId && applied
        ? coverDirty(currentParams(), applied)
        : { inference: false, mix: false };
      const summary = selectedId ? summaries.find((s) => s.id === selectedId) : undefined;
      // 原地重跑必须有可用源：会话里有原声副本，或用户刚选了一个新文件；重混不需要。
      const needSource = actionNeedsSource(action) && !summary?.source;
      dirtyLine.textContent = needSource ? t.needSource
        : !selectedId ? ''
          : dirty.inference && dirty.mix ? t.coverDirtyBoth
            : dirty.inference ? t.coverDirtyInfer
              : dirty.mix ? t.coverDirtyMix
                : '';
      const busy = state?.job?.phase === 'working';
      coverBtn.disabled = busy || !state?.ready || (action === 'cover' && !state?.uvr5) || needSource;
      biliBtn.disabled = busy || !state?.ready || !state?.uvr5;
      biliQuery.disabled = busy;
      biliKind.disabled = busy;
    }

    /** 每次搜索都列候选：按相似度排序，用户点哪首就只跑哪首。 */
    function renderBiliCandidates(pick: BiliPickResp): void {
      biliCandidates.textContent = '';
      for (const [index, cand] of pick.candidates.entries()) {
        const row = ui.h('div', 'rvc-library-row');
        const head = ui.h('div', 'rvc-library-head');
        head.append(
          ui.h('strong', '', cand.title),
          ui.pill(cand.durationSec > 0 ? ui.fmt.duration(cand.durationSec * 1000) : '—', 'plain'),
        );
        const meta = ui.h('div', 'rvc-detail', t.biliCandidateMeta(
          cand.author || '—',
          Math.max(0, cand.play).toLocaleString(),
          cand.artist || '',
        ));
        if (cand.matchLevel === 'partial') {
          meta.append(ui.h('div', 'rvc-detail', t.biliPartialTag));
        }
        const acts = ui.actions();
        // 带上后面的候选：用户选的那条失效/412 时还能自动换下一条。
        acts.append(ui.button(t.biliUse, { size: 'sm', onClick: () => void runBili(pick.candidates.slice(index)) }));
        row.append(head, meta, acts);
        biliCandidates.append(row);
      }
    }

    /** 面板「B 站搜索」：搜索后总是列出按相似度排序的候选，用户点一首再生成。 */
    async function runBili(chosen?: BiliCandidate[]): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      biliLine.classList.remove('bad');
      const query = biliQuery.value.trim();
      if (!query) { msg.textContent = t.biliNeedSong; msg.classList.add('bad'); return; }
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!state?.uvr5) { msg.textContent = t.coverNeedsUvr; msg.classList.add('bad'); return; }
      biliCandidates.textContent = '';
      let picked = chosen;
      if (!picked) {
        biliBtn.disabled = true;
        biliLine.textContent = t.biliSearching;
        try {
          const r = await ctx.invoke<BiliPickResp>('biliSearch', [query]);
          if (!r.candidates.length) {
            biliLine.textContent = t.biliNoResult;
            biliLine.classList.add('bad');
            return;
          }
          // 每次搜索都列候选（按相似度排序），不再自动挑第一条直接跑几分钟。
          biliLine.textContent = r.confident ? t.biliPickOne : t.biliLowConfidence(r.reason);
          biliLine.classList.toggle('bad', !r.confident);
          renderBiliCandidates(r);
          biliBtn.disabled = false;
          return;
        } catch (err) {
          biliLine.textContent = errText(err);
          biliLine.classList.add('bad');
          return;
        }
      }
      const best = picked[0]!;
      // 让面板上的 BGM 选择跟着这次的类型走，之后「重新混音」保持同一档。
      bgmMode.value = biliKind.value === 'clean' ? 'clean' : 'bgm';
      const params = currentParams();
      settledKey = '';
      msg.textContent = t.covering;
      biliLine.textContent = t.biliGenerating(best.title);
      try {
        await ctx.invoke('biliCover', [query, {
          withBgm: params.withBgm,
          voice: params.voice,
          pitch: params.pitch,
          indexRate: params.indexRate,
          protect: params.protect,
          vocalGain: params.vocalGainDb,
          format: params.format,
          chunk: params.chunk,
          keepSource: keepSource.checked,
          toLibrary: toLibrary.checked,
          candidates: picked.slice(0, 5),
        }]);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        biliLine.textContent = '';
        biliBtn.disabled = false;
      }
    }

    async function onCoverClick(): Promise<void> {
      const action = actionOf();
      if (action === 'remix') return runRemix();
      if (action === 'rerun' || action === 'rerunMix') return rerunCover();
      return run();
    }

    function chooseSession(id: string): void {
      selectedId = id;
      sessionSelect.value = id;
      // 切工程时丢掉上一次选的新文件，音频输入改显示这个会话的原声（没有就提示未选）。
      pickedPath = null;
      pickedName = '';
      bindSource();
      // 成品选择也回到这个会话的最近一条。
      outputsSessionId = '';
      pickedOutput = '';
      outputLoadKey = '';
      outputSeq += 1;
      // 选中老工程时不自动把某条成品塞进播放器；等用户在「成品」里选。
      autoPickOutput = false;
      clearOutputPlayer();
      outputSelect.value = '';
      mixKey = '';
      rangeParamsKey = '';
      peaks = null;
      peaksKey = '';
      selStart = 0;
      selEnd = 0;
      pitchData = null;
      pitchKey = '';
      pitchList.textContent = '';
      pitchLine.textContent = t.pitchHint;
      abKey = '';
      abLoaded = false;
      stopAB();
      updateRangeLine();
      drawWave();
      // 顶部参数等 refineState 回来再按会话回填（置空强制走一次回填）。
      appliedSessionId = '';
      void loadRefine(id);
      sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /** 会话里的「歌名」：优先原始上传 / B 站视频标题；老会话的 source.* 不算名字。 */
    function songName(s: SessionSummary): string {
      const base = s.source?.name ?? '';
      if (base && !/^source\.[^.]+$/i.test(base)) return base.replace(/\.[^.]+$/, '');
      const copy = s.source?.file ?? '';
      return copy && !/^source\.[^.]+$/i.test(copy) ? copy.replace(/\.[^.]+$/, '') : t.unnamed;
    }

    function renderRecent(r: RefineState): void {
      const key = JSON.stringify(r.sessions.map((s) => [
        s.id, s.updatedAt, s.bytes, s.voice, s.source, s.outputFiles,
      ]));
      if (key === recentKey) return;
      recentKey = key;
      exportForm = null;
      libraryForm = null;
      recentList.textContent = '';
      if (!r.sessions.length) {
        recentList.append(ui.h('div', 'rvc-detail', t.recentEmpty));
        return;
      }
      for (const s of r.sessions) {
        const row = ui.h('div', 'rvc-recent');
        const head = ui.h('div', 'rvc-recent-head');
        head.append(
          ui.h('strong', '', songName(s)),
          ui.h('span', '', [
            s.voice ? t.voiceLabel(s.voice) : '',
            t.recentMeta(new Date(s.updatedAt).toLocaleString(), ui.fmt.duration(s.durationSec * 1000), ''),
          ].filter(Boolean).join(' · ')),
        );
        const source = ui.h('div', 'rvc-detail', s.source
          ? t.recentSource(s.source.file, ui.fmt.bytes(s.source.bytes))
          : t.recentNoSource);
        const last = s.outputFiles[s.outputFiles.length - 1];
        const output = ui.h('div', 'rvc-detail', last
          ? t.recentOutput(last.path.replace(/^out\//, ''), ui.fmt.bytes(last.bytes))
          : t.recentNoOutput);
        const acts = ui.actions();
        // 「打开文件夹」：直接在资源管理器里打开这个会话目录（原声、分轨、成品都在里面）。
        let rowOpenLine: HTMLElement | null = null;
        acts.append(
          ui.button(t.recentResume, { size: 'sm', onClick: () => chooseSession(s.id) }),
          ui.button(t.recentExport, { size: 'sm', onClick: () => toggleExport(row, s) }),
          ui.button(t.librarySave, { size: 'sm', onClick: () => toggleLibrary(row, s) }),
          ui.button(t.recentRowOpen, {
            size: 'sm',
            onClick: () => {
              void (async () => {
                rowOpenLine ??= ui.h('div', 'rvc-detail');
                if (!rowOpenLine.isConnected) row.append(rowOpenLine);
                try {
                  const r = await ctx.invoke<{ dir: string }>('sessionOpen', [s.id]);
                  rowOpenLine.textContent = t.recentRowOpenDone(r.dir);
                  rowOpenLine.classList.remove('bad');
                } catch (err) {
                  rowOpenLine.textContent = errText(err);
                  rowOpenLine.classList.add('bad');
                }
              })();
            },
          }),
          ui.button(t.sessionDelete, { size: 'sm', onClick: () => void deleteById(s.id) }),
        );
        if (s.id === selectedId) {
          head.prepend(ui.pill(t.using, 'on'));
        }
        row.append(head, source, output, acts);
        recentList.append(row);
      }
    }

    /** 另存：先调浏览器原生保存框（File System Access），不支持或拒绝时退回下载，全程不碰 PowerShell。 */
    function toggleExport(row: HTMLElement, s: SessionSummary): void {
      if (exportForm) {
        exportForm.remove();
        exportForm = null;
      }
      const form = ui.h('div', 'rvc-recent-form');
      const name = ui.input({ value: `cover-${songName(s)}` });
      // 当前会话有选中的成品时，另存默认就存它；其它会话仍按最新混音。
      const picked = s.id === selectedId ? outputFiles.find((f) => f.path === pickedOutput) : undefined;
      const which = ui.select({
        value: picked ? 'current' : 'output',
        options: [
          ...(picked ? [{
            value: 'current',
            label: t.exportCurrent(outputKindLabel(picked), picked.format.toUpperCase()),
          }] : []),
          { value: 'output', label: t.exportOutput },
          ...(s.source ? [{ value: 'source', label: t.exportSource }] : []),
        ],
      });
      const line = ui.h('div', 'rvc-detail', t.exportHint);
      const grid = ui.h('div', 'rvc-grid');
      grid.append(ui.field(t.exportName, name), ui.field(t.exportWhich, which));
      const acts = ui.actions();
      const save = ui.button(t.exportPick, {
        variant: 'primary', size: 'sm', onClick: () => void doExport(s, name, which, line),
      });
      const cancel = ui.button(t.exportCancel, {
        size: 'sm',
        onClick: () => {
          form.remove();
          if (exportForm === form) exportForm = null;
        },
      });
      acts.append(save, cancel);
      form.append(grid, acts, line);
      row.after(form);
      exportForm = form;
    }

    function targetOf(file: SessionOutputFile): LibraryTarget {
      // 老会话没有 mediaKind，按文件名兜底（清唱文件固定 clean-*）。
      const kind: 'clean' | 'cover' = file.mediaKind ?? (file.path.includes('clean-') ? 'clean' : 'cover');
      return { media: file.kind, index: file.index, format: file.format, kind };
    }

    function toggleLibrary(row: HTMLElement, s: SessionSummary): void {
      if (libraryForm) {
        libraryForm.remove();
        libraryForm = null;
      }
      const form = ui.h('div', 'rvc-recent-form');
      const name = ui.input({ value: songName(s) });
      const version = ui.select({ value: '', options: [{ value: '', label: t.libraryLoading }] });
      const line = ui.h('div', 'rvc-detail', t.libraryHint);
      let target: LibraryTarget | undefined;
      const save = ui.button(t.libraryConfirm, {
        variant: 'primary', size: 'sm', onClick: () => void doLibrarySave(s, target, name, line),
      });
      const cancel = ui.button(t.libraryCancel, {
        size: 'sm',
        onClick: () => {
          form.remove();
          if (libraryForm === form) libraryForm = null;
        },
      });
      const acts = ui.actions();
      acts.append(save, cancel);
      const grid = ui.h('div', 'rvc-grid');
      grid.append(ui.field(t.libraryName, name), ui.field(t.libraryVersion, version));
      form.append(grid, acts, line);
      row.after(form);
      libraryForm = form;

      // 列出这个会话的全部成品（混音 + 母带），默认最近一条；类型跟着所选版本走。
      void (async () => {
        try {
          const r = await ctx.invoke<{ files: SessionOutputFile[] }>('sessionFiles', [s.id]);
          if (!r.files.length) {
            version.textContent = '';
            const empty = ui.h('option', null, t.exportNeedOutput);
            empty.value = '';
            version.append(empty);
            save.disabled = true;
            return;
          }
          fillSelect(ui, version, r.files.map((file, at) => ({
            value: String(at),
            label: t.libraryVersionOption(
              new Date(file.at).toLocaleTimeString(),
              file.format.toUpperCase(),
              file.mediaKind === 'clean' || (!file.mediaKind && file.path.includes('clean-'))
                ? t.libraryKindClean
                : t.libraryKindCover,
              ui.fmt.bytes(file.bytes),
            ),
          })));
          const pick = (): void => {
            target = targetOf(r.files[Number(version.value)] ?? r.files[r.files.length - 1]!);
            line.classList.remove('bad');
            line.textContent = t.libraryHint;
          };
          version.value = String(r.files.length - 1);
          version.addEventListener('change', pick);
          pick();
        } catch (err) {
          line.textContent = errText(err);
          line.classList.add('bad');
          save.disabled = true;
        }
      })();
    }

    async function doLibrarySave(
      s: SessionSummary,
      target: LibraryTarget | undefined,
      name: HTMLInputElement,
      line: HTMLElement,
    ): Promise<void> {
      line.classList.remove('bad');
      if (!target) {
        line.textContent = t.exportNeedOutput;
        line.classList.add('bad');
        return;
      }
      if (target.kind === 'clean' && target.format !== 'wav') {
        line.textContent = t.libraryNeedWav;
        line.classList.add('bad');
        return;
      }
      line.textContent = t.librarySaving;
      try {
        const r = await ctx.invoke<{
          entry: { title: string; bytes: number }; duplicate: boolean;
          stats: { totalBytes: number; maxBytes: number };
        }>('librarySave', [s.id, target.media, target.index, target.kind, name.value.trim()]);
        const over = r.stats.maxBytes > 0 && r.stats.totalBytes > r.stats.maxBytes;
        let text = r.duplicate
          ? t.libraryDuplicate(r.entry.title)
          : t.librarySaved(`${r.entry.title}_${target.kind === 'clean' ? '清唱' : '翻唱'}cover`, ui.fmt.bytes(r.entry.bytes));
        if (over) text = `${text} · ${t.libraryOver}`;
        line.textContent = text;
        line.classList.toggle('bad', over);
        ui.toast(text);
        void loadLibrary(true);
      } catch (err) {
        line.textContent = errText(err);
        line.classList.add('bad');
      }
    }

    // ---- 翻唱库面板 ---------------------------------------------------------

    function libKind(entry: LibraryEntryView): string {
      return entry.kind === 'clean' ? t.libraryKindClean : t.libraryKindCover;
    }

    function setLibrarySort(sort: 'recent' | 'name' | 'random'): void {
      libSort = sort;
      libPage = 0;
      if (sort === 'random') libShuffle = shuffled((libState?.entries ?? []).map((entry) => entry.id));
      renderLibrary(libState, true);
    }

    function renderLibrary(data: LibraryState | null, force = false): void {
      libState = data;
      if (!data) return;
      const key = JSON.stringify([data.maxBytes, data.entries.map((entry) => [
        entry.id, entry.title, entry.kind, entry.bytes, entry.durationSec, entry.createdAt,
      ])]);
      if (!force && key === libKey) return;
      libKey = key;
      const over = data.maxBytes > 0 && data.totalBytes > data.maxBytes;
      librarySummary.textContent = `${t.libraryUsage(
        data.count,
        ui.fmt.bytes(data.totalBytes),
        data.maxBytes > 0 ? ui.fmt.bytes(data.maxBytes) : t.libraryUnlimited,
      )}${over ? ` · ${t.libraryOver}` : ''}`;
      librarySummary.classList.toggle('bad', over);
      if (document.activeElement !== libraryCapInput) {
        libraryCapInput.value = String(Math.round(data.maxBytes / (1024 * 1024 * 1024)));
      }
      for (const btn of libSortBar.querySelectorAll('button')) {
        btn.dataset.on = btn.dataset.sort === libSort ? '1' : '0';
      }
      libraryList.textContent = '';
      const filtered = data.entries.filter((entry) => libFilter === 'all' || entry.kind === libFilter);
      let sorted: LibraryEntryView[];
      if (libSort === 'name') {
        sorted = [...filtered].sort((a, b) =>
          a.title.localeCompare(b.title, 'zh') || Date.parse(b.createdAt) - Date.parse(a.createdAt));
      } else if (libSort === 'random') {
        if (!libShuffle.length) libShuffle = shuffled(data.entries.map((entry) => entry.id));
        const rank = new Map(libShuffle.map((id, at) => [id, at]));
        sorted = [...filtered].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      } else {
        sorted = [...filtered].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      }
      const pages = Math.max(1, Math.ceil(sorted.length / 5));
      libPage = Math.min(libPage, pages - 1);
      const pageItems = sorted.slice(libPage * 5, libPage * 5 + 5);
      libPageLine.textContent = t.libraryPage(libPage + 1, pages, sorted.length);
      libPrev.disabled = libPage <= 0;
      libNext.disabled = libPage >= pages - 1;
      if (!pageItems.length) {
        libraryList.append(ui.h('div', 'rvc-detail', data.entries.length ? t.libraryEmptyFilter : t.libraryEmpty));
        return;
      }
      for (const entry of pageItems) {
        const row = ui.h('div', 'rvc-library-row');
        const head = ui.h('div', 'rvc-library-head');
        head.append(
          ui.h('strong', '', entry.title),
          ui.pill(entry.kind === 'clean' ? t.libraryKindClean : t.libraryKindCover, entry.kind === 'clean' ? 'on' : 'plain'),
        );
        const duration = entry.durationSec > 0 ? ui.fmt.duration(entry.durationSec * 1000) : '—';
        const meta = ui.h('div', 'rvc-detail', t.libraryMeta(
          libKind(entry),
          duration,
          `${ui.fmt.bytes(entry.bytes)} · ${entry.format.toUpperCase()}`,
        ));
        const source = ui.h('div', 'rvc-detail', entry.sessionId
          ? t.librarySource(`${entry.sessionId.slice(0, 12)}…`)
          : t.libraryNoSource);
        const acts = ui.actions();
        acts.append(
          ui.button(libPlaying === entry.id ? t.libraryStopListen : t.libraryListen, {
            size: 'sm', onClick: () => void previewLibrary(entry),
          }),
          ui.button(t.libraryDelete, { size: 'sm', onClick: () => void deleteLibrary(entry) }),
        );
        row.append(head, meta, source, acts);
        libraryList.append(row);
      }
    }

    function stopLibraryPreview(): void {
      libraryAudio.pause();
      libraryAudio.removeAttribute('src');
      if (libUrl) {
        URL.revokeObjectURL(libUrl);
        libUrl = null;
      }
      libPlaying = '';
      libraryLine.textContent = '';
    }

    async function saveLibraryCap(): Promise<void> {
      libraryLine.classList.remove('bad');
      const gb = Math.max(0, Math.min(1000, Math.round(Number(libraryCapInput.value) || 0)));
      libraryCapInput.value = String(gb);
      try {
        await ctx.setConfig('world:rvc:service', { 'worlds.rvc.libraryMaxGb': gb });
        libraryLine.textContent = t.libraryMaxSaved(gb);
        // 配置已热更新：重读一次，让库面板与配置页同源。
        await loadLibrary(true);
      } catch (err) {
        libraryLine.textContent = errText(err);
        libraryLine.classList.add('bad');
      }
    }

    async function loadLibrary(force = false): Promise<void> {
      const seq = ++libSeq;
      try {
        const data = await ctx.invoke<LibraryState>('libraryState');
        if (seq !== libSeq) return;
        if (libPlaying && !data.entries.some((entry) => entry.id === libPlaying)) stopLibraryPreview();
        renderLibrary(data, force);
      } catch (err) {
        if (seq === libSeq) {
          libraryLine.textContent = errText(err);
          libraryLine.classList.add('bad');
        }
      }
    }

    async function previewLibrary(entry: LibraryEntryView): Promise<void> {
      libraryLine.textContent = '';
      libraryLine.classList.remove('bad');
      if (libPlaying === entry.id) {
        stopLibraryPreview();
        renderLibrary(libState, true);
        return;
      }
      try {
        const blob = await ctx.invokeBinary('libraryFile', [entry.id]);
        if (libUrl) URL.revokeObjectURL(libUrl);
        libUrl = URL.createObjectURL(blob);
        libraryAudio.src = libUrl;
        libPlaying = entry.id;
        libraryLine.textContent = t.libraryPlaying(entry.title);
        renderLibrary(libState, true);
        await libraryAudio.play();
      } catch (err) {
        libPlaying = '';
        libraryLine.textContent = errText(err);
        libraryLine.classList.add('bad');
        renderLibrary(libState, true);
      }
    }

    async function deleteLibrary(entry: LibraryEntryView): Promise<void> {
      const ok = await ui.confirm({
        title: t.libraryDelete,
        body: t.libraryDeleteConfirm(entry.title),
        danger: true,
      });
      if (!ok) return;
      libraryLine.textContent = '';
      libraryLine.classList.remove('bad');
      try {
        if (libPlaying === entry.id) stopLibraryPreview();
        const data = await ctx.invoke<LibraryState>('libraryDelete', [entry.id]);
        libKey = '';
        renderLibrary(data);
        libraryLine.textContent = t.libraryDeleted(entry.title);
      } catch (err) {
        libraryLine.textContent = errText(err);
        libraryLine.classList.add('bad');
      }
    }

    function extOf(file: string): string {
      const match = /\.[a-z0-9]{1,5}$/i.exec(file);
      return match ? match[0].toLowerCase() : '.wav';
    }

    interface SaveHandle {
      name: string;
      createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
    }
    type SavePicker = (options: { suggestedName?: string }) => Promise<SaveHandle>;

    function savePicker(): SavePicker | null {
      const host = window as unknown as { showSaveFilePicker?: SavePicker };
      return typeof host.showSaveFilePicker === 'function' ? host.showSaveFilePicker.bind(window) : null;
    }

    async function doExport(
      s: SessionSummary,
      name: HTMLInputElement,
      which: HTMLSelectElement,
      line: HTMLElement,
    ): Promise<void> {
      line.textContent = t.exportHint;
      line.classList.remove('bad');
      const picked = which.value === 'current'
        ? outputFiles.find((f) => f.path === pickedOutput)
        : undefined;
      const ext = which.value === 'source'
        ? extOf(s.source?.file ?? '')
        : picked ? `.${picked.format}` : `.${s.outputFiles[s.outputFiles.length - 1]?.format ?? 'wav'}`;
      const base = (name.value.trim() || `cover-${songName(s)}`)
        .replace(/\.(wav|mp3|flac|ogg|m4a)$/i, '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .trim() || `cover-${songName(s)}`;
      const suggested = `${base}${ext}`;
      // 原生保存框必须在点击的同一拍里调起，所以先开框、再取字节。
      let handle: SaveHandle | null = null;
      const picker = savePicker();
      if (picker) {
        try {
          handle = await picker({ suggestedName: suggested });
        } catch (err) {
          // 用户取消就什么都不做；不安全上下文/被策略禁用则退回下载。
          if ((err as { name?: string } | null)?.name === 'AbortError') return;
        }
      }
      try {
        const args = picked ? [s.id, picked.kind, picked.index] : [s.id, which.value];
        const r = await ctx.invoke<{
          name: string; ext: string; bytes: number; mime: string; base64: string;
        }>('sessionFile', args);
        const blob = blobFromBase64(r.base64, r.mime);
        if (handle) {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          line.textContent = t.exportDone(handle.name, ui.fmt.bytes(blob.size));
          ui.toast(line.textContent);
        } else {
          const href = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = href;
          link.download = suggested;
          link.click();
          setTimeout(() => URL.revokeObjectURL(href), 30_000);
          line.textContent = t.exportDownloaded(suggested);
          ui.toast(line.textContent);
        }
      } catch (err) {
        line.textContent = errText(err);
        line.classList.add('bad');
      }
    }

    async function saveRetention(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      retentionLine.classList.remove('bad');
      const days = Math.max(0, Math.floor(Number(daysInput.value) || 0));
      const gb = Math.max(0, Number(gbInput.value) || 0);
      try {
        await ctx.setConfig('world:rvc:service', {
          'worlds.rvc.sessionDays': days,
          'worlds.rvc.sessionMaxGb': gb,
        });
        retentionLine.textContent = t.retentionSaved(days, gb);
        // 配置已经热更新，重读一次让 days/maxGb 与配置页保持同源。
        await loadRefine(selectedId);
      } catch (err) {
        retentionLine.textContent = errText(err);
        retentionLine.classList.add('bad');
      }
    }

    function renderRefine(r: RefineState): void {
      fillSelect(ui, sessionSelect, [
        { value: '', label: t.sessionPick },
        ...r.sessions.map((s) => ({
          value: s.id,
          label: [s.id, s.voice ? t.voiceLabel(s.voice) : '', t.sessionLine(ui.fmt.duration(s.durationSec * 1000), ui.fmt.bytes(s.bytes), s.outputs)]
            .filter(Boolean)
            .join(' · '),
        })),
      ]);
      const session = r.session;
      summaries = r.sessions;
      selectedId = session?.id ?? '';
      // 选段重跑留下的 range 段带着「重跑前」备份：把它接到卡片里的「还原」上。
      const revertible = (session?.segments ?? []).filter(
        (item) => item.kind === 'range' && item.backup && !revertedRanges.has(item.id),
      );
      lastRangeSegId = revertible.length ? revertible[revertible.length - 1].id : '';
      rangeRevertBtn.disabled = !lastRangeSegId || !state?.ready;
      // 先定 selectedId 再刷音源，避免轮询时控件还停在上一个会话。
      bindSource();
      sessionSelect.value = selectedId;
      // 换会话时把顶部参数按会话回填（「继续编辑」也走这里），之后不再覆盖用户正在改的值。
      if (session && session.id !== appliedSessionId) {
        appliedSessionId = session.id;
        const defaults = session.converted.defaults;
        pitch.value = String(defaults.pitch);
        indexRate.value = String(defaults.indexRate);
        protect.value = String(defaults.protect);
        chunk.value = defaults.chunk ? 'chunk' : 'full';
        voiceSelect.value = session.engine.voice || '';
        setSlider(vocalGainDb, session.mix.vocalGainDb);
        setSlider(instGainDb, session.mix.instGainDb);
        setSlider(fadeIn, session.mix.fadeInSec);
        setSlider(fadeOut, session.mix.fadeOutSec);
        mixFormat.value = lastFormatOf(session);
        bgmMode.value = session.mix.withBgm === false ? 'clean' : 'bgm';
        applied = appliedFromSession(session);
        mixKey = `${session.id}:${JSON.stringify(session.mix)}`;
      }
      if (session) {
        // 只在会话或混音参数真的变了时才回填滑杆，避免轮询把用户正在拖的值弹回去。
        const key = `${session.id}:${JSON.stringify(session.mix)}`;
        if (key !== mixKey) {
          mixKey = key;
          setSlider(vocalGainDb, session.mix.vocalGainDb);
          setSlider(instGainDb, session.mix.instGainDb);
          setSlider(fadeIn, session.mix.fadeInSec);
          setSlider(fadeOut, session.mix.fadeOutSec);
          bgmMode.value = session.mix.withBgm === false ? 'clean' : 'bgm';
        }
      }
      if (session) {
        const defaults = session.converted.defaults;
        const pk = `${session.id}:${defaults.pitch}:${defaults.indexRate}:${defaults.protect}`;
        if (pk !== rangeParamsKey) {
          rangeParamsKey = pk;
          rangePitch.value = String(defaults.pitch);
          rangeIndex.value = String(defaults.indexRate);
          rangeProtect.value = String(defaults.protect);
        }
      }
      if (selectedId && peaksKey !== selectedId) void loadPeaks(selectedId);
      if (selectedId && pitchKey !== selectedId) {
        // 换会话先清掉上一个会话的曲线与母带读数，别让旧数据叠在新波形上。
        pitchData = null;
        pitchKey = '';
        pitchLine.textContent = state?.ready ? t.pitchLoading : t.pitchNeedsReady;
        pitchList.textContent = '';
        masterLine.textContent = '';
        drawWave();
        if (state?.ready) void loadPitch(selectedId);
      }
      if (!selectedId) {
        peaks = null;
        peaksKey = '';
        selStart = 0;
        selEnd = 0;
        updateRangeLine();
        drawWave();
      }
      const busy = state?.job?.phase === 'working';
      sessionSelect.disabled = busy || !r.sessions.length;
      vocalGainDb.input.disabled = busy || !session;
      instGainDb.input.disabled = busy || !session;
      fadeIn.input.disabled = busy || !session;
      fadeOut.input.disabled = busy || !session;
      mixFormat.disabled = busy || !session;
      rangePitch.disabled = busy || !session || !state?.ready;
      rangeIndex.disabled = busy || !session || !state?.ready;
      rangeProtect.disabled = busy || !session || !state?.ready;
      rerunRangeBtn.disabled = busy || !session || !state?.ready;
      auditionBtn.disabled = busy || !session || !state?.ready;
      f0Btn.disabled = busy || !session || !state?.ready;
      pitch.disabled = busy;
      indexRate.disabled = busy;
      protect.disabled = busy;
      chunk.disabled = busy;
      voiceSelect.disabled = busy;
      masterPreset.disabled = busy || !session;
      masterFormat.disabled = busy || !session;
      masterBtn.disabled = busy || !session || !state?.ready || !session.outputs.length;
      deleteBtn.disabled = busy || !session;
      cleanupBtn.disabled = busy;
      if (!selectedId) {
        pitchData = null;
        pitchKey = '';
        pitchLine.textContent = t.pitchHint;
        pitchList.textContent = '';
        masterLine.textContent = '';
      } else if (!state?.ready && !pitchData) {
        pitchLine.textContent = t.pitchNeedsReady;
      }
      currentSession = session;
      renderOutputs(r, busy);
      renderAB(session, busy);
      refineDisk.textContent = t.refineDisk(r.days, r.maxGb);
      // 保留策略与配置页同一份设置：轮询时刷新，正在输入的框不抢。
      if (document.activeElement !== daysInput) daysInput.value = String(r.days);
      if (document.activeElement !== gbInput) gbInput.value = String(r.maxGb);
      refineLine.textContent = session
        ? [
            session.engine.kind,
            session.engine.voice ? t.voiceLabel(session.engine.voice) : '',
            session.engine.modelSampleRate ? `${session.engine.modelSampleRate} Hz` : '',
            t.rangeSegments(session.segments.filter((item) => item.kind === 'range').length),
          ].filter(Boolean).join(' · ')
        : t.noSession;
      renderRecent(r);
      renderSegments(session, busy);
      updateCoverButton();
    }

    /** 渲染 20 秒段落列表；每段带独立参数与重做/静音/还原/切分/合并。 */
    function renderSegments(session: RefineSession | null, busy: boolean): void {
      const segments = (session?.segments ?? []).filter((item) => item.kind === 'segment');
      const key = session
        ? `${session.id}:${JSON.stringify(segments.map((item) => [
            item.id, item.start, item.end, item.revision, item.params, item.muted, item.backup,
          ]))}`
        : '';
      if (key === segKey) {
        // 数据没变，只同步禁用状态（引擎就绪、任务进行中会变）。
        for (const el of Array.from(segmentList.querySelectorAll<HTMLButtonElement>('button[data-need-model]'))) {
          el.disabled = busy || !state?.ready;
        }
        return;
      }
      segKey = key;
      segmentList.textContent = '';
      if (!segments.length) {
        segmentLine.textContent = `${t.segmentCutHint} ${t.segmentEmpty}`;
        return;
      }
      segmentLine.textContent = t.segmentCutHint;
      for (const segment of segments) {
        const head = ui.h('div', 'rvc-seg-head');
        head.append(
          ui.h('strong', '', segment.id),
          ui.h('span', '', t.segmentLine(fmtSeconds(segment.start), fmtSeconds(segment.end))),
        );

        const rowPitch = ui.input({ value: String(segment.params.pitch) });
        rowPitch.type = 'number';
        rowPitch.min = '-24';
        rowPitch.max = '24';
        rowPitch.step = '1';
        const rowIndex = ui.input({ value: String(segment.params.indexRate) });
        rowIndex.type = 'number';
        rowIndex.min = '0';
        rowIndex.max = '1';
        rowIndex.step = '0.05';
        const rowProtect = ui.input({ value: String(segment.params.protect) });
        rowProtect.type = 'number';
        rowProtect.min = '0';
        rowProtect.max = '0.5';
        rowProtect.step = '0.01';
        const rowKnobs = ui.h('div', 'rvc-grid');
        rowKnobs.append(ui.field(t.pitch, rowPitch), ui.field(t.indexRate, rowIndex), ui.field(t.protect, rowProtect));

        const redoBtn = ui.button(t.segmentRedo, {
          variant: 'primary', size: 'sm',
          onClick: () => void segmentAction('segmentRedo', segment, {
            pitch: Number(rowPitch.value), indexRate: Number(rowIndex.value), protect: Number(rowProtect.value),
          }),
        });
        redoBtn.dataset.needModel = '1';
        const muteBtn = ui.button(segment.muted ? t.segmentUnmute : t.segmentMute, {
          size: 'sm',
          onClick: () => void segmentAction('segmentMute', segment, { muted: !segment.muted }),
        });
        const revertBtn = ui.button(t.segmentRevert, {
          size: 'sm', onClick: () => void segmentAction('segmentRevert', segment),
        });
        revertBtn.dataset.needModel = '1';
        const cutBtn = ui.button(t.segmentCut, {
          size: 'sm', onClick: () => void segmentAction('segmentCut', segment),
        });
        const mergeBtn = ui.button(t.segmentMerge, {
          size: 'sm', onClick: () => void segmentAction('segmentMerge', segment),
        });
        const auditionBtn = ui.button(t.segmentAudition, {
          size: 'sm', onClick: () => void auditionSegment(segment),
        });
        auditionBtn.dataset.needModel = '1';
        const rowActs = ui.actions();
        rowActs.append(auditionBtn, redoBtn, muteBtn, revertBtn, cutBtn, mergeBtn);

        const status = ui.h('div', 'rvc-detail', t.segmentState(segment.revision, Boolean(segment.muted), Boolean(segment.backup)));
        const row = ui.h('div', 'rvc-seg');
        row.append(head, rowKnobs, rowActs, status);
        segmentList.append(row);
        redoBtn.disabled = busy || !state?.ready;
        revertBtn.disabled = busy || !state?.ready;
        auditionBtn.disabled = busy || !state?.ready;
        muteBtn.disabled = busy;
        cutBtn.disabled = busy;
        mergeBtn.disabled = busy;
      }
    }

    /** 音高体检：首次要跑 RMVPE（几秒）；源人声不变，按会话缓存，不随重做失效。 */
    async function loadPitch(id: string): Promise<void> {
      const seq = ++pitchSeq;
      pitchLine.textContent = t.pitchLoading;
      pitchList.textContent = '';
      try {
        const r = await ctx.invoke<PitchAnalysis>('refinePitch', [id]);
        if (seq !== pitchSeq) return;
        pitchData = r;
        pitchKey = id;
        if (r.voicedRatio <= 0) pitchLine.textContent = t.pitchNoVoice;
        else {
          pitchLine.textContent = [
            t.pitchSummary(Math.round(r.inTuneRatio * 100), r.regionCount),
            t.pitchMeta(r.tuningOffsetCents, r.thresholds.cents, Math.round((r.thresholds.minRegionFrames / r.frameRate) * 1000)),
          ].join(' · ');
        }
        renderPitchRegions();
        drawWave();
      } catch (err) {
        if (seq !== pitchSeq) return;
        pitchData = null;
        // 记住失败的会话，别让 3 秒轮询反复打同一个错误。
        pitchKey = id;
        pitchLine.textContent = t.pitchFailed(errText(err));
        pitchList.textContent = '';
        drawWave();
      }
    }

    function renderPitchRegions(): void {
      pitchList.textContent = '';
      if (!pitchData || !pitchData.regions.length) {
        if (pitchData) pitchList.append(ui.h('div', 'rvc-detail', t.pitchEmpty));
        return;
      }
      pitchList.append(ui.h('div', 'rvc-detail', t.pitchRegions));
      for (const region of pitchData.regions.slice(0, 20)) {
        const row = ui.h('div', 'rvc-pitch-row');
        row.append(
          ui.h('span', '', t.pitchRegion(fmtSeconds(region.start), fmtSeconds(region.end), region.meanCents.toFixed(0))),
          ui.button(t.pitchSelect, { size: 'sm', onClick: () => selectRegion(region) }),
        );
        pitchList.append(row);
      }
      if (pitchData.regionCount > 20) {
        pitchList.append(ui.h('div', 'rvc-detail', t.pitchMore(pitchData.regionCount - 20)));
      }
    }

    /** 点跑调区间 → 选中并滚回「重跑这一段」，参数留给用户自己改。 */
    function selectRegion(region: PitchAnalysis['regions'][number]): void {
      if (!peaks) return;
      selStart = Math.max(0, Math.min(peaks.durationSec, region.start));
      selEnd = Math.max(selStart, Math.min(peaks.durationSec, region.end + 0.05));
      updateRangeLine();
      drawWave();
      msg.textContent = t.pitchJump;
      // 折叠卡默认收起：先展开再滚过去，否则滚到的是一个看不见内容的标题。
      (waveSheet.el as HTMLDetailsElement).open = true;
      waveSheet.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // ---- A/B 试听 ----------------------------------------------------------
    function abEl(which: 'A' | 'B'): HTMLAudioElement {
      return which === 'A' ? abAudioA : abAudioB;
    }

    function abCurrent(): HTMLAudioElement {
      return abEl(abActive);
    }

    function abDuration(): number {
      const a = Number.isFinite(abAudioA.duration) && abAudioA.duration > 0 ? abAudioA.duration : 0;
      const b = Number.isFinite(abAudioB.duration) && abAudioB.duration > 0 ? abAudioB.duration : 0;
      if (a && b) return Math.min(a, b);
      return a || b || 0;
    }

    function abLoopRange(): { start: number; end: number } {
      return abRange(selStart, selEnd, abDuration() || peaks?.durationSec || 0);
    }

    function updateABLine(): void {
      if (!abLoaded) return;
      const range = abLoopRange();
      abLine.textContent = [
        t.abLoaded(abLabelA, abLabelB),
        t.abRange(fmtSeconds(range.start), fmtSeconds(range.end)),
        t.abPosition(abActive, fmtSeconds(abCurrent().currentTime)),
      ].join(' · ');
    }

    function stopABTimer(): void {
      if (abTimer) {
        cancelAnimationFrame(abTimer);
        abTimer = 0;
      }
    }

    function startABTimer(): void {
      stopABTimer();
      const tick = (): void => {
        const el = abCurrent();
        if (el.paused) {
          abTimer = 0;
          updateABLine();
          return;
        }
        const range = abLoopRange();
        // 只在越过终点时跳回起点；每帧无脑写 currentTime 会反复 seek，播起来像慢放。
        const seek = abSeek(el.currentTime, range.start, range.end);
        if (seek !== null) el.currentTime = seek;
        updateABLine();
        abTimer = requestAnimationFrame(tick);
      };
      abTimer = requestAnimationFrame(tick);
    }

    function stopAB(): void {
      stopABTimer();
      abAudioA.pause();
      abAudioB.pause();
      updateABLine();
    }

    /** 切到 A 或 B：先搬 currentTime，再决定是否继续播。 */
    async function abPlay(which: 'A' | 'B'): Promise<void> {
      if (!abLoaded) return;
      // 互斥：A/B 一开声就停掉试听，避免两个播放器叠在一起。
      stopPreview();
      const from = abCurrent();
      const to = abEl(which);
      const playing = !from.paused;
      const range = abLoopRange();
      if (which !== abActive) {
        carryPosition(from, to, abDuration());
        from.pause();
        abActive = which;
      }
      if (!playing && (to.currentTime < range.start || to.currentTime >= range.end)) {
        to.currentTime = range.start;
      }
      await to.play().catch(() => undefined);
      startABTimer();
      updateABLine();
    }

    function waitMeta(el: HTMLAudioElement): Promise<void> {
      if (el.readyState >= 1) return Promise.resolve();
      return new Promise((resolve) => {
        el.addEventListener('loadedmetadata', () => resolve(), { once: true });
        el.addEventListener('error', () => resolve(), { once: true });
      });
    }

    function clockOf(at: string | undefined): string {
      if (!at) return '';
      const date = new Date(at);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
    }

    function abSideLabel(item: SessionOutputFile | undefined): string {
      if (!item) return '';
      return [clockOf(item.at), item.kind === 'master' ? t.masterTag : ''].filter(Boolean).join(' ');
    }

    /** 载入 A/B 两条：A = 所选成品的上一条，B = 所选成品；保留当前播放位置。 */
    async function loadAB(a: SessionOutputFile, b: SessionOutputFile): Promise<void> {
      if (!selectedId) return;
      const token = ++abToken;
      abLoaded = false;
      abLine.textContent = t.abLoading;
      try {
        const [blobA, blobB] = await Promise.all([
          ctx.invokeBinary('refineAudio', [selectedId, a.index, a.kind]),
          ctx.invokeBinary('refineAudio', [selectedId, b.index, b.kind]),
        ]);
        if (token !== abToken) return;
        const wasPlaying = !abCurrent().paused;
        const position = abCurrent().currentTime;
        if (abUrlA) URL.revokeObjectURL(abUrlA);
        if (abUrlB) URL.revokeObjectURL(abUrlB);
        abUrlA = URL.createObjectURL(blobA);
        abUrlB = URL.createObjectURL(blobB);
        abAudioA.src = abUrlA;
        abAudioB.src = abUrlB;
        await Promise.all([waitMeta(abAudioA), waitMeta(abAudioB)]);
        if (token !== abToken) return;
        const duration = abDuration();
        const at = Number.isFinite(position) && position > 0 && position < duration ? position : 0;
        abAudioA.currentTime = at;
        abAudioB.currentTime = at;
        abLabelA = abSideLabel(a);
        abLabelB = abSideLabel(b);
        abABtn.textContent = t.abA(abLabelA ? ` · ${abLabelA}` : '');
        abBBtn.textContent = t.abB(abLabelB ? ` · ${abLabelB}` : '');
        abLoaded = true;
        if (wasPlaying) void abCurrent().play().catch(() => undefined);
        updateABLine();
        if (wasPlaying) startABTimer();
      } catch (err) {
        if (token !== abToken) return;
        abLoaded = false;
        abLine.textContent = `${t.abFailed}：${errText(err)}`;
      }
    }

    function renderAB(session: RefineSession | null, busy: boolean): void {
      const index = outputFiles.findIndex((f) => f.path === pickedOutput);
      const b = index >= 0 ? outputFiles[index] : outputFiles[outputFiles.length - 1];
      const a = index > 0 ? outputFiles[index - 1] : outputFiles.find((f) => f.path !== b?.path);
      const key = session && a && b ? `${session.id}:${a.path}|${b.path}` : '';
      if (key !== abKey) {
        abKey = key;
        if (!session || !a || !b) {
          abToken += 1;
          abLoaded = false;
          stopAB();
          abAudioA.removeAttribute('src');
          abAudioB.removeAttribute('src');
          abLine.textContent = t.abNeedTwo;
        } else {
          void loadAB(a, b);
        }
      }
      const ready = abLoaded && !busy;
      abABtn.disabled = !ready;
      abBBtn.disabled = !ready;
      abSwitchBtn.disabled = !ready;
      abStopBtn.disabled = !ready;
    }

    /** 段落动作：重做/还原走后台（会跑模型），静音/切分/合并只改 session.json。 */
    async function segmentAction(
      method: string,
      segment: RefineSession['segments'][number],
      extra: Record<string, unknown> = {},
    ): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      if ((method === 'segmentRedo' || method === 'segmentRevert') && !state?.ready) {
        msg.textContent = t.notReady;
        msg.classList.add('bad');
        return;
      }
      const payload: Record<string, unknown> = { segmentId: segment.id, format: mixFormat.value, ...extra };
      if (method === 'segmentCut') {
        // 选区中点落在段落内就切在那里，否则切段落中点。
        const middle = (selStart + selEnd) / 2;
        const inside = selEnd - selStart > 0.05 && middle > segment.start + 0.05 && middle < segment.end - 0.05;
        payload.atSec = inside ? middle : (segment.start + segment.end) / 2;
      }
      if (method === 'segmentRedo' || method === 'segmentRevert') {
        settledKey = '';
        mixLine.textContent = '';
        msg.textContent = method === 'segmentRedo' ? t.segmentRedo : t.segmentRevert;
        try {
          await ctx.invoke(method, [selectedId, payload]);
        } catch (err) {
          msg.textContent = errText(err);
          msg.classList.add('bad');
        }
        return;
      }
      try {
        const r = await ctx.invoke<RefineState>(method, [selectedId, payload]);
        refineSeq += 1;
        renderRefine(r);
        if (method === 'segmentMute') {
          msg.textContent = segment.muted ? t.segmentUnmuted(segment.id) : t.segmentMuted(segment.id);
        } else if (method === 'segmentCut') {
          msg.textContent = t.segmentCutDone(segment.id);
        } else {
          msg.textContent = t.segmentMerged(segment.id);
        }
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    async function loadRefine(id = selectedId): Promise<void> {
      const seq = ++refineSeq;
      try {
        // 没选会话时只列清单，不自动挑最新一条：刷新 / 从别的页面进来时原声保持为空。
        const r = await ctx.invoke<RefineState>('refineState', id ? [id] : ['', 'list']);
        if (seq === refineSeq) renderRefine(r);
      } catch (err) {
        if (seq === refineSeq) refineLine.textContent = errText(err);
      }
    }

    function render(s: PanelState, voices: VoiceRow[]): void {
      state = s;
      if (!defaultsApplied && s.defaults) {
        defaultsApplied = true;
        keepSource.checked = s.defaults.keepSource;
        toLibrary.checked = s.defaults.saveToLibrary;
        biliKind.value = s.defaults.panelKind;
        bgmMode.value = s.defaults.panelKind === 'clean' ? 'clean' : 'bgm';
        pitch.value = String(s.defaults.pitch ?? 0);
        indexRate.value = String(s.defaults.indexRate ?? 0.3);
        protect.value = String(s.defaults.protect ?? 0.33);
      }
      paramHint.hidden = !s.defaults;
      if (s.defaults) {
        paramHint.textContent = t.paramDefaults(
          s.defaults.pitch ?? 0,
          s.defaults.indexRate ?? 0.3,
          s.defaults.protect ?? 0.33,
        );
      }
      const fallback = s.defaultVoice ? `${t.defaultVoice}（${t.voiceLabel(s.defaultVoice)}）` : t.defaultVoice;
      fillSelect(ui, voiceSelect, [{ value: '', label: fallback }, ...voices.map((v) => ({ value: v.name, label: t.voiceLabel(v.name) + binTag(v) }))]);
      if (!voiceInitialized) {
        voiceInitialized = true;
        voiceSelect.value = preferredVoice != null && (preferredVoice === '' || voices.some((v) => v.name === preferredVoice))
          ? preferredVoice
          : '';
      } else if (voiceSelect.value !== '' && !voices.some((v) => v.name === voiceSelect.value)) {
        voiceSelect.value = '';
      }
      updateCoverButton();
      sepTier.value = s.highSeparator ? 'high' : 'fast';
      const mb = s.melband;
      if (mb?.phase === 'working') {
        const percent = mb.total ? Math.min(99, Math.floor(((mb.done ?? 0) / mb.total) * 100)) : 0;
        sepLine.hidden = false;
        sepLine.textContent = t.sepDownloading(percent);
      } else if (mb?.phase === 'error' && s.highSeparator) {
        sepLine.hidden = false;
        sepLine.textContent = t.sepDownloadFailed(mb.detail || '');
      } else {
        sepLine.hidden = true;
        sepLine.textContent = '';
      }
      if (!s.ready && s.detail) msg.textContent = s.detail;
      else if (!s.uvr5) msg.textContent = t.coverNeedsUvr;
    }

    /** 切分离档：写配置；选高质量时顺手开始下权重（已装好会立即返回）。 */
    async function setSepTier(value: string): Promise<void> {
      const high = value === 'high';
      try {
        await ctx.setConfig('world:rvc:service', { 'worlds.rvc.highSeparator': high });
        if (state) state.highSeparator = high;
        if (high) {
          sepLine.hidden = false;
          sepLine.textContent = t.sepDownloading(0);
          await ctx.invoke<unknown>('downloadSeparator');
        } else {
          sepLine.hidden = true;
          sepLine.textContent = '';
        }
      } catch (err) {
        sepTier.value = high ? 'fast' : 'high';
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    async function run(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!pickedPath) { msg.textContent = t.pickFileFirst; msg.classList.add('bad'); return; }
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!state?.uvr5) { msg.textContent = t.coverNeedsUvr; msg.classList.add('bad'); return; }
      settledKey = '';
      msg.textContent = t.covering;
      pendingApplied = currentParams();
      coverBtn.disabled = true;
      try {
        // 只传路径：整首歌可能几十 MB，base64 进 invoke 会触发 413。
        await ctx.invoke('cover', [pickedName, '', {
          path: pickedPath,
          voice: voiceSelect.value,
          pitch: Number(pitch.value),
          indexRate: Number(indexRate.value),
          protect: Number(protect.value),
          vocalGain: Number(vocalGainDb.input.value),
          format: mixFormat.value,
          chunk: chunk.value === 'chunk',
          keepSource: keepSource.checked,
          toLibrary: toLibrary.checked,
          withBgm: bgmMode.value !== 'clean',
        }]);
      } catch (err) {
        pendingApplied = null;
        msg.textContent = errText(err);
        msg.classList.add('bad');
        updateCoverButton();
      }
    }

    /** 原地重新翻唱：复用会话里的分轨与原声副本，更新同一个会话目录。 */
    async function rerunCover(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      const summary = summaries.find((s) => s.id === selectedId);
      if (!summary?.source) {
        // 老会话没有原声副本：只能让用户重新选原声，另起一次翻唱。
        if (!pickedPath) { msg.textContent = t.rerunNeedSource; msg.classList.add('bad'); return; }
        return run();
      }
      settledKey = '';
      mixLine.textContent = '';
      msg.textContent = t.covering;
      pendingApplied = currentParams();
      coverBtn.disabled = true;
      try {
        await ctx.invoke('coverRerun', [selectedId, pendingApplied]);
      } catch (err) {
        pendingApplied = null;
        msg.textContent = errText(err);
        msg.classList.add('bad');
        updateCoverButton();
      }
    }

    async function runRemix(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      settledKey = '';
      mixLine.textContent = '';
      msg.textContent = t.remixing;
      pendingApplied = currentParams();
      coverBtn.disabled = true;
      try {
        await ctx.invoke('remix', [selectedId, {
          vocalGainDb: Number(vocalGainDb.input.value),
          instGainDb: Number(instGainDb.input.value),
          fadeInSec: Number(fadeIn.input.value),
          fadeOutSec: Number(fadeOut.input.value),
          format: mixFormat.value,
          withBgm: bgmMode.value !== 'clean',
        }]);
      } catch (err) {
        pendingApplied = null;
        msg.textContent = errText(err);
        msg.classList.add('bad');
        updateCoverButton();
      }
    }

    async function deleteById(id: string): Promise<void> {
      if (!id) return;
      const ok = await ui.confirm({ title: t.sessionDelete, body: t.sessionDeleteConfirm, danger: true });
      if (!ok) return;
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const r = await ctx.invoke<RefineState>('sessionDelete', [id]);
        refineSeq += 1;
        mixKey = '';
        appliedSessionId = '';
        if (selectedId === id) { selectedId = ''; applied = null; }
        renderRefine(r);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    async function deleteCurrent(): Promise<void> {
      await deleteById(selectedId);
    }

    async function cleanup(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const r = await ctx.invoke<RefineState>('cleanupSessions');
        refineSeq += 1;
        mixKey = '';
        renderRefine(r);
        msg.textContent = t.sessionCleaned(r.cleaned ?? 0);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    function fmtSeconds(value: number): string {
      return `${value.toFixed(2)}s`;
    }

    function stopPreviewTimer(): void {
      if (previewTimer) {
        cancelAnimationFrame(previewTimer);
        previewTimer = 0;
      }
    }

    /** 把 min/max 包络画成波形，并在选区上盖一层半透明块。 */
    function drawWave(): void {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round((rect.width || 600) * dpr));
      const height = Math.max(1, Math.round((rect.height || 96) * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const paint = canvas.getContext('2d');
      if (!paint) return;
      paint.clearRect(0, 0, width, height);
      const mid = height / 2;
      paint.strokeStyle = 'rgba(127,127,127,.35)';
      paint.beginPath();
      paint.moveTo(0, mid);
      paint.lineTo(width, mid);
      paint.stroke();
      if (!peaks || !peaks.max.length) return;
      const count = peaks.max.length;
      const bar = width / count;
      paint.fillStyle = 'rgba(120,170,255,.75)';
      for (let i = 0; i < count; i += 1) {
        const high = Math.max(0, Math.min(1, peaks.max[i]));
        const low = Math.max(-1, Math.min(0, peaks.min[i]));
        const top = mid - high * mid * 0.92;
        const bottom = mid - low * mid * 0.92;
        paint.fillRect(i * bar, top, Math.max(1, bar * 0.9), Math.max(1, bottom - top));
      }
      drawPitch(paint, width, height, peaks.durationSec);
      if (peaks.durationSec > 0 && selEnd - selStart > 0.001) {
        const x1 = (selStart / peaks.durationSec) * width;
        const x2 = (selEnd / peaks.durationSec) * width;
        paint.fillStyle = 'rgba(255,196,84,.28)';
        paint.fillRect(x1, 0, Math.max(1, x2 - x1), height);
        paint.strokeStyle = 'rgba(255,196,84,.9)';
        paint.strokeRect(x1 + 0.5, 0.5, Math.max(1, x2 - x1 - 1), height - 1);
      }
    }

    /**
     * 在波形上叠音高曲线（对数频率轴 70–1200 Hz）和底部偏差热力条。
     * 热力条颜色：|偏差| <15 绿、15–35 黄、≥35 红；跑调区间再盖一层红框。
     */
    function drawPitch(paint: CanvasRenderingContext2D, width: number, height: number, duration: number): void {
      if (!pitchData || !duration || !pitchData.curve.times.length) return;
      const { times, f0, cents } = pitchData.curve;
      const count = times.length;
      const bucket = width / count;
      const stripTop = height * 0.86;
      const stripHeight = Math.max(2, height * 0.11);
      for (let i = 0; i < count; i += 1) {
        const value = cents[i];
        if (value === null) continue;
        const abs = Math.abs(value);
        paint.fillStyle = abs < 15 ? 'rgba(94,214,139,.55)' : abs < pitchData.thresholds.cents ? 'rgba(255,196,84,.6)' : 'rgba(255,96,96,.72)';
        paint.fillRect(times[i] / duration * width, stripTop, Math.max(1, bucket), stripHeight);
      }

      const lo = Math.log2(70);
      const hi = Math.log2(1200);
      const yOf = (hz: number): number => {
        const v = Math.log2(Math.max(70, Math.min(1200, hz)));
        return (1 - (v - lo) / (hi - lo)) * (stripTop - 8) + 4;
      };
      paint.strokeStyle = 'rgba(126,231,255,.9)';
      paint.lineWidth = Math.max(1, window.devicePixelRatio || 1);
      paint.beginPath();
      let pen = false;
      for (let i = 0; i < count; i += 1) {
        if (!(f0[i] > 0)) {
          pen = false;
          continue;
        }
        const x = times[i] / duration * width;
        const y = yOf(f0[i]);
        if (pen) paint.lineTo(x, y);
        else paint.moveTo(x, y);
        pen = true;
      }
      paint.stroke();

      for (const region of pitchData.regions) {
        const x1 = Math.max(0, Math.min(width, region.start / duration * width));
        const x2 = Math.max(0, Math.min(width, region.end / duration * width));
        if (x2 - x1 < 0.5) continue;
        paint.fillStyle = 'rgba(255,96,96,.13)';
        paint.fillRect(x1, 0, x2 - x1, height);
        paint.fillStyle = 'rgba(255,96,96,.95)';
        paint.fillRect(x1, 0, Math.max(1, x2 - x1), Math.max(2, height * 0.03));
      }
      paint.lineWidth = 1;
    }

    function updateRangeLine(): void {
      if (!selectedId) {
        rangeLine.textContent = t.rangeNoSession;
        return;
      }
      if (!peaks) {
        rangeLine.textContent = t.rangeLoading;
        return;
      }
      if (selEnd - selStart < 0.05) {
        rangeLine.textContent = t.rangeNoSelection;
        return;
      }
      rangeLine.textContent = t.rangeSelection(fmtSeconds(selStart), fmtSeconds(selEnd), fmtSeconds(selEnd - selStart));
    }

    async function loadPeaks(id: string): Promise<void> {
      const seq = ++peaksSeq;
      try {
        const r = await ctx.invoke<PeaksResp>('refinePeaks', [id]);
        if (seq !== peaksSeq) return;
        peaks = r;
        peaksKey = id;
        if (selEnd > r.durationSec) {
          selEnd = r.durationSec;
          if (selStart > selEnd) selStart = 0;
        }
        updateRangeLine();
        drawWave();
      } catch (err) {
        if (seq !== peaksSeq) return;
        peaks = null;
        // 记住这次 id，别让 3 秒轮询反复重试同一个失败请求；切会话或重跑后会重新拉。
        peaksKey = id;
        rangeLine.textContent = errText(err);
        drawWave();
      }
    }

    function timeAt(event: PointerEvent): number {
      const rect = canvas.getBoundingClientRect();
      const duration = peaks?.durationSec ?? 0;
      if (rect.width <= 0) return 0;
      const ratio = (event.clientX - rect.left) / rect.width;
      return Math.min(duration, Math.max(0, ratio * duration));
    }

    let dragging = false;
    let dragAnchor = 0;
    canvas.addEventListener('pointerdown', (event) => {
      if (!peaks) return;
      dragging = true;
      dragAnchor = timeAt(event);
      selStart = dragAnchor;
      selEnd = dragAnchor;
      canvas.setPointerCapture(event.pointerId);
      updateRangeLine();
      drawWave();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const now = timeAt(event);
      selStart = Math.min(dragAnchor, now);
      selEnd = Math.max(dragAnchor, now);
      updateRangeLine();
      drawWave();
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!dragging) return;
      dragging = false;
      const now = timeAt(event);
      selStart = Math.min(dragAnchor, now);
      selEnd = Math.max(dragAnchor, now);
      // 单击给 0.5 秒默认选区，省得「点了没反应」。
      if (peaks && selEnd - selStart < 0.05) selEnd = Math.min(peaks.durationSec, selStart + 0.5);
      updateRangeLine();
      drawWave();
    });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
    window.addEventListener('resize', drawWave);
    ctx.own(disposable(() => { window.removeEventListener('resize', drawWave); }));

    /** 还原上一次选段重跑：有备份就逐样本写回，没有就提示先重跑。 */
    async function revertLastRange(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      if (!lastRangeSegId) { msg.textContent = t.rangeRevertNone; msg.classList.add('bad'); return; }
      settledKey = '';
      mixLine.textContent = '';
      msg.textContent = t.rangeRevert;
      rangeRevertBtn.disabled = true;
      try {
        await ctx.invoke('segmentRevert', [selectedId, { segmentId: lastRangeSegId, format: mixFormat.value }]);
        revertedRanges.add(lastRangeSegId);
        lastRangeSegId = '';
        msg.textContent = t.rangeRevert;
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        rangeRevertBtn.disabled = !lastRangeSegId;
      }
    }

    async function runRange(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      if (!peaks || selEnd - selStart < 0.05) { msg.textContent = t.rangeSelectFirst; msg.classList.add('bad'); return; }
      settledKey = '';
      mixLine.textContent = '';
      msg.textContent = t.rangeRunning;
      rerunRangeBtn.disabled = true;
      rangeRevertBtn.disabled = true;
      try {
        await ctx.invoke('rangeConvert', [selectedId, {
          startSec: selStart,
          endSec: selEnd,
          pitch: Number(rangePitch.value),
          indexRate: Number(rangeIndex.value),
          protect: Number(rangeProtect.value),
          format: mixFormat.value,
        }]);
        // 任务跑完后 settle() 会重读会话，届时这一段带 backup，「还原」自动亮起。
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        rerunRangeBtn.disabled = !state?.ready;
      }
    }

    /** 试听播放层的 40 ms 淡出：只作用在播放上，不写进文件，避免段边界「啪」一声。 */
    const PREVIEW_FADE_SEC = 0.04;
    let previewGain: GainNode | null = null;
    let previewCtx: AudioContext | null = null;

    function previewGainNode(): GainNode | null {
      if (previewGain) return previewGain;
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        previewCtx = new Ctor();
        previewGain = previewCtx.createGain();
        previewCtx.createMediaElementSource(audio).connect(previewGain).connect(previewCtx.destination);
      } catch {
        previewGain = null;
        return null;
      }
      return previewGain;
    }

    /** 互斥：试听一开始就停掉 A/B，两个播放器不再同时出声。 */
    function stopPreview(): void {
      stopPreviewTimer();
      audio.pause();
      if (previewGain) previewGain.gain.value = 1;
    }

    /** 在同一个 audio 元素上只播 [from,to)，末尾 40 ms 线性淡出。 */
    function playWindow(from: number, to: number): void {
      stopAB();
      const gain = previewGainNode();
      if (gain && previewCtx) {
        gain.gain.cancelScheduledValues(previewCtx.currentTime);
        gain.gain.setValueAtTime(1, previewCtx.currentTime);
      }
      if (previewCtx) void previewCtx.resume().catch(() => undefined);
      audio.currentTime = Math.max(0, from);
      void audio.play().catch(() => undefined);
      stopPreviewTimer();
      const tick = (): void => {
        if (audio.paused) {
          if (gain) gain.gain.value = 1;
          previewTimer = 0;
          return;
        }
        const remain = to - audio.currentTime;
        if (gain) gain.gain.value = remain <= PREVIEW_FADE_SEC ? Math.max(0, remain / PREVIEW_FADE_SEC) : 1;
        if (remain <= 0) {
          audio.pause();
          audio.currentTime = Math.max(0, from);
          if (gain) gain.gain.value = 1;
          previewTimer = 0;
          return;
        }
        previewTimer = requestAnimationFrame(tick);
      };
      previewTimer = requestAnimationFrame(tick);
    }

    /** 用当前滑杆参数混一条临时成品（不写 outputs、不改会话）。 */
    async function auditionPreview(from: number, to: number): Promise<void> {
      msg.textContent = t.previewing;
      const r = await ctx.invoke<JobResult>('refinePreview', [selectedId, {
        vocalGainDb: Number(vocalGainDb.input.value),
        instGainDb: Number(instGainDb.input.value),
        fadeInSec: Number(fadeIn.input.value),
        fadeOutSec: Number(fadeOut.input.value),
        format: 'wav',
      }]);
      if (r.error || !r.base64) throw new Error(r.error ?? '没有拿到音频');
      const blob = blobFromBase64(r.base64, r.mime ?? 'audio/wav');
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      audio.src = url;
      audio.hidden = false;
      msg.textContent = '';
      if (audio.readyState >= 1) playWindow(from, to);
      else audio.addEventListener('loadedmetadata', () => playWindow(from, to), { once: true });
    }

    /** 用当前滑杆参数混出临时成品，只播放选区那一段。 */
    async function auditionRange(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      if (!peaks || selEnd - selStart < 0.05) { msg.textContent = t.rangeSelectFirst; msg.classList.add('bad'); return; }
      const from = selStart;
      const to = selEnd;
      auditionBtn.disabled = true;
      try {
        await auditionPreview(from, to);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      } finally {
        auditionBtn.disabled = !(state?.ready && selectedId);
      }
    }

    /** 段落试听：前后各留 0.3 秒上下文，播放层 40 ms 淡出，不写 outputs。 */
    async function auditionSegment(segment: RefineSession['segments'][number]): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      const { from, to } = segmentWindow(segment.start, segment.end, peaks?.durationSec ?? 0);
      // 选区跟着这一段走，波形高亮与 A/B 循环都落到同一个窗口。
      selStart = from;
      selEnd = to;
      updateRangeLine();
      drawWave();
      try {
        await auditionPreview(from, to);
        msg.textContent = t.segmentAuditionLine(fmtSeconds(segment.start), fmtSeconds(segment.end));
      } catch (err) {
        msg.textContent = `${t.segmentAuditionFailed}：${errText(err)}`;
        msg.classList.add('bad');
      }
    }

    /** 导出音高曲线：worker 只读分轨跑 RMVPE，CSV 直接给浏览器下载。 */
    async function exportF0(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      msg.textContent = t.f0Running;
      f0Btn.disabled = true;
      try {
        const r = await ctx.invoke<{
          name: string; csv: string; frames: number; frameRate: number; durationSec: number; savedPath: string;
        }>('exportF0', [selectedId]);
        const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        dl.href = url;
        dl.download = r.name || 'f0.csv';
        dl.hidden = false;
        msg.textContent = t.f0Done(r.frames, r.frameRate, r.savedPath);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      } finally {
        f0Btn.disabled = !(state?.ready && selectedId);
      }
    }

    /** 一键母带：源永远是最新成品，结果另存；处理完由 settle 接音频。 */
    async function runMaster(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!selectedId) { msg.textContent = t.noSession; msg.classList.add('bad'); return; }
      settledKey = '';
      masterLine.textContent = '';
      msg.textContent = t.mastering;
      masterBtn.disabled = true;
      try {
        await ctx.invoke('master', [selectedId, {
          targetLufs: Number(masterPreset.value),
          format: masterFormat.value,
        }]);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      } finally {
        masterBtn.disabled = !(state?.ready && selectedId);
      }
    }

    async function settle(s: PanelState): Promise<void> {
      const job = s.job;
      if (!job || (job.kind !== 'cover' && job.kind !== 'remix' && job.kind !== 'range' && job.kind !== 'master')) return;
      if (job.phase === 'working') {
        msg.textContent = job.detail || (job.kind === 'range' ? t.rangeRunning : job.kind === 'remix' ? t.remixing : job.kind === 'master' ? t.mastering : t.covering);
        msg.classList.remove('bad');
        return;
      }
      const key = `${job.kind}:${job.phase}:${job.at}`;
      if (job.phase === 'error') {
        if (settledKey !== key) {
          settledKey = key;
          pendingApplied = null;
          msg.textContent = job.error || (job.kind === 'range' ? '选段重跑失败' : job.kind === 'remix' ? '重新混音失败' : job.kind === 'master' ? t.masterFailed : '翻唱失败');
          msg.classList.add('bad');
          biliLine.textContent = '';
          biliBtn.disabled = false;
        }
        return;
      }
      if (!s.resultReady || settledKey === key) return;
      settledKey = key;
      // 这次任务多半新增了一条成品：让选择器回到最新一条，播放器/下载随选择器重载。
      autoPickOutput = true;
      pickedOutput = '';
      outputLoadKey = '';
      // 任务真的跑完了才算「生效」：改了又改回去的判定从这里重新起步。
      if (pendingApplied && (job.kind === 'cover' || job.kind === 'remix')) {
        applied = pendingApplied;
        pendingApplied = null;
        updateCoverButton();
      }
      const r = await ctx.invoke<JobResult>('takeResult');
      if (r.error || !r.base64) {
        msg.textContent = r.error ?? '没有拿到音频';
        msg.classList.add('bad');
        biliLine.textContent = '';
        biliBtn.disabled = false;
        return;
      }
      msg.textContent = '';
      const blob = blobFromBase64(r.base64, r.mime ?? 'audio/wav');
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      audio.src = url;
      audio.hidden = false;
      if (job.kind === 'range') {
        const done = s.lastRange;
        dl.href = url;
        dl.download = done
          ? `refine-${done.start.toFixed(1)}-${done.end.toFixed(1)}.${done.format}`
          : `refine.${mixFormat.value}`;
        dl.hidden = false;
        mixLine.textContent = done
          ? t.rangeDone(
              ui.fmt.duration(done.ms),
              ui.fmt.bytes(done.bytes),
              fmtSeconds(done.start),
              fmtSeconds(done.end),
              done.savedPath ?? r.savedPath ?? '',
            )
          : '';
        // conv.wav 已经换过一段，波形要重新拉；选区保留，方便连续微调。
        peaksKey = '';
        void loadPeaks(selectedId);
        // 段落参数/备份状态也变了，重读一次 session。
        void loadRefine(selectedId);
        return;
      }
      if (job.kind === 'remix') {
        const done = s.lastMix;
        dl.href = url;
        dl.download = `remix.${done?.format ?? mixFormat.value}`;
        dl.hidden = false;
        mixLine.textContent = done
          ? t.remixDone(ui.fmt.duration(done.ms), ui.fmt.bytes(done.bytes), done.savedPath ?? r.savedPath ?? '')
          : '';
        return;
      }
      if (job.kind === 'master') {
        const done = s.lastMaster;
        dl.href = url;
        dl.download = `master-${done?.targetLufs ?? masterPreset.value}.${done?.format ?? masterFormat.value}`;
        dl.hidden = false;
        masterLine.textContent = done
          ? `${t.masterDone(
              done.inputLufs.toFixed(1),
              done.outputLufs.toFixed(1),
              done.outputTruePeakDb.toFixed(2),
              done.savedPath ?? '',
            )} · ${t.masterLimit(done.gainDb.toFixed(1), done.limitedDb.toFixed(1))}`
          : '';
        // 母带记到 session.masters，重读一次把历史补齐。
        void loadRefine(selectedId);
        return;
      }
      dl.href = url;
      dl.download = `cover.${mixFormat.value}`;
      dl.hidden = false;
      biliLine.textContent = '';
      const done = s.lastCover;
      if (done) {
        const stages = done.stages
          ? t.coverStages(
              ui.fmt.duration(done.stages.separate ?? 0),
              ui.fmt.duration(done.stages.convert ?? 0),
              ui.fmt.duration(done.stages.mix ?? 0),
            )
          : '';
        resultLine.textContent = [
          t.coverDone(ui.fmt.duration(done.ms), ui.fmt.bytes(done.bytes), stages),
          done.separator === 'mel_band' ? t.sepUsedHigh : '',
          done.separatorNote ? t.sepFallback(done.separatorNote) : '',
          done.peakScale !== undefined && done.peakScale < 1 ? t.peakScaled : '',
          done.library ? (done.library.duplicate
            ? t.libraryDuplicate(done.library.title)
            : t.libraryAutoSaved(done.library.title)) : '',
          done.libraryError ? t.libraryAutoFailed(done.libraryError) : '',
          done.savedPath ? t.saved(done.savedPath) : '',
        ].filter(Boolean).join(' · ');
        if (done.sessionId) selectedId = done.sessionId;
        // 这次上传已经进（或按勾选没进）会话；清掉文件输入，音频处改显示当前工程的原声。
        pickedPath = null;
        pickedName = '';
        bindSource();
      }
    }

    const refresh = async (): Promise<void> => {
      try {
        const [s, v] = await Promise.all([ctx.invoke<PanelState>('state'), ctx.invoke<VoicesResp>('voices')]);
        render(s, v.voices ?? []);
        await settle(s);
        await Promise.all([loadRefine(selectedId), loadLibrary()]);
      } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 3000);
  },
};

// ---------------------------------------------------------------------------
// 音色
// ---------------------------------------------------------------------------

const voicesPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let voices: VoiceRow[] = [];
    let defaultVoice = '';
    let armedDelete = '';

    const sheet = ui.section(t.voicesTitle, t.voicesHint);
    const list = ui.h('div');
    const addBtn = ui.button(t.addVoice, { variant: 'primary', size: 'sm', onClick: () => openForm() });
    const refreshBtn = ui.button(t.voiceRefresh, { size: 'sm', onClick: () => void load() });
    const acts = ui.actions();
    acts.append(addBtn, refreshBtn);

    const form = ui.h('div');
    form.hidden = true;
    const fName = ui.input({ placeholder: t.voiceNamePh });
    const fPth = ui.input({});
    fPth.type = 'file';
    fPth.accept = '.pth';
    const fIndex = ui.input({});
    fIndex.type = 'file';
    fIndex.accept = '.index';
    const saveBtn = ui.button(t.saveVoice, { variant: 'primary', size: 'sm', onClick: () => void save() });
    const cancelBtn = ui.button(t.cancelAdd, { size: 'sm', onClick: () => closeForm() });
    const formActs = ui.actions();
    formActs.append(saveBtn, cancelBtn);
    form.append(
      ui.h('div', 'rvc-detail', t.voiceFormHint),
      ui.field(t.voiceName, fName),
      ui.field(t.pthFile, fPth),
      ui.field(t.indexFile, fIndex),
      formActs,
    );

    sheet.append(list, acts, ui.h('div', 'rvc-detail', t.voiceHint), form);
    ctx.root.append(sheet, msg);

    function openForm(): void {
      fName.value = '';
      fPth.value = '';
      fIndex.value = '';
      form.hidden = false;
      addBtn.hidden = true;
      msg.textContent = '';
      msg.classList.remove('bad');
    }

    function closeForm(): void {
      form.hidden = true;
      addBtn.hidden = false;
      fPth.value = '';
      fIndex.value = '';
      msg.textContent = '';
      msg.classList.remove('bad');
    }

    /** 大索引不能一次 btoa：按 4 MB 分块传到临时文件，最后再改名为正式音色。 */
    async function uploadVoiceFile(
      file: File,
      kind: 'pth' | 'index',
      uploadId: string,
      onProgress?: (done: number, total: number) => void,
    ): Promise<void> {
      if (!file.size) throw new Error(`${file.name} 是空文件`);
      const chunkSize = 4 * 1024 * 1024;
      const total = Math.max(1, Math.ceil(file.size / chunkSize));
      for (let index = 0; index < total; index += 1) {
        const slice = file.slice(index * chunkSize, (index + 1) * chunkSize);
        const b64 = toBase64(new Uint8Array(await slice.arrayBuffer()));
        const res = await ctx.invoke<{ error?: string }>('uploadVoiceChunk', [uploadId, kind, index, total, b64]);
        if (res.error) throw new Error(res.error);
        onProgress?.(index + 1, total);
      }
    }

    async function save(): Promise<void> {
      const name = fName.value.trim();
      const pth = fPth.files?.[0];
      if (!name || !pth) {
        msg.textContent = t.voiceFormHint;
        msg.classList.add('bad');
        return;
      }
      const normalized = name.replace(/\.(pth|index)$/i, '').trim().toLowerCase();
      if (voices.some((voice) => voice.name.toLowerCase() === normalized)) {
        msg.textContent = t.voiceExists;
        msg.classList.add('bad');
        return;
      }
      msg.textContent = '';
      msg.classList.remove('bad');
      const busy = ui.busy(t.saveVoice, name);
      const uploadId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        await uploadVoiceFile(pth, 'pth', uploadId, (done, total) => {
          msg.textContent = `${pth.name} ${Math.round((done / total) * 100)}%`;
        });
        const index = fIndex.files?.[0];
        if (index) {
          await uploadVoiceFile(index, 'index', uploadId, (done, total) => {
            msg.textContent = `${index.name} ${Math.round((done / total) * 100)}%`;
          });
        }
        const res = await ctx.invoke<ImportResp>('finishVoice', [name, uploadId, index ? uploadId : '']);
        if (res.error) throw new Error(res.error);
        ui.toast(t.importOk(res.name ?? name));
        closeForm();
        await load();
      } catch (err) {
        await ctx.invoke('cancelVoiceUpload', [uploadId]).catch(() => undefined);
        msg.textContent = errText(err);
        msg.classList.add('bad');
      } finally {
        busy.dispose();
      }
    }

    async function useVoice(name: string): Promise<void> {
      try {
        await ctx.setConfig('world:rvc', { 'worlds.rvc.voice': name });
        ui.toast(name);
        await load();
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    async function remove(name: string): Promise<void> {
      if (armedDelete !== name) {
        armedDelete = name;
        msg.textContent = t.confirmDelete;
        msg.classList.remove('bad');
        render();
        return;
      }
      armedDelete = '';
      try {
        const res = await ctx.invoke<ImportResp>('deleteVoice', [name]);
        if (res.error) throw new Error(res.error);
        ui.toast(t.voiceDeleted(res.name ?? name));
        await load();
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    function render(): void {
      list.textContent = '';
      if (!voices.length) { list.append(ui.h('div', 'rvc-detail', t.noVoiceHint)); return; }
      for (const v of voices) {
        const line = row(list, ui, t.voiceLabel(v.name) + binTag(v));
        const using = v.name === defaultVoice;
        setPill(line.pill, using ? t.using : '', using ? 'on' : 'off');
        const binText = v.bin
          ? `${t.binLabel} ${v.bin} bin${v.f0Max ? ` · ≤${Math.round(v.f0Max)} Hz` : ''}`
          : t.binUnknown;
        line.detail.textContent = [binText, ui.fmt.bytes(v.bytes), v.index ? t.indexHas(ui.fmt.bytes(v.index)) : t.indexNone].join(' · ');
        if (!using) line.acts.append(ui.button(t.setDefault, { size: 'sm', onClick: () => void useVoice(v.name) }));
        line.acts.append(ui.button(armedDelete === v.name ? t.confirmDelete : t.deleteVoice, {
          size: 'sm',
          onClick: () => void remove(v.name),
        }));
      }
    }

    async function load(): Promise<void> {
      try {
        const [s, v] = await Promise.all([ctx.invoke<PanelState>('state'), ctx.invoke<VoicesResp>('voices')]);
        voices = v.voices ?? [];
        defaultVoice = s.defaultVoice;
        render();
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    }

    void load();
    ctx.interval(() => void load(), 5000);
  },
};

const bundle: WebUiClientBundle = {
  panels: {
    cover: coverPanel,
    convert: convertPanel,
    voices: voicesPanel,
    service: servicePanel,
  },
};
export default bundle;
