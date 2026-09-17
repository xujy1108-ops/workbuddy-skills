"""步骤 2a — 依据品牌配置的《达人类型基础标准》判定达人类型。

输入：达人风格 JSON（influencer-style-analysis 输出）
输出：类型判定 JSON（primary_type 一级类型、secondary_type 二级类型）

标准文档：品牌配置 docs.influencerTypeStandard.url（运行时实时拉取）
固化版本：品牌配置 config/<brand>/references/influencer-type-standard.md
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentSpec
from config.settings import INFLUENCER_TYPE_STANDARD_MAP, load_prompt
from providers.llm import run_llm

logger = logging.getLogger(__name__)

# 达人类型标准（终版，唯一合法枚举）：一级类型 -> 二级类型列表
# 来源：飞书文档 QDPOdmP6XoNiqpxmbl6cwNianCg（4 大类 8 二级，删除了旧版财经-常规/财经-鸡汤）
# 达人类型标准（唯一合法枚举，来自品牌配置 config/<brand>/config.json）
# 来源：品牌达人类型基础标准文档；换品牌时改配置，不改代码
TYPE_STANDARD: dict[str, list[str]] = INFLUENCER_TYPE_STANDARD_MAP

# 二级类型 -> 历史库(头条)「达人类型」select 枚举映射
# 注意：
# - 财经系三个二级均归并到历史库的「财经」枚举
# - 生活系（民生/人文杂谈）映射待确认：头条历史表的「达人类型」是否有「生活」枚举。
#   当前置空（查询返回空、不报错），确认后在此补充，例如 ("生活","民生"): ["生活"]。
SECONDARY_TO_HISTORY_TYPES: dict[tuple[str, str], list[str]] = {
    ("财经", "泛财经"): ["财经"],
    ("财经", "高价值"): ["财经"],
    ("财经", "小微企业主"): ["财经"],
    ("生活", "民生"): [],
    ("生活", "人文杂谈"): [],
    ("三农", "三农美食"): ["三农"],
    ("三农", "三农建造"): ["三农"],
    ("剧情", "常规剧情"): ["剧情"],
    ("剧情", "剧情搞笑"): ["剧情搞笑"],
}

SPEC = AgentSpec(
    name="influencer-type-classifier",
    instructions=load_prompt("influencer_type.md"),
    max_tokens=1024,
)


def run_match_condition_extractor(style_json: dict[str, Any]) -> dict[str, Any]:
    """判定达人类型。"""
    logger.info("步骤 2a: 依据达人类型标准判定类型...")
    user_text = (
        "## 达人风格 JSON\n"
        + json.dumps(style_json, ensure_ascii=False, indent=2)
    )
    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=user_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.1,
    )
    judgment = _parse_json(result.text)
    judgment.setdefault("primary_type", "")
    judgment.setdefault("secondary_type", "")
    judgment.setdefault("reason", "")

    primary = judgment["primary_type"]
    secondary = judgment["secondary_type"]
    # 校验枚举合法性；超出枚举或空值 → 视为未匹配（reason 中应含"无匹配-需补充"提示）
    if primary not in TYPE_STANDARD or secondary not in TYPE_STANDARD.get(primary, []):
        logger.warning(
            "类型判定超出标准枚举或无匹配: %s-%s（reason=%s），按未匹配处理",
            primary, secondary, judgment["reason"][:80],
        )
        judgment["primary_type"] = ""
        judgment["secondary_type"] = ""

    # 派生查询条件
    judgment["material_match_text"] = (
        f"达人类型：{judgment['primary_type']}-{judgment['secondary_type']}"
        if judgment["primary_type"] and judgment["secondary_type"]
        else ""
    )
    judgment["history_daren_types"] = SECONDARY_TO_HISTORY_TYPES.get(
        (judgment["primary_type"], judgment["secondary_type"]), []
    )
    if judgment["primary_type"] == "生活":
        logger.warning(
            "生活系类型（%s）的历史库头条表映射尚未确认，history_daren_types 为空，需在 SECONDARY_TO_HISTORY_TYPES 中补充",
            judgment["secondary_type"],
        )
    logger.info(
        "类型判定: %s-%s | 素材匹配词=%s | 历史库类型=%s",
        judgment["primary_type"], judgment["secondary_type"],
        judgment["material_match_text"], judgment["history_daren_types"],
    )
    return judgment


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
