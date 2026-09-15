# JSON 输出结构定义

`influencer_profiler` 的 JSON 输出结构。LLM 生成后经 `_ensure_complete_json()` 校验完整性 + `_compact_result()` 硬截断超长字段。

---

## 完整 Schema

```json
{
  "basic_positioning": {
    "nickname": "string — 达人昵称",
    "influencer_type": "string — 达人类型，格式'一级-二级'（如'财经-泛财经'），<=10字",
    "core_persona": "string — 人设一句话总结，需突出差异化与记忆点，<=50字",
    "content_tracks": ["string — 核心赛道，每个<=10字，2-3个"],
    "influencer_demographic": {
      "age_range": "string — 年龄区间，从面部特征/言行推断，<=10字",
      "gender": "string — 男/女/未知",
      "occupation": "string — 职业身份（结合 bio 和视频口述），<=30字",
      "career_identity": {
        "status": "string — 有明确证据/有间接线索/无法判断",
        "description": "string — 职业经历描述，无证据写'未发现'，<=30字",
        "evidence": "string — 判定依据（引用 bio 原文或口述，或注明画面线索），<=50字"
      },
      "appearance": "string — 外貌与气质，<=25字",
      "speech_style": "string — 讲话风格与外显特质，<=35字",
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
| core_persona | string | <=50字 | 人设一句话总结，需突出差异化与记忆点 |
| content_tracks | string[] | 2-3个，每个<=10字 | 核心内容赛道 |

### basic_positioning.influencer_demographic（达人自身画像）

| 字段 | 类型 | 限制 | 说明 |
|------|------|------|------|
| age_range | string | <=10字 | 年龄区间，从面部特征/言行推断 |
| gender | string | - | 男/女/未知 |
| occupation | string | <=30字 | 职业身份（结合 bio 和视频口述） |
| career_identity.status | string | - | 职业身份证据等级：有明确证据（bio 自述或视频口述明确提及职业/经营/从业经历）/ 有间接线索（仅画面场景道具推断）/ 无法判断 |
| career_identity.description | string | <=30字 | 职业经历描述，无证据写"未发现" |
| career_identity.evidence | string | <=50字 | 判定依据，引用 bio 原文/口述内容，或注明画面线索 |
| appearance | string | <=25字 | 外貌与气质（如"正气硬朗，身姿挺拔""和蔼可亲"） |
| speech_style | string | <=35字 | 讲话风格与外显特质（如"伶牙俐齿""温和慢条斯理"） |
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

## 入参 manual_supplement（人工补充，优先级最高）

分析前先向用户收集人工补充信息，三项固定模板：

```
1. 达人职业：
2. 资产层次：
3. 其他补充：
```

凡不属于「达人职业」「资产层次」的信息（拍摄方式、出镜人数、单人/双人共说台词、机位、真实身份背景、从业经历等）统一写进「其他补充」。

入参支持三种写法：

```json
{ "manual_supplement": { "occupation": "...", "asset_level": "...", "other": "..." } }
{ "manual_supplement": "拍摄方式：两人共说台词" }
{ "manual_occupation": "...", "manual_asset_level": "...", "manual_other": "..." }
```

纯字符串写法整体归入 `other`；扁平写法仅在对应嵌套写法为空时生效。

`_apply_manual_supplement()` 的强制覆盖映射（不依赖模型自觉，在合并/单视频结果产出后程序化执行）：

| 人工字段 | 覆盖的产出字段 |
|---|---|
| occupation | `influencer_demographic.occupation`；同时 `career_identity` 强制置为 `{status: 有明确证据, description: 人工职业, evidence: 人工补充（用户提供）}` |
| asset_level | `influencer_demographic.asset_level`，加「人工补充：」前缀便于溯源 |
| other | 追加到 `influencer_demographic.visual_symbols` 末尾（不丢失）；同时注入 prompt，要求模型把其中与呈现相关的内容融入 `appearance` / `speech_style` |

三项均留空时不做任何覆盖，产出即为纯推断结果。

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

`_compact_result()` 对以下字段强制截断。截断走 `_smart_truncate()`，**标点感知**，不把句子拦腰切断：

1. 未超限 → 原样保留
2. 截断点恰好落在标点上 → 直接收
3. 否则优先回退到最近句末标点（`。！？；`），再退到子句标点（`，、,;：`）；但回退后不得少于上限的 60%（下限 8 字），否则视为"标点太远"放弃回退
4. 无可用标点 → 去掉末尾一字补 `…`，既语义可知又不超限

| 字段 | 最大长度 |
|------|----------|
| basic_positioning.core_persona | 50 字 |
| basic_positioning.influencer_type | 10 字 |
| basic_positioning.influencer_demographic.age_range | 10 字 |
| basic_positioning.influencer_demographic.occupation | 30 字 |
| basic_positioning.influencer_demographic.career_identity.status | 8 字 |
| basic_positioning.influencer_demographic.career_identity.description | 30 字 |
| basic_positioning.influencer_demographic.career_identity.evidence | 50 字 |
| basic_positioning.influencer_demographic.appearance | 25 字 |
| basic_positioning.influencer_demographic.speech_style | 35 字 |
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
