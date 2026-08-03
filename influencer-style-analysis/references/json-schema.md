# JSON 输出结构定义

`influencer_profiler` 的 JSON 输出结构。LLM 生成后经 `_ensure_complete_json()` 校验完整性 + `_compact_result()` 硬截断超长字段。

---

## 完整 Schema

```json
{
  "basic_positioning": {
    "nickname": "string — 达人昵称",
    "core_persona": "string — 人设一句话总结，需突出差异化与记忆点，<=40字",
    "content_tracks": ["string — 核心赛道，每个<=10字，2-3个"]
  },
  "audience_insight": {
    "demographic": "string — 人口统计学特征，<=20字",
    "psychological_needs": "string — 受众心理诉求与痛点，<=50字"
  },
  "multimodal_style": {
    "verbal_pace": "string — 语速动态描述（非静态标签），<=40字",
    "tone_and_emotion": "string — 语气与情绪基调，<=20字",
    "visual_symbols": "string — 标志性视觉/听觉元素，<=50字",
    "style_tags": ["string — 开放式风格标签，2-4个"]
  },
  "traffic_logic": {
    "hook_strategy": "string — 流量互动策略（开头抓眼球+结尾留白），<=50字"
  },
  "commercial_logic": {
    "trust_builder": "string — 信任构建机制，<=40字",
    "brand_fit": ["string — 适配的商业品类，最多3个"],
    "placement_style": "string — 商单植入风格约束，<=50字"
  },
  "taboos_and_risks": ["string — 内容红线或掉粉点，2-3条"],
  "ai_scripting_guide": "string — 供下游LLM生成脚本的结构化指令，分点说明，<=300字"
}
```

---

## 字段说明

### basic_positioning（基础定位）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| nickname | string | - | 达人昵称（来自 TikHub） |
| core_persona | string | <=40字 | 人设一句话总结，需突出差异化与记忆点 |
| content_tracks | string[] | 2-3个，每个<=10字 | 核心内容赛道 |

### audience_insight（受众洞察）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| demographic | string | <=20字 | 人口统计学特征，如"25-45岁一二线男性" |
| psychological_needs | string | <=50字 | 受众心理诉求与痛点 |

### multimodal_style（多模态风格）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| verbal_pace | string | <=40字 | 语速**动态描述**，如"整体中等，铺垫平稳，抛出结论时突然加速并加重语气" |
| tone_and_emotion | string | <=20字 | 语气与情绪基调 |
| visual_symbols | string | <=50字 | 标志性视觉/听觉元素（穿搭、道具、机位、特效等） |
| style_tags | string[] | 2-4个 | **开放式**提取的风格标签，不限于固定枚举 |

### traffic_logic（流量逻辑）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| hook_strategy | string | <=50字 | 流量互动策略：开头3秒如何抓眼球（保完播），结尾如何留白引导互动（保评论） |

### commercial_logic（商业逻辑）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| trust_builder | string | <=40字 | 信任构建机制 |
| brand_fit | string[] | 最多3个 | 适配的商业品类 |
| placement_style | string | <=50字 | 商单植入风格约束 |

### taboos_and_risks（禁忌与风险）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| - | string[] | 2-3条 | 内容红线或掉粉点，如"无数据支撑的地摊文学"、"过度情绪化消解专业底色" |

### ai_scripting_guide（AI 脚本生成指南）

| 属性 | 值 |
|------|-----|
| 类型 | string |
| 最大长度 | 300 字 |
| 用途 | 供下游 LLM 生成脚本的结构化指令 |
| 格式 | 必须分点说明：1. 开头约束；2. 中段行文与节奏约束；3. 结尾约束 |

---

## 设计原则

1. **拒绝僵化标签**：禁止使用"亲切唠嗑"、"朴实接地气"等空泛枚举标签，必须使用动态语言描述
2. **解耦流量与商业**：traffic_logic 和 commercial_logic 严格分离，禁止混淆
3. **克制推断边界**：基于视频样本分析，不过度推断具体转化率或强行适配不相关品类
4. **多模态视角**：必须提取画面中的标志性视觉元素，不仅分析文本和语速
5. **开放式标签**：style_tags 不限于固定枚举，根据达人实际特征动态提取

---

## 输出示例

```json
{
  "basic_positioning": {
    "nickname": "达哥有点味",
    "core_persona": "用大白话拆解古今中外军事装备的杂谈博主",
    "content_tracks": ["装备解析", "军宣解读"]
  },
  "audience_insight": {
    "demographic": "25-45岁一二线男性",
    "psychological_needs": "渴望专业但通俗的军事解读以获取社交谈资，缓解信息焦虑"
  },
  "multimodal_style": {
    "verbal_pace": "整体中等偏快，讲参数时平稳清晰，抛出对比结论时突然加重语气",
    "tone_and_emotion": "专业自信、略带激昂",
    "visual_symbols": "固定机位、深色背景、手持装备模型、穿插实拍素材",
    "style_tags": ["硬核拆解", "降维科普"]
  },
  "traffic_logic": {
    "hook_strategy": "开头用反常识提问抓眼球，结尾留悬念引导评论区讨论"
  },
  "commercial_logic": {
    "trust_builder": "引用详实参数数据、拆解底层逻辑、展现军事知识储备",
    "brand_fit": ["军事模型周边", "户外装备"],
    "placement_style": "必须采用参数对比式植入，禁止叫卖式话术"
  },
  "taboos_and_risks": [
    "无数据支撑的地摊文学",
    "过度情绪化消解专业底色"
  ],
  "ai_scripting_guide": "1. 开头：用反常识提问或装备对比引入，3秒内建立专业预期；2. 中段：参数拆解为主，穿插实拍画面，语速平稳偏快，抛结论时加重语气；3. 结尾：留开放性问题引导讨论，不直接喊关注。"
}
```

---

## 硬截断规则

`_compact_result()` 对以下字段强制截断：

| 字段 | 最大长度 |
|------|----------|
| basic_positioning.core_persona | 40 字 |
| audience_insight.demographic | 20 字 |
| audience_insight.psychological_needs | 50 字 |
| multimodal_style.verbal_pace | 40 字 |
| multimodal_style.tone_and_emotion | 20 字 |
| multimodal_style.visual_symbols | 50 字 |
| traffic_logic.hook_strategy | 50 字 |
| commercial_logic.trust_builder | 40 字 |
| commercial_logic.placement_style | 50 字 |
| ai_scripting_guide | 300 字 |

数组截断：

| 字段 | 最大数量 |
|------|----------|
| basic_positioning.content_tracks | 3 |
| multimodal_style.style_tags | 4 |
| commercial_logic.brand_fit | 3 |
| taboos_and_risks | 3 |
