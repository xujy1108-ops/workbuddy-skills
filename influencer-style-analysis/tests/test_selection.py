"""tikhub.py 选样规则单测（mock 数据，不打 API）。

运行：/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python tests/test_selection.py
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from tools.tikhub import UnfitInfluencerError, parse_influencer_bundle  # noqa: E402


def make_payload(videos: list[dict]) -> dict:
    """videos: [{id, digg, duration_ms}] → 仿 TikHub 响应结构。"""
    aweme_list = []
    for v in videos:
        aweme_list.append(
            {
                "aweme_id": v["id"],
                "desc": "测试视频",
                "duration": v["duration_ms"],
                "author": {"nickname": "测试达人", "signature": "简介"},
                "statistics": {"digg_count": v["digg"], "comment_count": 1, "share_count": 1},
                "video": {
                    "duration": v["duration_ms"],
                    "play_addr": {
                        "url_list": [
                            "https://api.amemv.com/video/aweme/v1/play/?video_id=test",
                        ]
                    },
                },
            }
        )
    return {"data": {"aweme_list": aweme_list}}


MIN10 = 10 * 60 * 1000


def test_normal_selection():
    """Top5 按点赞排序，筛 <10min，取前 2。"""
    payload = make_payload(
        [
            {"id": "v_low_short", "digg": 10, "duration_ms": 60_000},      # 点赞低不进Top5
            {"id": "v1", "digg": 5000, "duration_ms": 200_000},            # Top1 ✓ 选中
            {"id": "v2", "digg": 4000, "duration_ms": MIN10},              # Top2 恰好=10min 被筛掉
            {"id": "v3", "digg": 3000, "duration_ms": 300_000},            # Top3 ✓ 选中
            {"id": "v4", "digg": 2000, "duration_ms": 700_000},            # Top4 超长筛掉
            {"id": "v5", "digg": 1000, "duration_ms": 100_000},            # Top5 <10min 但排第3，不选
        ]
    )
    bundle = parse_influencer_bundle(payload)
    assert bundle["video_count"] == 2, bundle
    assert bundle["video_urls"][0].startswith("https://api.amemv.com")
    digest = bundle["top5_digest"]
    assert [d["aweme_id"] for d in digest] == ["v1", "v2", "v3", "v4", "v5"]
    assert [d["selected"] for d in digest] == [True, False, True, False, False]
    print("✅ 正常选样：点赞Top5 → <10min → 前2名")


def test_unfit_all_too_long():
    """Top5 全部 ≥10min → UnfitInfluencerError。"""
    payload = make_payload(
        [
            {"id": f"v{i}", "digg": 5000 - i, "duration_ms": MIN10 + i * 1000}
            for i in range(5)
        ]
    )
    try:
        parse_influencer_bundle(payload)
        raise AssertionError("应抛出 UnfitInfluencerError")
    except UnfitInfluencerError as e:
        assert "不适合本次投放" in str(e)
        print("✅ 全超长判定：", str(e)[:60], "...")


def test_short_video_no_duration_edge():
    """duration=0（缺失）的视频不参与时长筛选（视为不合格）。"""
    payload = make_payload(
        [
            {"id": "a", "digg": 9000, "duration_ms": 200_000},
            {"id": "b", "digg": 8000, "duration_ms": 0},  # 时长缺失
            {"id": "c", "digg": 7000, "duration_ms": 150_000},
            {"id": "d", "digg": 6000, "duration_ms": 100_000},
            {"id": "e", "digg": 5000, "duration_ms": 500_000},
        ]
    )
    bundle = parse_influencer_bundle(payload)
    digest = bundle["top5_digest"]
    # b 无时长被剔除，选中 a、c
    assert digest[0]["aweme_id"] == "a" and digest[0]["selected"] is True
    assert digest[1]["aweme_id"] == "b" and digest[1]["selected"] is False
    assert digest[2]["aweme_id"] == "c" and digest[2]["selected"] is True
    print("✅ 时长缺失边角：无时长视频不选中")


def test_top5_window_not_extended():
    """第6名开始即使 <10min 也不进入候选（Top5 窗口之外）。"""
    payload = make_payload(
        [
            {"id": f"long{i}", "digg": 9000 - i, "duration_ms": 700_000}
            for i in range(5)
        ]
        + [{"id": "short6", "digg": 100, "duration_ms": 60_000}]
    )
    try:
        parse_influencer_bundle(payload)
        raise AssertionError("应抛出 UnfitInfluencerError（Top5 全超长，第6名不参与）")
    except UnfitInfluencerError:
        print("✅ Top5 窗口：窗口外短视频不参与时长筛选")


if __name__ == "__main__":
    test_normal_selection()
    test_unfit_all_too_long()
    test_short_video_no_duration_edge()
    test_top5_window_not_extended()
    print("\n全部单测通过 ✅")
