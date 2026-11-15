# Mel-Band RoFormer

`attend.py` 与 `model.py` 取自 KimberleyJensen 的 Mel-Band Roformer Vocal Model：

- https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model
- 权重：https://huggingface.co/KimberleyJSN/melbandroformer（`MelBandRoformer.ckpt`）

与本插件一起按 MIT 许可分发，仅做了去掉 `beartype` 装饰器、把 librosa mel
滤波器改成等价的 numpy 实现、以及新增 `infer.py` 推理封装这三处改动。

## MIT License

Copyright (c) 2024 Kimberley Jensen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
