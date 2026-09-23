"""步骤 2 — 匹配达人风格 + 产生原始创意（达人类型标准 + 内容标准版）。

流程：
1. 依据品牌配置的《达人类型基础标准》（config/<brand>/references/influencer-type-standard.md）
   判定达人的一级/二级类型（LLM，军事归财经-泛财经）
2. 按类型程序化查询飞书：
   - 网络素材库：按"适配达人" contains "达人类型：一级-二级"（精确匹配）
3. 实时拉取《内容标准》飞书文档（转化链条/切入方向/铺垫转折）注入 prompt
4. LLM 基于真实命中的记录 + 内容标准硬约束生成原始创意，绑定来源 _record_id
5. 程序化校验：链条传动 >1 次、疑似宏大叙事切入的创意直接淘汰

历史变更：2026-09-17 移除历史库（头条）查询——历史库已退出全流程，
不再参与匹配，输出中不再有 raw_history / matched_history / source_history_ids。
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
from config.settings import BRAND_NAME, CONTENT_STANDARD_DOC_URL, load_prompt
from providers.llm import run_llm
from tools.feishu import (
    fetch_doc_content,
    fetch_materials_by_type,
)

logger = logging.getLogger(__name__)

SPEC = AgentSpec(
    name="material-matcher",
    instructions=load_prompt("material_match.md"),
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

    # 3. 实时拉取《内容标准》文档（创意产出前必读，失败则中止）
    logger.info("步骤 2: 拉取内容标准文档...")
    content_standard = fetch_doc_content(CONTENT_STANDARD_DOC_URL)
    logger.info("内容标准文档拉取成功（%d 字）", len(content_standard))

    # 4. LLM 基于真实命中记录 + 内容标准生成创意
    logger.info("步骤 2: 调用 LLM 匹配风格 + 生成创意...")
    user_text = _build_user_text(
        style_json, materials, user_input, conditions, content_standard
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
    user_input: str | None,
    type_judgment: dict | None = None,
    content_standard: str | None = None,
) -> str:
    parts: list[str] = []

    if type_judgment:
        parts.append(
            f"## 达人类型判定（依据《{BRAND_NAME}-达人类型基础标准》）\n"
            f"一级类型：{type_judgment.get('primary_type', '')}\n"
            f"二级类型：{type_judgment.get('secondary_type', '')}\n"
            f"判定依据：{type_judgment.get('reason', '')}\n\n"
            "素材库的命中记录均按此类型筛选，创意必须与该类型的范围限定契合。\n"
        )

    parts.append("## 达人风格 JSON\n")
    parts.append(json.dumps(style_json, ensure_ascii=False, indent=2))

    parts.append("\n\n## 网络素材库命中记录（程序化匹配）\n")
    if materials:
        for m in materials:
            parts.append(json.dumps(m, ensure_ascii=False) + "\n")
    else:
        parts.append("（无匹配素材）\n")

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
