# CI And Node Version Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为仓库建立 Node.js 20 单一版本基准和最小、可复现的 GitHub Actions 质量门禁。

**Architecture:** 以根目录 `.nvmrc` 作为 Node 主版本来源，启动前检查脚本负责验证运行时与 `package.json` 声明一致，Linux 安装脚本和 CI 复用该来源。CI 只执行无需外部服务的仓库内检查，并在全量测试失败时上传控制台日志。

**Tech Stack:** Node.js 20、CommonJS、npm、Bash、GitHub Actions、项目自定义测试运行器。

---

### Task 1: Node.js 版本边界

**Files:**
- Create: `.nvmrc`
- Create: `scripts/check-node-version.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/install-linux.sh`
- Modify: `scripts/check-linux.sh`
- Modify: `scripts/bootstrap-debian12.sh`
- Modify: `deploy/linux/README_LINUX.md`
- Modify: `deploy/linux/LINUX_DEPLOY_FULL.md`
- Test: `tests/nodeVersionPolicy.test.js`

- [x] 写入 Node 20 单一版本源和版本一致性测试。
- [x] 实现无第三方依赖的运行时版本检查。
- [x] 让 Linux 安装、检查和 Debian bootstrap 读取同一主版本。
- [x] 清除部署文档中的 Node 18 项目运行要求。
- [x] 运行版本策略测试和脚本探针。

### Task 2: 最小 CI 门禁

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `scripts/check-staged-secrets.js`
- Modify: `package.json`
- Test: `tests/ciWorkflow.test.js`
- Test: `tests/checkSecretsAllMode.test.js`

- [x] 为 secrets 检查增加已跟踪文件模式，避免 CI 空暂存区假通过。
- [x] 创建最小权限、可取消旧运行的 Node 20 工作流。
- [x] 执行 `npm ci`、版本检查、lint、prompt、secrets、production audit 和全量测试。
- [x] 为约 340 秒的全量测试设置合理上限，并仅在失败时上传日志。
- [x] 运行定向测试、静态检查和差异检查。

## 验收补记 2026-07-16 22:52 +08:00

- 官方 Node 20.20.2 Windows x64运行时确认 `process.versions.modules=115`；通过 `NODE_OPTIONS` 将 `better-sqlite3` 定向到独立 Node 20依赖目录，SQLite原生模块探针返回 `quick_check=ok`，未覆盖当前 Node 24依赖安装。
- `TEST_CONCURRENCY=4` 的 tracked完整全量自然退出0，耗时151.7秒；729文件 lint、typecheck、prompt、tracked/staged secrets、production audit和diff check均通过。
- Node 20归档此前按 nodejs.org SHA-256 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77` 校验，目标31完成；GitHub Actions真实远端运行仍属于目标8，不影响Node版本统一结论。
