"""带人工补充信息的达人分析 runner。

特性：
- 多拉候选视频（规避千问内容审核拦截），逐个分析、失败跳过、凑够 target 个即停
- 人工补充（达人职业 / 资产层次 / 其他补充）程序化强制覆盖最终产出

用法：
    python _run_with_manual.py \
        --url "https://www.douyin.com/user/MS4w..." \
        --occupation "金融助贷从业者" \
        --asset-level "高" \
        --other "拍摄方式：一男一女双人共说台词"

三项补充都可省略（省略即不覆盖该项）；不带任何补充时等价于纯推断分析。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agents.influencer_profiler import (  # noqa: E402
    _analyze_one_video,
    _apply_manual_supplement,
    _build_text_payload,
    _merge_multiple_analyses,
)
from tools.tikhub import fetch_influencer_from_douyin  # noqa: E402


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="达人风格分析（支持人工补充信息强制覆盖）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    target_group = p.add_mutually_exclusive_group(required=True)
    target_group.add_argument("--url", help="抖音主页链接")
    target_group.add_argument("--sec-user-id", help="抖音 sec_user_id")

    p.add_argument("--occupation", default="", help="人工补充：达人职业")
    p.add_argument("--asset-level", default="", help="人工补充：资产层次")
    p.add_argument(
        "--other",
        default="",
        help="人工补充：其他补充（拍摄方式/出镜人数/机位/身份背景等非前两项的内容）",
    )

    p.add_argument("--candidates", type=int, default=5, help="拉取候选视频数，默认 5")
    p.add_argument("--target", type=int, default=2, help="成功分析目标数，默认 2")
    p.add_argument("--out", default="", help="输出 JSON 路径，默认 analysis_result_manual_<日期>.json")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    manual = {
        "occupation": (args.occupation or "").strip(),
        "asset_level": (args.asset_level or "").strip(),
        "other": (args.other or "").strip(),
    }

    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_path = args.out or os.path.join(
        script_dir, f"analysis_result_manual_{datetime.now():%Y%m%d}.json"
    )

    # 1. 拉取候选视频
    bundle = fetch_influencer_from_douyin(
        profile_url=args.url,
        sec_user_id=args.sec_user_id,
        video_count=args.candidates,
    )
    print(f"昵称: {bundle.get('author_nickname')}")
    print(f"简介: {(bundle.get('bio') or '')[:120]}")
    print(f"候选视频: {bundle.get('video_count')} 个")

    video_urls = bundle.get("video_urls") or []
    if not video_urls:
        print("没有可以分析的视频")
        return 1

    data = {
        "douyin_profile_url": args.url or "",
        "sec_user_id": args.sec_user_id or "",
        "bio": bundle.get("bio") or "",
        "video_urls": video_urls,
        "manual_supplement": manual,
        "_tikhub_meta": {
            "sec_user_id": bundle.get("sec_user_id"),
            "author_nickname": bundle.get("author_nickname"),
            "video_count": bundle.get("video_count"),
            "douyin_profile_url": bundle.get("douyin_profile_url"),
        },
    }
    user_text = _build_text_payload(data)

    # 2. 逐个分析，失败跳过，成功 target 个即停
    success_results, errors = [], []
    for i, vurl in enumerate(video_urls):
        if len(success_results) >= args.target:
            break
        _, result, err = _analyze_one_video(vurl, i, len(video_urls), user_text)
        if result is not None:
            success_results.append(result)
            print(f"视频 {i + 1} 成功（累计 {len(success_results)}）")
        else:
            errors.append(str(err)[:200])
            print(f"视频 {i + 1} 失败，跳过")

    if not success_results:
        print("ALL_FAILED:", json.dumps(errors, ensure_ascii=False))
        return 1

    # 3. 合并（单视频直接用）+ 人工补充强制覆盖
    if len(success_results) == 1:
        final = success_results[0]
    else:
        meta = {"source": "douyin", "sec_user_id": bundle.get("sec_user_id", "")}
        final = _merge_multiple_analyses(
            success_results,
            data["bio"],
            bundle.get("author_nickname") or "",
            meta,
            manual=manual,
        )

    final = _apply_manual_supplement(final, manual)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(json.loads(final.text), f, ensure_ascii=False, indent=2)

    print("DONE - saved to", out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
