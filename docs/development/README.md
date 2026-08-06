# 开发者源码指南

这组文档面向第一次接触 MizukiBot、准备阅读源码或提交改动的开发者。它回答三个问题：进程如何运行，一条消息如何穿过 Agent 系统，以及修改某类能力时应从哪里开始、如何证明没有破坏其他链路。

最后核验：2026-08-06 09:37 +08:00。

## 先选阅读路线

不要从最大的文件开始顺读。先按当前任务建立一条窄链路，再向两侧展开。

| 目标 | 建议顺序 | 完成标准 |
| --- | --- | --- |
| 第一次本地运行 | [本地环境与首次启动](01-getting-started.md) -> [测试与质量门禁](06-testing-and-quality.md) | 能完成静态自检和一个定向测试，知道哪些本地文件不能提交 |
| 理解整体系统 | [架构地图](02-architecture-map.md) -> [消息与 Agent 运行时](03-message-and-agent-runtime.md) -> [记忆与提示词](04-memory-and-prompts.md) | 能从入口追到回复出口，并说清同步热路径与后台学习的边界 |
| 增加或修改功能 | [功能开发手册](05-feature-development.md) -> 对应领域文档 -> [测试与质量门禁](06-testing-and-quality.md) | 能确定代码所有者、组合根、配置和最小回归集 |
| 排查线上异常 | [调试与运维](07-debugging-and-operations.md) -> 对应链路文档 | 能用 requestId 或时间窗收集证据，不把重启当作修复证明 |
| 修改记忆或人格 | [记忆与提示词](04-memory-and-prompts.md) -> [消息与 Agent 运行时](03-message-and-agent-runtime.md) -> [测试与质量门禁](06-testing-and-quality.md) | 能区分记忆事实、人格、动态上下文和回复出口规则 |

## 文档清单

1. [本地环境与首次启动](01-getting-started.md)：Node 版本、安装、配置、启动模式和首次验收。
2. [架构地图](02-architecture-map.md)：进程、目录、依赖方向、兼容 facade 和数据所有权。
3. [消息与 Agent 运行时](03-message-and-agent-runtime.md)：OneBot 入站、路由、Runtime V2 图、工具循环、回复与后台副作用。
4. [记忆与提示词](04-memory-and-prompts.md)：短期连续性、Profile Journal、Memory V3、向量召回和 prompt 组装。
5. [功能开发手册](05-feature-development.md)：增加路由、工具、功能、Web 接口、配置、提示词和诊断入口的具体做法。
6. [测试与质量门禁](06-testing-and-quality.md)：测试发现、定向回归、静态检查、隔离规则和验收证据。
7. [调试与运维](07-debugging-and-operations.md)：按症状定位阶段、日志与诊断命令、生产调查边界。
8. [Discord / Telegram 多平台部署](../multi-platform-deployment.md)：平台开关、权限前置条件、身份绑定、健康检查和上线验收。

每一篇都可以独立使用；文中的“继续阅读”只用于需要跨边界追踪时，不是理解当前页面的前置条件。

## 建立源码地图的原则

### 以运行入口为准

根入口是 [`../../index.js`](../../index.js)，公开 Agent 调用入口是 [`../../api/agentGraph.js`](../../api/agentGraph.js)。目录名不能单独证明代码所有权：仓库正处于从 `api/`、`core/`、`utils/` 向 `src/` 分层迁移的阶段，部分 `src/` 文件是真实实现，部分只是指向旧实现的 facade；反向情况也存在。

阅读任何模块前先做三次搜索：谁导入它、它导入谁、哪个测试约束它。常用命令：

```bash
rg -n "require\(.+目标模块" api core src utils web tests
rg -n "module\.exports|exports\." path/to/module.js
rg -n "目标导出名|目标文件名" tests
```

### 以模块边界测试为迁移契约

[`../../tests/refactorSrcFacades.test.js`](../../tests/refactorSrcFacades.test.js)、[`../../tests/messageModuleFacade.test.js`](../../tests/messageModuleFacade.test.js)、[`../../tests/runtimeContextModuleBoundary.test.js`](../../tests/runtimeContextModuleBoundary.test.js) 等测试不仅检查功能，也固定公开导出、懒加载和兼容关系。迁移文件或改变 export shape 前必须先读对应边界测试。

### 以行为和数据契约为验收依据

只看到函数被调用，不代表链路正确。一次可信验收至少应覆盖：入口行为、状态或持久化结果、错误分支、日志/诊断证据，以及受影响的相邻链路。源码字符串检查只能证明“文本存在”，不能证明真实组合根已接线。

## 源码真值优先级

当文档、配置示例和代码不一致时，按以下顺序判断：

1. 当前分支的行为测试和模块边界测试。
2. 实际组合根与公开入口，例如 `index.js`、`api/agentGraph.js`、`api/toolRegistry.js`。
3. 配置解析代码 `config/index.js` 和 `config/envRuntime.js`。
4. `.env.example`、README 和专题文档。
5. 历史维护记录和旧迁移计划。

发现不一致时不要只改文档掩盖行为差异。先确认目标行为，再让代码、测试和文档回到同一事实。

## 修改这组文档

文档应描述稳定边界和可复现命令，不复制易漂移的全部环境变量、工具名或路由表。新增架构入口、改变公开 facade、移动数据所有权、增加质量门禁时，应更新对应主题页和本页导航。

提交前运行：

```bash
node tests/developerDocumentation.test.js
git diff --check
```

完整项目入口仍见 [`../../README.md`](../../README.md)，部署细节见 [`../../deploy/README.md`](../../deploy/README.md)，脚本索引见 [`../../scripts/README.md`](../../scripts/README.md)。

## 本次验收记录

完成时间：2026-07-31 02:15 +08:00；主提交：`1674530`。

| 命令 | 实际结果 |
| --- | --- |
| `node tests/developerDocumentation.test.js` | 通过；检查 8 篇文档、96 个本地链接、342 个仓库路径、69 个 npm 脚本 |
| `node scripts/run-tests.js tests/runTestsRunner.test.js` | 通过 |
| `npm run lint` | 通过；检查 795 个生产 JavaScript 文件 |
| `npm run typecheck` | 通过 |
| `npm run check:agent:static` | 通过 |
| `npm run check:prompts` | 通过；检查 107 个受治理 prompt 资产 |
| `npm run check:secrets:all` | 通过 |
| `git diff --check` | 通过；无 whitespace 错误 |

以上命令均使用 Node.js 20.20.2 实际执行。多文档开发者源码指南及其防漂移回归已落库，小目标已完成；未修改业务代码，未推送远端。
