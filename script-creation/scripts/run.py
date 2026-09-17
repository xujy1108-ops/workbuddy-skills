"""脚本创作 skill — 主入口。

支持按步骤独立执行（2026-09-09 改造：大纲步骤移除，directions → scripts 直通）：
  python run.py --step match       --style style.json [--user-input "..."]
  python run.py --step directions  --style style.json
  python run.py --step scripts     --style style.json --directions step3.json --selected 1,3,5

品牌配置化（2026-09-17）：品牌私有内容（飞书表 token / 文档 URL / prompt 模板 /
角色定位档位 / 达人类型枚举）外置在 skill 根目录 config/<brand>/。
  --brand duxiaoman   指定品牌（默认 duxiaoman，可用 env WORKFLOW_BRAND 覆盖）
  新增品牌 = 复制 config/duxiaoman 改配置，不改代码。
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
    """步骤 2: 匹配风格 + 产生原始创意（旧流程保留，主流程已不经过此步）。"""
    from agents.material_matcher import run_material_matcher

    style = _load_json(args.style)
    result = run_material_matcher(style, user_input=args.user_input)
    _output(result, args.output or "step2_materials.json")


def cmd_directions(args: argparse.Namespace) -> None:
    """步骤 3: 创意策略表驱动生成 5 个创意方向。"""
    from agents.direction_generator import run_direction_generator

    style = _load_json(args.style)
    result = run_direction_generator(style)
    _output(result, args.output or "step3_directions.json")


def cmd_scripts(args: argparse.Namespace) -> None:
    """步骤 6: 为选中的方向写脚本（SOP 驱动）+ 评分。"""
    from agents.script_writer import run_script_writer

    style = _load_json(args.style)
    all_directions = _load_json(args.directions)
    directions_list = all_directions.get("directions", all_directions)

    selected_ids = _parse_ids(args.selected)
    selected = [d for d in directions_list if d.get("id") in selected_ids]
    if not selected:
        selected = directions_list  # 兜底：全部

    result = run_script_writer(style, selected)
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


def main() -> None:
    parser = argparse.ArgumentParser(description="脚本创作 skill")
    parser.add_argument(
        "--step", required=True, choices=["match", "directions", "scripts"]
    )
    parser.add_argument("--style", required=True, help="达人风格 JSON 文件路径")
    parser.add_argument("--output", help="输出文件路径（默认 stepN_xxx.json）")
    parser.add_argument("--user-input", help="match 步骤: 用户手动输入的创意方向")
    parser.add_argument("--directions", help="scripts 步骤: step3_directions.json 路径")
    parser.add_argument("--selected", help="选中的方向 ID（逗号分隔，如 1,3,5）")
    parser.add_argument(
        "--brand",
        help="品牌（对应 config/<brand>/），默认 duxiaoman；亦可用 env WORKFLOW_BRAND",
    )

    args = parser.parse_args()

    # 品牌必须在 import agents 之前确定（agents / tools 在 cmd_* 内延迟 import）
    if args.brand:
        os.environ["WORKFLOW_BRAND"] = args.brand

    # 提前校验品牌配置：缺失/缺字段时给出可用品牌列表，而不是让堆栈冒到 agents 深处
    try:
        from config.settings import BRAND
    except RuntimeError as exc:
        logger.error("%s", exc)
        sys.exit(1)
    logger.info("生效品牌：%s（配置目录 config/%s/）", BRAND, BRAND)

    dispatch = {
        "match": cmd_match,
        "directions": cmd_directions,
        "scripts": cmd_scripts,
    }
    dispatch[args.step](args)


if __name__ == "__main__":
    main()
