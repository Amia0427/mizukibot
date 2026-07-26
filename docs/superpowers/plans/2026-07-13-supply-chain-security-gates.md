# Supply Chain Security Gates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 npm 依赖、Git 历史和容器镜像建立可复现的许可证、SBOM、gitleaks、OSV 与 Trivy 门禁，并将所有 CI Action 和基础镜像固定到权威不可变摘要。

**Architecture:** 本地确定性门禁只读取 `package-lock.json` 和版本化策略，使用 npm 内置 CycloneDX SBOM 能力，避免新增运行依赖。需要外部漏洞数据库或镜像注册表的扫描放入独立最小权限 workflow；Action commit SHA 与 Docker digest 必须从官方远端解析并由结构测试锁定，网络不可用时保持未完成而不是猜测摘要。

**Tech Stack:** Node.js 20、npm SBOM、GitHub Actions、gitleaks、OSV-Scanner、Trivy、Docker/OCI digest。

---

## Chunk 1: Deterministic local policy

### Task 1: Version the production-license policy

**Files:**
- Create: `config/supply-chain-policy.json`
- Create: `scripts/check-production-licenses.js`
- Test: `tests/supplyChainPolicy.test.js`

- [x] **Step 1: Write the failing license-policy test**

测试必须覆盖全部 `package-lock.json.packages` 中 `dev !== true` 的包；未知、缺失或未批准 license expression 失败。`cycletls@2.0.5` 的现有 `GPL3` 必须是带原因和复核日期的精确包例外，`json-bignum@0.0.3` 缺失 lock license 必须由版本锁定的 MIT override 解释，不能用全局通配。

- [x] **Step 2: Confirm failure before implementation**

Run: `node scripts/run-tests.js tests/supplyChainPolicy.test.js`
Expected: FAIL because policy/checker do not exist.

- [x] **Step 3: Add exact policy validation**

策略包含 version、approvedExpressions、packageExceptions 和 packageLicenseOverrides；checker 输出包数、许可证分布、例外与错误列表，`--json` 保持机器可读，失败设置非零退出码。

- [x] **Step 4: Cover drift cases**

测试修改内存中的 lock/policy fixture，验证新增未知许可证、过期例外、包版本漂移、无理由例外和无来源 override 均失败。

- [x] **Step 5: Run the checker**

Run: `node scripts/check-production-licenses.js --json`
Expected: exit 0 with all current production packages accounted for.

### Task 2: Generate and validate CycloneDX SBOM

**Files:**
- Create: `scripts/generate-sbom.js`
- Test: `tests/supplyChainPolicy.test.js`

- [x] **Step 1: Add a real npm-SBOM test**

运行 `npm sbom --omit=dev --sbom-format=cyclonedx`，验证 `bomFormat=CycloneDX`、specVersion、root `bom-ref`/version/purl、非空 components/dependencies，并确认所有直接生产依赖出现在组件中。根组件 `name` 可能取工作区目录名，不作为包身份依据。

- [x] **Step 2: Implement the wrapper**

wrapper 负责执行 npm、解析/验证 JSON、写入指定输出路径和输出 SHA-256；npm 失败、非法 JSON、缺少直接依赖或空组件时不得留下成功报告。

- [x] **Step 3: Run the SBOM generator**

Run: `node scripts/generate-sbom.js --output artifacts/sbom/mizukibot.cdx.json`
Expected: exit 0 and a valid CycloneDX JSON artifact.

**2026-07-14 16:50 +08:00 本地验收：** 生产许可证门禁覆盖330个 lock package entry，精确使用 `cycletls@2.0.5` 例外与 `json-bignum@0.0.3` HTTPS 来源 override；真实 npm SBOM 为 CycloneDX 1.5，包含275个组件和276条依赖记录。目标测试、定向 ESLint、lint、typecheck、prompt、tracked secrets、production audit 与 diff check 通过；串行替代全量515文件中498个通过，17个仅因当前沙箱禁止 Node 创建子进程而返回 `EPERM`，因此 Node 20、并发4全量与完整外部扫描证据仍未完成。

## Chunk 2: Immutable CI scanners

### Task 3: Pin GitHub Actions and add source/dependency scans

**Files:**
- Create: `.github/workflows/supply-chain.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ciWorkflow.test.js`
- Test: `tests/supplyChainPolicy.test.js`

- [x] **Step 1: Resolve official immutable SHAs**

从 GitHub 官方仓库解析 `actions/checkout`、`actions/setup-node`、`actions/upload-artifact`、gitleaks 和 OSV-Scanner 的 tag dereference commit；网络不可用时停止本任务，禁止凭记忆填写。

**2026-07-15 12:17 +08:00 权威解析：** `actions/checkout@v4.3.1=34e114876b0b11c390a56381ad16ebd13914f8d5`、`actions/setup-node@v4.4.0=49933ea5288caeca8642d1e84afbd3f7d6820020`、`actions/upload-artifact@v4.6.2=ea165f8d65b6e75b540449e92b4886f43607fa02`、`gitleaks/gitleaks-action@v3.0.0=e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`、`google/osv-scanner-action@v2.3.8=9a498708959aeaef5ef730655706c5a1df1edbc2`，均由 GitHub API release/tag ref 解引用到40位 commit。仓库归属个人账号，官方 gitleaks v3 文档确认无需组织许可证密钥。

- [x] **Step 2: Pin every `uses:` reference**

所有 workflow `uses:` 必须是40位 commit SHA，并在行尾保留可读版本注释。结构测试拒绝 tag、branch、短 SHA 和未知 action owner。

- [x] **Step 3: Add gitleaks and OSV jobs**

gitleaks 扫描完整 Git 历史；OSV 扫描 `package-lock.json`。workflow 使用 `contents: read`，只在确需上传 SARIF 时授予 `security-events: write`，PR fork 不获取项目 secrets。

- [x] **Step 4: Generate/upload SBOM and license report**

CI 运行本地 checker/SBOM wrapper并上传7天 artifact；扫描失败不使用 `continue-on-error`。

## Chunk 3: Container provenance and vulnerability scan

### Task 4: Pin the Node base image by digest

**Files:**
- Modify: `Dockerfile`
- Modify: `tests/dockerSecurityConfig.test.js`

- [ ] **Step 1: Resolve the official multi-arch digest**

从 Docker Hub/OCI manifest 获取当前 `node:20-bookworm-slim` manifest-list digest，并记录解析时间。registry 和本地 daemon 均不可用时保持任务 pending，禁止复制未验证摘要。

- [ ] **Step 2: Pin both Docker stages**

统一使用 `node:20-bookworm-slim@sha256:<64hex>`，结构测试要求两个 `FROM` 使用同一 digest 且仍保留可读 tag。

- [ ] **Step 3: Add Trivy image/config scan**

CI 构建本地镜像后运行 Trivy vulnerability 和 misconfiguration 扫描；HIGH/CRITICAL 且有修复版本时失败，报告作为 artifact 保留。

## Chunk 4: Verification and evidence

### Task 5: Run all gates and update the roadmap

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`

- [x] **Step 1: Run local policy tests under Node 20/current Node**

Run license/SBOM/CI/Docker policy tests in both runtimes.

- [x] **Step 2: Run repository gates and full tests**

Run lint、typecheck、prompt、secrets、npm audit、diff check 和并发4全量测试。

- [ ] **Step 3: Obtain external scanner evidence**

目标29只有在 gitleaks、OSV、Trivy、SBOM、许可证和 digest 固定均由真实 CI/本地命令成功执行时才能完成；仅存在 workflow YAML 不算运行证据。

- [x] **Step 4: Commit implementation and documentation separately**

本地策略/SBOM可以先独立提交；外部 action/digest 在权威网络恢复后单独提交，避免用未验证值污染可信链。

**2026-07-15 12:17 +08:00 验收：** Node 20.20.2与当前 Node的 CI/Supply Chain定向测试通过；729文件 lint、typecheck、prompt、tracked secrets、production audit（0漏洞）、diff check和 Node 24并发4全量通过，全量耗时105.2秒。workflow尚未推送，因此 gitleaks与OSV只有结构/配置证据，仍不能替代真实 GitHub Actions扫描结果。

实现提交：`a4ce6cc`。README、维护日志与32目标路线图在后续独立文档提交中记录该批次。
