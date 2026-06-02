# Gemini 系统提示词资产

更新 2026-06-02 20:43 +08:00：新增 `prompts/GEMINI.txt`，作为 Gemini 模型独立系统提示词资产。

## 使用方式

- `prompts/GEMINI.txt` 不在 `prompts/prompt-manifest.json` 中注册，不参与当前主回复 prompt 编译链。
- 需要给 Gemini 单独注入稳定系统提示词时，外部调用方可直接读取该文件内容。
- 该文件不会改变瑞希 persona、runtime 动态块、security contract 或现有主回复注入顺序。

## 筛选原则

- 来源目录：`C:\Users\Administrator\Downloads\预设 gemini`。
- 只保留通用且可迁移的规则：有限视角、上下文承接、因果一致、用户自主权、节奏控制、动作和感官落地、减少模板腔。
- 排除所有特定人格、神格身份、作者声明、预设教程、SillyTavern 变量/脚本、HTML 交互、外显思维链和高风险内容。

## 边界

- `GEMINI.txt` 是稳定提示词文本，不是角色卡、世界书或运行时策略。
- 后续若需要接入 manifest，应单独评估优先级、预算裁剪、与主回复 persona 的冲突，再补充测试。
