# 各步骤输出 JSON Schema

## 步骤 2: step2_materials.json

```json
{
  "style_summary": "达人风格核心摘要（2-3句话）",
  "matched_materials": [
    {
      "source": "素材库",
      "content_direction": "内容方向",
      "borrowable_points": "可借鉴点",
      "script_excerpt": "脚本摘要"
    }
  ],
  "matched_history": [
    {
      "source": "历史数据库",
      "script_theme": "脚本主题",
      "performance": "播放量/点赞量/转化情况",
      "success_factors": "成功要素提取"
    }
  ],
  "original_creatives": [
    {
      "id": 1,
      "title": "创意标题",
      "concept": "创意概念描述",
      "source_inspiration": "灵感来源",
      "target_emotion": "目标情绪反应"
    }
  ]
}
```

## 步骤 3: step3_directions.json

```json
{
  "directions": [
    {
      "id": 1,
      "title": "方向名称",
      "core_thesis": "核心立意",
      "narrative_logic": "叙事逻辑",
      "emotion_rhythm": {
        "intent": "主题意图",
        "curve": "情绪曲线描述"
      },
      "style_fit": "风格匹配说明",
      "source_creatives": [1, 3]
    }
  ]
}
```

## 步骤 5: step5_outlines.json

```json
{
  "outlines": [
    {
      "direction_id": 1,
      "direction_title": "方向名称",
      "outline_id": "1A",
      "outline_title": "大纲标题",
      "hook": {
        "type": "钩子类型",
        "content": "开头钩子内容"
      },
      "structure": [
        {
          "segment": "段落名",
          "duration": "时长",
          "content": "内容描述",
          "emotion": "情绪标记"
        }
      ],
      "emotion_curve": "情绪曲线描述",
      "qc": {
        "style_fit": 8,
        "direction_consistency": 9,
        "hook_appeal": 7,
        "emotion_rhythm": 8,
        "commercial_naturalness": 7,
        "overall": 7.8,
        "notes": "质检备注"
      }
    }
  ]
}
```

## 步骤 6-7: step6_scripts.json

```json
{
  "scripts": [
    {
      "outline_id": "1A",
      "outline_title": "大纲标题",
      "direction_title": "方向名称",
      "script": "完整脚本文案",
      "word_count": 280,
      "estimated_duration": "75s",
      "score": {
        "hook_appeal": 8,
        "content_value": 7,
        "emotion_rhythm": 8,
        "style_match": 9,
        "commercial_naturalness": 7,
        "completion_rate": 8,
        "interaction_guide": 7,
        "overall": 7.7
      },
      "score_notes": "评分理由",
      "style_fit_analysis": "风格匹配说明"
    }
  ]
}
```
