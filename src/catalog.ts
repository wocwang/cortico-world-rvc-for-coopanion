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

/**
 * 内置示例音色：显示名「小肥鱼」，落盘 ID 沿用上游 `daifeiyu`。
 * 官方 `YukiKaze1337/DaFeiYu_rvc_v2_40k` 在本项目里叫「星落落大肥鱼」，已不再内置。
 * 权重是用 gpt-sovits 的 dfy 干音自训的 RVC v2 40k 模型（606 条日语干音 / 29.46 分钟，底模来自 RVC-Project）。
 * 授权**不是 MIT**：仅供个人学习、娱乐和非商业使用，注明音源即可，禁止冒充/诈骗/伪造，商用需另行授权。
 * 音源见 README「示例音色」与 B 站 `BV1cbH56KER3`；训练素材为机械合成音（非真人录音）。
 */
export const SAMPLE_VOICE = 'daifeiyu';

export interface PinnedFile {
  /** 落盘位置：`ASSET_FILES` 相对 `<dataDir>/assets`，`VOICE_FILES` 相对 `<dataDir>/voices`。 */
  path: string;
  bytes: number;
  sha256: string;
  /** 下载地址，按顺序尝试；前一个失败（网络、HTTP 状态、校验）才试下一个。 */
  sources: readonly string[];
}

const MS_OWN = 'https://www.modelscope.cn/models/wocwang/rvc-for-coopanion/resolve/master';
const GH_OWN = 'https://github.com/wocwang/cortico-world-rvc-for-coopanion/releases/download/voice-20261028';
const HF_MIRROR = 'https://hf-mirror.com';
const HF = 'https://huggingface.co';
const UPSTREAM_PATH = 'lj1995/VoiceConversionWebUI/resolve/main';

/** 上游资产（hubert / rmvpe）：自有魔搭仓库没放这两个，走 hf-mirror 再退官方 HF。 */
function pinnedUpstream(path: string, remote: string, bytes: number, sha256: string): PinnedFile {
  return {
    path,
    bytes,
    sha256,
    sources: [`${HF_MIRROR}/${remote}`, `${HF}/${remote}`],
  };
}

/**
 * 推理资产，落到 `<dataDir>/assets`：
 * - `hubert_base/`：transformers 格式的 ContentVec（上游 `81eed5e` 不再用 fairseq）；
 * - `rmvpe/rmvpe.pt`：F0 提取器。
 */
export const ASSET_FILES: readonly PinnedFile[] = [
  pinnedUpstream('hubert_base/config.json', `${UPSTREAM_PATH}/hubert_base/config.json`, 1492, '0346950779dfb7f9316fa74ed846e2b8a22a08eedfdc5387b73f327cb1a4a7cf'),
  pinnedUpstream('hubert_base/preprocessor_config.json', `${UPSTREAM_PATH}/hubert_base/preprocessor_config.json`, 225, '7c1976a680fb7acc757cd36fb08eef878fa36c70b4c9d2d595df9c608bbbbf0e'),
  pinnedUpstream('hubert_base/pytorch_model.bin', `${UPSTREAM_PATH}/hubert_base/pytorch_model.bin`, 189206711, 'cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5'),
  pinnedUpstream('rmvpe/rmvpe.pt', `${UPSTREAM_PATH}/rmvpe.pt`, 181184272, '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193'),
];

/** 自训音色，落到 `<dataDir>/voices`：自有魔搭仓库 → GitHub Release。索引落盘统一改名成同名 `.index`。 */
const voiceFile = (path: string, bytes: number, sha256: string): PinnedFile => ({
  path,
  bytes,
  sha256,
  sources: [`${MS_OWN}/voices/${path}`, `${GH_OWN}/${path}`],
});

/** 官方 DaFeiYu（显示名「星落落大肥鱼」）的落盘 ID；与自训的 `daifeiyu`（小肥鱼）区分开。 */
export const OFFICIAL_VOICE = 'xll';

/** 官方模型只在上游 Hugging Face：先 hf-mirror，再原站（国内多半不通，只当兜底）。 */
const OFFICIAL_VOICE_PATH = 'YukiKaze1337/DaFeiYu_rvc_v2_40k/resolve/main';
const officialVoiceFile = (path: string, remote: string, bytes: number, sha256: string): PinnedFile => ({
  path,
  bytes,
  sha256,
  sources: [`${HF_MIRROR}/${OFFICIAL_VOICE_PATH}/${remote}`, `${HF}/${OFFICIAL_VOICE_PATH}/${remote}`],
});

export const VOICE_FILES: readonly PinnedFile[] = [
  voiceFile(`${SAMPLE_VOICE}.pth`, 55223661, 'ff64ca1e5978073058882fc86ebd68acd5ac0b1a7d846e6d0c0137b7bf582a02'),
  voiceFile(`${SAMPLE_VOICE}.index`, 266765099, '3387bece70af26610f80858d52e8d7343ffc6904b95c73f6006ca7c302568196'),
  officialVoiceFile(`${OFFICIAL_VOICE}.pth`, 'dafeiyu.pth', 55229202, 'eaa043e9329fa7a6c9002ccff4efe7667d42ab8187eb5f9297c5f2b2628c9935'),
  officialVoiceFile(`${OFFICIAL_VOICE}.index`, 'added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index', 161949619, '01da84f7efd48f713835e6dfc87f9ee865cd0e223f8bc40eb35b15696b0058a7'),
];

/** 两类资产总字节，面板显示总量用。 */
export const ASSET_BYTES = ASSET_FILES.reduce((n, f) => n + f.bytes, 0);
export const VOICE_BYTES = VOICE_FILES.reduce((n, f) => n + f.bytes, 0);
