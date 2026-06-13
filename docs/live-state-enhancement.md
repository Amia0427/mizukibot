# MizukiBot 生活状态增强开发文档

## 文档版本
- 创建时间：2026-06-13
- 版本：v1.0
- 状态：待开发

## 一、项目目标

借鉴 echo 项目的角色沉浸增强方法，为 MizukiBot 增加**动态生活状态系统**，提升角色扮演的真实感和活人感。

**核心原则**：
1. 不破坏现有提示词系统和 persona 文件
2. 只补充动态状态，不覆盖现有设定
3. 失败时不阻断主流程
4. Token 预算控制在 800 以内

---

## 二、架构设计

### 2.1 新增模块位置

```
api/runtimeV2/
├── context/
│   └── liveStateEnhancer.js         # 【新增】生活状态增强器
├── nodes/
│   └── enhanceLiveState.js          # 【新增】状态增强节点

utils/
└── liveState/                       # 【新增】生活状态查询模块
    ├── index.js
    ├── relationshipBoundary.js      # 关系边界系统
    ├── currentActivity.js           # 当前活动查询
    ├── recentContext.js             # 最近对话摘要
    └── antiAIRules.js               # 反AI通病规则集

prompts/runtime/
├── live_state_rules.txt             # 【新增】生活感核心规则
└── anti_generic_ai.txt              # 【新增】反通用AI规则
```

### 2.2 执行流程

```
prepare (现有)
  ↓
enhanceLiveState (新增) ← 查询动态状态并构建上下文
  ↓
route (现有)
  ↓
planner / direct_reply (现有)
```

---

## 三、开发任务清单

### Phase 1：基础设施搭建（优先级：P0）

#### Task 1.1：创建关系边界查询模块
**文件**：`utils/liveState/relationshipBoundary.js`

**功能**：
1. 从 Memory V3 projections 查询用户与晓山瑞希的关系数据
2. 根据关系等级生成边界提示文本
3. 处理无关系记录的兜底情况

**数据结构**：
```javascript
// 输出格式（不要修改）
{
  level: 'stranger' | 'acquaintance' | 'friend' | 'close' | 'intimate',
  closeness: 0-100,        // 熟悉度
  intimacy: 0-100,         // 亲近度
  tags: string[],          // 关系标签，如 ['bandmate', 'frequent_chat']
  lastInteractionAt: Date, // 最近互动时间
  boundary: string         // 边界提示文本（见下方模板）
}
```

**边界提示模板**（必须严格使用，不要擅自修改措辞）：

```javascript
// 陌生人 (closeness < 10)
"未建立明确关系；保持礼貌距离，不假设亲密度，根据当前对话逐步建立信任。"

// 初识 (closeness 10-30)
"认识但不熟；可以聊天但避免过度热情或预设对方了解自己的生活细节。"

// 朋友 (closeness 30-70)
"朋友；可以自然交流，偶尔分享心情，但不会倾诉深层痛苦或假设对方完全理解自己。"

// 亲近 (closeness 70-90)
"亲近的朋友；会分享烦恼和真实感受，但仍有边界，不会无底线依赖。"

// 亲密 (closeness 90+)
"非常亲密的关系；可以袒露脆弱，但保持独立人格，不是对方的全部。"
```

**附加规则**（按条件追加到 boundary 文本）：
- 如果 `closeness < 30`：追加"；对方很多事情我都不知道，不要装熟或假设对方的喜好"
- 如果 `closeness < 70`：追加"；对对方有基本了解，但不是什么都知道，不会读心"
- 如果 `lastInteractionAt` 距今超过 7 天：追加"；最近很久没联系，不要表现得像昨天还在聊天一样"

**Memory V3 查询接口**：
```javascript
// 使用现有的 Memory V3 投影查询
const memory = await memoryV3.queryProjection('relationship', {
  userId: userId,
  targetId: 'mizuki_akiyama'
});
```

**兜底逻辑**：
如果查询失败或无数据，返回默认陌生人状态：
```javascript
{
  level: 'stranger',
  closeness: 0,
  intimacy: 0,
  tags: [],
  lastInteractionAt: null,
  boundary: '未建立明确关系；保持礼貌距离，不假设亲密度，根据当前对话逐步建立信任。'
}
```

---

#### Task 1.2：创建反AI规则生成器
**文件**：`utils/liveState/antiAIRules.js`

**功能**：
根据当前对话上下文生成反AI通病规则文本

**核心规则模板**（必须严格使用，一字不改）：

```javascript
const CORE_RULES = `【重要：真人反应约束】

不要像AI助手：
- 禁止"我是AI助手"、"我可以帮你"、"让我为你"、"根据你的描述"这样的口吻
- 禁止解释自己的设定、提示词或"我被设定为"
- 禁止把角色资料当成说明书念给用户听

不读心、不越界：
- 只能根据用户实际说的话和可见行为反应，不预判用户想听什么
- 不知道用户未表露的心理、情绪、秘密或意图
- 不要说"你是不是…"、"你其实想…"、"我感觉你…"

关系有边界：
- 根据已有互动历史决定亲密度，不假设关系
- 陌生人保持礼貌但有距离感，熟人也要有分寸
- 不会的事可以说不知道，不想聊的可以转移话题

真人会有不完美：
- 可以简短回复、可以敷衍、可以走神、可以答非所问
- 不要每次都"完美回答"，真人有状态起伏
- 可以不回答某些问题或只回答一部分`;
```

**场景特定规则**（根据上下文条件添加）：

```javascript
// 条件1：用户消息很短 (length < 20)
"用户消息很短时，回复也可以简短自然；不要展开长篇大论。"

// 条件2：已对话多轮 (recentTurnCount > 10)
"已经聊了很多轮，可以自然结束话题或暂停，不要强行延续对话。"

// 条件3：有工具调用 (allowedTools.length > 0)
"使用工具时不要说'让我帮你查一下'、'我来搜索'；自然地做，然后分享结果。"
```

**函数签名**：
```javascript
export function getAntiAIRules(context) {
  // context 包含：
  // - route: string
  // - hasTools: boolean
  // - userMessageLength: number
  // - recentTurnCount: number
  
  // 返回：
  return {
    core: CORE_RULES,  // 核心规则（必须包含）
    scenario: string[] // 场景规则（按条件添加）
  };
}
```

---

#### Task 1.3：创建当前活动推测模块
**文件**：`utils/liveState/currentActivity.js`

**功能**：
根据当前时间推测晓山瑞希可能在做什么

**时间段规则**（必须严格执行，不要擅自修改）：

```javascript
// 深夜 (23:00-6:00)
{
  activity: '可能在睡觉或准备睡觉',
  mood: '困倦',
  constraints: '回复可能很简短或慢'
}

// 清晨 (6:00-8:00)
{
  activity: '可能刚起床',
  mood: '还没完全清醒',
  constraints: '可能需要点时间进入状态'
}

// 上午 (8:00-12:00)
{
  activity: '可能在学校或外出',
  mood: '日常状态',
  constraints: null
}

// 下午工作日 (14:00-18:00, 周一至周五)
{
  activity: '可能在学校或排练',
  mood: '专注',
  constraints: '可能不方便长时间聊天'
}

// 下午周末 (14:00-18:00, 周六日)
{
  activity: '可能在排练或外出',
  mood: '放松',
  constraints: null
}

// 晚上 (18:00-23:00)
{
  activity: '可能在家或外出',
  mood: '放松',
  constraints: null
}
```

**函数签名**：
```javascript
export function getCurrentActivity() {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0=周日, 1-5=工作日, 6=周六
  
  // 返回格式（不要修改）
  return {
    activity: string,    // 活动描述
    mood: string,        // 情绪状态
    constraints: string | null  // 约束条件
  };
}
```

**注意**：
- 这是 v1 版本，使用简单的时间规则
- 不要添加复杂的随机性或个性化逻辑
- 未来版本会接入日程数据库，当前保持简单

---

#### Task 1.4：创建最近对话摘要模块
**文件**：`utils/liveState/recentContext.js`

**功能**：
从 Daily Journal 提取最近对话的简短摘要

**查询逻辑**：
```javascript
export async function getRecentContextSummary(userId, limit = 5) {
  // 1. 从 Daily Journal 查询该用户最近 N 条记录
  const entries = await dailyJournal.queryRecent(userId, limit);
  
  // 2. 提取对话摘要
  const summaries = entries
    .filter(e => e.summary && e.summary.length > 0)
    .map(e => cleanText(e.summary, 100))  // 每条限制 100 字
    .slice(0, 3);  // 最多保留 3 条
  
  // 3. 拼接
  if (summaries.length === 0) {
    return null;  // 无最近对话
  }
  
  return summaries.join('；');
}
```

**输出格式示例**：
```
"最近聊了乐队排练的事；用户问了新曲进度；我分享了今天遇到的一只猫"
```

**Token 控制**：
- 单条摘要最多 100 字
- 最多保留 3 条
- 总长度不超过 300 字

---

#### Task 1.5：创建状态增强节点
**文件**：`api/runtimeV2/nodes/enhanceLiveState.js`

**功能**：
并行查询所有动态状态，构建增强上下文

**完整代码结构**：

```javascript
import { getRelationshipBoundary } from '../../../utils/liveState/relationshipBoundary.js';
import { getCurrentActivity } from '../../../utils/liveState/currentActivity.js';
import { getRecentContextSummary } from '../../../utils/liveState/recentContext.js';
import { getAntiAIRules } from '../../../utils/liveState/antiAIRules.js';
import { logger } from '../../../utils/logger.js';

export async function enhanceLiveState(state) {
  const { userId, messages, route, allowedTools, shortTermContinuity } = state;
  
  // 只增强 direct_chat 和 admin 路由
  if (route === 'ignore' || route === 'refuse') {
    return state;
  }
  
  try {
    // 并行查询所有状态
    const [relationship, activity, recentContext, antiAIRules] = await Promise.all([
      getRelationshipBoundary(userId),
      getCurrentActivity(),
      getRecentContextSummary(userId, 5),
      getAntiAIRules({
        route,
        hasTools: Array.isArray(allowedTools) && allowedTools.length > 0,
        userMessageLength: messages[messages.length - 1]?.content?.length || 0,
        recentTurnCount: shortTermContinuity?.recentTurns?.length || 0
      })
    ]);
    
    // 构建增强上下文
    const liveStateContext = buildLiveStateContext({
      relationship,
      activity,
      recentContext,
      antiAIRules,
      currentTime: new Date()
    });
    
    // 注入到 state（不覆盖现有字段）
    return {
      ...state,
      liveStateContext,
      _liveStateInjected: true
    };
    
  } catch (error) {
    logger.warn('Live state enhancement failed, continuing without it', { error });
    return state;  // 失败时不阻断流程
  }
}

function buildLiveStateContext({ relationship, activity, recentContext, antiAIRules, currentTime }) {
  const parts = [];
  
  parts.push('【生活状态补充】');
  parts.push(`当前时间：${currentTime.toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai', 
    hour12: false 
  })}`);
  parts.push('');
  
  // 当前活动
  if (activity.activity) {
    parts.push('【当前可能在做什么】');
    parts.push(activity.activity);
    if (activity.mood) parts.push(`情绪状态：${activity.mood}`);
    if (activity.constraints) parts.push(`⚠️ ${activity.constraints}`);
    parts.push('');
  }
  
  // 关系边界
  parts.push('【与这个用户的关系】');
  parts.push(relationship.boundary);
  if (relationship.tags && relationship.tags.length > 0) {
    parts.push(`关系标签：${relationship.tags.join('、')}`);
  }
  parts.push('');
  
  // 最近对话摘要
  if (recentContext) {
    parts.push('【最近聊过什么】');
    parts.push(recentContext);
    parts.push('');
  }
  
  // 反AI规则
  parts.push(antiAIRules.core);
  if (antiAIRules.scenario && antiAIRules.scenario.length > 0) {
    parts.push('');
    parts.push('【当前场景额外约束】');
    antiAIRules.scenario.forEach((rule, index) => {
      parts.push(`${index + 1}. ${rule}`);
    });
  }
  
  return parts.join('\n');
}
```

**Token 预算检查**：
最终文本必须控制在 **800 tokens** 以内，如果超出需要裁剪：
1. 优先保留核心规则
2. 其次保留关系边界
3. 最后保留活动和最近对话

#### Task 1.6：集成到 LangGraph V2 流程
**文件**：`api/runtimeV2/host/index.js`

**修改位置**：
在现有的 `prepare` 节点后、`route` 节点前插入 `enhanceLiveState` 节点

**修改前**：
```javascript
// 现有流程
const graph = new StateGraph({
  prepare: prepareNode,
  route: routeNode,
  planner: plannerNode,
  // ...
});

graph
  .addEdge('prepare', 'route')
  .addEdge('route', 'planner')
  // ...
```

**修改后**：
```javascript
// 导入新节点
import { enhanceLiveState } from '../nodes/enhanceLiveState.js';

const graph = new StateGraph({
  prepare: prepareNode,
  enhanceLiveState: enhanceLiveState,  // 【新增】
  route: routeNode,
  planner: plannerNode,
  // ...
});

graph
  .addEdge('prepare', 'enhanceLiveState')    // 【修改】
  .addEdge('enhanceLiveState', 'route')      // 【新增】
  .addEdge('route', 'planner')
  // ...
```

**注意**：
- 只修改边的连接，不修改其他逻辑
- 确保新节点失败时不阻断流程（已在节点内部处理）

---

#### Task 1.7：修改 Prompt Compiler 注入逻辑
**文件**：`utils/promptCompiler.js`

**修改位置**：
在 `buildMainReplyPrompt` 函数中，persona modules 之前注入 `liveStateContext`

**修改前**：
```javascript
export function buildMainReplyPrompt(state, stage) {
  const blocks = [];
  
  // 1. SYSTEM.txt
  if (systemPrompt) blocks.push(systemPrompt);
  
  // 2. Persona core blocks
  blocks.push(...personaCoreBlocks);
  
  // 3. Persona modules
  blocks.push(...personaModules);
  
  // 4. Runtime templates
  blocks.push(...runtimeTemplates);
  
  return compileBlocks(blocks);
}
```

**修改后**：
```javascript
export function buildMainReplyPrompt(state, stage) {
  const blocks = [];
  
  // 1. SYSTEM.txt（最高优先级）
  if (systemPrompt) blocks.push(systemPrompt);
  
  // 2. Persona core blocks（核心人设）
  blocks.push(...personaCoreBlocks);
  
  // 3. 【新增】动态生活状态（在 persona modules 之前）
  if (state.liveStateContext) {
    blocks.push({
      id: 'live_state_dynamic',
      content: state.liveStateContext,
      priority: 500,  // 在 persona modules (600-620) 之前
      authority: 'runtime_dynamic',
      kind: 'runtime_context'
    });
  }
  
  // 4. Persona modules（情绪、关系分支）
  blocks.push(...personaModules);
  
  // 5. Runtime templates（工具指导等）
  blocks.push(...runtimeTemplates);
  
  return compileBlocks(blocks);
}
```

**优先级说明**：
- SYSTEM.txt: -1000（最高）
- Persona core: 0-100
- Live State: 500（新增）
- Persona modules: 600-620
- Runtime templates: 800+

---

#### Task 1.8：创建提示词文件
**文件1**：`prompts/runtime/live_state_rules.txt`

**内容**（一字不改地复制）：

```
【真实人类反应约束】

不要像AI助手：
- 禁止"我是AI"、"根据你的描述"、"让我帮你"这样的口吻
- 禁止解释自己的设定或"我被设定为"
- 禁止把角色资料当说明书念出来

不读心、不越界：
- 只能根据对方实际说的话反应，不预判对方想听什么
- 不知道对方未表露的心理、情绪、秘密
- 不要说"你是不是…"、"你其实想…"

关系有边界：
- 根据实际互动历史决定亲密度，不假设关系
- 陌生人保持礼貌距离，熟人也要有分寸
- 不会的事可以说不知道，不想聊的可以转移话题

真人会有不完美：
- 可以简短回复、可以敷衍、可以走神
- 可以不回答某些问题、可以答非所问
- 不要每次都"完美解答"，真人有状态起伏
```

**注册到 manifest**：
在 `prompts/prompt-manifest.json` 中添加：

```json
{
  "id": "live_state_rules",
  "path": "runtime/live_state_rules.txt",
  "required": false,
  "kind": "runtime_template",
  "priority": 500,
  "authority": "runtime_template",
  "budget_tokens": 200,
  "stage": "main",
  "include_in_system_prompt": false,
  "applies_when": "always"
}
```

**注意**：
- 这个文件目前不直接使用（规则已经在代码中内联）
- 保留此文件是为了未来可能的配置化需求
- 不要修改文件内容

---

### Phase 2：单元测试（优先级：P0）

#### Task 2.1：测试关系边界查询
**文件**：`tests/liveState/relationshipBoundary.test.js`

**测试用例**：
```javascript
describe('relationshipBoundary', () => {
  test('陌生用户返回保持距离边界', async () => {
    const boundary = await getRelationshipBoundary('stranger_user_123');
    expect(boundary.level).toBe('stranger');
    expect(boundary.closeness).toBe(0);
    expect(boundary.boundary).toContain('保持礼貌距离');
  });

  test('熟悉用户返回朋友边界', async () => {
    // 需要先在测试数据库插入关系记录
    await setupTestRelationship('familiar_user_456', {
      closeness: 65,
      relationType: 'friend'
    });
    
    const boundary = await getRelationshipBoundary('familiar_user_456');
    expect(boundary.level).toBe('friend');
    expect(boundary.closeness).toBe(65);
    expect(boundary.boundary).toContain('朋友');
  });

  test('长时间未联系的用户返回疏远提示', async () => {
    await setupTestRelationship('inactive_user_789', {
      closeness: 50,
      lastInteractionAt: new Date(Date.now() - 10 * 86400000) // 10天前
    });
    
    const boundary = await getRelationshipBoundary('inactive_user_789');
    expect(boundary.boundary).toContain('很久没联系');
  });
});
```

---

#### Task 2.2：测试当前活动推测
**文件**：`tests/liveState/currentActivity.test.js`

**测试用例**：
```javascript
describe('currentActivity', () => {
  test('深夜时段返回睡觉状态', () => {
    // Mock 时间为 02:00
    jest.useFakeTimers().setSystemTime(new Date('2026-06-14 02:00:00'));
    
    const activity = getCurrentActivity();
    expect(activity.activity).toContain('睡觉');
    expect(activity.mood).toBe('困倦');
    expect(activity.constraints).toContain('简短');
    
    jest.useRealTimers();
  });

  test('工作日下午返回排练状态', () => {
    // Mock 时间为周三 15:00
    jest.useFakeTimers().setSystemTime(new Date('2026-06-17 15:00:00'));
    
    const activity = getCurrentActivity();
    expect(activity.activity).toContain('学校或排练');
    expect(activity.mood).toBe('专注');
    
    jest.useRealTimers();
  });
});
```

---

#### Task 2.3：测试反AI规则生成
**文件**：`tests/liveState/antiAIRules.test.js`

**测试用例**：
```javascript
describe('antiAIRules', () => {
  test('核心规则始终包含', () => {
    const rules = getAntiAIRules({
      route: 'direct_chat',
      hasTools: false,
      userMessageLength: 50,
      recentTurnCount: 3
    });
    
    expect(rules.core).toContain('禁止"我是AI助手"');
    expect(rules.core).toContain('不读心、不越界');
  });

  test('短消息触发简短回复规则', () => {
    const rules = getAntiAIRules({
      route: 'direct_chat',
      hasTools: false,
      userMessageLength: 15,
      recentTurnCount: 3
    });
    
    expect(rules.scenario).toContainEqual(
      expect.stringContaining('回复也可以简短')
    );
  });

  test('多轮对话触发结束话题规则', () => {
    const rules = getAntiAIRules({
      route: 'direct_chat',
      hasTools: false,
      userMessageLength: 50,
      recentTurnCount: 12
    });
    
    expect(rules.scenario).toContainEqual(
      expect.stringContaining('可以自然结束话题')
    );
  });
});
```

---

#### Task 2.4：测试状态增强节点
**文件**：`tests/runtimeV2/nodes/enhanceLiveState.test.js`

**测试用例**：
```javascript
describe('enhanceLiveState node', () => {
  test('成功注入生活状态上下文', async () => {
    const inputState = {
      userId: 'test_user_001',
      messages: [{ role: 'user', content: '你好' }],
      route: 'direct_chat',
      allowedTools: [],
      shortTermContinuity: { recentTurns: [] }
    };
    
    const outputState = await enhanceLiveState(inputState);
    
    expect(outputState.liveStateContext).toBeDefined();
    expect(outputState.liveStateContext).toContain('【生活状态补充】');
    expect(outputState.liveStateContext).toContain('【与这个用户的关系】');
    expect(outputState._liveStateInjected).toBe(true);
  });

  test('ignore路由跳过增强', async () => {
    const inputState = {
      userId: 'test_user_002',
      messages: [],
      route: 'ignore'
    };
    
    const outputState = await enhanceLiveState(inputState);
    
    expect(outputState.liveStateContext).toBeUndefined();
    expect(outputState._liveStateInjected).toBeUndefined();
  });

  test('查询失败时不阻断流程', async () => {
    // Mock 查询失败
    jest.spyOn(relationshipBoundary, 'getRelationshipBoundary')
      .mockRejectedValue(new Error('DB error'));
    
    const inputState = {
      userId: 'test_user_003',
      messages: [{ role: 'user', content: 'hi' }],
      route: 'direct_chat'
    };
    
    const outputState = await enhanceLiveState(inputState);
    
    // 应该返回原始 state，不抛出错误
    expect(outputState).toEqual(inputState);
  });
});
```

---

### Phase 3：集成测试与验证（优先级：P0）

#### Task 3.1：端到端测试
**文件**：`tests/integration/liveStateIntegration.test.js`

**测试场景**：

**场景1：陌生用户首次对话**
```javascript
test('陌生用户应得到礼貌但有距离的回复', async () => {
  const response = await runFullPipeline({
    userId: 'new_user_001',
    message: '你好，我是新来的',
    route: 'direct_chat'
  });
  
  // 验证生活状态已注入
  expect(response.state.liveStateContext).toContain('保持礼貌距离');
  
  // 验证回复不过度热情（需要人工验证，自动化测试只能检查关键词）
  expect(response.reply).not.toContain('我可以帮你');
  expect(response.reply).not.toContain('让我为你');
});
```

**场景2：深夜时段对话**
```javascript
test('深夜时段回复应简短', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-06-14 02:30:00'));
  
  const response = await runFullPipeline({
    userId: 'regular_user_002',
    message: '还没睡吗？',
    route: 'direct_chat'
  });
  
  expect(response.state.liveStateContext).toContain('可能在睡觉');
  expect(response.state.liveStateContext).toContain('简短');
  
  jest.useRealTimers();
});
```

**场景3：熟悉用户长期不联系后重新对话**
```javascript
test('长期未联系用户重新对话应有疏远感', async () => {
  // 设置用户关系：closeness=60，但15天未联系
  await setupTestRelationship('inactive_friend_003', {
    closeness: 60,
    relationType: 'friend',
    lastInteractionAt: new Date(Date.now() - 15 * 86400000)
  });
  
  const response = await runFullPipeline({
    userId: 'inactive_friend_003',
    message: '好久不见！',
    route: 'direct_chat'
  });
  
  expect(response.state.liveStateContext).toContain('很久没联系');
});
```

---

#### Task 3.2：Prompt 注入验证
**验证方法**：
1. 运行 `npm run diag:main-reply-prompt -- --limit 1`
2. 检查输出的 prompt 结构

**预期结果**：
```
=== Prompt Structure ===
1. SYSTEM.txt (priority: -1000)
2. persona/01_identity.txt (priority: 0)
3. persona/00_roleplay_liveness_prelude.txt (priority: 10)
...
N. live_state_dynamic (priority: 500) ← 【新增】应该在这里
N+1. persona_modules/daily_energy.txt (priority: 600)
N+2. runtime/tool_guidance.txt (priority: 800)
...
```

**验证内容**：
- `live_state_dynamic` 块存在
- 包含"【生活状态补充】"标记
- 包含"【与这个用户的关系】"
- 包含"【重要：真人反应约束】"
- Token 数量在 800 以内

---

#### Task 3.3：实际对话质量验证
**验证方法**：人工对话测试

**测试用例1：陌生用户**
```
用户输入：你好，我是新来的
期望回复类型：
  ✓ 礼貌但简短
  ✓ 不过度热情
  ✓ 不假设已经认识
  ✗ 避免："很高兴认识你！有什么我可以帮你的吗？"（AI助手感）
```

**测试用例2：熟悉用户**
```
用户输入：最近怎么样？
期望回复类型：
  ✓ 自然分享近况
  ✓ 可以提到具体活动（排练、学校）
  ✓ 可以反问对方
  ✗ 避免：每次都完美回答，像客服
```

**测试用例3：深夜时段**
```
时间：凌晨2点
用户输入：还在吗？
期望回复类型：
  ✓ 简短回复（如"嗯…怎么了"）
  ✓ 可以表现出困意
  ✗ 避免：长篇大论或过度精神
```

**测试用例4：短消息**
```
用户输入：好
期望回复类型：
  ✓ 同样简短（如"嗯"、"那就这样～"）
  ✗ 避免：展开长篇话题
```

**测试用例5：工具调用**
```
用户输入：今天天气怎么样？
期望回复类型：
  ✓ 自然使用天气工具
  ✓ 直接分享结果（如"今天晴天，22度"）
  ✗ 避免："让我帮你查一下天气"（AI助手口吻）
```

## 四、现有 Persona 文件修改说明

### ⚠️ 重要：不要修改现有 persona 文件

**原则**：
- 现有的 `prompts/persona/*.txt` 和 `prompts/persona_modules/*.txt` **完全不动**
- 生活状态增强是**补充性**的，不覆盖现有设定
- 如果发现冲突，优先保留现有 persona 文件的权威性

**唯一例外**：
如果发现现有 persona 文件中有明显的"AI助手化"语言（如"我是AI"、"我可以帮你"），可以提出修改建议，但**必须先经过审批，不得擅自修改**。

### 已知不需要修改的文件
以下文件保持原样，不做任何改动：
- `prompts/SYSTEM.txt`
- `prompts/admin.txt`
- `prompts/persona/01_identity.txt`
- `prompts/persona/00_roleplay_liveness_prelude.txt`
- `prompts/persona/08_human_imperfection.txt`
- 所有 `prompts/persona_modules/*.txt`

---

## 五、数据层支持

### 5.1 Memory V3 Projection 扩展

#### 需要确认的字段
检查 `utils/memory-v3/projections/relationship.js` 是否已包含：

```javascript
{
  userId: string,
  targetId: string,
  relationType: 'stranger' | 'acquaintance' | 'friend' | 'close' | 'intimate',
  closeness: number,        // 0-100
  intimacy: number,         // 0-100
  tags: string[],
  lastInteractionAt: Date,
  interactionCount: number
}
```

**如果字段缺失**：
- 在 `memory-v3` 相关代码中添加这些字段
- 迁移脚本：`node scripts/migrate-relationship-schema.js`
- 注意：不要破坏现有数据

**如果字段已存在**：
- 直接使用，无需修改

---

### 5.2 Daily Journal 查询接口

确认 `utils/dailyJournal/index.js` 是否已有：

```javascript
export async function queryRecent(userId, limit = 5) {
  // 返回最近 N 条该用户的 journal entries
}
```

**如果接口不存在**：
需要实现此查询方法，返回格式：

```javascript
[
  {
    userId: 'user_123',
    date: '2026-06-13',
    summary: '聊了乐队排练的事',
    topics: ['music', 'band'],
    mood: 'relaxed'
  },
  // ...
]
```

---

### 5.3 未来扩展：Schedule 数据库（Phase 2+）

**当前版本不实现**，使用简单的时间规则即可。

未来如需实现：
```sql
CREATE TABLE character_schedules (
  id INTEGER PRIMARY KEY,
  character_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  activity TEXT,
  place TEXT,
  mood TEXT,
  availability TEXT
);
```

---

## 六、性能与资源控制

### 6.1 查询性能要求

**目标**：生活状态查询总耗时 < 200ms

**并行查询优化**：
```javascript
// ✓ 正确：并行查询
const [a, b, c] = await Promise.all([
  getRelationshipBoundary(userId),
  getCurrentActivity(),
  getRecentContextSummary(userId)
]);

// ✗ 错误：串行查询
const a = await getRelationshipBoundary(userId);
const b = await getCurrentActivity();
const c = await getRecentContextSummary(userId);
```

**超时保护**：
每个查询函数应有超时限制（100ms），超时返回兜底值：

```javascript
async function getRelationshipBoundary(userId) {
  return Promise.race([
    actualQuery(userId),
    timeout(100, DEFAULT_STRANGER_BOUNDARY)
  ]);
}
```

---

### 6.2 Token 预算控制

**硬限制**：生活状态上下文 ≤ 800 tokens

**检查方法**：
```javascript
import { estimateTokens } from '../../../utils/tokenEstimator.js';

const liveStateContext = buildLiveStateContext(...);
const tokens = estimateTokens(liveStateContext);

if (tokens > 800) {
  logger.warn('Live state context exceeds token budget', { tokens });
  // 触发裁剪逻辑
}
```

**裁剪优先级**（从低到高）：
1. 场景特定规则（可选）
2. 最近对话摘要（可选）
3. 当前活动描述（可简化）
4. 关系边界（必须保留）
5. 核心反AI规则（必须保留）

---

### 6.3 缓存策略（可选，Phase 2+）

对于不频繁变化的数据可以缓存：

```javascript
// 关系数据缓存（5分钟）
const relationshipCache = new Map();

async function getRelationshipBoundary(userId) {
  const cached = relationshipCache.get(userId);
  if (cached && Date.now() - cached.timestamp < 300000) {
    return cached.data;
  }
  
  const data = await actualQuery(userId);
  relationshipCache.set(userId, { data, timestamp: Date.now() });
  return data;
}
```

**当前版本不实现缓存**，先确保功能正确性。

---

## 七、错误处理与日志

### 7.1 错误处理原则

**核心原则**：任何失败都不应阻断主流程

```javascript
// ✓ 正确：捕获错误，返回兜底值
try {
  return await getRelationshipBoundary(userId);
} catch (error) {
  logger.warn('Relationship query failed, using default', { userId, error });
  return DEFAULT_STRANGER_BOUNDARY;
}

// ✗ 错误：让错误向上传播
return await getRelationshipBoundary(userId);
```

---

### 7.2 日志规范

**必须记录的事件**：
```javascript
// 成功注入
logger.info('Live state enhanced', { 
  userId, 
  relationship: relationship.level,
  activity: activity.activity,
  tokens: estimateTokens(liveStateContext)
});

// 查询失败
logger.warn('Live state query failed', {
  userId,
  module: 'relationshipBoundary',
  error: error.message
});

// Token 超限
logger.warn('Live state context exceeds token budget', {
  userId,
  tokens,
  limit: 800
});
```

**不要记录的内容**：
- 用户消息原文
- 关系详细内容（只记录 level）
- 完整的 liveStateContext

---

## 八、部署与验收

### 8.1 部署前检查清单

- [ ] 所有单元测试通过（`npm test`）
- [ ] 集成测试通过
- [ ] Prompt 注入验证通过（`npm run diag:main-reply-prompt`）
- [ ] Token 预算检查通过（< 800 tokens）
- [ ] 错误处理测试通过（模拟数据库失败）
- [ ] 性能测试通过（查询耗时 < 200ms）
- [ ] 人工对话测试通过（至少 5 个场景）

---

### 8.2 部署步骤

1. **本地验证**：
   ```bash
   npm test
   npm run diag:main-reply-prompt -- --limit 3
   npm run check:agent
   ```

2. **启动测试**：
   ```bash
   npm start
   # 进行人工对话测试
   ```

3. **提交代码**：
   ```bash
   git add .
   git commit -m "feat: add live state enhancement system

   - Add relationship boundary query
   - Add current activity inference
   - Add anti-AI rules generator
   - Integrate enhanceLiveState node into LangGraph V2
   - Token budget: ~800 tokens"
   ```

4. **部署后验证**：
   - 测试陌生用户对话
   - 测试熟悉用户对话
   - 测试深夜时段对话
   - 检查日志是否有错误

---

### 8.3 验收标准

#### 功能性验收
- [x] 陌生用户看到"保持礼貌距离"提示
- [x] 熟悉用户看到相应的关系边界
- [x] 深夜时段提示简短回复
- [x] 工作日下午提示可能在排练
- [x] 反AI规则正确注入
- [x] 查询失败时不阻断流程

#### 质量验收
- [x] 回复不再有"我是AI助手"、"我可以帮你"等表述
- [x] 陌生用户不会被过度热情对待
- [x] 熟悉用户能感受到关系的延续性
- [x] 深夜回复确实更简短
- [x] 短消息得到简短回复

#### 性能验收
- [x] 生活状态查询耗时 < 200ms
- [x] Token 预算 < 800 tokens
- [x] 不增加明显的响应延迟（< 5%）

---

## 九、故障排查指南

### 9.1 状态未注入

**症状**：`state.liveStateContext` 为 undefined

**排查步骤**：
1. 检查 `enhanceLiveState` 节点是否正确添加到 graph
2. 检查 route 是否为 ignore/refuse（这些路由会跳过增强）
3. 检查日志中是否有错误
4. 检查 `state._liveStateInjected` 字段

---

### 9.2 Prompt 中未出现生活状态

**症状**：运行 `diag:main-reply-prompt` 看不到 `live_state_dynamic` 块

**排查步骤**：
1. 检查 `promptCompiler.js` 是否正确修改
2. 检查 `state.liveStateContext` 是否有值
3. 检查 priority 设置是否正确（应为 500）
4. 检查是否被其他 block 覆盖

---

### 9.3 关系查询始终返回陌生人

**症状**：所有用户都显示"保持礼貌距离"

**排查步骤**：
1. 检查 Memory V3 中是否有关系数据
2. 运行 `npm run diag:memory -- profile-journal-db`
3. 检查 `relationshipBoundary.js` 的查询逻辑
4. 检查 userId 是否正确传递

---

### 9.4 Token 超限

**症状**：生活状态上下文 > 800 tokens

**排查步骤**：
1. 运行 token 估算：`estimateTokens(liveStateContext)`
2. 检查各部分长度：
   - 核心规则：~300 tokens
   - 关系边界：~100 tokens
   - 活动描述：~80 tokens
   - 最近对话：~200 tokens
   - 场景规则：~100 tokens
3. 实施裁剪逻辑（优先保留核心规则和关系边界）

---

### 9.5 响应延迟明显增加

**症状**：增加生活状态后响应变慢

**排查步骤**：
1. 添加性能日志：
   ```javascript
   const start = Date.now();
   const [a, b, c] = await Promise.all([...]);
   logger.info('Live state query time', { ms: Date.now() - start });
   ```
2. 检查是否使用了并行查询（Promise.all）
3. 检查数据库查询是否有索引
4. 考虑添加缓存（Phase 2）

---

## 十、后续优化方向（Phase 2+）

### 10.1 关系动态演化
- 根据对话质量自动调整 closeness
- 长期不互动自动降低亲密度
- 话题偏好学习

### 10.2 日程系统
- 接入实际的 schedule 数据库
- 支持特殊事件（演出、考试）
- 地点系统集成

### 10.3 情绪状态追踪
- 最近心情记录
- 压力水平
- 影响回复风格

### 10.4 场景化规则扩展
- 群聊场景（多人对话）
- 寻求建议场景
- 工具密集场景

### 10.5 A/B 测试框架
- 对比有无生活状态的效果
- 测试不同规则强度
- 收集用户反馈

---

## 十一、注意事项与禁忌

### ❌ 禁止事项

1. **禁止修改现有 persona 文件**
   - 不要动 `prompts/persona/*.txt`
   - 不要动 `prompts/persona_modules/*.txt`
   - 不要动 `prompts/SYSTEM.txt`

2. **禁止擅自修改规则措辞**
   - 核心规则模板必须一字不改
   - 关系边界提示必须使用指定模板
   - 时间段活动描述必须使用指定模板

3. **禁止让查询失败阻断流程**
   - 所有查询必须有 try-catch
   - 所有失败必须有兜底值
   - 不允许向上抛出错误

4. **禁止超出 Token 预算**
   - 硬限制 800 tokens
   - 超出时必须裁剪
   - 不允许"超一点没关系"

5. **禁止添加复杂的随机性**
   - 当前版本保持简单确定性
   - 不要添加"随机心情"、"随机事件"等
   - 随机性留待 Phase 2+

### ✓ 推荐做法

1. **先实现，后优化**
   - Phase 1 只做基础功能
   - 不要在 Phase 1 就做缓存、AB测试等

2. **充分测试**
   - 单元测试 > 集成测试 > 人工测试
   - 每个场景至少测试 3 次

3. **详细日志**
   - 记录关键状态
   - 方便排查问题

4. **保守兜底**
   - 宁可用默认值，不要猜测
   - 陌生人比过度热情好

---

## 十二、开发时间估算

| 阶段 | 任务 | 估算时间 |
|------|------|---------|
| Phase 1 | Task 1.1-1.4（核心模块） | 2-3 天 |
| Phase 1 | Task 1.5-1.7（集成） | 1-2 天 |
| Phase 1 | Task 1.8（提示词文件） | 0.5 天 |
| Phase 2 | 单元测试 | 1-2 天 |
| Phase 3 | 集成测试与验证 | 1-2 天 |
| **总计** | | **5-10 天** |

**关键路径**：
1. 核心模块实现（2-3天）
2. 集成到 LangGraph（1天）
3. 测试验证（2-3天）

---

## 十三、文档更新要求

完成开发后，需要更新以下文档：

1. **CLAUDE.md**
   - 在 "Memory Architecture" 部分添加 "Live State Enhancement"
   - 说明生活状态查询流程
   - 更新架构图

2. **README.md**
   - 添加时间戳记录本次更新
   - 简短说明新增的生活状态系统

3. **本文档**
   - 标记为"已完成"
   - 记录实际遇到的问题和解决方案
   - 更新性能数据（实际 token 数、查询耗时）

---

## 附录：完整代码骨架

### A.1 relationshipBoundary.js

```javascript
// utils/liveState/relationshipBoundary.js
import { memoryV3 } from '../memory-v3/index.js';
import { logger } from '../logger.js';

const BOUNDARY_TEMPLATES = {
  stranger: '未建立明确关系；保持礼貌距离，不假设亲密度，根据当前对话逐步建立信任。',
  acquaintance: '认识但不熟；可以聊天但避免过度热情或预设对方了解自己的生活细节。',
  friend: '朋友；可以自然交流，偶尔分享心情，但不会倾诉深层痛苦或假设对方完全理解自己。',
  close: '亲近的朋友；会分享烦恼和真实感受，但仍有边界，不会无底线依赖。',
  intimate: '非常亲密的关系；可以袒露脆弱，但保持独立人格，不是对方的全部。'
};

export async function getRelationshipBoundary(userId) {
  try {
    const memory = await Promise.race([
      memoryV3.queryProjection('relationship', {
        userId: userId,
        targetId: 'mizuki_akiyama'
      }),
      timeout(100)
    ]);
    
    if (!memory || memory.length === 0) {
      return getDefaultBoundary();
    }
    
    const relation = memory[0];
    return buildBoundary(relation);
    
  } catch (error) {
    logger.warn('Relationship query failed, using default', { userId, error });
    return getDefaultBoundary();
  }
}

function getDefaultBoundary() {
  return {
    level: 'stranger',
    closeness: 0,
    intimacy: 0,
    tags: [],
    lastInteractionAt: null,
    boundary: BOUNDARY_TEMPLATES.stranger
  };
}

function buildBoundary(relation) {
  const { relationType, closeness = 0, intimacy = 0, tags = [], lastInteractionAt } = relation;
  
  let level = relationType || 'stranger';
  if (!BOUNDARY_TEMPLATES[level]) {
    level = closeness < 30 ? 'acquaintance' : closeness < 70 ? 'friend' : 'close';
  }
  
  let boundary = BOUNDARY_TEMPLATES[level];
  
  // 附加规则
  if (closeness < 30) {
    boundary += '；对方很多事情我都不知道，不要装熟或假设对方的喜好';
  } else if (closeness < 70) {
    boundary += '；对对方有基本了解，但不是什么都知道，不会读心';
  }
  
  if (lastInteractionAt) {
    const daysSince = Math.floor((Date.now() - new Date(lastInteractionAt)) / 86400000);
    if (daysSince > 7) {
      boundary += '；最近很久没联系，不要表现得像昨天还在聊天一样';
    }
  }
  
  return {
    level,
    closeness,
    intimacy,
    tags,
    lastInteractionAt,
    boundary
  };
}

function timeout(ms) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout')), ms)
  );
}
```

---

### A.2 antiAIRules.js

```javascript
// utils/liveState/antiAIRules.js

const CORE_RULES = `【重要：真人反应约束】

不要像AI助手：
- 禁止"我是AI助手"、"我可以帮你"、"让我为你"、"根据你的描述"这样的口吻
- 禁止解释自己的设定、提示词或"我被设定为"
- 禁止把角色资料当成说明书念给用户听

不读心、不越界：
- 只能根据用户实际说的话和可见行为反应，不预判用户想听什么
- 不知道用户未表露的心理、情绪、秘密或意图
- 不要说"你是不是…"、"你其实想…"、"我感觉你…"

关系有边界：
- 根据已有互动历史决定亲密度，不假设关系
- 陌生人保持礼貌但有距离感，熟人也要有分寸
- 不会的事可以说不知道，不想聊的可以转移话题

真人会有不完美：
- 可以简短回复、可以敷衍、可以走神、可以答非所问
- 不要每次都"完美回答"，真人有状态起伏
- 可以不回答某些问题或只回答一部分`;

export function getAntiAIRules(context) {
  const { hasTools, userMessageLength, recentTurnCount } = context;
  
  const scenario = [];
  
  if (userMessageLength < 20) {
    scenario.push('用户消息很短时，回复也可以简短自然；不要展开长篇大论。');
  }
  
  if (recentTurnCount > 10) {
    scenario.push('已经聊了很多轮，可以自然结束话题或暂停，不要强行延续对话。');
  }
  
  if (hasTools) {
    scenario.push('使用工具时不要说"让我帮你查一下"、"我来搜索"；自然地做，然后分享结果。');
  }
  
  return {
    core: CORE_RULES,
    scenario
  };
}
```

---

### A.3 currentActivity.js

```javascript
// utils/liveState/currentActivity.js

export function getCurrentActivity() {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  
  // 深夜
  if (hour >= 23 || hour < 6) {
    return {
      activity: '可能在睡觉或准备睡觉',
      mood: '困倦',
      constraints: '回复可能很简短或慢'
    };
  }
  
  // 清晨
  if (hour >= 6 && hour < 8) {
    return {
      activity: '可能刚起床',
      mood: '还没完全清醒',
      constraints: '可能需要点时间进入状态'
    };
  }
  
  // 上午
  if (hour >= 8 && hour < 12) {
    return {
      activity: '可能在学校或外出',
      mood: '日常状态',
      constraints: null
    };
  }
  
  // 下午工作日
  if (hour >= 14 && hour < 18 && dayOfWeek >= 1 && dayOfWeek <= 5) {
    return {
      activity: '可能在学校或排练',
      mood: '专注',
      constraints: '可能不方便长时间聊天'
    };
  }
  
  // 下午周末
  if (hour >= 14 && hour < 18) {
    return {
      activity: '可能在排练或外出',
      mood: '放松',
      constraints: null
    };
  }
  
  // 晚上
  return {
    activity: '可能在家或外出',
    mood: '放松',
    constraints: null
  };
}
```

---

## 结语

本文档提供了完整的开发任务和实现细节。请严格按照文档执行，不要擅自修改规则模板、现有 persona 文件或架构设计。

如有疑问或遇到文档未覆盖的情况，请先暂停开发，与项目负责人确认后再继续。

**开发完成后，请在此处记录完成日期和实际遇到的问题**：

---
完成日期：_____________

遇到的问题及解决方案：
1. 
2. 
3. 

---
