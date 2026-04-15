# 路由重构交接（Canonical Only）

## 已完成

- Router 已改成 canonical-only 输出
- Execution 已切到 canonical policy catalog
- Prompt policy 已改成 `topRouteType -> policyKey`
- Graph / AI / review / memory / telemetry 已统一使用：
  - `routePolicyKey`
  - `topRouteType`
  - `reviewMode`
  - `routeMeta`
- 图片语义已拆分：
  - 看图问答：`lookup/vision-answer`
  - 图片总结：`transform/vision-summary`

## 当前运行时不应再出现

- `legacyRouteType`
- `executionProfile`
- `deriveExecutionProfile`
- `getExecutionProfileRouteKey`
- `mapTopRouteToLegacyRoute`
- `review_${routeType}`
- 以 `route.type` 表达细路由

## 还保留但不属于运行时合同的东西

- `policyKey`
  - 仅执行层 / prompt / telemetry 的 canonical 内部键
- `topRouteType`
  - 顶层执行与治理边界

## 后续如果继续开发

- 新增能力时先判断是否是已有 `topRouteType` 下的新 `policyKey`
- 不要再加 dual-read / dual-write
- 不要恢复 “能力不足时降级成 chat” 的旧行为
- 不要让 memory / task / group / passive awareness 回写旧 `routeType`

## 建议回归

- `node tests\\router.test.js`
- `node tests\\routerHybrid.test.js`
- `node tests\\routeSchema.test.js`
- `node tests\\routeExecution.test.js`
- `node tests\\routeProfiles.test.js`
- `node tests\\routePromptPolicy.test.js`
- `node tests\\localToolAccess.test.js`
- `node tests\\messageFlowSource.test.js`
- `node tests\\graphDispatch.test.js`
- `node tests\\graphMemoryLearningRouteSource.test.js`
- `node tests\\passiveAwareness.test.js`
- `node tests\\messagePassiveAwarenessSource.test.js`
- `node tests\\canonicalRouteSource.test.js`
