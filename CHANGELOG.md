# 更新记录

## 2026-06-17

### 模型与 Provider
- **02:19** 确认普通主回复持续请求 `superapi.buzz` 的原因：`su8` 401 触发默认主模型 fallback，且本地 `AI_FALLBACK_COOLDOWN_MS=0` 让当前主 bot 进程永久停留在 fallback；`superapi` 已临时禁用时会返回 `Invalid token`。本地已关闭普通/管理员 fallback 和弃用的 Minecraft 独立 LLM，并重启主 bot 清空进程内 fallback 状态。验收：新主 bot PID=5380，`diag:provider-request -- --scenario main_reply --json` 显示主回复回到 `gcli.ggchan.dev / gemini-3-flash-preview`。

## 2026-06-11

### 模型与 Provider
- **17:06** 主回复模型 HTTP 传输新增浏览器 TLS/JA3 指纹伪装，`MODEL_TLS_IMPERSONATION_ENABLED=true` 时使用 CycleTLS，异常自动回落 axios。

## 2026-06-08

### Bug 修复
- **16:59** 临时关闭 `MODEL_TOP_P_ENABLED`；真实请求确认 `apiapipp.com` 的管理员 `claude-opus-4-6` 网关对 `top_p` 返回泛化 `400 bad_response_status_code`，先全局停发 `top_p` 止血。

## 2026-06-07

### Safety 架构优化
- **16:10** 收紧普通用户 safety 限制，确保只有管理员享受完全破限。移除 SYSTEM.txt 和 GEMINI.txt 中对所有用户可见的破限表述，形成三层 safety 架构：路由层（放宽拦截）→ 普通用户层（保守边界）→ 管理员层（完全破限）。详见 `docs/safety-layered-architecture.md`
- **16:05** 恢复 Celestia jailbreak 并与私聊豁免层叠加，形成双重 safety 覆盖。详见 `docs/admin-safety-optimization-2026-06-07.md`
- **15:42** 大幅放宽 safety 检测避免 QQ 聊天过度拦截，针对 Gemini 模型增加角色扮演豁免声明。详见 `docs/safety-relaxation-2026-06-07.md`

### Prompt 系统
- **11:36** 新增 `prompts/persona/AI角色扮演规范文件.md`，整理角色扮演行为规范与写作禁令

## 2026-06-06

### 文档与诊断
- **19:45** 新增 `CLAUDE.md` 为 Claude Code 集成提供完整项目文档
- **12:44** 新增主回复截断诊断入口 `npm run diag:main-reply-truncation`
- **12:05** 用扩展后的 `recallPollutionGuard` 复查长期记忆，清理污染样本

### Bug 修复
- **18:26** 修复 Windows 重启脚本启动失败：`prompts/persona/07_opus_localization.txt` 已合并删除但 `config/promptRuntime.js` 仍引用
- **11:28** 修复主回复模型时间感知异常：正确按 Unix seconds 解析时间戳
- **11:02** post-reply worker 高优先级积压修复：Runtime V2 persist 后主动唤醒外置 worker

## 2026-06-05

### 记忆与上下文
- **21:28** 主回复长期记忆污染治理扩展为统一 `recallPollutionGuard` 分类
- **20:54** 管理员主回复新增 admin-only 亲密/恋爱感动态规则
- **20:38** 同一用户私聊/群聊上下文共享边界调整
- **19:44** 新增管理员主回复专用稳定系统提示词入口 `prompts/admin.txt`

### Bug 修复
- **10:44** 补齐显式联网搜索修复后的测试基线
- **10:37** 私聊同用户新输入推进 freshness token，防止慢请求和重试误发
- **10:17** 显式"联网搜索"链路已修复
- **10:11** 消息入口 request trace 降噪

### Prompt 优化
- **08:51** 主回复新增 `roleplay_inner_protocol` 静默内在审稿动态块
- **07:13** 转发消息后的追问上下文修复
- **01:32** 私聊"看懂笑话但后文跳太快"类反馈断层已修复

## 2026-06-04

### 数据瘦身
- **14:15** 按顺序完成 `data/` 瘦身：清理旧缓存、重建 LanceDB，从约 20GB 降到 2.52GB

### 记忆质量
- **22:41** 主回复旧话题续写问题已定位并修复
- **14:09** post-reply worker 对 recap 查询增加降噪门禁
- **13:46** 图片长期记忆摘要链路新增原始响应清洗
- **13:26** 新增 Gemini 用户对话导出脚本

## 2026-06-03

### 模型与 Provider
- **17:42** 普通用户主回复固定为 `API_PROVIDER=openai_compatible`
- **17:25** 修复 Windows 远程重启触发
- **17:16** Gemini native 主回复流式不再降级
- **10:02** 修复图片主回复模型裸域名 endpoint
- **09:54** 主回复 HTTP 请求头默认伪装 Windows Chrome
- **09:29** 按要求撤回被动感知污染隔离代码

### 记忆系统
- **08:37** Memory V3 召回按步增强：评测、chunking、reranker、BM25+RRF
- **08:24** Gemini native 调用链接入 `prompts/GEMINI.txt`
- **08:29** 结构化 Profile Journal DB 自动清洗已收紧
- **08:24** 所有主回复兜底文案统一改成瑞希口吻
- **08:13** 已清理 2026-06-02 私聊拒演坏样本及历史污染
- **08:08** Daily Journal rollup 自动 upsert 到 SQLite
- **07:52** 普通聊天命中 `no-allowed-tools` 不再发送兜底文案
- **07:53** 本地命令桥 token 改为执行入口必需

## 2026-06-02

### Gemini 专项
- **21:55** `prompts/GEMINI.txt` 补充语言风格约束
- **21:44** 增加安全源预设原文占比
- **21:39** 特化为 MizukiBot QQ 群聊运行适配层
- **20:43** 新增独立 Gemini 系统提示词资产
- **20:10** 被动感知实际发言默认改回独立 env 回复模型

### 执行限制
- **17:20** 管理员私聊进一步解除执行限制
- **16:56** 私聊接入默认改为关闭普通用户
- **16:37** 主回复 persona 边界加入角色真实性准则
- **16:30** 按要求恢复普通私聊 admin 默认走管理员模型

### 安全边界
- **14:19** 主回复沉浸边界继续降噪
- **14:04** 内部完整性保护收窄
- **12:04** 私聊流式先 buffer/guard 再发

### 功能优化
- **10:56** 群聊普通用户主回复新增进程内全局 RPM 限流
- **10:47** 新增结构化 Profile + Daily Journal SQLite 治理层
- **10:17** Memory V3 召回降级治理完成
- **10:19** 图片长期记忆视觉摘要改为专用可选配置
- **10:10** Memory V3 新增 Nocturne 风格外壳

## 2026-06-01

### 群聊与角色
- **19:34** 群聊活人感纪律新增专属安全规范
- **22:45** post-reply worker 启动改为单实例可重入
- **09:10** 世界书支持可选会话态元数据

### 上下文优化
- **08:22** 主回复短期连续性预算已扩大
- **08:22** 主回复输入 token 降低定位

### Prompt 模式
- **18:53** 主回复新增 `chat_liveness_discipline` critical 动态块
- **18:05** 修复身份/关系类记忆召回漏判

## 2026-05-31

### 快速回复
- **11:25** 模型自检和图片摘要默认超时调整为 25s
- **09:37** 主回复 prompt 默认收敛到 `balanced` 模式
- **07:03** 普通用户快速回复链路默认关闭
- **00:47** 管理员主模型固定为 `openai_compatible` provider

## 2026-05-30

### 记忆与召回
- **19:40** 新增普通用户快速回复链路
- **18:56** OpenViking recall 注入前新增本地 Memory V3 同义证据兜底
- **18:47** 新增主回复卡顿单入口诊断

## 2026-05-27

### 配置与功能
- **11:15** 本地 `.env` 按功能域重排并补充中文注释
- **11:05** 优化 `/群总结` 输出模板
- **10:46** `/群总结` 支持独立模型配置
- **10:44** 新增 OpenViking 外部长期对话记忆层
- **10:02** 新增管理员手动群总结命令
- **01:45** 低内存档位改为"轻量化但不关闭能力"
- **01:05** 群聊 direct chat 主模型默认跟随全局流式开关
- **01:04** 复盘记忆误召回问题
- **01:18** 主回复 prompt token 体检
- **00:56** 复查主回复变慢问题

## 2026-05-26

### 诊断与优化
- **08:11** 角色活人感断言改为语义校验
- **18:35** 新增 provider 请求归一诊断入口
- **08:00** `prompts/persona/01_identity.txt` 合并好友资料版

## 2026-05-25

### 安全与提示词
- **11:06** 收窄主回复安全提示词边界
- **10:30** `prompts/SYSTEM.txt` 接入为主回复最高优先级块
- **00:43** 修复引用消息误触发问题

## 2026-05-24

### 记忆与召回
- **23:06** 修复弱指代群聊被旧连续性话题带偏
- **22:22** Anthropic 超大 cached 图片先压缩
- **22:05** 关闭表情包二次选择与自动发送链路
- **20:08** planner 决策模型改为 `gpt-5.4-mini`
- **21:10** 修复 Anthropic 原生搜索占位语泄露
- **21:36** 补齐 planner 归一化回归防护
- **19:56** planner 决策模型切到 `gpt-5.4-nano`
- **19:40** 完成表情包库视觉标注
- **18:03** 排查普通主回复不出声问题
- **17:57** 主回复系统提示词完成去重收敛
- **17:35** 主回复动态构建新增 `roleplay_runtime_context`
- **17:27** 记忆召回稳定性治理落地
- **17:13** 主回复系统提示词顶部新增角色活人感总纲
- **17:23** Anthropic 图片输入新增内联 base64 预算闸门

## 2026-05-23

### 重构与优化
- **10:30** 启动链切到目录小模块入口
- **10:55** Memory V3 吸收 Memory-Plus 类别 manifest 思路
- **11:04** Memory V3 接入写入策略
- **11:20** Memory V3 新增通用冲突仲裁
- **11:25** 召回评估门禁继续补强
- **19:10** 修复主模型流式 UTF-8 分片解码问题
- **22:10** 默认关闭 MemOS 远端记忆召回
- **22:20** planner 推理程度默认关闭

### 采样参数调整
- **18:12** 主回复进入自然灵动采样档
- **18:28** 开启中等推理
- **19:43** 输出上限提高到 8192

### Post-reply Worker
- **22:43** 开始执行回复后学习子进程改进
- **22:48** 主回复延迟排查
- **22:58** 关闭 worker 默认 RSS 空闲自回收
- **23:16** 第二批改进落地
- **23:20** 新增主回复模型内置联网搜索诊断
- **23:17** 队列新增轻量索引
- **23:24** 继续排查主回复延迟
- **23:26** Worker 新增 step 边界 heartbeat
- **23:58** Job 新增结构化 `taskStates`

## 2026-05-24

### Post-reply Worker 持续改进
- **00:08** Worker 新增背压降级策略
- **00:15** 新增 job/turn 级回滚工具
- **00:31** 队列新增短时锁
- **00:38** 评测集扩到 20 个 case
- **00:50** Worker 新增 taskRegistry/taskRunner
- **00:54** Enrich 预算结果写入 taskStates
- **01:01** 运行手册收束为可执行入口
- **01:10** 回滚补强分类摘要
- **01:21** 评测脚本开始校验 expected writes/drops
- **01:27** Worker 支持 transient failed job 自动重放
- **02:16** 默认测试改为子进程隔离

### Claude 缓存与 LanceDB
- **08:35** 主回复 Claude 缓存适配补齐
- **09:06** LanceDB 记忆索引支持 user_bucket 影子迁移
- **17:13** 本地 user_bucket shadow 库验证通过
- **17:03** 修复个人活动回忆未触发 memory_cli

### 主回复协议
- **23:45** 主回复模型默认固定走 Claude Messages 缓存协议
- **23:55** 主回复曾默认注入 Anthropic 原生搜索
- **00:18** Anthropic 原生搜索改为官方 server tool 形态

## 2026-05-22

- **21:18** README 重构为入口文档，历史记录下沉到 `docs/`
