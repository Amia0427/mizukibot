# Private Prompt Deployment

更新 2026-06-23 09:05 +08:00：`prompts/persona/` 和 `prompts/admin.txt` 已从仓库和 `master` 历史移除。部署者需要在自己的运行环境里创建这些本地文件。

## 需要本地提供的文件

这些文件不要提交到 Git，也不要放进公开制品：

```text
prompts/admin.txt
prompts/persona/01_identity.txt
prompts/persona/02_style.txt
prompts/persona/03_boundaries.txt
prompts/persona/04_behavior.txt
prompts/persona/05_examples.index.json
prompts/persona/05_voice_samples.txt
prompts/persona/06_state_modulation.txt
prompts/persona/09_liveness_authentic.txt
```

`prompts/persona/05_examples.txt` 仍被旧 few-shot 工具常量引用，但当前实际读取入口是 `05_examples.index.json`。如团队需要兼容旧脚本，可以本地额外放置 `05_examples.txt`，不要提交。

## 运行时引用关系

- `config/index.js` 默认把 `PROMPTS_DIR` 指向项目内 `prompts/`，也可以通过环境变量 `PROMPTS_DIR=/absolute/path/to/prompts` 指向外部私有目录。
- `config/promptRuntime.js` 会在启动配置时读取 `prompts/prompt-manifest.json`，再按 manifest 加载 `admin.txt` 和 `persona/...`。
- `prompts/admin.txt` 在 manifest 中是 `admin_system_prompt`，`required=false`，`authority=system_root`，`priority=-1100`，`applies_when.admin_only=true`。文件非空时，只会进入管理员主回复稳定系统块；管理员识别依赖 `ADMIN_USER_IDS` 或显式 admin 上下文。
- 普通用户不会注入 `admin_system_prompt`；管理员私聊和管理员在群聊发言都会带这个块，并且排在 `root_system_prompt` 前。
- `persona/01_identity.txt`、`02_style.txt`、`03_boundaries.txt`、`04_behavior.txt`、`06_state_modulation.txt` 是必需核心 persona 文件。缺失或为空时，配置构建会报 `Missing persona prompt files`。
- `persona/09_liveness_authentic.txt` 在 manifest 里是必需资产，但 `include_in_system_prompt=false`，不会直接拼进基础 stable system prompt；保留它是为了维持 manifest 完整性和后续动态 persona 选择。
- `persona/05_examples.index.json` 是可选资产，不直接进入 system prompt；`utils/fewShotPrompts.js` 和 `utils/localPromptRecall.js` 会用它做动态示例和本地 prompt recall。
- `persona/05_voice_samples.txt` 是可选参考资产，当前不直接读取；保留给人工维护和后续迁移使用。

## 文件格式建议

- `admin.txt`：写管理员专用的稳定系统约束。不要写真实密钥、账号、内网地址或一次性部署信息。
- `01_identity.txt`：角色身份和长期不变的自我定位。
- `02_style.txt`：聊天语气、句长、表达节奏和禁用表达。
- `03_boundaries.txt`：安全边界、隐私边界和不可回应范围。
- `04_behavior.txt`：常见场景下的行为原则。
- `06_state_modulation.txt`：不同情绪、亲疏、场景下的状态调节。
- `09_liveness_authentic.txt`：真实感、反套路、关系驱动等质量约束。
- `05_examples.index.json`：JSON 文件，建议至少保持这个骨架：

```json
{
  "version": 1,
  "max_examples": 0,
  "examples": []
}
```

## 部署步骤

1. 从仓库拉取代码后，先确认 `.gitignore` 已包含：

```text
prompts/admin.txt
prompts/persona/
```

2. 创建目录和本地文件：

```bash
mkdir -p prompts/persona
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force prompts\persona | Out-Null
```

3. 按上面的清单写入本地 prompt 文件。

4. 如果你希望把私有 prompt 放在项目外，设置 `PROMPTS_DIR` 指向外部目录。外部目录仍需要包含 `prompt-manifest.json`、`SYSTEM.txt`、`defaut.txt`、`GEMINI.txt`、`runtime/`、`persona_modules/`、`persona_worldbook/` 以及本文件列出的私有 prompt。

5. 运行检查：

```bash
npm run check:prompts
node scripts/rebuild-local-prompt-recall-db.js --status
```

如果刚创建或修改了 `05_examples.index.json`、`persona_modules/module-catalog.json`，可以重建本地召回库：

```bash
node scripts/rebuild-local-prompt-recall-db.js
```

## 常见故障

- `Missing persona prompt files: persona/...`：必需 persona 文件不存在或内容为空。
- `missing required prompt asset`：manifest 标记为 required 的文件不存在。
- 管理员回复没有带 `admin_system_prompt`：检查 `prompts/admin.txt` 是否非空，以及 `ADMIN_USER_IDS` 是否包含当前用户 ID。
- 普通用户带了管理员规则：检查是否误把用户 ID 写进 `ADMIN_USER_IDS`，或调用链是否传入了显式 admin 上下文。
- `git status` 看不到这些私有文件是正常现象；它们被 `.gitignore` 忽略。

## 验收命令

```bash
git ls-files prompts/persona prompts/admin.txt
git log --all --oneline -- prompts/persona prompts/admin.txt
npm run check:prompts
```

前两条应无输出；第三条应通过，或只报告你明确接受的可选 prompt 缺失警告。
