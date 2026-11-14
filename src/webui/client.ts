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
import { coverAction, coverDirty, type CoverAction, type CoverParams } from './dirty.ts';
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
  source: { file: string; bytes: number } | null;
  outputFiles: Array<{ format: string; path: string; bytes: number; at: string }>;
}
interface SessionMix {
  vocalGainDb: number;
  instGainDb: number;
  rmsRatio: number;
  rmsFrozen: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  peakScale: number;
}
interface RefineSession {
  id: string;
  engine: { kind: string; voice: string; modelSampleRate: number };
  source: { durationSec: number; inputPeak: number; format: string; file?: string; bytes?: number };
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
  outputs: Array<{ format: string; path: string; at: string }>;
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
interface RefineState {
  root: string;
  keep: boolean;
  days: number;
  maxGb: number;
  active: string | null;
  sessions: SessionSummary[];
  session: RefineSession | null;
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
  venv: JobState;
  uvr: JobState;
  install: JobState;
  voiceCount: number;
  defaultVoice: string;
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
}
interface VoicesResp {
  voices: VoiceRow[];
}
interface ImportResp {
  error?: string;
  name?: string;
}

type Tone = 'on' | 'off' | 'warn' | 'bad';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 大块二进制转 base64：分块拼，别把整个文件塞进一次调用。 */
function toBase64(buf: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

const toneOf = (phase: string): Tone =>
  phase === 'ready' ? 'on' : phase === 'working' || phase === 'starting' ? 'warn' : phase === 'error' ? 'bad' : 'off';

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
  const same = select.options.length === items.length && items.every((o, i) => select.options[i]?.value === o.value);
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
    const voiceRow = row(sheet, ui, t.rowVoice);
    const apiRow = row(sheet, ui, t.rowApi);

    const uvr5Warn = ui.msgline(t.uvr5Off, true);
    const bar = ui.progress({ tone: 'warn' });
    bar.el.hidden = true;
    sheet.append(bar.el, uvr5Warn, ui.h('div', 'rvc-detail', t.voiceNotice));

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
      // 分离模型
      setPill(
        uvrRow.pill,
        s.uvr.phase === 'working' ? `${t.working} ${s.uvr.total ? `${Math.round((s.uvr.done ?? 0) / s.uvr.total * 100)}%` : ''}` : t[phaseKey(s.uvr.phase)],
        toneOf(s.uvr.phase),
      );
      uvrRow.detail.textContent = s.uvr.detail ?? `${ui.fmt.bytes(s.uvr.done)} / ${ui.fmt.bytes(s.uvr.total)}`;
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
    ctx.own(disposable(() => { if (url) URL.revokeObjectURL(url); }));

    const sheet = ui.section(t.convertTitle, t.convertHint);
    const fileInput = ui.input({});
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.wav,.flac,.mp3,.ogg,.m4a';
    const voiceSelect = ui.select({ options: [] });

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

    const convertBtn = ui.button(t.convert, { variant: 'primary', size: 'sm', onClick: () => void run() });
    const acts = ui.actions();
    acts.append(convertBtn);

    sheet.append(
      ui.field(t.file, fileInput),
      ui.h('div', 'rvc-detail', t.fileHint),
      ui.field(t.voice, voiceSelect),
      knobs,
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
      fillSelect(ui, voiceSelect, [{ value: '', label: fallback }, ...voices.map((v) => ({ value: v.name, label: t.voiceLabel(v.name) }))]);
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
    let file: File | null = null;
    let url: string | null = null;
    ctx.own(disposable(() => { if (url) URL.revokeObjectURL(url); }));

    const sheet = ui.section(t.coverTitle, t.coverHint);
    const fileInput = ui.input({});
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.wav,.flac,.mp3,.ogg,.m4a';
    const keepSource = ui.h('input') as HTMLInputElement;
    keepSource.type = 'checkbox';
    keepSource.checked = true;
    const sourceLine = ui.h('div', 'rvc-detail');
    const voiceSelect = ui.select({ options: [] });

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

    // 第二组：只影响混音。首次出结果前隐藏，但仍参与「上次生效值」比对。
    const vocalGainDb = slider(t.vocalGain, -12, 12, 1);
    const instGainDb = slider(t.instGain, -12, 12, 1);
    const fadeIn = slider(t.fadeIn, 0, 10, 0.5);
    const fadeOut = slider(t.fadeOut, 0, 10, 0.5);
    const mixFormat = ui.select({ value: 'wav', options: [{ value: 'wav' }, { value: 'mp3' }] });
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
      ui.h('div', 'rvc-detail', t.coverStagesHint),
      ui.field(t.file, fileInput),
      ui.h('div', 'rvc-detail', t.fileHint),
      sourceLine,
      ui.field(t.keepSource, keepSource),
      ui.h('div', 'rvc-detail', t.keepSourceHint),
      ui.field(t.voice, voiceSelect),
      ui.h('div', 'rvc-detail', t.coverInferHint),
      inferKnobs,
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
    let mixKey = '';
    let settledKey = '';
    /** 上次生效的翻唱参数与它对应的会话：按钮文案与动作都按这两组的 dirty 决定。 */
    let applied: CoverParams | null = null;
    let appliedSessionId = '';
    let pendingApplied: CoverParams | null = null;
    /** 最近一次 refineState 的会话摘要；菜单「另存」要知道原声副本在不在。 */
    let summaries: SessionSummary[] = [];
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
    let abOutputs: RefineSession['outputs'] = [];

    const refineSheet = ui.section(t.refineTitle, t.refineHint);
    const sessionSelect = ui.select({
      options: [],
      onChange: (value) => chooseSession(value),
    });

    // 选段重跑：波形上拖出 [a,b)，只重渲这一段，区间外样本保持不变。
    const waveSheet = ui.section(t.rangeTitle, t.rangeHint);
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
    const auditionBtn = ui.button(t.rangeAudition, { size: 'sm', onClick: () => void auditionRange() });
    const f0Btn = ui.button(t.exportF0, { size: 'sm', onClick: () => void exportF0() });
    const rangeActs = ui.actions();
    rangeActs.append(rerunRangeBtn, auditionBtn, f0Btn);
    // 音高体检：曲线与热力条画在同一个波形画布上，下面只列跑调区间。
    const pitchLine = ui.h('div', 'rvc-detail', t.pitchHint);
    const pitchList = ui.h('div', 'rvc-pitch-regions');
    waveSheet.append(canvas, rangeLine, pitchLine, pitchList, rangeKnobs, rangeActs);

    // 一键母带：另存，不覆盖最近一次混音。
    const masterSheet = ui.section(t.masterTitle, t.masterHint);
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
    masterSheet.append(ui.field(t.masterPreset, masterPreset), ui.field(t.format, masterFormat), masterActs, masterLine);

    // 「重新混音」已经并到上面的主按钮（按 dirty 决定只重混还是先重跑变声），这里只留会话与清理。
    const deleteBtn = ui.button(t.sessionDelete, { size: 'sm', onClick: () => void deleteCurrent() });
    const cleanupBtn = ui.button(t.sessionCleanup, { size: 'sm', onClick: () => void cleanup() });
    const refineActs = ui.actions();
    refineActs.append(deleteBtn, cleanupBtn);

    const refineDisk = ui.h('div', 'rvc-detail');
    const refineLine = ui.h('div', 'rvc-detail');
    const mixLine = ui.h('div', 'rvc-detail');
    refineSheet.append(ui.field(t.session, sessionSelect), refineActs, refineDisk, refineLine, mixLine);

    // 顶部「最近翻唱」：原声/成品、体积、时间、时长、音色，以及继续编辑 / 另存 / 删除与保留策略。
    const recentSheet = ui.foldSheet('rvc-cover-recent', { title: t.recentTitle, desc: t.recentHint });
    const recentList = ui.h('div');
    const daysInput = ui.input({ type: 'number', value: '7' });
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
    const retentionRow = ui.h('div', 'rvc-grid');
    retentionRow.append(ui.field(t.retentionDays, daysInput), ui.field(t.retentionGb, gbInput));
    const retentionActs = ui.actions();
    retentionActs.append(retentionSave);
    recentSheet.body.append(
      recentList,
      ui.h('div', 'rvc-detail', t.retentionHint),
      retentionRow,
      retentionActs,
      retentionLine,
    );

    // 段落级参数：默认 20 秒网格，每段独立重做/静音/还原/切分/合并。
    const segmentSheet = ui.section(t.segmentTitle, t.segmentHint);
    const segmentList = ui.h('div', 'rvc-segments');
    const segmentLine = ui.h('div', 'rvc-detail', t.segmentCutHint);
    segmentSheet.append(segmentList, segmentLine);

    // A/B 试听：两个隐藏 audio，各自持有一条成品；切换只搬 currentTime。
    const abSheet = ui.section(t.abTitle, t.abHint);
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
    abSheet.append(abActs, abLine);

    ctx.root.append(recentSheet.el, sheet, audio, resultLine, dl, refineSheet, waveSheet, masterSheet, segmentSheet, abSheet, abAudioA, abAudioB, msg);
    ctx.own(disposable(() => {
      stopPreview();
      stopAB();
      if (previewCtx) void previewCtx.close();
      if (abUrlA) URL.revokeObjectURL(abUrlA);
      if (abUrlB) URL.revokeObjectURL(abUrlB);
    }));

    fileInput.addEventListener('change', () => {
      file = fileInput.files?.[0] ?? null;
      msg.textContent = '';
      msg.classList.remove('bad');
      if (file) resultLine.textContent = `${file.name} · ${ui.fmt.bytes(file.size)}`;
      bindSource();
      updateCoverButton();
    });

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
      const update = (): void => { readout.textContent = String(Number(input.value)); };
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
        format: mixFormat.value,
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
      };
    }

    function actionOf(): CoverAction {
      // 新选的文件优先：那是另一首歌，点按钮会新建一次翻唱，不走原地重跑。
      if (file) return 'cover';
      if (!selectedId || !applied) return 'cover';
      return coverAction(coverDirty(currentParams(), applied), true);
    }

    /** 音频输入下方的「当前音源」：新选的文件优先，其次会话原声，最后提示未选。 */
    function bindSource(): void {
      if (file) {
        sourceLine.textContent = t.sourcePicked(file.name, ui.fmt.bytes(file.size));
        return;
      }
      const summary = selectedId ? summaries.find((s) => s.id === selectedId) : undefined;
      sourceLine.textContent = summary?.source
        ? t.sourceFromSession(summary.source.file, ui.fmt.bytes(summary.source.bytes))
        : selectedId ? t.sourceMissing : '';
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
      const needSource = (action === 'rerun' || action === 'rerunMix') && !summary?.source;
      dirtyLine.textContent = needSource ? t.needSource
        : !selectedId ? ''
          : dirty.inference && dirty.mix ? t.coverDirtyBoth
            : dirty.inference ? t.coverDirtyInfer
              : dirty.mix ? t.coverDirtyMix
                : '';
      const busy = state?.job?.phase === 'working';
      coverBtn.disabled = busy || !state?.ready || (action === 'cover' && !state?.uvr5) || needSource;
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
      file = null;
      fileInput.value = '';
      bindSource();
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

    /** 会话里的「歌名」：优先用原声副本的文件名，老会话退回 id。 */
    function songName(s: SessionSummary): string {
      const base = s.source?.file ?? '';
      return base ? base.replace(/\.[^.]+$/, '') : s.id;
    }

    function renderRecent(r: RefineState): void {
      const key = JSON.stringify(r.sessions.map((s) => [
        s.id, s.updatedAt, s.bytes, s.voice, s.source, s.outputFiles,
      ]));
      if (key === recentKey) return;
      recentKey = key;
      exportForm = null;
      recentList.textContent = '';
      if (!r.sessions.length) {
        recentList.append(ui.h('div', 'rvc-detail', t.recentEmpty));
        return;
      }
      for (const s of r.sessions) {
        const row = ui.h('div', 'rvc-recent');
        const head = ui.h('div', 'rvc-recent-head');
        head.append(
          ui.h('strong', '', s.voice ? t.voiceLabel(s.voice) : t.unknown),
          ui.h('span', '', t.recentMeta(
            new Date(s.updatedAt).toLocaleString(),
            ui.fmt.duration(s.durationSec * 1000),
            '',
          )),
        );
        const source = ui.h('div', 'rvc-detail', s.source
          ? t.recentSource(s.source.file, ui.fmt.bytes(s.source.bytes))
          : t.recentNoSource);
        const last = s.outputFiles[s.outputFiles.length - 1];
        const output = ui.h('div', 'rvc-detail', last
          ? t.recentOutput(last.path.replace(/^out\//, ''), ui.fmt.bytes(last.bytes))
          : t.recentNoOutput);
        const acts = ui.actions();
        acts.append(
          ui.button(t.recentResume, { size: 'sm', onClick: () => chooseSession(s.id) }),
          ui.button(t.recentExport, { size: 'sm', onClick: () => toggleExport(row, s) }),
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
      const which = ui.select({
        value: 'output',
        options: [
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
      const ext = which.value === 'source'
        ? extOf(s.source?.file ?? '')
        : `.${s.outputFiles[s.outputFiles.length - 1]?.format ?? 'wav'}`;
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
        const r = await ctx.invoke<{
          name: string; ext: string; bytes: number; mime: string; base64: string;
        }>('sessionFile', [s.id, which.value]);
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
      fillSelect(ui, sessionSelect, r.sessions.map((s) => ({
        value: s.id,
        label: [s.id, s.voice ? t.voiceLabel(s.voice) : '', t.sessionLine(ui.fmt.duration(s.durationSec * 1000), ui.fmt.bytes(s.bytes), s.outputs)]
          .filter(Boolean)
          .join(' · '),
      })));
      const session = r.session;
      summaries = r.sessions;
      bindSource();
      selectedId = session?.id ?? '';
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
      waveSheet.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    /** 载入最近两条成品，保留当前播放位置；切会话/新成品时自动重载。 */
    async function loadAB(aIndex: number, bIndex: number): Promise<void> {
      if (!selectedId) return;
      const token = ++abToken;
      abLoaded = false;
      abLine.textContent = t.abLoading;
      try {
        const [blobA, blobB] = await Promise.all([
          ctx.invokeBinary('refineAudio', [selectedId, aIndex]),
          ctx.invokeBinary('refineAudio', [selectedId, bIndex]),
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
        abLabelA = clockOf(abOutputs[aIndex]?.at);
        abLabelB = clockOf(abOutputs[bIndex]?.at);
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
      abOutputs = session?.outputs ?? [];
      const pair = abOutputs.slice(-2);
      const key = session ? `${session.id}:${pair.map((item) => item.path).join('|')}` : '';
      if (key !== abKey) {
        abKey = key;
        if (!session || pair.length < 2) {
          abLoaded = false;
          stopAB();
          abAudioA.removeAttribute('src');
          abAudioB.removeAttribute('src');
          abLine.textContent = t.abNeedTwo;
        } else {
          void loadAB(abOutputs.length - 2, abOutputs.length - 1);
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
        const r = await ctx.invoke<RefineState>('refineState', id ? [id] : []);
        if (seq === refineSeq) renderRefine(r);
      } catch (err) {
        if (seq === refineSeq) refineLine.textContent = errText(err);
      }
    }

    function render(s: PanelState, voices: VoiceRow[]): void {
      state = s;
      const fallback = s.defaultVoice ? `${t.defaultVoice}（${t.voiceLabel(s.defaultVoice)}）` : t.defaultVoice;
      fillSelect(ui, voiceSelect, [{ value: '', label: fallback }, ...voices.map((v) => ({ value: v.name, label: t.voiceLabel(v.name) }))]);
      updateCoverButton();
      if (!s.ready && s.detail) msg.textContent = s.detail;
      else if (!s.uvr5) msg.textContent = t.coverNeedsUvr;
    }

    async function run(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!file) { msg.textContent = t.pickFileFirst; msg.classList.add('bad'); return; }
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!state?.uvr5) { msg.textContent = t.coverNeedsUvr; msg.classList.add('bad'); return; }
      settledKey = '';
      msg.textContent = t.covering;
      pendingApplied = currentParams();
      coverBtn.disabled = true;
      try {
        const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
        // 后台跑：分离 + 变声 + 混音都在 World 里，页面可以随时切走。
        await ctx.invoke('cover', [file.name, base64, {
          voice: voiceSelect.value,
          pitch: Number(pitch.value),
          indexRate: Number(indexRate.value),
          protect: Number(protect.value),
          vocalGain: Number(vocalGainDb.input.value),
          format: mixFormat.value,
          chunk: chunk.value === 'chunk',
          keepSource: keepSource.checked,
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
        if (!file) { msg.textContent = t.rerunNeedSource; msg.classList.add('bad'); return; }
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
      try {
        await ctx.invoke('rangeConvert', [selectedId, {
          startSec: selStart,
          endSec: selEnd,
          pitch: Number(rangePitch.value),
          indexRate: Number(rangeIndex.value),
          protect: Number(rangeProtect.value),
          format: mixFormat.value,
        }]);
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
        }
        return;
      }
      if (!s.resultReady || settledKey === key) return;
      settledKey = key;
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
          done.peakScale !== undefined && done.peakScale < 1 ? t.peakScaled : '',
          done.savedPath ? t.saved(done.savedPath) : '',
        ].filter(Boolean).join(' · ');
        if (done.sessionId) selectedId = done.sessionId;
        // 这次上传已经进（或按勾选没进）会话；清掉文件输入，音频处改显示当前工程的原声。
        file = null;
        fileInput.value = '';
        bindSource();
      }
    }

    const refresh = async (): Promise<void> => {
      try {
        const [s, v] = await Promise.all([ctx.invoke<PanelState>('state'), ctx.invoke<VoicesResp>('voices')]);
        render(s, v.voices ?? []);
        await settle(s);
        await loadRefine(selectedId);
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

    const sheet = ui.section(t.voicesTitle, t.voicesHint);
    const list = ui.h('div');
    const importInput = ui.input({});
    importInput.type = 'file';
    importInput.accept = '.pth,.index';
    const importBtn = ui.button(t.importFile, { variant: 'primary', size: 'sm', onClick: () => void doImport() });
    const refreshBtn = ui.button(t.voiceRefresh, { size: 'sm', onClick: () => void load() });
    const acts = ui.actions();
    acts.append(importBtn, refreshBtn);
    sheet.append(list, acts, ui.h('div', 'rvc-detail', t.voiceHint), importInput);

    ctx.root.append(sheet, msg);

    async function doImport(): Promise<void> {
      const file = importInput.files?.[0];
      if (!file) { msg.textContent = t.importFile; msg.classList.add('bad'); return; }
      msg.textContent = '';
      msg.classList.remove('bad');
      const busy = ui.busy(t.importFile, file.name);
      try {
        const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
        const res = await ctx.invoke<ImportResp>('import', [file.name, base64]);
        if (res.error) throw new Error(res.error);
        ui.toast(t.importOk(res.name ?? file.name));
        importInput.value = '';
        await load();
      } catch (err) {
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

    function render(): void {
      list.textContent = '';
      if (!voices.length) { list.append(ui.h('div', 'rvc-detail', t.noVoiceHint)); return; }
      for (const v of voices) {
        const line = row(list, ui, t.voiceLabel(v.name));
        const using = v.name === defaultVoice;
        setPill(line.pill, using ? t.using : '', using ? 'on' : 'off');
        line.detail.textContent = [ui.fmt.bytes(v.bytes), v.index ? t.indexHas(ui.fmt.bytes(v.index)) : t.indexNone].join(' · ');
        if (!using) line.acts.append(ui.button(t.setDefault, { size: 'sm', onClick: () => void useVoice(v.name) }));
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
    service: servicePanel,
    convert: convertPanel,
    cover: coverPanel,
    voices: voicesPanel,
  },
};
export default bundle;
