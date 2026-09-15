"""步骤 3 — 生成 5 个创意方向（创意策略表驱动版）。

改造（2026-09-09）：不再由 LLM 基于素材/历史库自由生成，改为创意策略多维表格驱动。

流程：
1. 拉取创意策略表全量 → LLM 判定达人画像与哪些策略行匹配
   （「适合达人」+「内容方向」与达人画像共同判定，不简单按 influencer_type 分线）
2. 命中策略行中内容方向一 = 蹭热点 → 蹭热点线：从热点素材库按「素材评分」
   降序取优组织创意方向
3. 命中策略行为其他方向 → 其他方向线：植入策略直取策略行字段；叙事策略基于
   正向案例 + 素材链接ids 反查网络素材库的素材合并分析，描述人物/场景/如何植入
4. 输出 5 个创意方向（内容方向定义 + 植入策略 + 适合达人）

停用项：内容标准文档注入与程序化校验、历史库匹配。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from agents.base import AgentSpec
from providers.llm import run_llm
from tools.feishu import (
    fetch_hotspot_table,
    fetch_materials_by_ids,
    fetch_strategy_table,
)

logger = logging.getLogger(__name__)

# 素材评分定级顺序（优秀 > 良好 > 一般 > 劣质；未评级的排最后）
_SCORE_RANK = {"优秀": 0, "良好": 1, "一般": 2, "劣质": 3}


# ── 第一步：LLM 匹配策略行 ──────────────────────────────────

_MATCH_PROMPT = """你是一位资深的内容策略匹配专家。

## 任务
给定达人风格画像和创意策略表全量记录，判定达人匹配哪些策略行。

## 判定规则
1. 拿每条策略的「适合达人」字段（达人类型/年龄区间/职业身份/资产层次等条件）
   与「内容方向一/二」，同达人画像**共同判定**是否命中。
   - 「适合达人」= 所有类型 → 任何达人均命中（蹭热点线对达人无过滤）
   - 达人类型、年龄区间、讲话风格等是辅助判定条件，不是一票否决
2. **职业身份是一票否决的硬门槛**（对所有策略生效，不分方向类型）：
   - 策略行「适合达人」中指定了职业身份（如"企业主、前企业主""个体经营者""宝妈""卡车司机"等）
     → 达人画像的 career_identity 必须 status=「有明确证据」且身份与之相符，该策略行才可命中；
   - career_identity 缺失、status=「无法判断」或「有间接线索」但身份不符 → 该策略行**不推荐**，
     不得列入 matched_strategies，也不得以"角色代入/剧情演绎"为由绕过；
   - 策略行未指定职业身份 → 此门槛不适用，按类型/年龄/风格正常判定。
3. 「适合达人」语义是基于策略反推的匹配条件，不是对达人本人的验证——**唯独职业身份条件除外**（必须验证本人证据，见第2条）。
4. 核心字段（内容一方向定义/植入策略/正向案例）为空的策略行跳过。
5. 多条策略命中属正常情况，全部列出；被职业身份门槛排除的策略列入 excluded_strategies 并说明原因。

## 输入
- 达人风格 JSON（influencer_type + 风格画像，含 career_identity 职业身份核实字段；
  若缺失该字段视为「无法判断」，职业身份门槛一律拦下）
- 创意策略表记录列表（每条含 record_id、内容方向一/二、策略等级、
  内容一方向定义、植入策略、适合达人、正向案例、素材链接ids）

## 输出格式（严格 JSON，禁止 markdown 代码块包裹）
{
  "matched_strategies": [
    {
      "record_id": "策略行的 _record_id",
      "match_reason": "命中原因（<=50字，说明达人画像与适合达人/内容方向的匹配点）",
      "direction_track": "蹭热点 或 其他方向（取该行内容方向一：蹭热点→蹭热点，其余→其他方向）"
    }
  ],
  "excluded_strategies": [
    {
      "record_id": "被职业身份门槛排除的策略行 _record_id",
      "exclude_reason": "排除原因（如：策略要求职业身份'企业主、前企业主'，达人 career_identity 无法判断，一票否决）"
    }
  ],
  "no_match_reason": "无任何命中时的说明（有命中则省略）"
}
"""


# ── 第二步：组织创意方向 ────────────────────────────────────

_DIRECTION_PROMPT = """你是一位资深短视频内容策划总监。

## 任务
基于已匹配的策略素材，组织 5 个创意方向。

## 分线逻辑
- 蹭热点线素材：热点素材库按素材评分取优的热点（热点标题/概述/植入方向）
- 其他方向线素材：策略行（内容一方向定义/植入策略/适合达人/正向案例）
  + 按 素材链接ids 反查的网络素材库素材（场景/内容分析/广告可借鉴点）

## 要求
1. 恰好 5 个方向，优先蹭热点线（热点素材按评分降序），不足 5 个由其他方向线补足；
   若无蹭热点素材则全部来自其他方向线（多条策略命中时按策略等级 S>A>B>X 优先）。
2. 每个方向固定四维度输出：
   - 内容方向定义：该方向讲什么、钩子逻辑（蹭热点线=热点内容+植入衔接思路；
     其他线=策略表内容一方向定义的具体化）
   - 场景：这个创意发生在哪里、什么场合、几个人（如"酒席饭桌，多人聚餐当众讨债"、
     "居家客厅，一人对镜讲述"）——依据反查素材的「场景」标签与内容分析判断；
     素材场景为「对镜口播」时写"对镜口播（无场景情节）"；蹭热点线从热点概述判断
   - 植入策略：蹭热点线=热点素材库植入方向；其他线=策略行植入策略直取
   - 适合达人：策略行「适合达人」反推的匹配条件（类型/年龄/职业身份）；
     并结合「场景」标注对拍摄能力的要求（如：需能还原饭桌场景 / 仅需对镜口播）
3. 其他方向线的方向须包含 narrative_strategy（叙事策略）：基于正向案例
   +（如有）反查素材合并分析，描述整体叙事逻辑——人物、场景、如何植入。
   - 素材ids为空的策略：只用正向案例分析
   - 素材ids不空的策略：正向案例与反查素材一起分析
4. 方向与达人风格（口吻/语速/情绪/视觉符号）契合，具体可执行。

## 输出格式（严格 JSON，禁止 markdown 代码块包裹）
{
  "directions": [
    {
      "id": 1,
      "title": "方向名称（简短有力）",
      "track": "蹭热点 或 其他方向",
      "strategy_record_id": "来源策略行 _record_id（蹭热点线填热点来源策略行，如无则空）",
      "hotspot_id": "蹭热点线：热点素材库 热点ID；其他线留空",
      "content_direction": "内容方向定义（<=100字）",
      "scene": "场景：在哪里发生、什么场合、几个人（<=40字）",
      "implant_strategy": "植入策略（蹭热点线取热点植入方向；其他线取策略行植入策略，可精炼）",
      "suitable_influencer": "适合达人（策略反推的匹配条件：类型/年龄/职业身份 + 场景拍摄能力要求）",
      "narrative_strategy": "仅其他方向线：整体叙事逻辑——人物、场景、如何植入（<=200字）",
      "source_material_ids": ["dy_xxx"],
      "style_fit": "与达人风格的匹配说明（<=80字）"
    }
  ]
}
"""


SPEC_MATCH = AgentSpec(
    name="strategy-matcher",
    instructions=_MATCH_PROMPT,
    max_tokens=8192,
)

SPEC_DIRECTION = AgentSpec(
    name="direction-generator",
    instructions=_DIRECTION_PROMPT,
    max_tokens=8192,
)


def run_direction_generator(style_json: dict[str, Any]) -> dict[str, Any]:
    """步骤 3 主入口（创意策略表驱动版）。

    Args:
        style_json: influencer-style-analysis 输出的风格 JSON

    Returns:
        5 个创意方向 JSON dict
    """
    logger.info("步骤 3: 创意策略表驱动生成创意方向...")

    # 1. 拉取创意策略表
    strategies = fetch_strategy_table()
    if not strategies:
        raise RuntimeError("创意策略表拉取为空，无法进行策略匹配")

    # 2. LLM 判定达人命中哪些策略行
    match_result = _match_strategies(style_json, strategies)
    matched_ids = [m["record_id"] for m in match_result.get("matched_strategies", [])]
    if not matched_ids:
        return {
            "directions": [],
            "strategy_match": match_result,
            "message": "无匹配策略：请补充创意策略表策略行或人工指定方向",
        }
    logger.info("策略匹配: 命中 %d 条策略行", len(matched_ids))

    strategies_by_id = {s.get("_record_id"): s for s in strategies}
    matched_strategies = [
        strategies_by_id[rid] for rid in matched_ids if rid in strategies_by_id
    ]

    # 3. 分线：蹭热点策略行 / 其他方向策略行
    hotspot_rows = [s for s in matched_strategies if "蹭热点" in (s.get("内容方向一") or "")]
    other_rows = [s for s in matched_strategies if "蹭热点" not in (s.get("内容方向一") or "")]
    logger.info(
        "分线: 蹭热点策略 %d 条 / 其他方向策略 %d 条", len(hotspot_rows), len(other_rows)
    )

    # 4. 蹭热点线 → 热点素材库按素材评分取优
    hotspots = []
    if hotspot_rows:
        hotspots = _rank_hotspots(fetch_hotspot_table())
        logger.info("热点素材库: 按评分排序后取前 %d 条", len(hotspots))

    # 5. 其他方向线 → ids 反查网络素材库
    materials_by_strategy: dict[str, list[dict]] = {}
    for row in other_rows:
        ids = _parse_material_ids(row.get("素材链接ids") or "")
        if ids:
            mats = fetch_materials_by_ids(ids)
            # 标注反查缺失
            found = {m.get("素材id") for m in mats}
            missing = [i for i in ids if i not in found]
            if missing:
                logger.warning(
                    "策略 %s 素材反查缺失: %s（降级只用正向案例）",
                    row.get("_record_id"), missing,
                )
            materials_by_strategy[row.get("_record_id")] = mats

    # 6. LLM 组织 5 个创意方向
    output = _generate_directions(
        style_json, match_result, hotspot_rows, other_rows,
        hotspots, materials_by_strategy,
    )
    output["strategy_match"] = match_result
    return output


# ── 内部实现 ────────────────────────────────────────────────


def _match_strategies(
    style_json: dict, strategies: list[dict]
) -> dict[str, Any]:
    """LLM 判定达人画像命中哪些策略行。"""
    slim_strategies = []
    for s in strategies:
        slim_strategies.append({
            "record_id": s.get("_record_id"),
            "内容方向一": s.get("内容方向一"),
            "内容方向二": s.get("内容方向二"),
            "策略等级": s.get("策略等级"),
            "内容一方向定义": (s.get("内容一方向定义") or "")[:300],
            "植入策略": (s.get("植入策略") or "")[:300],
            "适合达人": s.get("适合达人"),
            "正向案例": "（略，非空）" if s.get("正向案例") else "",
            "素材链接ids": s.get("素材链接ids"),
        })

    user_text = json.dumps({
        "达人风格": style_json,
        "创意策略表": slim_strategies,
    }, ensure_ascii=False, indent=2)

    result = run_llm(
        agent_name=SPEC_MATCH.name,
        system=SPEC_MATCH.instructions,
        user_text=user_text,
        max_tokens=SPEC_MATCH.max_tokens,
        temperature=0.3,
    )
    return _parse_json(result.text)


def _rank_hotspots(hotspots: list[dict]) -> list[dict]:
    """热点素材按「素材评分」定级降序排序（优秀>良好>一般>劣质>未评级）。"""

    def rank(h: dict) -> int:
        score = (h.get("素材评分") or "").strip()
        return _SCORE_RANK.get(score, 9)

    return sorted(hotspots, key=rank)


def _parse_material_ids(raw: str) -> list[str]:
    """解析策略行「素材链接ids」字段（顿号/逗号分隔的 dy_xxx 列表）。"""
    if not raw:
        return []
    ids = re.split(r"[、,，;；\s]+", raw.strip())
    return [i for i in ids if i]


def _generate_directions(
    style_json: dict,
    match_result: dict,
    hotspot_rows: list[dict],
    other_rows: list[dict],
    hotspots: list[dict],
    materials_by_strategy: dict[str, list[dict]],
) -> dict[str, Any]:
    """LLM 组织 5 个创意方向。"""

    # 其他方向线按策略等级排序（S > A > B > X，无等级排最后）
    grade_rank = {"S": 0, "A": 1, "B": 2, "X": 3}
    other_rows_sorted = sorted(
        other_rows,
        key=lambda r: grade_rank.get((r.get("策略等级") or "").strip(), 9),
    )

    def slim_strategy(row: dict) -> dict:
        rid = row.get("_record_id")
        return {
            "record_id": rid,
            "内容方向一": row.get("内容方向一"),
            "内容方向二": row.get("内容方向二"),
            "策略等级": row.get("策略等级"),
            "内容一方向定义": row.get("内容一方向定义"),
            "植入策略": row.get("植入策略"),
            "适合达人": row.get("适合达人"),
            "正向案例": row.get("正向案例"),
            "素材链接ids": row.get("素材链接ids"),
            "反查素材": [
                {
                    "素材id": m.get("素材id"),
                    "场景": m.get("场景") or "",
                    "内容分析": (m.get("内容分析") or "")[:800],
                    "广告可借鉴点": (m.get("广告可借鉴点") or "")[:800],
                }
                for m in materials_by_strategy.get(rid, [])
            ],
        }

    hotspots_slim = [
        {
            "热点ID": h.get("热点ID"),
            "热点标题": h.get("热点标题"),
            "热点概述": h.get("热点概述"),
            "热点类型": h.get("热点类型"),
            "植入方向": h.get("植入方向"),
            "素材评分": h.get("素材评分"),
        }
        for h in hotspots[:10]  # 评分降序取前 10 供 LLM 组织
    ]

    user_text = json.dumps({
        "达人风格": style_json,
        "策略匹配结果": match_result,
        "蹭热点线_热点素材库（按素材评分降序）": hotspots_slim,
        "蹭热点线_来源策略行": [slim_strategy(r) for r in hotspot_rows],
        "其他方向线_策略行（按策略等级排序，含反查素材）": [
            slim_strategy(r) for r in other_rows_sorted
        ],
        "组织要求": "恰好 5 个方向；优先蹭热点线，不足由其他方向线按策略等级补足；其他方向线须含 narrative_strategy",
    }, ensure_ascii=False, indent=2)

    result = run_llm(
        agent_name=SPEC_DIRECTION.name,
        system=SPEC_DIRECTION.instructions,
        user_text=user_text,
        max_tokens=SPEC_DIRECTION.max_tokens,
        temperature=0.7,
    )
    return _parse_json(result.text)


def _parse_json(text: str) -> dict[str, Any]:
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
