/**
 * 钉住的上游代码与模型资产：每个文件写明字节数、SHA-256 与按顺序尝试的来源。
 *
 * 包体只带推理源码（`vendor/rvc`，约 0.5 MB），**不带权重**：hubert / rmvpe / 示例音色共约 587 MB，
 * 首次安装时下到插件数据目录（`<dataDir>/assets`、`<dataDir>/voices`），断点续传、校验通过才落位。
 *
 * 来源顺序：自有 ModelScope 仓库（还没上传时 404，自动落到下一个）→ hf-mirror（国内可达）→ huggingface。
 */

/** 上游推理代码仓库与 commit；`vendor/rvc` 就是这份代码的瘦身副本（见 `VENDOR_NOTE`）。 */
export const UPSTREAM_REPO = 'RVC-Project/Retrieval-based-Voice-Conversion-WebUI';
export const UPSTREAM_COMMIT = '81eed5e8f68b6bed1789f682fe78cdd324495afc';

/** `vendor/rvc` 里保留的目录：推理链只用到这些（不含 assets / train / WebUI / VST，也不含用不到的语言包）。 */
export const VENDOR_NOTE = 'infer, configs, i18n/{i18n.py,locale/{zh_CN,en_US}.json}, tools/{cuda_graph,file_io,progress}.py + LICENSE';

/** 内置示例音色（MIT）：大肥鱼。上游文件名是 `dafeiyu`，落盘统一成 `daifeiyu`。 */
export const SAMPLE_VOICE = 'daifeiyu';

export interface PinnedFile {
  /** 落盘位置：`ASSET_FILES` 相对 `<dataDir>/assets`，`VOICE_FILES` 相对 `<dataDir>/voices`。 */
  path: string;
  bytes: number;
  sha256: string;
  /** 下载地址，按顺序尝试；前一个失败（网络、HTTP 状态、校验）才试下一个。 */
  sources: readonly string[];
}

const MS_OWN = 'https://www.modelscope.cn/models/Phantivia/rvc-for-coopanion/resolve/master';
const HF_MIRROR = 'https://hf-mirror.com';
const HF = 'https://huggingface.co';
const UPSTREAM_PATH = 'lj1995/VoiceConversionWebUI/resolve/main';
const VOICE_PATH = 'YukiKaze1337/DaFeiYu_rvc_v2_40k/resolve/main';

/** 一个文件：自有魔搭 → hf-mirror → huggingface。`remote` 是上游仓库里的相对路径。 */
function pinned(path: string, remote: string, bytes: number, sha256: string, mirrorPath = path): PinnedFile {
  return {
    path,
    bytes,
    sha256,
    sources: [`${MS_OWN}/${mirrorPath}`, `${HF_MIRROR}/${remote}`, `${HF}/${remote}`],
  };
}

/**
 * 推理资产，落到 `<dataDir>/assets`：
 * - `hubert_base/`：transformers 格式的 ContentVec（上游 `81eed5e` 不再用 fairseq）；
 * - `rmvpe/rmvpe.pt`：F0 提取器。
 */
export const ASSET_FILES: readonly PinnedFile[] = [
  pinned('hubert_base/config.json', `${UPSTREAM_PATH}/hubert_base/config.json`, 1492, '0346950779dfb7f9316fa74ed846e2b8a22a08eedfdc5387b73f327cb1a4a7cf'),
  pinned('hubert_base/preprocessor_config.json', `${UPSTREAM_PATH}/hubert_base/preprocessor_config.json`, 225, '7c1976a680fb7acc757cd36fb08eef878fa36c70b4c9d2d595df9c608bbbbf0e'),
  pinned('hubert_base/pytorch_model.bin', `${UPSTREAM_PATH}/hubert_base/pytorch_model.bin`, 189206711, 'cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5'),
  pinned('rmvpe/rmvpe.pt', `${UPSTREAM_PATH}/rmvpe.pt`, 181184272, '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193'),
];

/** 内置示例音色，落到 `<dataDir>/voices`；索引在上游是另一个文件名，落盘时改成同名 `.index`。 */
export const VOICE_FILES: readonly PinnedFile[] = [
  pinned(`${SAMPLE_VOICE}.pth`, `${VOICE_PATH}/dafeiyu.pth`, 55229202, 'eaa043e9329fa7a6c9002ccff4efe7667d42ab8187eb5f9297c5f2b2628c9935', `voices/${SAMPLE_VOICE}.pth`),
  pinned(`${SAMPLE_VOICE}.index`, `${VOICE_PATH}/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index`, 161949619, '01da84f7efd48f713835e6dfc87f9ee865cd0e223f8bc40eb35b15696b0058a7', `voices/${SAMPLE_VOICE}.index`),
];

/** 两类资产总字节，面板显示总量用。 */
export const ASSET_BYTES = ASSET_FILES.reduce((n, f) => n + f.bytes, 0);
export const VOICE_BYTES = VOICE_FILES.reduce((n, f) => n + f.bytes, 0);
