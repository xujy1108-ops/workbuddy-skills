"""步骤 2 — 匹配达人风格 + 产生原始创意（达人类型标准 + 内容标准版）。

流程：
1. 依据《度小满-达人类型基础标准》（references/influencer-type-standard.md）
   判定达人的一级/二级类型（LLM，军事归财经-泛财经）
2. 按类型程序化查询飞书：
   - 网络素材库：按"适配达人" contains "达人类型：一级-二级"（精确匹配）
   - 历史库-头条：按"达人类型" intersects 大类映射 + "星推比" 降序（服务端 sort-json）
3. 实时拉取《内容标准》飞书文档（转化链条/切入方向/铺垫转折）注入 prompt
4. LLM 基于真实命中的记录 + 内容标准硬约束生成原始创意，绑定来源 _record_id
5. 程序化校验：链条传动 >1 次、疑似宏大叙事切入的创意直接淘汰

注意：视频号历史表字段不全（达人风格为空、无星推比），按决策排除，不参与匹配。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentResult, AgentSpec
from agents.match_condition_extractor import run_match_condition_extractor
from agents.standard_guard import GRAND_NARRATIVE_MARKERS as _GRAND_NARRATIVE_MARKERS
from agents.standard_guard import grand_narrative_hit, parse_chain_transitions
from config.settings import CONTENT_STANDARD_DOC_URL
from providers.llm import run_llm
from tools.feishu import (
    fetch_doc_content,
    fetch_history_toutiao_by_types,
    fetch_materials_by_type,
)

logger = logging.getLogger(__name__)

SPEC = AgentSpec(
    name="material-matcher",
    instructions="""你是一位资深的内容创意策略师。

## 任务
基于达人风格分析结果、以及**程序化匹配到的真实素材库/历史库记录**，产生原始创意种子。

## 输入
1. 达人风格 JSON（2 维度：基础定位[含达人自身画像 influencer_demographic] + 受众洞察）
2. 网络素材库命中记录（含素材id、脚本文案、内容方向、适配达人、可借鉴点）
3. 历史投放数据库命中记录（含达人名称、达人类型、脚本文案、播放量、点赞量、星推比、转化是否达标）
4. 用户手动输入的创意方向（可选）

## 工作步骤
1. 分析达人风格 JSON，提取核心风格特征（人设定位、受众画像、达人自身画像中的风格标签/语速/讲话风格等）
2. 通读网络素材库命中记录，理解其内容方向与可借鉴的广告手法
3. 通读历史库命中记录，优先参考星推比高的优质脚本，提取成功要素
4. 综合以上信息 + 用户手动输入（如有），产生 5-8 个原始创意种子

## 来源绑定（必须遵守）
- 每个创意必须引用至少一个真实来源记录：`source_material_ids`（素材库记录的 `_record_id`）或 `source_history_ids`（历史库记录的 `_record_id`）
- **只能引用输入记录中实际存在的 `_record_id`，严禁编造**；如果某个创意完全基于用户手动输入产生，则两个来源数组都可以为空，但必须在 `concept` 里注明"来源：用户输入"
- `_record_id` 是记录的唯一标识，形如 `recXXX`，必须逐字引用

## 内容标准（硬性约束，违反任一条的创意会被直接淘汰）
用户输入末尾附有《内容标准》文档全文（含正反案例），创意必须满足三个方向：

1. **转化链条**：从开头事件到广告植入，**最多 1 次叙事链条传动**。观众不能跟着视频多次跳跃
2. **切入方向**：**生活化/原生场景化**，和普通人息息相关、和钱息息相关。
   - **禁止宏大叙事切入**（历史事件、军事史、国际关系、名人轶事类比等）——观众只会当故事看，无法代入自己的借贷需求
   - **同样禁止古典民俗/典故切入**（民俗传说、古人故事、老祖宗规矩、俗语谚语等）——与宏大叙事同罪，观众无法代入自己当下的借贷场景
   - 唯一例外是时政热点，但也必须在植入逻辑上尽快落到"自己的钱"上
   - 讲述用大白话，不深奥
3. **铺垫转折**：广告植入前的铺垫要顺着内容逻辑链条，不能硬切，要让"聊到借钱"显得自然

**特别注意**：即使达人是军事/历史/国际类账号，也**只能把其人设口吻作为表达风格**，切入方向必须是普通人的生活/钱场景，绝不能用历史战役、国际格局、古典民俗典故等宏大叙事开场。

## 输出格式（严格 JSON）
```json
{
  "style_summary": "达人风格核心摘要（2-3句话）",
  "matched_materials": [
    {
      "source": "素材库",
      "record_id": "recXXX",
      "content_direction": "内容方向",
      "borrowable_points": "可借鉴点",
      "script_excerpt": "脚本摘要"
    }
  ],
  "matched_history": [
    {
      "source": "历史数据库",
      "record_id": "recXXX",
      "script_theme": "脚本主题",
      "performance": "播放量/点赞量/星推比/转化情况",
      "success_factors": "成功要素提取"
    }
  ],
  "original_creatives": [
    {
      "id": 1,
      "title": "创意标题",
      "concept": "创意概念描述（这个创意讲什么、为什么适合这个达人）",
      "target_emotion": "目标情绪反应",
      "entry_direction": "切入方向（生活化/原生场景化的痛点或热点，必须和普通人的钱息息相关）",
      "chain_transitions": 1,
      "transition_setup": "广告植入前的铺垫逻辑（怎么顺内容自然聊到借钱）",
      "source_material_ids": ["recXXX"],
      "source_history_ids": ["recYYY"]
    }
  ]
}
```

## 约束
- matched_materials 最多 5 条（从输入素材中精选最有价值的）
- matched_history 最多 5 条（优先星推比高的）
- original_creatives 5-8 条
- `chain_transitions` 必须为整数且 ≤ 1
- 每个字段 concise，不要长篇大论
- 只输出 JSON，不要其他文字
""",
    max_tokens=8192,
)


def run_material_matcher(
    style_json: dict[str, Any],
    user_input: str | None = None,
) -> dict[str, Any]:
    """步骤 2 主入口。

    Args:
        style_json: influencer-style-analysis 输出的 7 维度风格 JSON
        user_input: 用户手动输入的创意方向（可选）

    Returns:
        原始创意 JSON dict（含匹配条件、命中记录、创意列表）
    """
    # 1. 依据达人类型标准判定类型（LLM）
    conditions = run_match_condition_extractor(style_json)

    # 2. 按类型程序化查询飞书
    logger.info("步骤 2: 按达人类型查询飞书...")
    materials = fetch_materials_by_type(
        material_match_text=conditions.get("material_match_text", ""),
        limit=30,
    )
    history = fetch_history_toutiao_by_types(
        daren_types=conditions.get("history_daren_types", []),
        limit=30,
    )

    # 3. 实时拉取《内容标准》文档（创意产出前必读，失败则中止）
    logger.info("步骤 2: 拉取内容标准文档...")
    content_standard = fetch_doc_content(CONTENT_STANDARD_DOC_URL)
    logger.info("内容标准文档拉取成功（%d 字）", len(content_standard))

    # 4. LLM 基于真实命中记录 + 内容标准生成创意
    logger.info("步骤 2: 调用 LLM 匹配风格 + 生成创意...")
    user_text = _build_user_text(
        style_json, materials, history, user_input, conditions, content_standard
    )

    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=user_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.7,
    )

    output = _parse_json(result.text)
    output = _filter_violating_creatives(output)
    output["match_conditions"] = conditions
    # 附加真实命中数据，供后续写稿步骤使用（含完整脚本文案 + _record_id 可追溯）
    output["raw_materials"] = materials
    output["raw_history"] = history
    return output


def _filter_violating_creatives(output: dict[str, Any]) -> dict[str, Any]:
    """按内容标准程序化校验创意，淘汰违规项并重新编号。

    校验规则：
    - chain_transitions > 1 → 淘汰（转化链条超限）
    - concept/entry_direction 含宏大叙事疑似关键词 → 淘汰（切入方向违规）
    """
    creatives = output.get("original_creatives", [])
    kept: list[dict] = []
    dropped: list[dict] = []

    for c in creatives:
        reason = None
        ct = parse_chain_transitions(c.get("chain_transitions", "1"))
        if ct > 1:
            reason = f"转化链条 {ct} 次传动（上限 1 次）"
        else:
            hit = grand_narrative_hit(c.get("entry_direction", ""), c.get("concept", ""))
            if hit:
                reason = f"疑似宏大叙事切入（关键词「{hit}」）"

        if reason:
            dropped.append({"title": c.get("title"), "reason": reason})
            logger.warning("内容标准校验淘汰: %s — %s", c.get("title"), reason)
        else:
            kept.append(c)

    for i, c in enumerate(kept, 1):
        c["id"] = i

    output["original_creatives"] = kept
    output["standard_check_dropped"] = dropped
    if dropped:
        logger.warning("内容标准校验: 淘汰 %d 个，保留 %d 个", len(dropped), len(kept))
    return output


def _build_user_text(
    style_json: dict,
    materials: list[dict],
    history: list[dict],
    user_input: str | None,
    type_judgment: dict | None = None,
    content_standard: str | None = None,
) -> str:
    parts: list[str] = []

    if type_judgment:
        parts.append(
            "## 达人类型判定（依据《度小满-达人类型基础标准》）\n"
            f"一级类型：{type_judgment.get('primary_type', '')}\n"
            f"二级类型：{type_judgment.get('secondary_type', '')}\n"
            f"判定依据：{type_judgment.get('reason', '')}\n\n"
            "素材库与历史库的命中记录均按此类型筛选，创意必须与该类型的范围限定契合。\n"
        )

    parts.append("## 达人风格 JSON\n")
    parts.append(json.dumps(style_json, ensure_ascii=False, indent=2))

    parts.append("\n\n## 网络素材库命中记录（程序化匹配）\n")
    if materials:
        for m in materials:
            parts.append(json.dumps(m, ensure_ascii=False) + "\n")
    else:
        parts.append("（无匹配素材）\n")

    parts.append("\n## 历史投放数据库命中记录（程序化匹配，已按星推比降序）\n")
    if history:
        for h in history:
            parts.append(json.dumps(h, ensure_ascii=False) + "\n")
    else:
        parts.append("（无匹配历史记录）\n")

    if user_input:
        parts.append(f"\n## 用户手动输入的创意方向\n{user_input}\n")

    if content_standard:
        parts.append(
            "\n## 《内容标准》文档全文（硬性约束，含正反案例，"
            "创意必须逐条满足，反面案例里出现过的切入方式严禁使用）\n\n"
            f"{content_standard}\n"
        )

    return "".join(parts)


def _parse_json(text: str) -> dict[str, Any]:
    """从 LLM 输出中提取 JSON。"""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        start = 1
        end = len(lines) - 1
        for i, line in enumerate(lines[1:], 1):
            if line.strip().startswith("```"):
                end = i
                break
        text = "\n".join(lines[start:end])
    return json.loads(text)
