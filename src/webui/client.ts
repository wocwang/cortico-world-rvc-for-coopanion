/**
 * 浏览器端面板：`service`（状态 / 一键安装 / 日志尾部）、`convert`（上传 → 试听 → 落盘）、
 * `voices`（列表 / 导入 / 设为默认）。三个面板的数据都走 `ctx.invoke`，定时拉一次状态。
 *
 * 上传的音频只在浏览器与本地 World 之间走：base64 进 `convert`，回的是 `$binary`，
 * 不经 gpt-sovits、也不联网。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext, WebUi, Disposable } from 'cortico/web/shared/client-panel.ts';
import { panelText } from './text.ts';
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
  job: { kind: 'convert' | 'cover'; phase: 'working' | 'done' | 'error'; detail: string; error?: string; ms?: number } | null;
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
      if (!job) return;
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
    const vocalGain = ui.input({ type: 'number', value: '0' });
    vocalGain.min = '-12';
    vocalGain.max = '12';
    vocalGain.step = '1';
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
      ui.field(t.vocalGain, vocalGain),
      ui.field(t.format, format),
      ui.field(t.chunkMode, chunk),
    );

    const coverBtn = ui.button(t.cover, { variant: 'primary', size: 'sm', onClick: () => void run() });
    const acts = ui.actions();
    acts.append(coverBtn);

    sheet.append(
      ui.h('div', 'rvc-detail', t.coverStagesHint),
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
      const fallback = s.defaultVoice ? `${t.defaultVoice}（${t.voiceLabel(s.defaultVoice)}）` : t.defaultVoice;
      fillSelect(ui, voiceSelect, [{ value: '', label: fallback }, ...voices.map((v) => ({ value: v.name, label: t.voiceLabel(v.name) }))]);
      coverBtn.disabled = !s.ready || !s.uvr5 || s.job?.phase === 'working';
      if (!s.ready && s.detail) msg.textContent = s.detail;
      else if (!s.uvr5) msg.textContent = t.coverNeedsUvr;
    }

    let tookResult = false;

    async function run(): Promise<void> {
      msg.textContent = '';
      msg.classList.remove('bad');
      if (!file) { msg.textContent = t.pickFileFirst; msg.classList.add('bad'); return; }
      if (!state?.ready) { msg.textContent = t.notReady; msg.classList.add('bad'); return; }
      if (!state?.uvr5) { msg.textContent = t.coverNeedsUvr; msg.classList.add('bad'); return; }
      tookResult = false;
      msg.textContent = t.covering;
      coverBtn.disabled = true;
      try {
        const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
        // 后台跑：分离 + 变声 + 混音都在 World 里，页面可以随时切走。
        await ctx.invoke('cover', [file.name, base64, {
          voice: voiceSelect.value,
          pitch: Number(pitch.value),
          indexRate: Number(indexRate.value),
          protect: Number(protect.value),
          vocalGain: Number(vocalGain.value),
          format: format.value,
          chunk: chunk.value === 'chunk',
        }]);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        coverBtn.disabled = !(state?.ready && state?.uvr5);
      }
    }

    async function settle(s: PanelState): Promise<void> {
      const job = s.job;
      if (!job) return;
      if (job.phase === 'working') {
        msg.textContent = job.detail || t.covering;
        msg.classList.remove('bad');
        return;
      }
      if (tookResult) return;
      tookResult = true;
      if (job.phase === 'error') {
        msg.textContent = job.error || '翻唱失败';
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
      dl.download = `cover.${format.value}`;
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
      }
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
