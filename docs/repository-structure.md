# Repository Structure

更新 2026-06-13 15:27 +08:00：完成轻量仓库组成审计，建立本文件作为后续代理判断“代码、运行资产、参考资料、临时产物”的入口。

## 目录边界

| 目录 | 用途 | 清理规则 |
| --- | --- | --- |
| `api/` | 模型调用、工具注册、Runtime V2、LangGraph 入口 | 只按功能改动；不要做目录级搬迁 |
| `core/` | QQ 消息入口、路由、调度、被动感知和主动任务 | 保持现有分块文件；`.chunk.js` 不按垃圾文件处理 |
| `utils/` | 记忆、prompt、诊断、存储、工具策略和运行时辅助 | 优先新增小模块，避免大范围重排 |
| `config/` | 环境变量解析和运行时配置 | 配置默认值变更必须有测试或诊断验证 |
| `prompts/` | 正式运行 prompt、persona、worldbook 和 manifest | 只有 `prompts/prompt-manifest.json` 或代码明确引用的文件才算运行资产 |
| `scripts/` | 启动、诊断、测试、部署和维护脚本 | 诊断输出默认写 `data/exports/` 或被忽略的 `artifacts/*` |
| `tests/` | 单元测试和回归测试 | 新行为优先补窄测试，避免只靠全量测试 |
| `web/` | 本地管理 Web 服务 | 路由和页面入口保持分文件 |
| `docs/` | 设计说明、维护记录、计划和参考资料 | 长期说明写这里；README 只保留入口摘要 |
| `docs/reference/` | 不参与运行的参考资料 | 允许放原始提示词、外部资料摘录和人工整理素材 |
| `artifacts/` | 评估样本、命名备份和一次性诊断产物 | 可提交的必须有文档引用；本地导出应被 `.gitignore` 遮住 |
| `data/` | 本地运行数据库、日志、缓存和模型调用轨迹 | 默认不提交；删除前必须另行确认 |

## 当前整理结论

- 根目录 `25时角色扮演提示词.md` 与 `新建 文本文档.txt` 没有运行代码、脚本或文档入口引用，已移动到 `docs/reference/roleplay-prompts/` 并保留内容历史。
- `artifacts/gemini-sampling-degradation-48h.json` 含真实对话导出，只作为本地复核文件，不应提交；已加入 `.gitignore` 的 `artifacts/gemini-sampling-degradation-*.json`。
- `prompts/defaut.txt` 是当前工作区并行改动准备接入的 prompt 资产，提交版 manifest 尚未引用；命名疑似 typo，本次不忽略、不删除，避免破坏并行工作。
- `prompts/GEMINI.txt.bak` 是已跟踪历史备份，但不在 prompt manifest 中；本次不删除，列入后续需人工确认的清理候选。
- `artifacts/backups/large-facades-small-module-cutover-2026-05-23-0917+0800.zip` 是小模块切换验收凭据，已被 `docs/repo-cleanup.md` 和计划文档引用，不当作垃圾文件处理。

## 后续候选

以下项目只做候选记录，删除需要用户明确同意：

- `prompts/GEMINI.txt.bak`：已跟踪备份文件，当前 manifest 不引用。
- `prompts/defaut.txt`：当前工作区存在 manifest 接入改动但尚未提交；若要改名，需要同步 manifest、相关测试和文档。
- `.playwright-mcp/*.jpg`：已跟踪浏览器截图样本，当前代码未引用。
- `artifacts/tmp-memory-pollution-*.json` 与 `artifacts/tmp-recall-pollution-*.json`：历史治理验收输出；部分文档引用最终检查结果，删除前需要先确认文档是否足够。
- 忽略目录中的本地大备份，例如 `data/*.backup-*`、`data/memory-v3-backup-*`、`data/.hapi/`、`data/hapi-home/`、`artifacts/backups/_migration_backup_*/`。

## 验收

- PASS 2026-06-13 15:40 +08:00：`npm run check:prompts` 在当前工作区通过；同时确认当前工作区 manifest 已引用 `prompts/defaut.txt`，因此本次不把它加入 `.gitignore`。
- PASS 2026-06-13 15:27 +08:00：`git check-ignore -v artifacts/gemini-sampling-degradation-48h.json prompts/GEMINI.new.bak` 命中新增规则。
- PASS 2026-06-13 15:27 +08:00：引用复核未发现运行代码引用旧根目录资料文件；旧文件名仅保留在本审计文档中作为迁移说明。
