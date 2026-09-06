# 本地日文 TTS 与瑞希音色转换 Sidecar 实现计划与验收

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 Node 主进程模型边界的前提下，增加一个可独立运行的本地 HTTP sidecar，用轻量日文 TTS 生成源音频，并可选串联 Project Sekai 瑞希 So-VITS-SVC 音色模型，最终返回现有 QQ 语音链路需要的 MP3 二进制。

**Architecture:** 独立目录 `D:\tts-models` 使用 Python FastAPI 暴露 `/health` 和 `/synthesize`。当前最小链路先由 Piper 日文 ONNX 生成源音频，再按开关决定是否经过瑞希 So-VITS-SVC，最后统一用内置 FFmpeg 输出 MP3；CosyVoice3 保留为后续高质量基础 TTS。Node 端继续只调用现有 `COMPANION_VOICE_LOCAL_API_URL`，不加载 Python 模型、不持有音频文件和模型权重。

**Tech Stack:** Windows 原生 Python 3.10、FastAPI、Uvicorn、Piper ONNX、So-VITS-SVC 4.1、ContentVec、RMVPE、imageio-ffmpeg、现有 Node.js CommonJS 本地 TTS Provider。

---

## 当前实施状态（2026-09-06 21:22 +08:00）

- [x] 在 `D:\tts-models` 建立独立 Windows 原生 sidecar，不使用容器，不把模型权重放入 MizukiBot 仓库。
- [x] 增加 `LOCAL_TTS_BACKEND=piper|cosyvoice`，并用 `COMPANION_VOICE_LOCAL_TTS_ENABLED`、`COMPANION_VOICE_LOCAL_SVC_ENABLED` 分别控制基础 TTS 和 SVC。
- [x] 下载并加载 Piper `ja_JA-hi_fi_captain-medium`、瑞希 `mzk.pth`、ContentVec 和 RMVPE。
- [x] 完成 Piper → 瑞希 SVC → MP3 真实串联，输出 44.1 kHz，已测峰值显存约 1.34 GB。
- [x] 完成 `/health`、`/synthesize` 和 Node 本地 Provider 真实 HTTP 验收；Node 请求返回 56,886 字节 `audio/mpeg`，完整服务使用当前 `.env` 将两段日文依次处理为 `accepted + record`，没有文字回退。
- [x] QQ Provider、私聊/群聊 `record`、工具上下文和平台注册表定向测试通过。
- [x] `lint`、`typecheck`、全仓密钥扫描和差异检查通过。
- [ ] 完整 `npm test` 清零；当前 3 个既有失败均不属于语音目标，分别是两个 prompt manifest/allowlist 失败和一个语音输入超时配置期望不一致。
- [ ] 在真实 QQ 私聊和群聊客户端确认语音接收与播放。
- [ ] 下载、安装并验收 CosyVoice3 高质量基础 TTS。
- [ ] 使用自有合规数据进行瑞希 SVC 微调训练。
- [ ] 正式验收 Discord 和微信语音路径。

以下原始分阶段计划保留为 CosyVoice 和后续平台工作的路线记录，不作为当前 Piper 最小上线链路的完成条件。

## 文件边界

- Create: `tts-sidecar/server.py`，HTTP 入口和请求/响应协议。
- Create: `tts-sidecar/pipeline.py`，CosyVoice → So-VITS-SVC → MP3 编排。
- Create: `tts-sidecar/config.py`，sidecar 环境变量解析和开关语义。
- Create: `tts-sidecar/requirements.txt`，sidecar 运行依赖说明，不修改主项目 Node 依赖。
- Create: `tts-sidecar/README.md`，Windows 原生运行、模型下载、音频数据和真实试听步骤。
- Create: `tts-sidecar/run.cmd`，Windows 本地启动入口。
- Create: `tts-sidecar/download-models.py`，下载 CosyVoice 和 Hugging Face 瑞希模型，不把权重提交到 Git。
- Create: `tts-sidecar/.gitignore`，忽略虚拟环境、模型权重、生成音频和运行日志。
- Modify: `.env.example`，增加 sidecar 地址、两个模型开关、模型路径和运行参数。
- Modify: `README.md`、`docs/multi-platform-deployment.md`、`docs/development/05-feature-development.md`，记录本地模型部署方式、当前未完成项和时间戳验收状态。
- Modify: `tests/companionVoiceMultichannel.test.js` 或新增 `tests/localTtsSidecarConfig.test.js`，覆盖两个开关的配置语义和本地 Provider 请求兼容性；不在 Node 测试中加载真实模型。

## Chunk 1：协议与配置

- [ ] **Step 1: 写 sidecar 配置和 HTTP 协议测试**

  覆盖：基础 TTS 开关、音色转换开关、两个都关闭、只开基础 TTS、两个都开启；验证服务统一接收 `{text, voice, speed, format}` 并返回 `audio/mpeg`。

- [ ] **Step 2: 运行配置测试确认失败**

  Run: `python -m unittest discover -s tts-sidecar/tests -v`

  Expected: FAIL，因为 sidecar 配置模块和服务尚未创建。

- [ ] **Step 3: 实现最小配置模块和 FastAPI 健康检查**

  `config.py` 读取环境变量；`server.py` 暴露 `/health`，健康结果必须包含两个开关和模型路径是否存在，但不返回 API Key 或音频内容。

- [ ] **Step 4: 运行配置测试确认通过**

  Run: `python -m unittest discover -s tts-sidecar/tests -v`

  Expected: 配置和健康检查测试 PASS。

## Chunk 2：基础 TTS 与音频转换

- [ ] **Step 1: 增加 CosyVoice 适配器的 mock 测试**

  用可替换的 fake generator 验证文本、日文参考音频、语速和情绪指令能够进入基础 TTS 阶段；测试不下载权重。

- [ ] **Step 2: 实现 CosyVoice3 适配器**

  使用官方 `AutoModel`/`CosyVoice3` 接口加载本地模型目录，默认走日文零样本/参考音频模式；模型只在 sidecar 启动时加载一次，推理串行执行，输出统一为 WAV 字节流。

- [ ] **Step 3: 实现 FFmpeg WAV→MP3 转换**

  使用临时目录和显式输入输出路径，失败时返回可诊断错误；不把中间 WAV 交给 Node 主进程。

- [ ] **Step 4: 运行 mock 测试确认基础链路通过**

  Run: `python -m unittest discover -s tts-sidecar/tests -v`

  Expected: 无模型环境下配置、请求、音频编排 mock 测试 PASS。

## Chunk 3：瑞希 So-VITS-SVC 阶段

- [ ] **Step 1: 增加 SVC 适配器的 mock 测试**

  覆盖音色转换关闭时原样输出基础 TTS，开启时调用 SVC，并验证缺少模型文件时健康检查明确失败而不是静默回退。

- [ ] **Step 2: 实现 So-VITS-SVC 4.1 适配器**

  通过官方 `Svc`/`slice_inference` 接口加载 `mzk_release` 解压后的 `.pth` 与 `config.json`，使用 `rmvpe` 或配置指定的 F0 预测器，输入基础 TTS WAV，输出 WAV；不修改上游代码。

- [ ] **Step 3: 接入两个独立开关**

  - `COMPANION_VOICE_LOCAL_TTS_ENABLED=false`：文本请求拒绝并返回明确配置错误，因为没有源音频。
  - `COMPANION_VOICE_LOCAL_TTS_ENABLED=true`、`COMPANION_VOICE_LOCAL_VOICE_CONVERSION_ENABLED=false`：只输出 CosyVoice 音频。
  - 两者均为 `true`：输出 CosyVoice 后经瑞希 SVC 转换的音频。
  - `COMPANION_VOICE_LOCAL_TTS_ENABLED=false`、`COMPANION_VOICE_LOCAL_VOICE_CONVERSION_ENABLED=true`：健康检查标记配置无效，文本接口不尝试隐式生成源音频。

- [ ] **Step 4: 运行 sidecar mock 测试确认通过**

  Run: `python -m unittest discover -s tts-sidecar/tests -v`

  Expected: 所有开关组合和阶段调用顺序 PASS。

## Chunk 4：模型下载、启动和项目接线

- [ ] **Step 1: 实现模型下载脚本和 Windows 启动入口**

  `download-models.py` 使用 Hugging Face Hub 下载 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`，并下载 `Strelexia/ProjectSekaiVITSModel` 后只解压用户选择的 `mzk_release.zip`；输出模型目录和缺少依赖提示。

- [ ] **Step 2: 增加 `.env.example` 配置**

  增加 sidecar URL、端口、两个开关、CosyVoice 模型目录、瑞希模型目录、参考音频、参考文本、SVC 配置、F0 预测器和 FFmpeg 路径；默认两个模型开关关闭，避免主程序启动时误触发本地大模型。

- [ ] **Step 3: 运行 Node 侧兼容测试**

  Run: `node scripts/run-tests.js tests/companionVoice.test.js tests/companionVoiceMultichannel.test.js tests/companionVoiceIntegration.test.js`

  Expected: 现有本地 Provider 请求和 QQ record 流程 PASS。

- [ ] **Step 4: 运行本机模型 smoke test**

  使用一条短日文句子，分别执行：基础 TTS、基础 TTS+瑞希 SVC；记录启动时间、生成耗时、峰值显存、输出采样率、MP3 文件大小和人工试听结果。

## Chunk 5：文档、验收和提交

- [ ] **Step 1: 更新 README、开发文档和部署文档**

  明确当前推荐链路为 CosyVoice3 0.5B + `mzk_release.zip`，两个开关语义、模型许可证/角色素材使用权边界、Windows 依赖和真实 QQ 验收仍需人工执行。

- [ ] **Step 2: 运行质量门禁**

  ```text
  python -m unittest discover -s tts-sidecar/tests -v
  node scripts/run-tests.js tests/companionVoice.test.js tests/companionVoiceMultichannel.test.js tests/companionVoiceIntegration.test.js
  npm run lint -- --quiet
  npm run typecheck
  npm run check:secrets:all
  git diff --check
  ```

- [ ] **Step 3: 记录真实结果**

  将模型是否下载、是否能在 RTX 5070 12GB 推理、是否能完成串联、是否完成 QQ 实收写入文档；未执行的项目标为未完成，不把 mock 测试当作真实模型验收。

- [ ] **Step 4: 提交当前分支**

  只暂存本功能和文档文件，保留并行修改及模型权重不入 Git；提交当前分支但不推送远端。
