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

- [ ] 写入 Node 20 单一版本源和版本一致性测试。
- [ ] 实现无第三方依赖的运行时版本检查。
- [ ] 让 Linux 安装、检查和 Debian bootstrap 读取同一主版本。
- [ ] 清除部署文档中的 Node 18 项目运行要求。
- [ ] 运行版本策略测试和脚本探针。

### Task 2: 最小 CI 门禁

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `scripts/check-staged-secrets.js`
- Modify: `package.json`
- Test: `tests/ciWorkflow.test.js`
- Test: `tests/checkSecretsAllMode.test.js`

- [ ] 为 secrets 检查增加已跟踪文件模式，避免 CI 空暂存区假通过。
- [ ] 创建最小权限、可取消旧运行的 Node 20 工作流。
- [ ] 执行 `npm ci`、版本检查、lint、prompt、secrets、production audit 和全量测试。
- [ ] 为约 340 秒的全量测试设置合理上限，并仅在失败时上传日志。
- [ ] 运行定向测试、静态检查和差异检查。
