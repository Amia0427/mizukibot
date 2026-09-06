# QQ 按需语音与瑞希本地音色更新公告及使用说明

更新时间：2026-09-06 22:21 +08:00

本文包含可直接发布的公告文案，以及普通用户和管理员的使用说明。当前正式范围是 QQ 私聊与群聊；管理员应先完成真实 QQ 客户端收音检查，再对外宣布功能可用。

## QQ 群公告短版

```text
【瑞希语音回复上线】

现在可以让瑞希用语音回复或朗读内容啦！

你可以这样说：
1. “用语音回复我。”
2. “把上一段说给我听。”
3. “朗读这段：今日はいい天気だね。”
4. “用日语语音说一句晚安。”

语音只会在你明确要求时发送，普通聊天仍然回复文字，不会自动把每条消息都变成语音。QQ 私聊和群聊都可以使用；较长内容会按句子拆成多条语音，超出本次语音长度的尾部会继续用文字发送。

当前语音由本地日文 TTS 生成，再经过瑞希音色模型转换。音色转换主要改变声音特征，情绪、停顿和日语读音仍会受到基础 TTS 与输入文本的影响，建议使用自然标点和较短的日文句子。

如果没有收到语音，可能是当前实例尚未启用、语音服务暂时不可用，或本次发送状态无法确认；请不要连续重复发送同一请求，避免稍后收到重复消息。
```

## 更新公告长版

```text
【更新公告｜QQ 按需语音与瑞希本地音色】

本次更新为 QQ 私聊和群聊增加了按需语音回复。用户明确要求“语音回复”“朗读”“说给我听”等操作时，瑞希会生成 MP3 并以 QQ 原生 record 消息发送；没有明确语音要求时，机器人仍按原方式回复文字。

当前语音链路完全运行在本机：先由轻量日文 Piper TTS 生成基础语音，再通过瑞希 So-VITS-SVC 音色模型转换，最后生成 QQ 可以发送的 MP3。文本不会为了语音生成而自动切换到外部 TTS 服务。

可以直接尝试：

“请用语音回复：おはよう、今日も一緒に頑張ろう。”
“把你刚才的回答用语音说给我听。”
“朗读这段日文：無理しなくてもいいよ。ゆっくり休もう。”
“用语音简单介绍一下今天的计划。”

较长文本会先按中英文句末标点拆分，每段最多 300 字，一次最多生成 4 段语音；超过本次上限的剩余内容会以文字继续发送。各段按顺序生成和发送，不会为了加速而打乱顺序。

生成语音失败，或 QQ 明确表示消息尚未提交时，机器人会把对应片段改为文字并继续处理；如果发送结果无法确认，则不会自动重发语音或补发文字，以免产生重复消息。

当前版本优先保证 QQ 可用。Discord 音频附件、微信语音、CosyVoice 高质量基础模型和 SVC 微调训练尚未作为正式能力开放。瑞希音色模型负责音色转换，不等于完整复刻原角色的情绪、演技和所有说话方式。
```

## 普通用户使用说明

### 1. 明确提出语音要求

只有明确要求语音时才会触发，例如：

```text
用语音回复我。
把上一段朗读出来。
说给我听：今日はちょっと疲れたな。
用日语语音对我说晚安。
```

只发送“你好”“在吗”或普通问题不会自动生成语音。

### 2. 优先使用自然日文和标点

当前基础模型以日文为主。为了获得更稳定的读音和停顿：

- 使用完整的日文句子，并保留 `。`、`！`、`？`、`、` 等标点。
- 人名、缩写、英文和生僻汉字可能出现读音偏差，可以改成假名后重试。
- 一次请求尽量控制在几句话内；短句通常比连续长段落更自然。
- SVC 主要迁移音色，源 TTS 语气平淡时，转换后也不会凭空产生强烈情绪。

### 3. 长文本处理方式

- 先按中英文句末标点分段。
- 单段最多 300 字，单句过长时按 300 字硬切。
- 一次最多处理 4 段，即最多约 1200 字。
- 超出上限的尾部不生成语音，改为文字发送。
- 同一次请求中的语音和文字回退按原顺序发送。

### 4. 失败时怎么处理

- 对应片段生成失败：机器人发送该片段文字，并继续后面的内容。
- QQ 明确未提交语音：机器人发送该片段文字，并继续后面的内容。
- QQ 发送状态不确定：机器人停止本次后续语音，不自动重发，也不补发同一段文字。
- 整个功能关闭、没有本地 Provider 或当前消息缺少精确投递目标：只发送一次完整文字回复。

## 管理员部署与使用说明

### 1. 当前本地链路

```text
日文文本
  -> Piper ja_JA-hi_fi_captain-medium（CPU）
  -> 基础 WAV
  -> 瑞希 mzk.pth So-VITS-SVC（CUDA）
  -> 44.1 kHz WAV
  -> imageio-ffmpeg 内置 FFmpeg
  -> MP3
  -> MizukiBot 本地 Provider
  -> QQ OneBot record
```

模型服务独立放在 `D:\tts-models`，不在 MizukiBot Node 进程内加载模型，也不使用容器。

### 2. 配置模型服务

编辑 `D:\tts-models\.env`：

```dotenv
VOICE_SIDECAR_PORT=6843

COMPANION_VOICE_LOCAL_TTS_ENABLED=true
COMPANION_VOICE_LOCAL_SVC_ENABLED=true

LOCAL_TTS_BACKEND=piper
PIPER_MODEL_PATH=models/piper/ja_JA-hi_fi_captain-medium.onnx
PIPER_CONFIG_PATH=models/piper/ja_JA-hi_fi_captain-medium.onnx.json
PIPER_USE_CUDA=false

MZK_SVC_MODEL_PATH=models/mzk/models/mzk.pth
MZK_SVC_CONFIG_PATH=models/mzk/models/mzk.json
MZK_SVC_SPEAKER=mzk
MZK_SVC_DEVICE=cuda
MZK_SVC_F0_PREDICTOR=rmvpe
MZK_SVC_TRANSPOSE=0

VOICE_FFMPEG_PATH=auto
VOICE_SIDECAR_MAX_TEXT_CHARS=300
```

两个模型开关的含义：

- TTS 开、SVC 开：Piper 生成基础语音，再转换为瑞希音色；当前推荐配置。
- TTS 开、SVC 关：只输出 Piper 基础语音，用于排查 SVC 问题或对比音色。
- TTS 关、SVC 关：sidecar 可以启动，但 `/synthesize` 不提供语音生成。
- TTS 关、SVC 开：无效组合；SVC 不能直接把文本转换成语音。

`LOCAL_TTS_BACKEND=cosyvoice` 只预留给后续高质量基础 TTS；当前机器尚未完成 CosyVoice 模型和依赖验收，不应在生产配置中切换。

### 3. 配置 MizukiBot

编辑 `D:\waifu\.env`：

```dotenv
COMPANION_VOICE_ENABLED=true
COMPANION_VOICE_PROVIDER=local
COMPANION_VOICE_LOCAL_API_URL=http://127.0.0.1:6843/synthesize
COMPANION_VOICE_LOCAL_API_KEY=
COMPANION_VOICE_NAME=mizuki
COMPANION_VOICE_SPEED=1
COMPANION_VOICE_TIMEOUT_MS=15000
COMPANION_VOICE_MAX_CHARS=300
COMPANION_VOICE_MAX_SEGMENTS=4
COMPANION_VOICE_MAX_CONCURRENCY=2
```

本地服务没有配置 Bearer Token 时，`COMPANION_VOICE_LOCAL_API_KEY` 保持为空。外部 Provider 与本地 Provider 不会自动互相回退。

### 4. 启动顺序

先启动本地模型服务：

```text
cd /d D:\tts-models
run.cmd
```

确认健康状态：

```text
curl.exe http://127.0.0.1:6843/health
```

正常结果应至少包含：

```json
{
  "status": "ready",
  "pipelineLoaded": true,
  "ttsEnabled": true,
  "svcEnabled": true,
  "ttsBackend": "piper",
  "piperModelPresent": true,
  "svcModelPresent": true,
  "svcConfigPresent": true,
  "svcDevice": "cuda",
  "svcF0Predictor": "rmvpe"
}
```

健康检查通过后，再启动或重启 MizukiBot。

### 5. HTTP 合成检查

```text
curl.exe -X POST http://127.0.0.1:6843/synthesize ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"瑞希のテスト音声です。\",\"voice\":\"mizuki\",\"speed\":1,\"format\":\"mp3\"}" ^
  --output mizuki-test.mp3
```

确认返回 `Content-Type: audio/mpeg`，并实际播放 `mizuki-test.mp3`。不要只根据 HTTP 200 判断音频质量。

### 6. QQ 端验收

至少分别执行一次：

1. QQ 私聊发送：“请用语音说：おはよう、今日も頑張ろう。”
2. QQ 群聊 @机器人发送：“用语音说一句晚安。”
3. 确认收到的是可播放的 QQ `record` 语音，而不是 Base64 文本或普通文件附件。
4. 发送超过 300 字但不超过 1200 字的文本，确认多段语音顺序正确。
5. 临时关闭 SVC，只开 TTS，对比基础 Piper 与瑞希音色转换结果。

完成私聊和群聊实收后，才将本文的群公告短版对外发布。

## 常见问题

### 明确要求语音后仍只收到文字

依次检查：

1. MizukiBot 的 `COMPANION_VOICE_ENABLED` 是否为 `true`。
2. `COMPANION_VOICE_PROVIDER` 是否为 `local`。
3. sidecar `/health` 是否为 `ready`。
4. TTS 和 SVC 模型路径是否存在。
5. NapCat 是否已连接，当前消息是否来自 QQ 私聊或群聊。

如果日志显示 TTS 失败或 QQ 明确未提交，文字回复属于预期回退，不应再由主回复管线重复发送原文。

### 日语读音或停顿不自然

- 补充句号、逗号和问号，避免整段没有标点。
- 将容易误读的人名或汉字换成假名。
- 先关闭 SVC 试听 Piper 原音：如果原音已经误读，问题不在音色模型。
- 当前 Piper 是优先上线的小模型，后续 CosyVoice 才是更高质量基础语音方向。

### 音色相似但情绪不足

So-VITS-SVC 负责音频到音频的音色转换，不负责理解文本和重新表演。当前情绪上限主要由 Piper 源音频决定；在不更换基础 TTS 的前提下，可以先通过标点、短句和更自然的措辞改善节奏，但不能把它当成完整的情感控制系统。

### 显存是否足够

当前实测链路让 Piper 使用 CPU、SVC 使用 CUDA，RTX 5070 上峰值显存约 1.34 GB。该数字是当前短日文样例的推理结果，不代表训练显存，也不代表所有长度输入都固定占用相同显存。

## 当前能力边界

- 正式目标仅为 QQ 私聊和群聊按需语音；普通回复不会自动语音化。
- 不实现 Discord 语音频道播放。
- Discord 音频附件和微信语音尚未完成正式验收。
- 不在机器人进程内加载、训练或管理本地模型。
- 不在外部 TTS 与本地 TTS 之间自动切换。
- 当前使用预训练瑞希 SVC 权重，尚未进行自有数据微调训练。
- 当前未完成 CosyVoice 高质量基础 TTS。
- 角色音色模型、训练数据和相关素材的使用权需要由部署者自行确认。

## 当前验收状态

截至 2026-09-06 22:21 +08:00：

- Piper、瑞希 SVC、ContentVec 和 RMVPE 已在本机加载成功。
- sidecar 6 项单元测试与 Python 依赖检查通过。
- Piper → 瑞希 SVC → MP3 真实串联通过，输出为 44.1 kHz MP3。
- Node 本地 Provider 与当前 `.env` 完整语音服务调用通过，两段日文均得到 `accepted + record`，没有文字回退。
- QQ Provider、私聊/群聊 OneBot `record` 结构、工具上下文和授权定向测试通过。
- `npm run lint`、`npm run typecheck`、`npm run check:secrets:all` 和 `git diff --check` 通过。
- 真实 QQ 私聊与群聊客户端收音仍需管理员手动完成。
- 完整 `npm test` 仍有两个既有 prompt manifest/allowlist 失败和一个既有语音输入超时配置期望不一致；这些失败不属于本次语音输出功能。
