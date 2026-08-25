# 共读共看共听活动实施计划

> **For agentic workers:** This plan is tracked in the current task and will be updated with the verified result.

**Goal:** 在现有私聊共处房间中支持围绕具体书籍、视频或音频的限时陪伴与进度回忆。

**Architecture:** 扩展 `companion-room` 的解析、状态和运行时，保留原有计时、节点发送和回忆机制。内容活动只保存类型、标题和用户主动记录的进度，不下载或播放媒体。

**Tech Stack:** Node.js CommonJS、现有 companion-room 状态与 tick 引擎。

---

## Chunk 1: 命令与状态

- [x] 解析共读、共看、共听开始命令和显式进度命令。
- [x] 房间与回忆保存内容类型、标题和最后进度。
- [x] 旧状态无须迁移脚本即可继续读取。

## Chunk 2: 运行体验

- [x] 开始、状态、节点模型和结束回忆包含具体内容上下文。
- [x] 不声称 Bot 已实际播放、观看或读取媒体。

## Chunk 3: 验收

- [x] 通过解析、状态、运行时、模型和相邻房间测试。
- [ ] 更新 README 与共处房间文档，运行项目门禁并提交。
