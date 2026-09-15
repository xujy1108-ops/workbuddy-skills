# JSON 输出结构定义

`influencer_profiler` 的 JSON 输出结构。LLM 生成后经 `_ensure_complete_json()` 校验完整性 + `_compact_result()` 硬截断超长字段。

---

## 完整 Schema

```json
{
  "basic_positioning": {
    "nickname": "string — 达人昵称",
    "influencer_type": "string — 达人类型，格式'一级-二级'（如'财经-泛财经'），<=10字",
    "core_persona": "string — 人设一句话总结，需突出差异化与记忆点，<=40字",
    "content_tracks": ["string — 核心赛道，每个<=10字，2-3个"],
    "influencer_demographic": {
      "age_range": "string — 年龄区间，从面部特征/言行推断，<=10字",
      "gender": "string — 男/女/未知",
      "occupation": "string — 职业身份（结合 bio 和视频口述），<=30字",
      "appearance": "string — 外貌与气质，<=25字",
      "speech_style": "string — 讲话风格与外显特质，<=25字",
      "asset_level": "string — 资产层次推断（高/中/一般）+ 理由，<=40字",
      "verbal_pace": "string — 语速：整体快/中/慢 + 约字数/分 + 关键变化点，<=45字",
      "tone_and_emotion": "string — 语气与情绪基调，<=20字",
      "visual_symbols": "string — 标志性视觉/听觉元素，<=50字",
      "style_tags": ["string — 开放式风格标签，2-4个"]
    }
  },
  "audience_insight": {
    "demographic": "string — 人口统计学特征，<=20字",
    "psychological_needs": "string — 受众心理诉求与痛点，<=50字"
  }
}
```

---

## 字段说明

### basic_positioning（基础定位）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| nickname | string | - | 达人昵称（来自 TikHub） |
| influencer_type | string | <=10字 | 达人类型，格式"一级-二级"（如"财经-泛财经"），依据《达人类型基础标准（终版）》判定，无匹配输出"无匹配-需补充" |
| core_persona | string | <=40字 | 人设一句话总结，需突出差异化与记忆点 |
| content_tracks | string[] | 2-3个，每个<=10字 | 核心内容赛道 |

### basic_positioning.influencer_demographic（达人自身画像）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| age_range | string | <=10字 | 年龄区间，从面部特征/言行推断 |
| gender | string | - | 男/女/未知 |
| occupation | string | <=30字 | 职业身份（结合 bio 和视频口述） |
| appearance | string | <=25字 | 外貌与气质（如"正气硬朗，身姿挺拔""和蔼可亲"） |
| speech_style | string | <=25字 | 讲话风格与外显特质（如"伶牙俐齿""温和慢条斯理"） |
| asset_level | string | <=40字 | 资产层次推断（高/中/一般）+ 理由，结合 bio 身份暗示和视频客观线索 |
| verbal_pace | string | <=45字 | 语速：整体快/中/慢 + 约字数/分 + 关键变化点，禁止无结论描述 |
| tone_and_emotion | string | <=20字 | 语气与情绪基调 |
| visual_symbols | string | <=50字 | 标志性视觉/听觉元素 |
| style_tags | string[] | 2-4个 | 开放式提取的风格标签 |

### audience_insight（受众洞察）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| demographic | string | <=20字 | 人口统计学特征，如"25-45岁一二线男性" |
| psychological_needs | string | <=50字 | 受众心理诉求与痛点 |

---

## 设计原则

1. **拒绝僵化标签**：禁止使用"亲切唠嗑"、"朴实接地气"等空泛枚举标签，必须使用动态语言描述
2. **克制推断边界**：基于视频样本分析，不过度推断或强行适配不相关品类
3. **多模态视角**：必须提取画面中的标志性视觉元素，不仅分析文本和语速
4. **达人自身画像**：结合 bio 文本和视频可视化信息，推断达人的年龄区间、职业身份、外貌特征、讲话风格、资产层次。资产层次需综合判断：bio 中暗示收入水平或社会阶层的身份标签（职业头衔、创业/高管经历等）、视频中暴露的穿搭/座驾/居住环境等客观线索。不预设任何职业分类
5. **开放式标签**：style_tags 不限于固定枚举，根据达人实际特征动态提取
6. **达人类型标准**：influencer_type 依据《度小满-达人类型基础标准（终版）》判定（4 大类 8 二级），军事点评归"财经-泛财经"，无匹配输出"无匹配-需补充"

---

## 输出示例

```json
{
  "basic_positioning": {
    "nickname": "达哥有点味",
    "influencer_type": "财经-泛财经",
    "core_persona": "用大白话拆解军事装备的杂谈博主，军事点评归财经-泛财经",
    "content_tracks": ["装备解析", "军宣解读"],
    "influencer_demographic": {
      "age_range": "30-35岁",
      "gender": "男",
      "occupation": "军事杂谈自媒体博主",
      "appearance": "戴棒球帽和眼镜，固定近景口播",
      "speech_style": "伶牙俐齿，大白话拆解复杂装备知识",
      "asset_level": "一般（bio 无身份暗示，视频场景简约无炫富）",
      "verbal_pace": "整体中等偏快，约 210 字/分，讲参数时平稳清晰，抛结论时加重语气小幅提速",
      "tone_and_emotion": "自信笃定，犀利真诚",
      "visual_symbols": "固定近景机位，棒球帽+眼镜标配，穿插实拍/实证素材，配醒目粗边字幕",
      "style_tags": ["硬核实证", "通俗接地气", "情绪饱满"]
    }
  },
  "audience_insight": {
    "demographic": "25-45岁一二线男性",
    "psychological_needs": "渴望专业但通俗的军事解读以获取社交谈资，缓解信息焦虑"
  }
}
```

---

## 硬截断规则

`_compact_result()` 对以下字段强制截断：

| 字段 | 最大长度 |
|------|----------|
| basic_positioning.core_persona | 40 字 |
| basic_positioning.influencer_type | 10 字 |
| basic_positioning.influencer_demographic.age_range | 10 字 |
| basic_positioning.influencer_demographic.occupation | 30 字 |
| basic_positioning.influencer_demographic.appearance | 25 字 |
| basic_positioning.influencer_demographic.speech_style | 25 字 |
| basic_positioning.influencer_demographic.asset_level | 40 字 |
| basic_positioning.influencer_demographic.verbal_pace | 45 字 |
| basic_positioning.influencer_demographic.tone_and_emotion | 20 字 |
| basic_positioning.influencer_demographic.visual_symbols | 50 字 |
| audience_insight.demographic | 20 字 |
| audience_insight.psychological_needs | 50 字 |

数组截断：

| 字段 | 最大数量 |
|------|----------|
| basic_positioning.content_tracks | 3 |
| basic_positioning.influencer_demographic.style_tags | 4 |
