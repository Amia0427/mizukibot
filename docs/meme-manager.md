# Meme Manager

更新 2026-05-24 22:05 +08:00：表情包自动 follow-up 已关闭。`MEME_MANAGER_FOLLOWUP_ENABLED=false` 时 `maybeSendMemeFollowup` 会在 selector LLM 前直接返回 `followup-disabled`，不会选择素材，也不会向 NapCat 发送图片；图库、标注和 `/meme` 管理命令保留。

更新 2026-05-24 19:40 +08:00：对 `C:\Users\Administrator\Downloads\yichuantiku` 的 11 张表情包完成视觉理解标注，并写入当前本地运行时图库。

## Runtime Assets

本次落点：

- `data/meme_manager.json`
- `data/memes/可爱夸夸`
- `data/memes/疑惑装傻`
- `data/memes/低落安慰`
- `data/memes/开心期待`
- `data/memes/加载等待`

分类摘要：

- `可爱夸夸`：4 张，`praise/playful`，适合夸奖、可爱回应、打招呼和轻松闲聊。
- `疑惑装傻`：3 张，`confused/playful`，适合疑惑、没懂、偷看和轻微吐槽。
- `低落安慰`：2 张，`comfort`，适合委屈、低落、自嘲和安慰场景。
- `开心期待`：1 张，`praise/playful`，适合庆祝、终于等到和高兴回应。
- `加载等待`：1 张，`confused/playful`，适合加载中、卡住、等一下和思考中。

## Annotation Shape

每张素材都标注为 `analysis.status=ready`，`analysis.model=manual-visual-annotation/2026-05-24T19:40+08:00`，并补齐当前发送机制会读取的字段：

- `summary`
- `primaryMood`
- `secondaryMoods`
- `intensity`
- `confidence`
- `expressionTags`
- `sceneTags`
- `styleTags`
- `subjectTags`
- `textContent`
- `textTags`
- `preferredContexts`
- `avoidContexts`

验证方式：

```powershell
@'
const meme = require('./core/memeManager');
const store = meme.initializeMemeManager();
console.log(Object.values(store.categories).map((c) => `${c.name}:${c.assets.length}`).join(', '));
'@ | node -
```
