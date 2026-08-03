# JSON 输出结构定义

`influencer_profiler` 的 JSON 输出结构。LLM 生成后经 `_compact_result()` 硬截断超长字段。

---

## 完整 Schema

```json
{
  "persona_positioning": {
    "summary": "string — 人设一句话，<=30 字",
    "target_audience": "string — 受众描述，<=15 字",
    "core_topics": ["string — 最多 3 个核心选题，每个 <=8 字"]
  },
  "content_style": {
    "style_labels": ["string — 最多 3 个风格标签，从 8 类枚举中选用"],
    "style_summary": "string — 口吻+节奏+风格综合描述，<=50 字",
    "speech_pace": "string — 语速：快 | 中 | 慢",
    "tone": "string — 语气描述，<=12 字",
    "taboos": ["string — 忌写法，最多 2 条，每条 <=12 字"]
  },
  "influencer_profile_text": "string — 供下游 script_scorer 使用的人设+风格+语气节奏摘要，<=200 字，口语化简单说明",
  "analysis_mode": "string — 分析模式：multimodal_audio | text_fallback | text_only",
  "author_nickname": "string — 达人昵称（可选，来自 TikHub）"
}
```

---

## 字段说明

### persona_positioning（人设定位）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| summary | string | <=30 字 | 人设一句话总结 |
| target_audience | string | <=15 字 | 目标受众 |
| core_topics | string[] | 最多 3 个，每个 <=8 字 | 核心内容选题方向 |

### content_style（内容风格）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| style_labels | string[] | 最多 3 个 | 从 8 类枚举标签中选用，按匹配度排序 |
| style_summary | string | <=50 字 | 口吻+节奏+风格综合描述 |
| speech_pace | string | 枚举 | 语速：快/中/慢 |
| tone | string | <=12 字 | 语气描述 |
| taboos | string[] | 最多 2 条，每条 <=12 字 | 内容忌讳/避免写法 |

### influencer_profile_text（风格摘要）

| 属性 | 值 |
|------|-----|
| 类型 | string |
| 最大长度 | 200 字 |
| 用途 | 供下游 `script_scorer` 使用的达人风格画像 |
| 格式 | 口语化简单说明，不要分点罗列 |
| 截断 | 超过 200 字时自动截断并标记 `_profile_text_truncated: true` |

### analysis_mode（分析模式）

| 模式 | 触发条件 | 分析质量 |
|------|----------|----------|
| `multimodal_audio` | 有音频 mp3 | 最佳：直接听音频分析口吻语气 |
| `text_fallback` | 无音频但有转写文本 | 中等：根据文本推断 |
| `text_only` | 无音频无转写 | 基础：仅根据 bio + 视频标题 |

---

## 输出示例

```json
{
  "persona_positioning": {
    "summary": "美妆测评达人，主打平价好物挖掘",
    "target_audience": "18-30 岁女性",
    "core_topics": ["平价美妆", "产品测评", "化妆教程"]
  },
  "content_style": {
    "style_labels": ["亲切唠嗑", "朴实接地气"],
    "style_summary": "像闺蜜分享好物，语速适中偏快，自然不造作",
    "speech_pace": "中",
    "tone": "亲切真诚",
    "taboos": ["避免硬广感", "忌过度包装"]
  },
  "influencer_profile_text": "美妆测评达人，主打平价好物挖掘，目标受众 18-30 岁女性。风格亲切唠嗑、朴实接地气，像闺蜜分享好物一样自然真诚，语速适中偏快。核心选题：平价美妆、产品测评、化妆教程。内容忌硬广感和过度包装。",
  "analysis_mode": "multimodal_audio",
  "author_nickname": "小美爱分享"
}
```

---

## 硬截断规则

`_compact_result()` 对以下字段强制截断：

| 字段 | 最大长度 | 截断标记 |
|------|----------|----------|
| influencer_profile_text | 200 字 | `_profile_text_truncated: true` |
| content_style.style_summary | 50 字 | - |
| persona_positioning.summary | 30 字 | - |
| content_style.tone | 12 字 | - |
