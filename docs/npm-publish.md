# NPM Publish Notes

更新 2026-06-23 08:58 +08:00：收窄 npm 发布包边界，避免把本地运行数据、密钥、MCP 本地配置、测试夹具和维护流水账一起发布。

## 发布内容

`package.json` 使用 `files` 白名单。当前 npm 包只包含：

- 运行源码：`api/`、`config/`、`core/`、`src/`、`utils/`、`web/`
- 运行资产：`prompts/GEMINI.txt`、`prompts/SYSTEM.txt`、`prompts/defaut.txt`、`prompts/prompt-manifest.json`、`prompts/persona_modules/`、`prompts/persona_worldbook/`、`prompts/runtime/`
- 运维入口：`scripts/`、`restart-bot.cmd`
- 配置模板：`.env.example`、`.env.skills.example`
- 部署说明：`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`deploy/`
- 包说明：`README.md`、本文件

## 明确不发布

- 真实 `.env`、`data/`、`logs/`、`artifacts/`、`tmp/`
- `.mcp.json`、`.husky/`、`.claude/`、`.playwright-mcp/`
- `tests/`
- `docs/maintenance-log.md` 等维护流水账和参考资料
- 本地 `skills/` 目录
- 本地私有 prompt：`prompts/persona/`、`prompts/admin.txt`

## 当前验收

- `npm view mizukibot name version --json` 返回 404，当前注册表中未查询到该包名。
- `npm whoami` 返回 `ENEEDAUTH`，本机未登录 npm，不能执行真实发布。
- `npm pack --dry-run --json` 通过，包内 `entryCount=956`。
- `npm publish --dry-run --json` 通过，模拟发布目标为 public access。
- 包文件清单禁发路径扫描 0 命中；包内文件敏感模式扫描 0 命中。
- `npm run check:secrets` 和 `git diff --check` 通过。

## 发布前检查

```bash
npm whoami
npm pack --dry-run --json
npm publish --dry-run
npm publish
```

本机当前未登录 npm，实际发布前需要先在发布环境完成 `npm login`。不要把 npm token 写入仓库或 `.env.example`。发布后的部署环境还需要自行提供本地私有 prompt，不能把 `prompts/persona/` 或 `prompts/admin.txt` 随包发布。
