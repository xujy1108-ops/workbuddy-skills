"""步骤 3 — 生成 5 个创意方向（创意策略表驱动版）。

改造（2026-09-09）：不再由 LLM 基于素材/历史库自由生成，改为创意策略多维表格驱动。
改造（2026-09-21 晚）：按用户人工 SOP 整合三段式匹配——
1. 类型门槛（LLM，「适合达人」或关系命中，禁止二次否决）→ 候选集
2. 候选集内精细化排序（LLM，authority_profile/母题/画像参与优选排序，只排队不踢人）
   + 「权威门槛」程序化硬过滤（大V专属 × 非大V → 排除；低置信 → 保留待人工确认）
3. 热点位程序化配额（优秀热点存在→1位；达人热点向居多→2位；无优秀→0位）
   + 热点到期过滤（到期复查日已过 → 剔除，程序做）
4. 商单线（LLM 判定 top_ad_video 命中策略行 → 锁定入选标"商单已验证"；
   未命中 → 产出"商单改编方向"，复用已验证架构，证据等级最高，排首位）
5. 每个方向标 evidence_level

流程：
1. 拉取创意策略表全量 → LLM 判定达人画像与哪些策略行匹配并精细化排序
2. 程序化权威门槛硬过滤 + 热点配额计算
3. 命中策略行中内容方向一 = 蹭热点 → 蹭热点线：按「素材评分」×达人母题贴近度取优
4. 命中策略行为其他方向 → 其他方向线：植入策略直取策略行字段；叙事策略基于
   正向案例 + 素材链接ids 反查网络素材库的素材合并分析
5. 输出 5 个创意方向（内容方向定义 + 植入策略 + 适合达人 + evidence_level）

停用项：内容标准文档注入与程序化校验、历史库匹配。
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date
from typing import Any

from agents.base import AgentSpec
from config.settings import load_prompt
from providers.llm import run_llm
from tools.feishu import (
    fetch_hotspot_table,
    fetch_materials_by_ids,
    fetch_strategy_table,
)

logger = logging.getLogger(__name__)

# 素材评分定级顺序（优秀 > 良好 > 一般 > 劣质；未评级的排最后）
_SCORE_RANK = {"优秀": 0, "良好": 1, "一般": 2, "劣质": 3}

# 到期复查日兼容格式：2026-09-22 / 2026/9/22 / 2026.09.22
_DATE_RE = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})")


# ── 第一步：LLM 匹配策略行 ──────────────────────────────────

_MATCH_PROMPT = load_prompt("direction_match.md")


# ── 第二步：组织创意方向 ────────────────────────────────────

_DIRECTION_PROMPT = load_prompt("direction_generate.md")


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

    # 2. LLM 判定达人命中哪些策略行（类型门槛 + 精细化排序 + 商单命中 + 热点向判定）
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

    # 2.5 程序化权威门槛硬过滤（大V专属 × 非大V → 排除；低置信 → 保留待人工确认）
    match_result, authority_notes = _apply_authority_gate(
        style_json, match_result, strategies_by_id
    )
    matched_ids = [m["record_id"] for m in match_result.get("matched_strategies", [])]
    if not matched_ids:
        return {
            "directions": [],
            "strategy_match": match_result,
            "message": "命中策略行全部被「权威门槛」过滤（达人非大V且策略均大V专属）",
        }

    matched_strategies = [
        strategies_by_id[rid] for rid in matched_ids if rid in strategies_by_id
    ]

    # 3. 分线：蹭热点策略行 / 其他方向策略行
    hotspot_rows = [s for s in matched_strategies if "蹭热点" in (s.get("内容方向一") or "")]
    other_rows = [s for s in matched_strategies if "蹭热点" not in (s.get("内容方向一") or "")]
    logger.info(
        "分线: 蹭热点策略 %d 条 / 其他方向策略 %d 条", len(hotspot_rows), len(other_rows)
    )

    # 4. 蹭热点线 → 热点素材库按 素材评分 取优（先做到期过滤，程序化）
    # 保护：热点素材库为空时跳过全部蹭热点策略行，禁止凭空编造热点方向
    hotspots = _rank_hotspots(fetch_hotspot_table()) if hotspot_rows else []
    skipped_hotspot_rows: list[dict] = []
    if hotspot_rows and not hotspots:
        skipped_hotspot_rows = hotspot_rows
        logger.warning(
            "热点素材库为空 → 跳过 %d 条蹭热点策略行（%s），本次只产出其他方向线",
            len(skipped_hotspot_rows),
            ", ".join((r.get("_record_id") or "") for r in skipped_hotspot_rows),
        )
        hotspot_rows = []
    elif hotspot_rows:
        logger.info("热点素材库: 到期过滤+评分排序后取前 %d 条", len(hotspots))

    # 4.5 热点位程序化配额（0/1/2）：无优秀热点→0；有→1；达人热点向居多→2
    hotspot_quota, quota_reason = _hotspot_quota(
        hotspots, style_json, match_result
    )
    logger.info("热点位配额: %d（%s）", hotspot_quota, quota_reason)

    if not hotspot_rows and not other_rows:
        return {
            "directions": [],
            "strategy_match": match_result,
            "message": (
                "命中策略行全部依赖热点素材库，而热点素材库当前为空："
                "请先跑热点抓取入库，或补充其他方向策略行"
            ),
        }

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

    # 6. LLM 组织 5 个创意方向（带热点配额 + 商单线 + 权威标注）
    output = _generate_directions(
        style_json, match_result, hotspot_rows, other_rows,
        hotspots, materials_by_strategy,
        hotspot_quota=hotspot_quota, quota_reason=quota_reason,
        authority_notes=authority_notes,
    )
    # 6.5 商单线程序化校正：ad_verified 命中的方向必须标"商单已验证"且排第 1 位
    _enforce_ad_verified(output, match_result, strategies)
    output["strategy_match"] = match_result
    output["hotspot_quota"] = {"quota": hotspot_quota, "reason": quota_reason}
    if authority_notes:
        output["authority_notes"] = authority_notes
    if skipped_hotspot_rows:
        output["skipped_hotspot_strategies"] = [
            {
                "record_id": r.get("_record_id"),
                "skip_reason": "热点素材库为空，跳过蹭热点策略行（禁止凭空编造热点方向）",
            }
            for r in skipped_hotspot_rows
        ]
    return output


# ── 内部实现 ────────────────────────────────────────────────


def _apply_authority_gate(
    style_json: dict, match_result: dict, strategies_by_id: dict
) -> tuple[dict, list[str]]:
    """程序化权威门槛硬过滤（2026-09-21 用户定，纯规则可审计）。

    消费 style_json.basic_positioning.authority_profile（influencer-style-analysis 产出）：
    - 「权威门槛」= 大V专属 × is_big_v=false（且非低置信）→ 移入 excluded_strategies
    - 大V专属 × 粉丝未知/低置信（available=false 或 confidence=low）→ 保留 + 标注待人工确认
    - 大V专属 × is_big_v=true → 保留 + 标注已命中
    - 大V优先/企业主优先/不限/字段缺失 → 不做硬过滤（LLM 精细化排序负责加权）

    老版本 style.json 无 authority_profile 字段 → 按未知处理（中性，不排除）。
    返回 (更新后的 match_result, authority_notes 列表)。
    """
    bp = style_json.get("basic_positioning") or {}
    ap = bp.get("authority_profile") or {}
    is_big_v = ap.get("is_big_v")
    available = ap.get("available")
    confidence = ap.get("confidence")
    tier = ap.get("tier") or "未知"
    # 不可确认态：字段缺失 / available=false / confidence=low
    unknown = (not ap) or (available is False) or (confidence == "low") or (is_big_v is None)

    notes: list[str] = []
    kept: list[dict] = []
    excluded = match_result.setdefault("excluded_strategies", [])
    matched = match_result.get("matched_strategies", [])

    for m in matched:
        rid = m.get("record_id")
        row = strategies_by_id.get(rid) or {}
        gate = (row.get("权威门槛") or "").strip()

        if gate == "大V专属":
            if unknown:
                m["authority_note"] = "大V专属策略，但达人粉丝量级未知/低置信，保留待人工确认"
                notes.append(
                    f"{rid}: 大V专属策略但达人粉丝量级未知（authority 不可确认），已保留，建议人工确认粉丝量级"
                )
                kept.append(m)
            elif not is_big_v:
                excluded.append({
                    "record_id": rid,
                    "exclude_reason": f"大V专属策略：达人非大V（tier={tier}），程序化硬过滤",
                })
                notes.append(
                    f"{rid}: 大V专属策略被排除（达人 tier={tier}，非大V）"
                )
                continue
            else:
                m["authority_note"] = "大V专属策略：达人已确认大V，命中"
                kept.append(m)
        else:
            kept.append(m)

    match_result["matched_strategies"] = kept
    if unknown and matched:
        notes.append(
            "authority_profile 不可确认（缺失/低置信）：大V加权按中性处理（不加权不打折）"
        )
    return match_result, notes


def _enforce_ad_verified(
    output: dict, match_result: dict, strategies: list[dict] | None = None
) -> None:
    """商单线程序化校正（2026-09-21 定，规则不依赖模型自觉）。

    ad_analysis.ad_verified_record_id 非空（商单已验证命中策略行）时：
    1. 输出方向中 strategy_record_id == 该 id 的方向（取第一个）→
       evidence_level 强制改写为「商单已验证」并挪到第 1 位（重编 id）
    2. source_material_ids 为空 → 程序直接从策略行「素材链接ids」回填
       （2026-09-22 补：LLM 曾对商单线方向漏填素材 ids，写稿侧断链）
    3. 无对应方向（LLM 漏配）→ 不强行注入，仅在 output 记一条提示

    ad_verified 为 null 且 adapt_fallback=true 时：track=商单改编 的方向
    evidence_level 强制为「商单架构改编」并排第 1 位（若 LLM 已排第 1 则只校正标签）。
    """
    directions = output.get("directions")
    if not isinstance(directions, list) or not directions:
        return

    ad = match_result.get("ad_analysis") or {}
    verified_rid = ad.get("ad_verified_record_id")
    strategies_by_id = {
        (s.get("_record_id") or ""): s for s in (strategies or [])
    }

    def _move_to_front(idx: int) -> None:
        if idx > 0:
            d = directions.pop(idx)
            directions.insert(0, d)
            for i, item in enumerate(directions, 1):
                if isinstance(item, dict):
                    item["id"] = i

    if verified_rid:
        found_ad = False
        for i, d in enumerate(directions):
            if isinstance(d, dict) and d.get("strategy_record_id") == verified_rid:
                found_ad = True
                d["evidence_level"] = "商单已验证"
                _move_to_front(i)
                # 素材链接ids 程序回填：商单线方向必须带策略行素材（防 LLM 漏填断链）
                if not d.get("source_material_ids"):
                    src_row = strategies_by_id.get(verified_rid) or {}
                    ids = src_row.get("素材链接ids")
                    if isinstance(ids, str) and ids.strip():
                        ids = [x.strip() for x in ids.split(",") if x.strip()]
                    if isinstance(ids, list) and ids:
                        d["source_material_ids"] = ids
                        logger.info(
                            "商单线方向素材ids程序回填: %s ← 策略行 %s", ids, verified_rid
                        )
                break
        if not found_ad:
            output.setdefault("ad_line_note", (
                f"商单已验证策略行 {verified_rid} 未被组织进 5 方向（LLM 漏配），"
                "请人工核对是否需要补入"
            ))
        return

    if ad.get("adapt_fallback"):
        for i, d in enumerate(directions):
            if isinstance(d, dict) and (d.get("track") or "").strip() == "商单改编":
                d["evidence_level"] = "商单架构改编"
                _move_to_front(i)
                return


def _hotspot_quota(
    hotspots: list[dict], style_json: dict, match_result: dict
) -> tuple[int, str]:
    """热点位程序化配额（2026-09-21 用户人工 SOP 固化）。

    - 无「优秀」级热点 → 0 位（宁缺毋滥，良好/一般不顶替热点位）
    - 有优秀热点 → 1 位
    - 达人内容热点向居多 → 2 位（判定：一级类型=财经-泛财经【程序判】，
      或 LLM match 输出 hotspot_affinity.hotspot_heavy=true【语义判】）
    """
    has_excellent = any(
        (h.get("素材评分") or "").strip() == "优秀" for h in hotspots
    )
    if not has_excellent:
        return 0, "无「优秀」级热点 → 热点位 0（宁缺毋滥）"

    # 热点向居多：程序判（泛财经一级类型）或 LLM 语义判
    bp = style_json.get("basic_positioning") or {}
    influencer_type = (bp.get("influencer_type") or "").strip()
    is_pancj = influencer_type.startswith("财经-泛财经")

    affinity = match_result.get("hotspot_affinity") or {}
    llm_heavy = bool(affinity.get("hotspot_heavy"))

    if is_pancj or llm_heavy:
        why = "泛财经类型" if is_pancj else "母题谱系热点向居多（LLM 判定）"
        return 2, f"有优秀热点 + 达人热点向居多（{why}）→ 2 位"
    return 1, "有优秀热点 → 1 位（达人非热点向居多）"


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
            "内容二方向定义": (s.get("内容二方向定义") or "")[:300],
            "植入策略": (s.get("植入策略") or "")[:300],
            "适合达人": s.get("适合达人"),
            "权威门槛": (s.get("权威门槛") or "").strip() or "不限",
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
    """热点素材按「素材评分」定级降序排序（优秀>良好>一般>劣质>未评级）。

    2026-09-21 新增：先程序化过滤「到期复查日」已过期的热点（过期不进候选，
    评分再高也不行）；到期日缺失视为未过期（保守保留，交给素材评分排序）。
    """

    def rank(h: dict) -> int:
        score = (h.get("素材评分") or "").strip()
        return _SCORE_RANK.get(score, 9)

    today = date.today()
    fresh: list[dict] = []
    expired: list[dict] = []
    for h in hotspots:
        raw = (h.get("到期复查日") or "").strip()
        m = _DATE_RE.search(raw)
        if m:
            try:
                expire = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                expire = None
            if expire and expire < today:
                expired.append(h)
                continue
        fresh.append(h)

    if expired:
        logger.warning(
            "热点到期过滤: 剔除 %d 条过期热点（%s）",
            len(expired),
            ", ".join((h.get("热点ID") or h.get("热点标题") or "")[:30] for h in expired),
        )
    return sorted(fresh, key=rank)


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
    hotspot_quota: int = 1,
    quota_reason: str = "",
    authority_notes: list[str] | None = None,
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
            "内容二方向定义": row.get("内容二方向定义"),
            "植入策略": row.get("植入策略"),
            "适合达人": row.get("适合达人"),
            "权威门槛": (row.get("权威门槛") or "").strip() or "不限",
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
        for h in hotspots[:10]  # 到期过滤+评分降序取前 10 供 LLM 组织
    ]

    # 商单线判定结果（LLM match 阶段输出，程序已校验 record_id 真实性由 generate 阶段约束）
    ad_line = match_result.get("ad_analysis") or {}

    user_text = json.dumps({
        "达人风格": style_json,
        "策略匹配结果": match_result,
        "热点位配额（程序判定，必须遵守）": {
            "quota": hotspot_quota,
            "reason": quota_reason,
        },
        "蹭热点线_热点素材库（到期过滤+评分降序）": hotspots_slim,
        "蹭热点线_来源策略行": [slim_strategy(r) for r in hotspot_rows],
        "其他方向线_策略行（按策略等级排序，含反查素材）": [
            slim_strategy(r) for r in other_rows_sorted
        ],
        "商单线（达人已被市场验证的植入范式）": ad_line,
        "组织要求": (
            f"恰好 5 个方向；蹭热点方向恰好 {hotspot_quota} 个（配额为程序判定不得增减；"
            "热点选择=素材评分×与达人母题谱系/内容赛道的语义贴近度共同排序）；"
            "其余来自其他方向线（按策略等级 S>A>B>X 补足）；其他方向线须含 narrative_strategy；"
            "商单线按系统指令处理（ad_verified 锁定入选或产出商单改编方向）；"
            "每个方向标 evidence_level"
        ),
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
