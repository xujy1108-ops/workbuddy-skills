"""direction_generator 三段式匹配程序逻辑单测（纯函数，不打 API 不调 LLM）。

运行：/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python tests/test_direction_match.py

规则依据（2026-09-21 人工 SOP 固化）：
- 热点到期过滤：到期复查日 < 今天 → 剔除；缺失 → 保留
- 权威门槛硬过滤：大V专属 × is_big_v=false（非低置信）→ 排除；
  低置信/缺失 → 保留+标注；老版本无 authority_profile → 中性
- 热点配额：无优秀→0；有优秀→1；泛财经一级类型或 LLM hotspot_heavy → 2
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from agents.direction_generator import (  # noqa: E402
    _apply_authority_gate,
    _hotspot_quota,
    _rank_hotspots,
)


TODAY = date.today()
FUTURE = (TODAY + timedelta(days=7)).isoformat()
PAST = (TODAY - timedelta(days=1)).isoformat()


def make_hotspot(hid: str, score: str, expire: str) -> dict:
    return {"热点ID": hid, "素材评分": score, "到期复查日": expire}


def make_style(is_big_v=None, available=True, confidence="medium", tier=None) -> dict:
    ap = {}
    if is_big_v is not None or available is not False:
        ap = {
            "available": available,
            "is_big_v": is_big_v,
            "confidence": confidence,
            "tier": tier or ("标准大V" if is_big_v else "内容能力型"),
        }
    return {"basic_positioning": {"authority_profile": ap} if ap else {}}


def make_match(rids: list[str]) -> dict:
    return {"matched_strategies": [{"record_id": r} for r in rids]}


def make_strategies(gates: dict[str, str]) -> dict:
    return {rid: {"权威门槛": g} for rid, g in gates.items()}


def test_hotspot_expiry():
    hotspots = [
        make_hotspot("h_exp_优秀", "优秀", PAST),     # 过期的优秀热点 → 剔除
        make_hotspot("h_fresh_优秀", "优秀", FUTURE), # 未过期优秀 → 保留第1
        make_hotspot("h_fresh_良好", "良好", ""),     # 到期缺失 → 保留第2
        make_hotspot("h_fresh_一般", "一般", FUTURE), # 保留但排后
    ]
    ranked = _rank_hotspots(hotspots)
    ids = [h["热点ID"] for h in ranked]
    assert "h_exp_优秀" not in ids, "过期热点必须剔除（评分再高也不行）"
    assert ids[0] == "h_fresh_优秀", "未过期优秀排第1"
    assert ids[1] == "h_fresh_良好"
    print("✅ 热点到期过滤：过期剔除（含优秀级）、缺失保守保留、评分排序保持")


def test_authority_gate_exclude():
    """大V专属 × 非大V（可确认态）→ 程序化排除。"""
    style = make_style(is_big_v=False, confidence="medium", tier="内容能力型")
    strategies = make_strategies({"r1": "大V专属", "r2": "不限", "r3": "大V优先"})
    match = make_match(["r1", "r2", "r3"])
    match, notes = _apply_authority_gate(style, match, strategies)
    kept_ids = [m["record_id"] for m in match["matched_strategies"]]
    assert kept_ids == ["r2", "r3"], kept_ids
    excluded = {e["record_id"] for e in match["excluded_strategies"]}
    assert "r1" in excluded
    assert any("非大V" in n for n in notes)
    print("✅ 权威门槛硬过滤：大V专属 × 非大V → 排除（达哥校准）")


def test_authority_gate_bigv_hit():
    """大V专属 × is_big_v=true → 保留+标注命中。"""
    style = make_style(is_big_v=True, confidence="high", tier="标准大V")
    strategies = make_strategies({"r1": "大V专属"})
    match = make_match(["r1"])
    match, notes = _apply_authority_gate(style, match, strategies)
    assert len(match["matched_strategies"]) == 1
    assert "已确认大V" in match["matched_strategies"][0]["authority_note"]
    print("✅ 权威门槛：大V专属 × 大V（大威哥校准）→ 保留+命中标注")


def test_authority_gate_low_confidence_neutral():
    """confidence=low / 字段缺失 → 大V专属保留待人工确认，不排除（防错杀）。"""
    # low confidence
    style = make_style(is_big_v=False, confidence="low")
    strategies = make_strategies({"r1": "大V专属"})
    match = make_match(["r1"])
    match, notes = _apply_authority_gate(style, match, strategies)
    assert len(match["matched_strategies"]) == 1, "低置信不得排除"
    assert any("人工确认" in n for n in notes)
    # available=false
    style = make_style(available=False, confidence=None)
    match = make_match(["r1"])
    match, notes = _apply_authority_gate(style, match, strategies)
    assert len(match["matched_strategies"]) == 1
    # 老版本 style.json 完全无 authority_profile
    style_old = {"basic_positioning": {}}
    match = make_match(["r1"])
    match, notes = _apply_authority_gate(style_old, match, strategies)
    assert len(match["matched_strategies"]) == 1, "老 JSON 中性处理"
    print("✅ 权威门槛中性规则：低置信/缺失/老JSON → 保留+人工确认提示（不错杀）")


def test_quota_zero_without_excellent():
    hotspots = [make_hotspot("h1", "良好", FUTURE), make_hotspot("h2", "一般", FUTURE)]
    style = make_style(is_big_v=False)
    q, reason = _hotspot_quota(hotspots, style, {})
    assert q == 0 and "宁缺毋滥" in reason
    print("✅ 热点配额 0：无优秀级热点")


def test_quota_one():
    hotspots = [make_hotspot("h1", "优秀", FUTURE)]
    style = make_style(is_big_v=False)
    q, _ = _hotspot_quota(hotspots, style, {})
    assert q == 1
    print("✅ 热点配额 1：有优秀热点、达人非热点向")


def test_quota_two():
    hotspots = [make_hotspot("h1", "优秀", FUTURE)]
    # 路径A：泛财经一级类型（达哥校准）
    style = make_style(is_big_v=False)
    style["basic_positioning"]["influencer_type"] = "财经-泛财经"
    q, reason = _hotspot_quota(hotspots, style, {})
    assert q == 2 and "泛财经" in reason
    # 路径B：LLM 语义判定 hotspot_heavy
    style2 = make_style(is_big_v=False)
    style2["basic_positioning"]["influencer_type"] = "生活-民生"
    q2, reason2 = _hotspot_quota(hotspots, style2, {"hotspot_affinity": {"hotspot_heavy": True}})
    assert q2 == 2 and "LLM 判定" in reason2
    print("✅ 热点配额 2：泛财经类型 或 LLM 热点向判定")


def test_quota_zero_with_no_hotspots():
    q, reason = _hotspot_quota([], make_style(is_big_v=False), {})
    assert q == 0
    print("✅ 热点配额 0：热点库为空")


if __name__ == "__main__":
    test_hotspot_expiry()
    test_authority_gate_exclude()
    test_authority_gate_bigv_hit()
    test_authority_gate_low_confidence_neutral()
    test_quota_zero_without_excellent()
    test_quota_one()
    test_quota_two()
    test_quota_zero_with_no_hotspots()
    print("\n全部单测通过 ✅")
