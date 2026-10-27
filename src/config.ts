import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language } from 'cortico/core/language.ts';

export const RVC_ID = 'rvc';

/** config.json 的 `worlds.rvc` 段。 */
export interface RvcConfigSection {
  enabled: boolean;
  /**
   * RVC 推理代码目录。空为扩展包自带的 `vendor/rvc`（只含源码，不含权重）。
   */
  codeDir: string;
  /**
   * 模型资产目录（`hubert_base/`、`rmvpe/`）。空为插件数据目录下的 `assets`。
   * 资产约 587 MB，首次使用在面板里安装（断点续传、SHA-256 校验），不随包分发。
   */
  assetsDir: string;
  /**
   * 派生 venv 里的 `python.exe`。空为插件数据目录下的 `venv\Scripts\python.exe`。
   * 派生 venv 以 gpt-sovits 运行时为 base（`--system-site-packages`），不复制整套运行时。
   */
  pythonPath: string;
  /**
   * 借用 base 解释器与 ffmpeg 的 gpt-sovits 运行时目录（含 `runtime/python.exe`）。
   * 空为在 `<部署根>/runtimes/gpt-sovits/` 下自动挑一个可用版本。
   */
  runtimeDir: string;
  /** 音色权重目录（`.pth` 与同名 `.index`）；空为插件数据目录下的 `voices`。 */
  voicesDir: string;
  /** 默认音色：`.pth` 文件名去掉扩展名。空为 `voicesDir` 里第一个。 */
  voice: string;
  /** 变调，半音，−24..24。 */
  pitch: number;
  /** 索引率（检索特征掺入比例），0..1；该音色没有 `.index` 时忽略。 */
  indexRate: number;
  /** 保护清辅音，0..0.5。 */
  protect: number;
  /** 对其他插件开放本机 HTTP 接口：只监听 127.0.0.1。 */
  httpApi: boolean;
  /** HTTP 接口端口；默认 9881。改端口要重挂扩展（重启 World）才生效。 */
  httpPort: number;
  /** HTTP 接口的访问令牌；留空不校验（接口只监听回环地址）。 */
  httpToken: string;
}

export const PITCH_MIN = -24;
export const PITCH_MAX = 24;
export const PROTECT_MAX = 0.5;
export const DEFAULT_PORT = 9881;

export const RVC_DEFAULTS: RvcConfigSection = {
  enabled: false,
  codeDir: '',
  assetsDir: '',
  pythonPath: '',
  runtimeDir: '',
  voicesDir: '',
  voice: '',
  pitch: 0,
  indexRate: 0.3,
  protect: 0.33,
  httpApi: true,
  httpPort: DEFAULT_PORT,
  httpToken: '',
};

const K = `worlds.${RVC_ID}`;

const TEXT = {
  zh: {
    title: 'RVC 变声',
    groupConvert: { title: '变声参数', description: '默认音色与三个推理参数；面板上传时还可以逐次覆盖。' },
    groupService: { title: '运行与接口', description: '推理代码、派生 venv 与音色目录，以及给其他插件用的本机 HTTP 接口。' },
    voice: { title: '默认音色', description: 'voices 目录里 .pth 的文件名（不含扩展名）；留空用第一个。同名 .index 有则自动带上。' },
    pitch: { title: '变调（半音）', description: '0 为原调；男声转女声一般 +12 左右。' },
    indexRate: { title: '索引率', description: '0..1，越高越贴近音色、但可能带出素材口音；该音色没有 .index 时忽略。' },
    protect: { title: '保护清辅音', description: '0..0.5，防止换声后齿音、吸气声被抹掉。' },
    codeDir: { title: '推理代码目录', description: 'RVC 源码目录；留空用扩展包自带的 vendor/rvc（只含代码，不含权重）。' },
    assetsDir: { title: '模型资产目录', description: 'hubert_base 与 rmvpe 所在目录；留空为插件数据目录下的 assets。约 587 MB，首次使用在面板里安装，不随包分发。' },
    pythonPath: { title: '派生 venv 的 python.exe', description: '留空为插件数据目录下的 venv\\Scripts\\python.exe。派生 venv 以 gpt-sovits 运行时为 base，不复制整套运行时。' },
    runtimeDir: { title: 'gpt-sovits 运行时目录', description: '派生 venv 的 base，也借它的 ffmpeg；留空自动挑部署里最新的一个。' },
    voicesDir: { title: '音色目录', description: '放 .pth 与同名 .index；留空为插件数据目录下的 voices。' },
    httpApi: { title: '开放本机变声接口', description: '给其他插件用：POST /convert 上传音频，拿回变声后的音频。只监听 127.0.0.1。' },
    httpPort: { title: '接口端口', description: '默认 9881；与别的程序冲突时换一个。' },
    httpToken: { title: '接口令牌', description: '留空不校验（只监听本机回环地址）。填了以后请求要带 Authorization: Bearer 或 ?token=。' },
  },
  en: {
    title: 'RVC Voice Changer',
    groupConvert: { title: 'Conversion', description: 'Default voice and the three inference knobs; the panel can override them per upload.' },
    groupService: { title: 'Runtime and API', description: 'Inference code, derived venv, voices folder, and the loopback HTTP endpoint for other plugins.' },
    voice: { title: 'Default voice', description: 'A .pth file name in the voices folder without the extension; empty uses the first one. A matching .index is picked up automatically.' },
    pitch: { title: 'Pitch (semitones)', description: '0 keeps the original key; a male voice to female is usually around +12.' },
    indexRate: { title: 'Index rate', description: '0..1; higher sticks closer to the voice but may leak the source accent. Ignored when the voice has no .index.' },
    protect: { title: 'Protect voiceless consonants', description: '0..0.5; keeps sibilants and breaths from being smeared by the conversion.' },
    codeDir: { title: 'Inference code folder', description: 'RVC source folder; empty uses the bundled vendor/rvc (code only, no weights).' },
    assetsDir: { title: 'Model assets folder', description: 'Where hubert_base and rmvpe live; empty uses assets under the plugin data folder. About 587 MB, installed from the panel on first use; not shipped in the package.' },
    pythonPath: { title: 'Derived venv python.exe', description: 'Empty uses venv\\Scripts\\python.exe under the plugin data folder. The venv is based on the gpt-sovits runtime instead of copying it.' },
    runtimeDir: { title: 'gpt-sovits runtime folder', description: 'Base of the derived venv and the source of ffmpeg; empty picks the newest one in the deployment.' },
    voicesDir: { title: 'Voices folder', description: 'Holds .pth files and matching .index files; empty uses voices under the plugin data folder.' },
    httpApi: { title: 'Serve the local conversion API', description: 'For other plugins: POST /convert with audio and get converted audio back. Loopback only.' },
    httpPort: { title: 'API port', description: 'Defaults to 9881; change it if something else uses that port.' },
    httpToken: { title: 'API token', description: 'Empty means no check (loopback only). When set, callers must send Authorization: Bearer or ?token=.' },
  },
};

export function configGroups(language: Language): ConfigGroup[] {
  const t = pick(language, TEXT);
  const owner = `world:${RVC_ID}`;
  return [
    {
      id: owner,
      owner,
      schema: {
        type: 'object',
        title: t.groupConvert.title,
        description: t.groupConvert.description,
        properties: {
          [`${K}.voice`]: { type: 'string', title: t.voice.title, description: t.voice.description, 'x-hot': true },
          [`${K}.pitch`]: { type: 'number', title: t.pitch.title, description: t.pitch.description, minimum: PITCH_MIN, maximum: PITCH_MAX, multipleOf: 1, 'x-hot': true },
          [`${K}.indexRate`]: { type: 'number', title: t.indexRate.title, description: t.indexRate.description, minimum: 0, maximum: 1, multipleOf: 0.05, 'x-hot': true },
          [`${K}.protect`]: { type: 'number', title: t.protect.title, description: t.protect.description, minimum: 0, maximum: PROTECT_MAX, multipleOf: 0.01, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:service`,
      owner,
      schema: {
        type: 'object',
        title: t.groupService.title,
        description: t.groupService.description,
        properties: {
          [`${K}.codeDir`]: { type: 'string', title: t.codeDir.title, description: t.codeDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.assetsDir`]: { type: 'string', title: t.assetsDir.title, description: t.assetsDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.pythonPath`]: { type: 'string', title: t.pythonPath.title, description: t.pythonPath.description, 'x-path': { kind: 'file', extensions: ['.exe'] }, 'x-hot': true },
          [`${K}.runtimeDir`]: { type: 'string', title: t.runtimeDir.title, description: t.runtimeDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.voicesDir`]: { type: 'string', title: t.voicesDir.title, description: t.voicesDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.httpApi`]: { type: 'boolean', title: t.httpApi.title, description: t.httpApi.description, 'x-hot': true },
          [`${K}.httpPort`]: { type: 'number', title: t.httpPort.title, description: t.httpPort.description, minimum: 1, maximum: 65535, multipleOf: 1, 'x-hot': true },
          [`${K}.httpToken`]: { type: 'string', title: t.httpToken.title, description: t.httpToken.description, 'x-hot': true },
        },
      },
    },
  ];
}

export function worldLabel(language: Language): string {
  return pick(language, TEXT).title;
}
