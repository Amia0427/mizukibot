# Gemini 系统提示词资产

更新 2026-06-02 20:43 +08:00：新增 `prompts/GEMINI.txt`，作为 Gemini 模型独立系统提示词资产。

更新 2026-06-02 21:39 +08:00：将 `prompts/GEMINI.txt` 从通用写作提示词收敛为 MizukiBot QQ 群聊瑞希运行适配层，只补充 Gemini 在群聊、被动感知、图片/引用、记忆证据和工具结果场景的输出纪律，不重复 persona 正文。

更新 2026-06-02 21:44 +08:00：提高安全源预设原文占比，主要引用“视角有限”“人格基底”“全局写作”“生活切片”和认知边界类句式；不引入高风险、不合规、特定人格接管、外显思维链或重复 persona 正文。

更新 2026-06-02 21:55 +08:00：新增“Gemini 语言风格约束”小节，参考源预设中“文风3-语言特化”“情感基准”“防重复”和语言选择类安全片段，强化简体中文、QQ 短消息、活人对白、节奏变化、情绪落点与去模板化；仍不引入脚本变量、隐藏思考输出、HTML 互动、特定人格身份或高风险内容。

更新 2026-06-03 08:24 +08:00：该文件已接入 Gemini native 出站适配层。显式 `API_PROVIDER=gemini_native` 或模型名匹配 `gemini-*` 时，HTTP 请求会转换为 Gemini `generateContent` body，并将 `prompts/GEMINI.txt` 作为 `[GeminiRuntimeAdapter]` 注入 `systemInstruction`；它仍不进入 prompt manifest，不改变非 Gemini 主回复编译顺序。

更新 2026-06-03 17:16 +08:00：Gemini native 主回复流式请求现在走 `streamGenerateContent?alt=sse`，不再为了该系统提示词适配层降级成非流式；`systemInstruction` 注入、工具声明转换和图片 part 转换逻辑与非流式共用。

更新 2026-06-13 01:53 +08:00：最近 48 小时真实样本诊断显示，当前 `prompts/GEMINI.txt` 已通过 `prompts/prompt-manifest.json` 的 `model_pattern=gemini` 进入 OpenAI-compatible Gemini 主回复，不再只是 Gemini native `systemInstruction` 适配层。旧文本中的“从容、细腻、周全”“张力呼吸”等叙事写作锚点会压过 QQ 短消息 persona，放大 `诶——/呜哇/呢/喔/♪` 固定口吻。现已收敛为短消息、防出戏、证据使用和重复口癖抑制规则。小目标已完成：Gemini 条件系统提示词不再推动轻小说式口吻坍缩。

更新 2026-06-13 02:23 +08:00：补齐注入链路回归，不改变温度、top_p、top_k 或其它模型配置。稳定 prompt cache、`buildPromptSnapshot` 和 Gemini native `systemInstruction` 组装都按 `modelName` 识别 Gemini 条件块；native provider 发现 manifest 已经带入 `prompts/GEMINI.txt` 时只追加 `[GeminiRuntimeAdapter]` 标记，不重复粘贴全文。`tests/promptGoldenSnapshots.test.js` 会同时检查当前 `GEMINI.txt`、Gemini 稳定块和 native systemInstruction 不包含高风险通用 Gemini 预设里的模板化、过度顺从或僵硬节奏文案。小目标已完成：采样退化缓解限定在提示词注入链路。

## 使用方式

- `prompts/GEMINI.txt` 已在 `prompts/prompt-manifest.json` 中注册为 `gemini_system_prompt`，当模型名包含 `gemini` 时作为稳定系统块进入主回复 prompt。
- Gemini native provider 会在 `systemInstruction` 前部写入 `[GeminiRuntimeAdapter]`。如果上游 system messages 已包含 manifest 注入的 `prompts/GEMINI.txt`，native provider 不再重复追加全文；如果没有，则补入 `[GeminiRuntimeAdapter]\nGEMINI.txt`。
- `GEMINI_NATIVE_SYSTEM_PROMPT_ENABLED=false` 可关闭自动注入；`GEMINI_SYSTEM_PROMPT_PATH` 可指向替代文件。
- 该文件只做模型适配，不写独立人设、世界观、叙事文风或安全绕过。
- 仓库根目录的 `通用gemini.txt` 若存在，只作为本地诊断输入；其中通用预设、anti-refusal 或 compliance override 文案不得进入 manifest、native adapter 或提交。

## 筛选原则

- 来源目录：`C:\Users\Administrator\Downloads\预设 gemini`。
- 只保留通用且可迁移的模型适配规则：有限视角、上下文承接、QQ 短消息、防模板腔、防出戏、证据边界和重复口癖抑制。
- 排除所有特定人格、神格身份、来源元信息、预设教程、SillyTavern 变量/脚本、HTML 交互、外显思维链和高风险内容。

## 边界

- `GEMINI.txt` 是稳定模型适配文本，不是角色卡、世界书或通用写作预设。
- 项目特化只写适配规则：QQ 短消息、上下文证据使用、工具结果转述和 Gemini 出戏防护；瑞希人设仍以 persona 目录为准。
- 后续若调整 manifest 优先级或 native 注入策略，应单独评估预算裁剪、重复注入和与 `persona/02_style.txt` 的冲突。
