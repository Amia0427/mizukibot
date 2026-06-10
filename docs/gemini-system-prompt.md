# Gemini 系统提示词资产

更新 2026-06-02 20:43 +08:00：新增 `prompts/GEMINI.txt`，作为 Gemini 模型独立系统提示词资产。

更新 2026-06-02 21:39 +08:00：将 `prompts/GEMINI.txt` 从通用写作提示词收敛为 MizukiBot QQ 群聊瑞希运行适配层，只补充 Gemini 在群聊、被动感知、图片/引用、记忆证据和工具结果场景的输出纪律，不重复 persona 正文。

更新 2026-06-02 21:44 +08:00：提高安全源预设原文占比，主要引用“视角有限”“人格基底”“全局写作”“生活切片”和认知边界类句式；不引入高风险、不合规、特定人格接管、外显思维链或重复 persona 正文。

更新 2026-06-02 21:55 +08:00：新增“Gemini 语言风格约束”小节，参考源预设中“文风3-语言特化”“情感基准”“防重复”和语言选择类安全片段，强化简体中文、QQ 短消息、活人对白、节奏变化、情绪落点与去模板化；仍不引入脚本变量、隐藏思考输出、HTML 互动、特定人格身份或高风险内容。

更新 2026-06-03 08:24 +08:00：该文件已接入 Gemini native 出站适配层。显式 `API_PROVIDER=gemini_native` 或模型名匹配 `gemini-*` 时，HTTP 请求会转换为 Gemini `generateContent` body，并将 `prompts/GEMINI.txt` 作为 `[GeminiRuntimeAdapter]` 注入 `systemInstruction`；它仍不进入 prompt manifest，不改变非 Gemini 主回复编译顺序。

更新 2026-06-03 17:16 +08:00：Gemini native 主回复流式请求现在走 `streamGenerateContent?alt=sse`，不再为了该系统提示词适配层降级成非流式；`systemInstruction` 注入、工具声明转换和图片 part 转换逻辑与非流式共用。

## 使用方式

- `prompts/GEMINI.txt` 不在 `prompts/prompt-manifest.json` 中注册；只在 Gemini native provider 出站请求中作为 `systemInstruction` 追加。
- `GEMINI_NATIVE_SYSTEM_PROMPT_ENABLED=false` 可关闭自动注入；`GEMINI_SYSTEM_PROMPT_PATH` 可指向替代文件。
- 该文件不会改变瑞希 persona、runtime 动态块、security contract 或现有主回复注入顺序。

## 筛选原则

- 来源目录：`C:\Users\Administrator\Downloads\预设 gemini`。
- 只保留通用且可迁移的规则与安全原文：有限视角、上下文承接、因果一致、用户自主权、语言风格、节奏控制、动作和感官落地、减少模板腔。
- 排除所有特定人格、神格身份、来源元信息、预设教程、SillyTavern 变量/脚本、HTML 交互、外显思维链和高风险内容。

## 边界

- `GEMINI.txt` 是稳定提示词文本，不是角色卡、世界书或运行时策略。
- 项目特化只写适配规则：QQ 群聊短消息、被动群感知、上下文证据使用、工具结果转述和 Gemini 出戏防护；瑞希人设仍以 persona 目录为准。
- 后续若需要接入 manifest，应单独评估优先级、预算裁剪、与主回复 persona 的冲突，再补充测试。
