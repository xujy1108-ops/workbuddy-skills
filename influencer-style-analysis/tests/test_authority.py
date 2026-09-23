"""大V（阅历型权威）判定规则单测（纯函数，不打 API，不调 LLM）。

运行：/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python tests/test_authority.py

规则依据（2026-09-21 与用户共创定稿）：
- 大V = 阅历型权威四特征全命中 AND 粉丝 > 100 万（用户硬门槛，大宽哥103万校准）
- tier：头部大V(>500万) | 标准大V(100-500万) | 中腰部阅历型(形态成立量级不足) | 内容能力型
- 样本校准：大威哥352万+驻港退役=标准大V；大宽哥103万=标准大V；崔校长81万=中腰部阅历型；
  达哥48万无阅历=内容能力型
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from agents.influencer_profiler import (  # noqa: E402
    _age_in_window,
    _compute_authority_tier,
    _parse_age_range,
)


def all_hit() -> dict:
    return {t: {"hit": True, "evidence": "x"} for t in (
        "age_35_50", "narratable_experience", "oral_opinion_form", "mentor_relationship",
    )}


def none_hit() -> dict:
    return {t: {"hit": False, "evidence": "x"} for t in (
        "age_35_50", "narratable_experience", "oral_opinion_form", "mentor_relationship",
    )}


def test_age_parse():
    assert _parse_age_range("40-45岁") == (40, 45)
    assert _parse_age_range("38岁上下") == (38, 38)
    assert _parse_age_range("30—35") == (30, 35)  # 全角破折号
    assert _parse_age_range("") is None
    assert _parse_age_range("未知") is None
    print("✅ 年龄区间解析")


def test_age_window():
    assert _age_in_window((40, 45)) is True       # 完全落在中年段
    assert _age_in_window((35, 50)) is True       # 边界完全重合
    assert _age_in_window((30, 40)) is True       # 重叠5年（35-40）≥3
    assert _age_in_window((33, 38)) is True       # 重叠3年（35-38）恰好达标
    assert _age_in_window((28, 35)) is False      # 重叠0年（35为开边界不算）
    assert _age_in_window((25, 30)) is False      # 完全在青年段
    assert _age_in_window((51, 55)) is False      # 完全在中老年段
    assert _age_in_window((48, 52)) is False      # 重叠仅2年（48-50）<3
    print("✅ 中年窗口判定")


def test_tier_head():
    tier, src, is_v, note = _compute_authority_tier(all_hit(), 6_000_000)
    assert tier == "头部大V" and src == "阅历身份型" and is_v is True
    print("✅ 头部大V：>500万 + 四特征")


def test_tier_standard():
    # 大威哥校准：352万 + 驻港部队退役阅历
    tier, src, is_v, _ = _compute_authority_tier(all_hit(), 3_526_789)
    assert tier == "标准大V" and is_v is True
    # 大宽哥校准：103万，刚过门槛
    tier, _, is_v, _ = _compute_authority_tier(all_hit(), 1_030_000)
    assert tier == "标准大V" and is_v is True
    print("✅ 标准大V：100-500万 + 四特征（大威哥352万/大宽哥103万校准）")


def test_tier_gate_boundary():
    # 硬门槛是严格大于 100 万
    tier, _, is_v, _ = _compute_authority_tier(all_hit(), 1_000_000)
    assert is_v is False and tier == "中腰部阅历型"
    tier, _, is_v, _ = _compute_authority_tier(all_hit(), 999_999)
    assert is_v is False and tier == "中腰部阅历型"
    # 崔校长校准：81万 + 企业主阅历 → 形态成立量级不足
    tier, src, _, note = _compute_authority_tier(all_hit(), 810_000)
    assert tier == "中腰部阅历型" and src == "阅历身份型" and "100万" in note
    print("✅ 粉丝硬门槛：严格 >100万；量级不足降级为中腰部阅历型")


def test_tier_content_capable():
    # 达哥校准：48万 + 无阅历证据 → 内容能力型
    tier, src, is_v, _ = _compute_authority_tier(none_hit(), 480_000)
    assert tier == "内容能力型" and src == "内容能力型" and is_v is False
    # 粉丝再多，无阅历形态也不是大V（量级不是充分条件）
    tier, _, is_v, _ = _compute_authority_tier(none_hit(), 3_000_000)
    assert tier == "内容能力型" and is_v is False
    print("✅ 内容能力型：无阅历证据（达哥校准），量级不构成大V充分条件")


def test_tier_trait_missing():
    # 特征缺失（LLM 没输出某项）按未命中处理
    traits = all_hit()
    del traits["mentor_relationship"]
    tier, _, is_v, _ = _compute_authority_tier(traits, 3_000_000)
    assert tier == "内容能力型" and is_v is False
    print("✅ 特征缺失按未命中（保守）")


def test_tier_follower_unknown():
    tier, src, is_v, note = _compute_authority_tier(all_hit(), None)
    assert tier == "中腰部阅历型" and is_v is False and "未知" in note
    tier, _, is_v, _ = _compute_authority_tier(none_hit(), None)
    assert tier == "内容能力型" and is_v is False
    print("✅ 粉丝未知：不确认大V，降级输出")


if __name__ == "__main__":
    test_age_parse()
    test_age_window()
    test_tier_head()
    test_tier_standard()
    test_tier_gate_boundary()
    test_tier_content_capable()
    test_tier_trait_missing()
    test_tier_follower_unknown()
    print("\n全部单测通过 ✅")
