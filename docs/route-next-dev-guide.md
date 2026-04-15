# 路由开发说明（Canonical 终态）

## 当前结论

- 运行时路由合同已经收口为 `topRouteType + intent + facets`
- `detectIntent()` / `detectIntentHybrid()` 不再返回 `legacyRouteType`、`executionProfile`、旧细路由 `type`
- 执行层只认 canonical policy catalog，内部键为 `policyKey`
- review 流程只认 `reviewMode`，不再使用 `review_${routeType}`
- 工具能力不足时不再静默降级成 `chat`，而是进入显式 `unavailable` 分支

## 当前核心字段

- Router 输出：
  - `topRouteType`
  - `intent`
  - `facets`
  - `confidence`
  - `cleanText`
  - `rawText`
  - `imageUrl`
  - `toolHints`
  - `meta`
- Execution 输出：
  - `executor`
  - `topRouteType`
  - `policyKey`
  - `capability`
  - `toolExecutionTarget`
  - `allowTools`
  - `allowedTools`
  - `allowStream`
  - `planId`
  - `planSteps`
  - `unavailableReason`

## 核心文件

- `core/router.js`
  - 直接产出 canonical route
  - fallback classifier 直接判 `terminal / act / plan / transform / lookup / chat`
- `core/routeSchema.js`
  - canonical normalize
  - canonical policy 选择
- `core/routeProfiles.js`
  - canonical policy catalog 与描述
- `core/routeExecution.js`
  - canonical execution matcher
  - 明确 `unavailable` 分支
- `utils/routePromptPolicy.js`
  - prompt policy 合并顺序为 `topRouteType -> policyKey`
- `core/messageHandler.js`
  - 统一透传 `routePolicyKey`、`topRouteType`、`routeMeta`
- `api/agentGraph.js` / `api/ai.js`
  - graph、memory、review、trace 全部按 canonical 字段运行

## Canonical Policy Catalog

- `chat/default`
- `lookup/notebook-answer`
- `lookup/vision-answer`
- `lookup/weather-live`
- `lookup/finance-live`
- `lookup/location-web`
- `lookup/music-web`
- `lookup/web-answer`
- `transform/quiz`
- `transform/notebook-summary`
- `transform/vision-summary`
- `transform/web-summary`
- `plan/research`
- `plan/general`
- `act/default`
- `admin/default`
- `clarify/default`
- `refuse/default`
- `ignore/default`

> 兼容说明：`lookup/time-direct` 不再作为 router 的活动 policyKey 产出，但 execution 层仍保留该 key 作为时间直答的兼容别名与日志键。

## 已删除的旧约定

- `legacyRouteType`
- `executionProfile`
- `deriveExecutionProfile()`
- `getExecutionProfileRouteKey()`
- `mapTopRouteToLegacyRoute()`
- `review_${routeType}`
- 以 `route.type` 表达旧细路由名

## 开发约束

- 新逻辑只能新增在 canonical 合同上，不要恢复任何 legacy 兼容层
- 若增加新能力，先决定它属于哪个 `topRouteType`，再新增 `policyKey`
- 不要把 `policyKey` 当成旧细路由名复活；它只是一条 canonical 策略键
- memory / telemetry / trace 也只写 `routePolicyKey + topRouteType`

## 验证重点

- `tests/router.test.js`
- `tests/routerHybrid.test.js`
- `tests/routeSchema.test.js`
- `tests/routeExecution.test.js`
- `tests/routeProfiles.test.js`
- `tests/routePromptPolicy.test.js`
- `tests/localToolAccess.test.js`
- `tests/messageFlowSource.test.js`
- `tests/graphDispatch.test.js`
- `tests/graphMemoryLearningRouteSource.test.js`
- `tests/canonicalRouteSource.test.js`
