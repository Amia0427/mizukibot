# Android APK Feasibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 评估并重写“把 MizukiBot 打包成安卓 APK”的方案边界，先输出可执行迁移路线，不改现有项目代码。

**Architecture:** 不做原项目完整 APK 打包。推荐把目标收敛为“手机本地前端对话 SKU”：React Native 负责界面，`nodejs-mobile-react-native` 仅承载一个裁剪后的 Node 后台对话内核，NapCat/OneBot/QQ 机器人能力先全部剥离；QuickJS/V8 只作为后续更大重写路线，不进入第一版 APK。

**Tech Stack:** React Native、nodejs-mobile-react-native、Node.js mobile 18.x、Android Gradle Plugin 8.5.1+、Android NDK r28+、现有 Node.js CommonJS 模块的裁剪子集。

---

## 结论

- 原样打包当前项目为安卓 APK：不可取，可行性低。当前仓库声明 Node.js `>=20.0.0`，实际依赖含 `@lancedb/lancedb`、`better-sqlite3`、`sharp`、`cycletls`、`express`、`ws`、`@langchain/langgraph` 等服务端/原生依赖；入口还绑定 NapCat HTTP reverse/WebSocket、文件日志、后台 worker、诊断脚本和本机数据目录。把这整套塞入 APK 会同时踩 Node 版本、原生 ABI、后台保活、文件路径、QQ 登录/协议和 16 KB page size。
- `nodejs-mobile-react-native` 裁剪路线：可做 PoC，前提是只保留手机前端对话，不保留 NapCat-onebot QQ 机器人。当前 npm 最新核验为 `nodejs-mobile-react-native@18.20.4`，与项目 Node `>=20` 不一致，所以不能直接复用整仓运行时，必须抽离移动子集。
- QuickJS/V8 嵌入路线：不适合作为第一版。QuickJS 很小、易嵌入，但没有 Node API/npm/native addon 生态；V8 是 JS 引擎，不等于 Node 运行时，嵌入需要 C++/JNI/宿主 API/安全模型/构建系统，工作量接近重写移动运行时。
- 最优先路线：做“APK 壳 + 裁剪对话内核”。若目标只是安卓手机可用，最快是 React Native/WebView 前端连接现有本地或远端 Node 服务；若目标必须端上自运行，再用 `nodejs-mobile-react-native` 承载最小对话内核。

## 证据

- 本地依赖核验：`npm ls @lancedb/lancedb better-sqlite3 sharp cycletls express ws @langchain/langgraph @langchain/core axios --depth=0` 通过，确认当前运行时依赖包含多个 Android 原生打包高风险模块。
- 本地版本核验：`npm view nodejs-mobile-react-native version time engines peerDependencies dependencies --json` 返回最新版本 `18.20.4`，发布时间为 2024-10-07；项目 `package.json` 要求 Node.js `>=20.0.0`。
- 官方文档核验：`nodejs-mobile-react-native` 会把 `nodejs-assets/nodejs-project/` 打进应用，并在独立线程启动 `main.js`；Android 原生模块需要 NDK/CMake，可检测和构建 `.node` 原生模块，也支持 Android/iOS prebuild。
- QuickJS 官方说明：QuickJS 是小型可嵌入 JS 引擎，当前 2026-06-04 发布版支持 ES2025，适合嵌入但不是 Node 兼容层。
- V8 官方嵌入文档显示需要宿主用 C++ 管理 context、object template、callback、安全 token 等；这不是“把 Node 项目放进去”的路径。
- Android 官方 16 KB page size 文档要求使用原生代码的 app 检查 `.so` ELF alignment，建议 AGP 8.5.1+ 和 NDK r28+；所有预编译 native 库都要兼容。

## 方案修正

原方案：

```text
嵌入 V8/QuickJS 或用 nodejs-mobile-react-native，把本项目打包成安卓 APK。
```

修正后：

```text
第一阶段只做安卓本地对话 APK，不做 QQ 机器人。
React Native 承担 UI；nodejs-mobile-react-native 承担最小 Node 对话后台。
移动后台只接收 UI 发来的 local_chat 事件，复用有限 prompt/模型调用/轻量记忆逻辑。
NapCat/OneBot/QQ action/Qzone/群调度/post-reply worker/Telegram/Minecraft/MCP/本地命令桥/向量索引先全部禁用。
QuickJS/V8 作为二期或三期重写路线，不用于第一版验证。
```

## 移动版保留范围

第一版保留：

- 手机前端单人对话 UI。
- 文本输入、模型回复、基础 loading/error 状态。
- 远程 LLM HTTPS 调用。
- 最小 persona/prompt 资产。
- 最近若干轮本地历史。
- 可选轻量 JSON 存储，先不接 SQLite/LanceDB。

第一版不保留：

- NapCat/OneBot/QQ 登录、收发、群聊、戳一戳、表情贴图、Qzone。
- `post-reply-worker`、life scheduler、daily share、被动群感知。
- LanceDB 向量索引、`better-sqlite3` Profile Journal 主读、`sharp` 图片处理、`cycletls` TLS 指纹伪装。
- MCP、skills native、本地命令桥、外部子进程。
- Telegram、Minecraft、Web 管理台和诊断 CLI。

## 路线选择

| 路线 | 可行性 | 适用目标 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- |
| 原样打包全项目进 APK | 低 | 想完整复制 Windows/服务端 bot | Node 20 不匹配、native addon、后台保活、NapCat/QQ 协议、数据体积 | 不推荐 |
| React Native + nodejs-mobile 裁剪内核 | 中 | 手机前端本地对话 | Node 18 兼容、模块抽离、native 依赖必须避开 | 推荐做 PoC |
| QuickJS 裁剪内核 | 中低 | 纯 JS 策略/提示词引擎 | 没有 Node API，需要重写 HTTP/存储/模块加载边界 | 后续可评估 |
| 直接嵌入 V8 | 低 | 自研移动 JS 宿主 | C++/JNI/API/安全沙箱/构建系统重，仍缺 Node API | 不推荐首版 |
| 安卓壳 + 现有 Node 后端 | 高 | 只要手机可用，不要求端上自运行 | 依赖本地/远端服务在线 | 最快交付 |

## Chunk 1: 移动边界冻结

### Task 1: 冻结移动 SKU 契约

**Files:**
- Create: `docs/mobile-apk/contracts.md`
- Create: `tests/fixtures/mobile-chat/local-chat-events/`

- [ ] **Step 1: 定义移动入站事件**

只允许本地 UI 事件：

```json
{
  "type": "local_chat",
  "conversationId": "default",
  "userId": "mobile-user",
  "text": "今晚聊点什么",
  "createdAt": 1781543580000
}
```

- [ ] **Step 2: 定义移动出站事件**

```json
{
  "type": "assistant_reply",
  "conversationId": "default",
  "text": "可以呀。",
  "finishReason": "stop"
}
```

- [ ] **Step 3: 写禁用清单**

在 `docs/mobile-apk/contracts.md` 明确第一版不接 QQ/NapCat/OneBot，也不接任何平台 action。

- [ ] **Step 4: 提交**

```bash
git add docs/mobile-apk/contracts.md tests/fixtures/mobile-chat
git commit -m "docs: freeze mobile chat apk contract"
```

## Chunk 2: 裁剪内核设计

### Task 2: 建立 mobile runtime adapter

**Files:**
- Create: `mobile/nodejs-project/main.js`
- Create: `mobile/nodejs-project/package.json`
- Create: `src/mobile/chatRuntime.js`
- Create: `tests/mobileChatRuntime.test.js`

- [ ] **Step 1: 写失败测试**

断言 `handleMobileChat({ text: "你好" })` 不加载 NapCat，不访问 `data/lancedb*`，只返回 assistant text 或 mock model 输出。

- [ ] **Step 2: 实现最小 adapter**

`main.js` 只做 `rn-bridge` 消息收发：

```js
const rnBridge = require('rn-bridge');
const { handleMobileChat } = require('./chatRuntime');

rnBridge.channel.on('message', async (event) => {
  const result = await handleMobileChat(event);
  rnBridge.channel.send(result);
});
```

- [ ] **Step 3: 显式隔离禁用模块**

移动入口不得 import：

```text
index.js
core/messageHandler*
core/napcat*
api/qqAction*
utils/lancedbMemoryStore*
utils/profileJournalDb*
scripts/*
web/*
```

- [ ] **Step 4: 提交**

```bash
git add mobile src/mobile tests/mobileChatRuntime.test.js
git commit -m "feat: add mobile chat runtime adapter"
```

## Chunk 3: React Native 壳验证

### Task 3: 建立安卓 PoC

**Files:**
- Create: `mobile/android-app/`
- Create: `docs/mobile-apk/android-build.md`

- [ ] **Step 1: 创建 React Native app**

引入 `nodejs-mobile-react-native`，把 `mobile/nodejs-project` 打入 `nodejs-assets/nodejs-project/`。

- [ ] **Step 2: 实现单屏对话 UI**

只做消息列表、输入框、发送按钮、错误提示。

- [ ] **Step 3: Android 构建约束**

使用 AGP 8.5.1+、NDK r28+；生成 APK 后必须检查：

```powershell
llvm-objdump.exe -p .\app-release.apk_extracted\lib\arm64-v8a\*.so | Select-String "LOAD"
zipalign.exe -v -c -P 16 4 .\app-release.apk
```

- [ ] **Step 4: 提交**

```bash
git add mobile/android-app docs/mobile-apk/android-build.md
git commit -m "feat: add android mobile chat poc"
```

## 验收标准

- 当前 Node bot 不受影响，`git diff` 不包含运行代码改动。
- 移动运行时单测证明不加载 NapCat/OneBot/QQ action。
- Android 真机或模拟器能完成一次“输入文本 -> 模型回复 -> UI 展示”。
- 关闭 app 后重新打开，最近对话仍可恢复。
- release APK 通过 16 KB zipalign/ELF alignment 检查。
- 文档记录每次验收命令、时间、结果。

## 当前评估验收

- PASS 2026-06-16 01:13 +08:00：只读检查 `npm ls @lancedb/lancedb better-sqlite3 sharp cycletls express ws @langchain/langgraph @langchain/core axios --depth=0` 通过，确认当前依赖边界。
- PASS 2026-06-16 01:13 +08:00：只读检查 `npm view nodejs-mobile-react-native version time engines peerDependencies dependencies --json` 通过，确认当前 npm 最新 `18.20.4` 与本项目 Node `>=20.0.0` 存在版本落差。
- PASS 2026-06-16 01:13 +08:00：已核对官方文档：nodejs-mobile React Native 插件、QuickJS、V8 embedding、Android 16 KB page size。
- PASS 2026-06-16 01:13 +08:00：本轮仅新增/更新文档方案，未修改项目运行代码。

## 参考链接

- nodejs-mobile-react-native README: https://github.com/nodejs-mobile/nodejs-mobile-react-native/blob/main/README.md
- QuickJS: https://bellard.org/quickjs/
- V8 Embedder Guide: https://v8.dev/docs/embed
- Android 16 KB page sizes: https://developer.android.com/guide/practices/page-sizes
