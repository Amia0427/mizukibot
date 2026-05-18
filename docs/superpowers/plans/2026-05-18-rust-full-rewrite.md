# Rust Full Rewrite Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 MizukiBot 从现有 Node.js + LangGraph 运行时完整重写为 Rust 实现，并在最终上线时一次性替换线上 Node 运行时。

**Architecture:** 采用“兼容契约优先 + Rust 新运行时离线完整建设 + 全量验收 + 一次性 cutover”的方案。先冻结现有 Node 行为和数据格式，再用 Rust workspace 重建入口、路由、执行计划、图运行时、工具、记忆、后台任务和部署脚本，最后在维护窗口内停止 Node、启动 Rust；失败则整体回滚到 Node。

**Tech Stack:** Rust stable、Tokio、Axum、tokio-tungstenite、Serde、Reqwest、SQLx 或 sled、tracing、clap、anyhow/thiserror、proptest、insta、criterion。

---

## 迁移原则

- 上线方式明确为一次性替换。Rust 版本未达到全量验收前不接管线上 QQ 消息；达到后在维护窗口内整体替换 Node。
- 先迁移契约，再迁移实现。所有跨模块边界先用 schema 固化。
- 先覆盖主链，再覆盖增强能力。主链是 NapCat 入站、路由、执行计划、回复、持久化。
- prompt、记忆、数据文件优先保持兼容，避免迁移时丢上下文。
- 每个开发阶段必须能单独运行、单独测试；生产回滚以“整套 Rust 退出、整套 Node 恢复”为准。
- Rust 实现不复刻 JavaScript 文件结构，而是复刻行为边界和数据契约。

---

## 目标系统边界

必须覆盖 README 中这些能力：

- NapCat / OneBot WebSocket 接入。
- 群聊和受限私聊入口。
- 消息接入、reply、quote、图片、连续消息上下文。
- canonical route contract。
- route execution plan。
- direct reply、background direct、full subagent 等 executor。
- LangGraph V2 等价运行时拓扑。
- prompt manifest、stage、priority、conflict tags、budget trimming。
- 分层记忆、本地知识、notebook、daily journal、Memory V3。
- 工具注册、工具策略、本地访问边界。
- 被动群感知、主动任务、scheduler、post-reply worker。
- Windows / Linux 运维入口。
- 诊断命令和测试入口。

---

## Rust Workspace 目标结构

建议新建独立 Rust workspace，不直接混进现有 JS 目录：

```text
rust/
  Cargo.toml
  crates/
    mizuki-app/              二进制入口，启动主进程
    mizuki-config/           .env、配置解析、路径约束
    mizuki-onebot/           NapCat / OneBot WebSocket 协议
    mizuki-ingress/          入站消息标准化
    mizuki-router/           canonical route contract
    mizuki-execution/        route execution plan 和 policy
    mizuki-runtime/          Rust 图运行时
    mizuki-model/            模型 Provider 抽象
    mizuki-prompt/           prompt manifest 和 compiler
    mizuki-tools/            工具注册、执行和权限
    mizuki-memory/           Memory V3、短期记忆、journal
    mizuki-knowledge/        本地知识和 notebook
    mizuki-background/       scheduler、tick、post-reply worker
    mizuki-subagent/         子代理桥接
    mizuki-web/              本地 Web 服务和诊断 API
    mizuki-diagnostics/      CLI 诊断命令
    mizuki-testkit/          golden tests、fixtures、mock OneBot
```

边界建议：

- `mizuki-onebot` 只懂 OneBot 协议和 WebSocket，不懂业务路由。
- `mizuki-ingress` 只把原始事件变成统一 `InboundMessageContext`。
- `mizuki-router` 只产出 canonical route contract，不执行工具。
- `mizuki-execution` 只把 route 转成 execution plan。
- `mizuki-runtime` 只编排节点和状态，不直接绑定 NapCat。
- `mizuki-tools` 负责工具权限、注册和执行。
- `mizuki-memory` 和 `mizuki-knowledge` 分离，避免 notebook 变成唯一知识入口。

---

## 兼容契约

Rust 重写前必须冻结这些契约：

- 入站事件：OneBot 原始 JSON。
- 标准化消息：`InboundMessageContext`。
- 顶层 route：`ignore`、`refuse`、`admin`、`direct_chat`。
- execution plan：`executor`、`policyKey`、`allowTools`、`allowedTools`、`allowStream`、`needsBackground`、`unavailableReason`。
- runtime state：`request`、`thread`、`memory`、`plan`、`execution`、`output`、`messages`、`events`。
- prompt manifest。
- Memory V3 events / projections。
- post-reply job 文件。
- scheduler task 文件。
- 诊断输出字段。

这些契约要变成 JSON schema、Rust struct 和 fixture，作为迁移的验收依据。

---

## Chunk 1: 行为冻结与迁移基线

### Task 1: 建立契约快照

**Files:**
- Create: `docs/rust-rewrite/contracts.md`
- Create: `tests/fixtures/rust-rewrite/onebot-events/`
- Create: `tests/fixtures/rust-rewrite/route-contracts/`
- Create: `tests/fixtures/rust-rewrite/execution-plans/`
- Create: `tests/fixtures/rust-rewrite/runtime-states/`

- [ ] **Step 1: 从现有主链采样真实事件**

采样内容：

- 群聊普通文字。
- 群聊 reply / quote。
- 群聊图片。
- 私聊白名单消息。
- admin 命令。
- 应被 ignore 的消息。
- 应被 refuse 的消息。
- 需要工具的 direct_chat。
- 需要 background_direct 的请求。
- 需要 full_subagent 的请求。

- [ ] **Step 2: 保存原始 OneBot JSON fixture**

每类消息保存为一个 fixture，命名格式：

```text
tests/fixtures/rust-rewrite/onebot-events/<case-name>.json
```

- [ ] **Step 3: 保存 Node 当前输出**

对每个 fixture 保存：

```text
tests/fixtures/rust-rewrite/route-contracts/<case-name>.json
tests/fixtures/rust-rewrite/execution-plans/<case-name>.json
tests/fixtures/rust-rewrite/runtime-states/<case-name>.json
```

- [ ] **Step 4: 编写契约说明**

`docs/rust-rewrite/contracts.md` 必须说明：

- 字段含义。
- 是否必填。
- 默认值。
- 兼容策略。
- Rust 是否允许扩展字段。

- [ ] **Step 5: 提交**

```bash
git add docs/rust-rewrite/contracts.md tests/fixtures/rust-rewrite
git commit -m "docs: freeze runtime contracts for rust rewrite"
```

### Task 2: 建立 Rust workspace 骨架

**Files:**
- Create: `rust/Cargo.toml`
- Create: `rust/crates/mizuki-app/Cargo.toml`
- Create: `rust/crates/mizuki-app/src/main.rs`
- Create: `rust/crates/mizuki-config/Cargo.toml`
- Create: `rust/crates/mizuki-config/src/lib.rs`

- [ ] **Step 1: 创建 workspace**

`rust/Cargo.toml`：

```toml
[workspace]
resolver = "2"
members = [
  "crates/mizuki-app",
  "crates/mizuki-config"
]

[workspace.package]
edition = "2021"
license = "UNLICENSED"
publish = false

[workspace.dependencies]
anyhow = "1"
thiserror = "1"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

- [ ] **Step 2: 创建最小主程序**

`rust/crates/mizuki-app/src/main.rs`：

```rust
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    let config = mizuki_config::Config::from_env()?;
    tracing::info!(data_dir = %config.data_dir.display(), "mizuki rust runtime starting");
    Ok(())
}
```

- [ ] **Step 3: 创建配置模块**

`rust/crates/mizuki-config/src/lib.rs`：

```rust
use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub napcat_ws_url: String,
    pub napcat_ws_token: Option<String>,
    pub data_dir: PathBuf,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required env var: {0}")]
    MissingEnv(&'static str),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let api_key = read_required("API_KEY")?;
        let napcat_ws_url = std::env::var("NAPCAT_WS_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "ws://127.0.0.1:3001".to_string());
        let napcat_ws_token = std::env::var("NAPCAT_WS_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let data_dir = std::env::var("DATA_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data"));

        Ok(Self {
            api_key,
            napcat_ws_url,
            napcat_ws_token,
            data_dir,
        })
    }
}

fn read_required(key: &'static str) -> Result<String, ConfigError> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(ConfigError::MissingEnv(key))
}
```

- [ ] **Step 4: 运行检查**

```bash
cd rust
cargo check
```

Expected: 编译通过。

- [ ] **Step 5: 提交**

```bash
git add rust
git commit -m "feat: scaffold rust workspace"
```

---

## Chunk 2: OneBot 接入与消息标准化

### Task 3: 实现 OneBot 协议模型

**Files:**
- Create: `rust/crates/mizuki-onebot/Cargo.toml`
- Create: `rust/crates/mizuki-onebot/src/lib.rs`
- Create: `rust/crates/mizuki-onebot/src/event.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 增加 crate**

workspace members 加入：

```toml
"crates/mizuki-onebot"
```

- [ ] **Step 2: 定义事件结构**

核心结构：

```rust
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct OneBotEvent {
    pub post_type: Option<String>,
    pub message_type: Option<String>,
    pub sub_type: Option<String>,
    pub message_id: Option<i64>,
    pub group_id: Option<i64>,
    pub user_id: Option<i64>,
    pub raw_message: Option<String>,
    pub message: serde_json::Value,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}
```

- [ ] **Step 3: 添加 fixture 反序列化测试**

测试所有 `tests/fixtures/rust-rewrite/onebot-events/*.json`。

- [ ] **Step 4: 运行测试**

```bash
cd rust
cargo test -p mizuki-onebot
```

- [ ] **Step 5: 提交**

```bash
git add rust
git commit -m "feat: add onebot event model"
```

### Task 4: 实现入站标准化

**Files:**
- Create: `rust/crates/mizuki-ingress/Cargo.toml`
- Create: `rust/crates/mizuki-ingress/src/lib.rs`
- Create: `rust/crates/mizuki-ingress/src/context.rs`
- Create: `rust/crates/mizuki-ingress/src/normalize.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 定义 `InboundMessageContext`**

必须覆盖：

- `message_type`
- `group_id`
- `user_id`
- `sender_name`
- `raw_text`
- `reply_to`
- `quote`
- `images`
- `is_private`
- `is_group`
- `is_from_self`

- [ ] **Step 2: 写 fixture 对照测试**

输入 OneBot JSON，输出标准上下文 JSON。

- [ ] **Step 3: 实现 normalize**

规则：

- 非消息事件返回 `None`。
- bot 自己消息标记 `is_from_self=true`。
- 私聊和群聊都进入统一上下文。
- 图片、reply、quote 保留结构化字段。

- [ ] **Step 4: 运行测试**

```bash
cd rust
cargo test -p mizuki-ingress
```

- [ ] **Step 5: 提交**

```bash
git add rust
git commit -m "feat: normalize onebot inbound messages"
```

---

## Chunk 3: 路由与执行计划

### Task 5: 实现 canonical route contract

**Files:**
- Create: `rust/crates/mizuki-router/Cargo.toml`
- Create: `rust/crates/mizuki-router/src/lib.rs`
- Create: `rust/crates/mizuki-router/src/contract.rs`
- Create: `rust/crates/mizuki-router/src/router.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 定义 route enum**

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Ignore,
    Refuse,
    Admin,
    DirectChat,
}
```

- [ ] **Step 2: 定义 route contract**

字段至少包括：

- `route`
- `reason`
- `confidence`
- `policy_hint`
- `admin_command`
- `needs_model`

- [ ] **Step 3: 用 fixture 写 golden tests**

Rust 输出必须和 `tests/fixtures/rust-rewrite/route-contracts/*.json` 等价。

- [ ] **Step 4: 实现第一版规则路由**

第一版只做可确定行为：

- 非消息和 self 消息 -> `ignore`
- admin 命令 -> `admin`
- 明确拒绝边界 -> `refuse`
- 其余可回复消息 -> `direct_chat`

模型路由之后单独补，不阻塞主链骨架。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-router
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: port canonical route contract"
```

### Task 6: 实现 execution plan

**Files:**
- Create: `rust/crates/mizuki-execution/Cargo.toml`
- Create: `rust/crates/mizuki-execution/src/lib.rs`
- Create: `rust/crates/mizuki-execution/src/plan.rs`
- Create: `rust/crates/mizuki-execution/src/policy.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 定义 executor enum**

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Executor {
    Ignore,
    Refuse,
    Admin,
    Direct,
    BackgroundDirect,
    FullSubagent,
}
```

- [ ] **Step 2: 定义 execution plan**

字段：

- `executor`
- `policy_key`
- `allow_tools`
- `allowed_tools`
- `allow_stream`
- `needs_background`
- `unavailable_reason`

- [ ] **Step 3: 写 route -> plan 测试**

覆盖所有 executor。

- [ ] **Step 4: 实现 policy 映射**

第一版只实现 README 中出现的行为边界，不迁移全部细碎策略。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-execution
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: port route execution plan"
```

---

## Chunk 4: Rust Runtime 图

### Task 7: 定义 runtime state

**Files:**
- Create: `rust/crates/mizuki-runtime/Cargo.toml`
- Create: `rust/crates/mizuki-runtime/src/lib.rs`
- Create: `rust/crates/mizuki-runtime/src/state.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 定义主状态结构**

必须包含 README 中的状态段：

```rust
pub struct RuntimeState {
    pub request: RequestState,
    pub thread: ThreadState,
    pub memory: MemoryState,
    pub plan: PlanState,
    pub execution: ExecutionState,
    pub output: OutputState,
    pub messages: Vec<MessageRecord>,
    pub events: Vec<RuntimeEvent>,
}
```

- [ ] **Step 2: 支持 JSON 序列化**

所有状态结构都 derive：

```rust
Serialize, Deserialize, Debug, Clone
```

- [ ] **Step 3: 用 Node runtime state fixture 做兼容测试**

要求 Rust 能读取旧状态，并写出兼容 JSON。

- [ ] **Step 4: 运行测试**

```bash
cd rust
cargo test -p mizuki-runtime state
```

- [ ] **Step 5: 提交**

```bash
git add rust
git commit -m "feat: define rust runtime state"
```

### Task 8: 实现图节点骨架

**Files:**
- Create: `rust/crates/mizuki-runtime/src/node.rs`
- Create: `rust/crates/mizuki-runtime/src/graph.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/prepare.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/route.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/direct_reply.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/planner.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/dispatch.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/validate.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/draft_reply.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/humanize.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/final_validate.rs`
- Create: `rust/crates/mizuki-runtime/src/nodes/persist.rs`

- [ ] **Step 1: 定义节点 trait**

```rust
#[async_trait::async_trait]
pub trait RuntimeNode: Send + Sync {
    async fn run(&self, state: RuntimeState) -> anyhow::Result<RuntimeState>;
}
```

- [ ] **Step 2: 实现固定拓扑**

拓扑必须对齐 README：

```text
prepare -> route -> direct_reply | planner -> dispatch -> validate -> repair_or_continue -> draft_reply -> humanize -> final_validate -> persist
```

- [ ] **Step 3: 节点先做 no-op 或 stub**

每个节点至少写入一条 `RuntimeEvent`，便于追踪。

- [ ] **Step 4: 写拓扑测试**

断言简单 direct 请求经过：

```text
prepare, route, direct_reply, humanize, final_validate, persist
```

断言工具请求经过：

```text
prepare, route, planner, dispatch, validate, draft_reply, humanize, final_validate, persist
```

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-runtime graph
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: add rust runtime graph skeleton"
```

---

## Chunk 5: 模型、Prompt 与回复链路

### Task 9: 实现模型 Provider 抽象

**Files:**
- Create: `rust/crates/mizuki-model/Cargo.toml`
- Create: `rust/crates/mizuki-model/src/lib.rs`
- Create: `rust/crates/mizuki-model/src/provider.rs`
- Create: `rust/crates/mizuki-model/src/openai_compatible.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 定义模型请求和响应**

支持：

- system messages
- user messages
- assistant messages
- tool evidence
- streaming 开关
- timeout

- [ ] **Step 2: 实现 OpenAI-compatible Provider**

配置从 `API_KEY`、可选 base url、model 读取。

- [ ] **Step 3: 写 mock provider 测试**

所有 runtime 测试默认使用 mock provider，避免测试依赖外部模型。

- [ ] **Step 4: 运行测试**

```bash
cd rust
cargo test -p mizuki-model
```

- [ ] **Step 5: 提交**

```bash
git add rust
git commit -m "feat: add rust model provider abstraction"
```

### Task 10: 迁移 prompt compiler

**Files:**
- Create: `rust/crates/mizuki-prompt/Cargo.toml`
- Create: `rust/crates/mizuki-prompt/src/lib.rs`
- Create: `rust/crates/mizuki-prompt/src/manifest.rs`
- Create: `rust/crates/mizuki-prompt/src/compiler.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 读取现有 `prompts/prompt-manifest.json`**

Rust 不复制 prompt 内容，直接读取现有资产。

- [ ] **Step 2: 实现 stage 过滤**

覆盖：

- `main`
- `router`
- `planner`
- `review`

- [ ] **Step 3: 实现 priority 和 conflict tags**

行为必须用 golden snapshot 验证。

- [ ] **Step 4: 实现 budget trimming**

第一版可用字符预算近似，后续再接 tokenizer。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-prompt
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: port prompt manifest compiler"
```

---

## Chunk 6: 工具、记忆和本地知识

### Task 11: 迁移工具注册与权限

**Files:**
- Create: `rust/crates/mizuki-tools/Cargo.toml`
- Create: `rust/crates/mizuki-tools/src/lib.rs`
- Create: `rust/crates/mizuki-tools/src/registry.rs`
- Create: `rust/crates/mizuki-tools/src/policy.rs`
- Create: `rust/crates/mizuki-tools/src/access.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 定义工具 trait**

```rust
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    async fn execute(&self, input: serde_json::Value) -> anyhow::Result<serde_json::Value>;
}
```

- [ ] **Step 2: 实现 tool policy**

从 execution plan 的 `policy_key` 和 `allowed_tools` 决定工具可见性。

- [ ] **Step 3: 实现本地路径访问边界**

所有文件访问必须经过 allowlist / denylist。

- [ ] **Step 4: 先迁移只读工具**

优先级：

1. 本地知识查询。
2. 记忆查询。
3. 诊断读取。
4. notebook search。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-tools
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: port tool registry and policy"
```

### Task 12: 迁移 Memory V3 和本地知识读取

**Files:**
- Create: `rust/crates/mizuki-memory/Cargo.toml`
- Create: `rust/crates/mizuki-memory/src/lib.rs`
- Create: `rust/crates/mizuki-memory/src/v3.rs`
- Create: `rust/crates/mizuki-memory/src/journal.rs`
- Create: `rust/crates/mizuki-memory/src/short_term.rs`
- Create: `rust/crates/mizuki-knowledge/Cargo.toml`
- Create: `rust/crates/mizuki-knowledge/src/lib.rs`
- Create: `rust/crates/mizuki-knowledge/src/notebook.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 读取现有 `data/memory-v3`**

第一版只读，不写。

- [ ] **Step 2: 实现 session / profile / scope projection 读取**

保持 JSON 兼容。

- [ ] **Step 3: 实现 daily journal 读取**

支持按日期、群、用户过滤。

- [ ] **Step 4: 实现 notebook search**

第一版可用 lexical search，语义检索后续接入。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-memory -p mizuki-knowledge
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: port memory and local knowledge readers"
```

---

## Chunk 7: 后台任务、Web 和诊断

### Task 13: 迁移 scheduler、tick 和 post-reply worker

**Files:**
- Create: `rust/crates/mizuki-background/Cargo.toml`
- Create: `rust/crates/mizuki-background/src/lib.rs`
- Create: `rust/crates/mizuki-background/src/scheduler.rs`
- Create: `rust/crates/mizuki-background/src/tick.rs`
- Create: `rust/crates/mizuki-background/src/post_reply.rs`
- Modify: `rust/Cargo.toml`

- [ ] **Step 1: 读取现有 scheduler task 文件**

兼容：

- `scheduled_qq_tasks.json`
- `post_reply_jobs`
- `daily_share_state.json`
- `life_scheduler_state.json`

- [ ] **Step 2: 实现 post-reply job 状态机**

状态必须覆盖：

- pending
- processing
- failed
- completed

- [ ] **Step 3: 实现 worker 并发限制**

使用 Tokio semaphore。

- [ ] **Step 4: 写重试和熔断测试**

覆盖 retry base、max、jitter、attempts。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test -p mizuki-background
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: port background runtimes"
```

### Task 14: 迁移 Web 服务和诊断 CLI

**Files:**
- Create: `rust/crates/mizuki-web/Cargo.toml`
- Create: `rust/crates/mizuki-web/src/lib.rs`
- Create: `rust/crates/mizuki-web/src/server.rs`
- Create: `rust/crates/mizuki-diagnostics/Cargo.toml`
- Create: `rust/crates/mizuki-diagnostics/src/lib.rs`
- Create: `rust/crates/mizuki-diagnostics/src/commands.rs`
- Modify: `rust/Cargo.toml`
- Modify: `rust/crates/mizuki-app/src/main.rs`

- [ ] **Step 1: 用 Axum 建立本地 Web 服务**

先实现：

- `/health`
- `/runtime/status`
- `/runtime/hotspots`

- [ ] **Step 2: 用 clap 建立诊断 CLI**

覆盖 README 中诊断命令的 Rust 等价入口：

- security
- fallback
- memory
- continuity
- main-reply
- runtime
- runtime-hotspots
- low-resource

- [ ] **Step 3: 保持 JSON 输出稳定**

诊断结果默认输出 JSON，方便脚本比对。

- [ ] **Step 4: 运行测试**

```bash
cd rust
cargo test -p mizuki-web -p mizuki-diagnostics
```

- [ ] **Step 5: 提交**

```bash
git add rust
git commit -m "feat: add rust web and diagnostics entrypoints"
```

---

## Chunk 8: 集成、全量验收和一次性上线

### Task 15: Rust 主进程接入 NapCat

**Files:**
- Modify: `rust/crates/mizuki-app/src/main.rs`
- Modify: `rust/crates/mizuki-onebot/src/lib.rs`
- Create: `rust/crates/mizuki-onebot/src/client.rs`

- [ ] **Step 1: 实现 WebSocket 连接和重连**

对齐 Node 行为：

- 使用 `NAPCAT_WS_URL`。
- 可选 `NAPCAT_WS_TOKEN`。
- 断线重连。
- shutdown 时停止重连。

- [ ] **Step 2: 实现 sendWithRetry 等价能力**

发送失败后按配置重试。

- [ ] **Step 3: 接入完整主链**

链路：

```text
OneBot event -> ingress -> router -> execution plan -> runtime -> send reply
```

- [ ] **Step 4: 用 mock NapCat 做集成测试**

模拟：

- 收消息。
- 收回复。
- 断线重连。
- 发送失败重试。

- [ ] **Step 5: 运行测试**

```bash
cd rust
cargo test --workspace
```

- [ ] **Step 6: 提交**

```bash
git add rust
git commit -m "feat: wire rust main runtime to onebot"
```

### Task 16: 全量离线验收

**Files:**
- Create: `scripts/verify-rust-full-rewrite.ps1`
- Create: `scripts/verify-rust-full-rewrite.sh`
- Create: `docs/rust-rewrite/full-acceptance-report.md`

- [ ] **Step 1: 编写全量验收脚本**

脚本必须执行：

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- golden fixture 对比
- prompt snapshot 对比
- Memory V3 旧数据读取测试
- post-reply job 旧数据读取测试
- mock NapCat 集成测试

- [ ] **Step 2: 固化通过标准**

`docs/rust-rewrite/full-acceptance-report.md` 必须记录：

- 测试命令。
- 测试时间。
- 测试环境。
- 通过 / 失败结果。
- 已知差异。
- 是否允许上线。

- [ ] **Step 3: 加入真实数据 dry-run**

dry-run 读取现有 `data/`，但不写入、不发送 QQ 消息。必须验证：

- 配置可加载。
- prompt 可编译。
- memory 可读取。
- scheduler task 可读取。
- post-reply queue 可读取。
- OneBot fixture 可完整跑完主链。

- [ ] **Step 4: 运行验收**

```bash
powershell -ExecutionPolicy Bypass -File scripts/verify-rust-full-rewrite.ps1
```

Expected: 所有检查通过，并生成验收记录。

- [ ] **Step 5: 提交**

```bash
git add scripts/verify-rust-full-rewrite.ps1 scripts/verify-rust-full-rewrite.sh docs/rust-rewrite/full-acceptance-report.md
git commit -m "chore: add rust full rewrite acceptance checks"
```

### Task 17: 一次性替换上线

**Files:**
- Create: `docs/rust-rewrite/one-shot-cutover-plan.md`
- Create: `scripts/start-rust-runtime.ps1`
- Create: `scripts/start-rust-runtime.sh`
- Create: `scripts/rollback-to-node-runtime.ps1`
- Create: `scripts/rollback-to-node-runtime.sh`
- Modify: `deploy/README.md`
- Modify: `deploy/linux/README_LINUX.md`

- [ ] **Step 1: 写一次性上线 runbook**

`docs/rust-rewrite/one-shot-cutover-plan.md` 必须包含：

- 上线窗口。
- 上线负责人。
- 上线前检查清单。
- 停止 Node 的命令。
- 启动 Rust 的命令。
- 验证 QQ 收发的步骤。
- 失败时回滚到 Node 的命令。
- 数据备份位置。
- 允许继续观察的轻微问题。
- 必须立即回滚的问题。

- [ ] **Step 2: 创建 Rust 启动脚本**

脚本必须：

- 设置工作目录。
- 读取 `.env`。
- 启动 Rust 主进程。
- 写 pid 文件。
- 写日志。
- 避免与 Node 同时持有 OneBot WebSocket。

- [ ] **Step 3: 创建 Node 回滚脚本**

脚本必须：

- 停止 Rust 进程。
- 恢复 Node 的 `.mizukibot.lock` 行为。
- 启动原 Node 主进程。
- 检查 NapCat WebSocket 是否恢复。

- [ ] **Step 4: 更新部署文档**

说明一次性替换上线流程，不提供灰度或分阶段入口。

- [ ] **Step 5: 提交**

```bash
git add docs/rust-rewrite/one-shot-cutover-plan.md scripts/start-rust-runtime.ps1 scripts/start-rust-runtime.sh scripts/rollback-to-node-runtime.ps1 scripts/rollback-to-node-runtime.sh deploy/README.md deploy/linux/README_LINUX.md
git commit -m "docs: add one-shot rust cutover plan"
```

---

## 验收标准

Rust 全量重写完成必须满足：

- `cargo test --workspace` 全绿。
- `cargo clippy --workspace --all-targets -- -D warnings` 全绿。
- `cargo fmt --all --check` 全绿。
- golden fixture 的 route contract 和 execution plan 与 Node 版本等价。
- prompt compiler snapshot 与 Node 版本等价。
- Memory V3、daily journal、post-reply jobs 可读取旧数据。
- 全量离线验收脚本通过。
- 一次性上线 runbook 已完成演练。
- Node 回滚脚本可用，并已验证能恢复主进程。
- 有明确回滚脚本和回滚文档。
- README、部署文档、诊断文档已更新。

---

## 风险清单

- JS 动态对象较多，Rust struct 过早收窄会丢字段。解决：关键输入使用 `#[serde(flatten)]` 保留扩展字段。
- prompt budget trimming 可能和 Node 版本不一致。解决：先 snapshot 对齐，再替换 tokenizer。
- Memory V3 数据兼容风险高。解决：Rust 初期只读旧数据，不直接写入。
- OneBot 消息形态复杂。解决：先用真实 fixture 和 mock NapCat 覆盖。
- 工具执行有副作用。解决：先迁移只读工具，副作用工具最后迁移。
- full subagent 行为不可完全单测。解决：保留桥接协议，用 mock 子代理和真实 fixture 做离线验收。
- 并发行为变化可能导致回复顺序不同。解决：入口、foreground、post-reply worker 均显式限流。

---

## 推荐执行顺序

1. 完成 Chunk 1，冻结契约。
2. 完成 Chunk 2，确保消息入口可复现。
3. 完成 Chunk 3，确保 route 和 execution plan 可复现。
4. 完成 Chunk 4，跑通 Rust runtime 骨架。
5. 完成 Chunk 5，让 Rust 能生成真实回复。
6. 完成 Chunk 6，补齐工具、记忆、本地知识。
7. 完成 Chunk 7，补齐后台任务、Web、诊断。
8. 完成 Chunk 8，全量验收后一次性替换上线。

不要跳过 Chunk 1。没有契约快照，Rust 重写会变成“凭感觉复刻”，后期很难判断是重写正确还是旧行为被误解。
