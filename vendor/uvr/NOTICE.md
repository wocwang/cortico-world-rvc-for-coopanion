# 第三方声明：MDX-Net 人声分离

- `mdx.py`：派生自 [python-audio-separator](https://github.com/karaokenerds/python-audio-separator)
  0.9.0 的 `Separator`（MIT，© 2023 Andrew Beveridge），其代码取自
  [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui)（MIT，Anjok07 / DilanBoskan）。
  改动：去掉模型下载与 GPU/MPS 分支，改为内存输入输出，只保留 MDX-Net ONNX 推理。
- 模型 `UVR-MDX-NET-Inst_HQ_3.onnx`：UVR 项目训练（MIT），由插件安装流程另行下载，不随包分发。
  模型参数取自 UVR 的 `mdx_model_data/model_data.json`。

原项目 MIT 许可证要求保留版权与许可声明；本插件的 `LICENSE` 为 MIT，再此注明来源。
