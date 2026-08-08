# 对话变量系统

更新 2026-08-08 14:17 +08:00。

对话变量由 `utils/conversationVariables/` 统一管理，SQLite 是当前真值。关系按用户隔离，角色的情绪、精力、压力和社交意愿使用全局状态；`favorites.json` 只作为一次性迁移输入、历史备份和故障回退，不再作为正常主读写。

## 数据与规则

- `variable_state` 保存当前快照、版本、更新时间和最近事件。
- `variable_events` 保存模型提案、管理员修改、状态衰减和迁移，`event_key` 保证重试幂等。
- `variable_overrides` 保存管理员覆盖值、锁定状态、原因、操作者和时间。
- 关系阶段由好感、信任和熟悉度加权推导，普通用户最高为“亲密伙伴”；模型不能直接写入阶段。
- 只有高置信度、带明确理由且属于越界、欺骗或持续伤害的提案允许关系负向变化。沉默不降低关系；短期角色状态线性回归固定基线：情绪 0、精力 60、压力 20、社交意愿 60。

## 运行入口

主接口位于 `utils/conversationVariables/index.js`：`getSnapshot`、`applyProposal`、`getEvents`、`setOverride` 和 `clearOverride`。模型提案统一为 `relationship` 与 `character` 两组增量，旧 `affinity` 字段仍可被兼容解析，但不再拥有独立写入权威。

主回复只注入关系阶段、边界、态度和角色状态的自然语言摘要，不包含原始分数、用户 ID、事件来源或内部评分规则；情绪、精力、压力和社交意愿会进一步推导当前语气温度、主动性和谨慎程度。私聊 `/关系` 和自然关系问题读取同一快照；群聊不公开个人关系细节。后台控制台提供以下接口：

```text
GET  /api/conversation-variables/state?user_id=<id>
GET  /api/conversation-variables/events?scope_type=user&scope_id=<id>
POST /api/conversation-variables/override
POST /api/conversation-variables/override/remove
```

覆盖操作必须提交原因，页面不提供直接编辑 SQLite 的入口。

## 配置与迁移

`.env` 中可设置 `CONVERSATION_VARIABLES_ENABLED`、`CONVERSATION_VARIABLES_DB_FILE`、`CONVERSATION_VARIABLES_PRIMARY_READ` 和 `CONVERSATION_VARIABLES_MODEL_MIN_CONFIDENCE`。首次切换前先执行预览：

```text
npm run conversation-variables:migrate
```

确认条数后执行 `node scripts/migrate-conversation-variables.js --apply`。脚本会备份两个旧 JSON 文件，并在迁移事件中保留旧阶段、态度和最近更新时间；管理员记录会建立锁定覆盖。

## 本次验收

- `node tests/conversationVariables.test.js`
- `node tests/conversationVariablesMigration.test.js`
- `node tests/conversationVariablesPrompt.test.js`
- `node tests/conversationVariablesQuery.test.js`
- `node tests/liveState.test.js`
- `node tests/personaMemoryState.test.js`
- `node tests/memoryContextProfileInjection.test.js`
- `node tests/postReplyWorkerRuntime.test.js`
- `node tests/messageHandlerModuleBoundary.test.js`
- `node tests/privateProactiveEngine.test.js`
- `node tests/developerDocumentation.test.js`
- `npm run lint`、`npm run typecheck`、`git diff --check` 均通过；控制台登录/渲染、隔离数据库快照查询、覆盖保存、审计事件和覆盖移除均通过。
- 真实迁移 dry-run 显示 97 条，apply 后迁移 97 条；备份目录为 `data/backups/conversation-variables-2026-08-08T05-23-02-520Z`。真实 SQLite `quick_check=ok`，包含 582 条状态、107 条事件和 10 条覆盖；管理员 `1960901788` 的 5 个关系变量均处于锁定状态。
- 完整 `npm test` 在 Node 24.14.1 下运行 162 秒，除 `tests/weatherAlertProvider.test.js` 外均通过。该用例在 2026-08-08 使用 `Date.now()` 断言 `expireTime=2026-08-07T12:00:00+08:00` 的固定预警仍有效，失败与本次变量系统改动无调用关系，本次未修改天气模块。
