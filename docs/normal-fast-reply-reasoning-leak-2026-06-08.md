# 普通用户快速回复思维链泄漏诊断

更新 2026-06-08 19:56 +08:00：最近普通用户群聊回复错误来自 `normal_fast_reply` 快速链路绕过正式 runtime V2 的最终输出校验。

## 现象

- 2026-06-08 19:24:32 +08:00，普通用户 `1052258894` 在群 `1092700300` 询问“诡化之花这首歌对应的剧情大概是什么”。
- 2026-06-08 19:25:04 +08:00，快速回复直接发送了英文自问式推理片段：`Maybe / What if / Wait / No`。
- 2026-06-08 19:35:14 +08:00，管理员在群里反馈“怎么把思维链弄出来了”。
- 2026-06-08 19:40:00 +08:00，普通用户追问后再次走 `normal_fast_reply`，发送了 `*Addressing the song:*` 这类草稿标记。

## 根因

`normal_fast_reply` 只做了基础 `sanitizeUserFacingText` 清洗，能剥离 `<think>`、`reasoning_content`、`internal_check` 等结构化泄漏，但没有识别自然语言版思维链痕迹。快速链路成功后会直接发送、写入短期历史和群感知上下文，因此坏回复继续污染下一轮上下文。

## 处理

- `utils/userFacingReplyGuards.js` 新增自然语言思维链泄漏识别：英文自问式推理、多段 `Maybe / What if / Wait`、`Addressing the ...:` 草稿标记，以及中文“思维链/推理过程/内部思考”显式泄漏。
- `core/normalFastReplyRuntime.js` 在返回快速回复前复用 `isUnsafeUserFacingReply` 校验；命中时抛出 `NORMAL_FAST_REPLY_UNSAFE_USER_FACING_REPLY`，由上层既有 catch 回退正式链路。
- 新增回归测试覆盖本次日志里的两类坏样式。

## 验证

```powershell
node tests\userFacingReplyGuards.test.js
node tests\normalFastReplyRuntime.test.js
```
