"""脚本创作 skill — 主入口。

支持按步骤独立执行：
  python run.py --step match       --style style.json [--user-input "..."]
  python run.py --step directions  --style style.json --step2 step2.json
  python run.py --step outlines    --style style.json --directions step3.json --selected 1,3,5
  python run.py --step scripts     --style style.json --outlines step5.json --selected 1A,2B,3A
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

# 确保 scripts/ 目录在 sys.path 中
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# 加载 .env
os.chdir(SCRIPT_DIR)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("script-creation")


def cmd_match(args: argparse.Namespace) -> None:
    """步骤 2: 匹配风格 + 产生原始创意。"""
    from agents.material_matcher import run_material_matcher

    style = _load_json(args.style)
    result = run_material_matcher(style, user_input=args.user_input)
    _output(result, args.output or "step2_materials.json")


def cmd_directions(args: argparse.Namespace) -> None:
    """步骤 3: 生成 5 个创意方向。"""
    from agents.direction_generator import run_direction_generator

    style = _load_json(args.style)
    step2 = _load_json(args.step2)
    result = run_direction_generator(style, step2)
    _output(result, args.output or "step3_directions.json")


def cmd_outlines(args: argparse.Namespace) -> None:
    """步骤 5: 为选中的方向生成大纲 + 质检。"""
    from agents.outline_writer import run_outline_writer

    style = _load_json(args.style)
    all_directions = _load_json(args.directions)
    directions_list = all_directions.get("directions", all_directions)

    selected_ids = _parse_ids(args.selected)
    selected = [d for d in directions_list if d.get("id") in selected_ids]
    if not selected:
        selected = directions_list  # 兜底：全部

    result = run_outline_writer(style, selected)
    _output(result, args.output or "step5_outlines.json")


def cmd_scripts(args: argparse.Namespace) -> None:
    """步骤 6-7: 为选中的大纲写脚本 + 评分。"""
    from agents.script_writer import run_script_writer

    style = _load_json(args.style)
    all_outlines = _load_json(args.outlines)
    outline_list = all_outlines.get("outlines", all_outlines)

    selected_ids = _parse_str_ids(args.selected)
    selected = [o for o in outline_list if o.get("outline_id") in selected_ids]
    if not selected:
        selected = outline_list  # 兜底：全部

    # 传入步骤 2 的素材库/历史数据，让写稿时 LLM 有完整产品上下文
    step2_result = _load_json(args.step2) if args.step2 else None

    result = run_script_writer(style, selected, step2_result=step2_result)
    _output(result, args.output or "step6_scripts.json")


# ── 工具函数 ──


def _load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _output(data: dict, path: str) -> None:
    out_path = SCRIPT_DIR / path
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info("输出: %s", out_path)
    # 同时打印到 stdout 供 agent 读取
    print(json.dumps(data, ensure_ascii=False, indent=2))


def _parse_ids(s: str) -> set[int]:
    return {int(x.strip()) for x in s.split(",") if x.strip()}


def _parse_str_ids(s: str) -> set[str]:
    return {x.strip() for x in s.split(",") if x.strip()}


def main() -> None:
    parser = argparse.ArgumentParser(description="脚本创作 skill")
    parser.add_argument("--step", required=True, choices=["match", "directions", "outlines", "scripts"])
    parser.add_argument("--style", required=True, help="达人风格 JSON 文件路径")
    parser.add_argument("--output", help="输出文件路径（默认 stepN_xxx.json）")
    parser.add_argument("--user-input", help="步骤2: 用户手动输入的创意方向")
    parser.add_argument("--step2", help="步骤3: step2_materials.json 路径")
    parser.add_argument("--directions", help="步骤5: step3_directions.json 路径")
    parser.add_argument("--selected", help="选中的 ID（逗号分隔，如 1,3,5 或 1A,2B）")
    parser.add_argument("--outlines", help="步骤6: step5_outlines.json 路径")

    args = parser.parse_args()

    dispatch = {
        "match": cmd_match,
        "directions": cmd_directions,
        "outlines": cmd_outlines,
        "scripts": cmd_scripts,
    }
    dispatch[args.step](args)


if __name__ == "__main__":
    main()
