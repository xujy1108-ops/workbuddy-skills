# 各步骤输出 JSON Schema

> **当前主流程只有两步**：`directions`（→ `step3_directions.json`）→ `scripts`（→ `step6_scripts.json`）。
> 下面的 步骤 2 / 步骤 5 是旧流程遗留（大纲步骤已于 2026-09-09 移除），标注为**已停用**，仅用于回溯历史产物。

## 步骤 2: step2_materials.json（已停用，主流程不经过）

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

## 步骤 3: step3_directions.json（当前主流程·步骤 1）

```json
{
  "directions": [
    {
      "id": 1,
      "title": "方向名称",
      "track": "蹭热点 或 其他方向",
      "content_direction": "内容方向定义",
      "scene": "场景（在哪里发生、什么场合、几个人；纯对镜讲述写「对镜口播（无场景情节）」）",
      "implant_strategy": "植入策略",
      "suitable_influencer": "适合达人",
      "narrative_strategy": "叙事策略（其他方向线）",
      "hotspot_id": "热点 ID（蹭热点线）",
      "source_material_ids": ["dy_xxx"],
      "style_fit": "风格匹配说明"
    }
  ],
  "strategy_match": {
    "hit_rows": [],
    "excluded_strategies": []
  }
}
```

> 输出恰好 5 个方向，其中**蹭热点方向最多 2 个**；`strategy_match` 记录命中的策略行与被职业身份门槛排除的行及原因。

## 步骤 5: step5_outlines.json（已停用，大纲步骤已移除）

```json
{
  "outlines": [
    {
      "direction_id": 1,
      "direction_title": "方向名称",
      "outline_id": "1A",
      "outline_title": "大纲标题",
      "hook": { "type": "钩子类型", "content": "开头钩子内容" },
      "structure": [
        { "segment": "段落名", "duration": "时长", "content": "内容描述", "emotion": "情绪标记" }
      ],
      "emotion_curve": "情绪曲线描述",
      "qc": { "style_fit": 8, "overall": 7.8, "notes": "质检备注" }
    }
  ]
}
```

## 步骤 6: step6_scripts.json（当前主流程·步骤 2，SOP + 策略库驱动版，2026-09-15）

**生成期不打分**：只输出 ① 红线一票否决 `compliance_check`；② 检验机制逐项 pass/fail `self_check`；③ 核验行 `verification`。
0/1/2 的预期分由**人工修改后**填写 `human_revision`（AI 输出固定 `null`）。

```json
{
  "scripts": [
    {
      "direction_id": 1,
      "direction_title": "来源方向标题",
      "track": "蹭热点 或 其他方向",
      "hook_class": "钩子类 + 打法（其他方向线如「B类·好奇心 · B1反常识观点」；蹭热点线如「A类·利益直给 · 1权威事件开场」）",
      "title": "脚本标题",
      "script": "完整口播逐字稿（含【模块·打法】标签与成段台词）",
      "word_count": 300,
      "estimated_duration": "75s",
      "compliance_check": { "passed": true, "violations": [] },
      "library_picks": [
        {
          "module": "模块①钩子",
          "library": "策略库-非热点·钩子方法库",
          "entry": "B·反常识观点",
          "reason": "创意核心是被忽略的真相，与B档『跟大众认知相反的结论』对齐"
        },
        {
          "module": "模块④角色定位",
          "library": "策略库-非热点·角色定位方法库",
          "entry": "应急安全垫",
          "reason": "创意落点是『备用金』而非消费，与『不是借钱消费，是备用金』对齐"
        }
      ],
      "material_gap": "素材缺口·打法X（库内无对应档位时填，否则空字符串）",
      "self_check": {
        "hook": "pass",
        "name_removal": "pass",
        "influencer": "pass",
        "speed": "pass",
        "placement_chain": "pass",
        "density": "pass",
        "entry_direction": "pass",
        "hotspot_fit": "pass（仅蹭热点线；其他方向线填 n/a）",
        "speakability": "pass",
        "redline": "pass",
        "fail_items": []
      },
      "verification": {
        "money_element_sentence": 1,
        "money_element_second": "约第3秒",
        "word_count": 300,
        "transition_sentences": 2,
        "function_tags": "钩子:权威事件开场 / 承接:政策翻译 / 转折:成本传导 / 植入:合规标杆·四步 / 收尾:合规劝退+人设"
      },
      "human_revision": null,
      "style_fit_analysis": "脚本如何匹配达人风格的说明（<=80字）"
    }
  ]
}
```

**字段约定**：

| 字段 | 说明 |
|------|------|
| `compliance_check` | 第 0 条合规红线，**一票否决**：`passed=false` 时列出 `violations`，该稿标记需重写（其余字段照常输出） |
| `library_picks` | SOP「素材取用流程·产出留痕」的落点：各模块选中的**库内编号＋名称＋命中理由**。须覆盖模块①-⑤；`module="模块④角色定位"` 有且仅有 1 档（非热点线 7 档选 1、热点线 5 档选 1）。理由必须引用创意特征与条目名称的对齐点，禁止"比较合适"式空泛表述 |
| `material_gap` | SOP「缺口兜底」的落点：库内无对应档位时填「素材缺口·打法X」，有对应档位则留空。**严禁自创公式** |
| `self_check` | 两份 SOP「四、检验机制」逐项 pass/fail。值只允许 `pass`｜`fail`｜`n/a`（`hotspot_fit` 仅蹭热点线适用）；未过项写进 `fail_items`。**不填分数** |
| `verification` | 核验行（SOP「生成期硬约束」自证）：钱要素首现位置、总字数、过渡句数、逐句功能标签串。须与脚本实际一致，禁止估算 |
| `human_revision` | **AI 固定输出 `null`**。人工修改后填写：`expected_score`（8 维度预期分，0-2/维，满分 16）+ `revisions[]`（position 改动位置／nature 改动性质／magnitude 改动幅度）。只记总分无法归因，三要素必填 |

> 编号纪律：`hook_class` / `【模块·打法】`标签沿用**对应 track 的 SOP 模块子编号**（热点线纯序号 1/2/3；非热点线 A1–D2）；库内编号只出现在 `library_picks`。
> 两套体系不同名不同号（库内：热点钩子 A–C／非热点钩子 A–J），禁止按字母或序号对齐，须按库内各档「对应 SOP」字段反查。
> 评分口径：生成期不打分（见《口播脚本评分标准-V2》「使用规则」节）。
