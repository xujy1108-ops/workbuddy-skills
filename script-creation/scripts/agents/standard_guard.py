"""内容标准程序化校验（共享模块）。

供 material_matcher / direction_generator / outline_writer 复用：
- 宏大叙事/古典民俗关键词安全网（LLM 层已有内容标准约束，这里兜底）
- 链条传动次数解析
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# 宏大叙事/古典民俗切入的疑似关键词（安全网，LLM 层已有内容标准约束）
GRAND_NARRATIVE_MARKERS = [
    "拿破仑", "战役", "二战", "一战", "世界大战", "军事史",
    "战争史", "国际关系", "帝国", "朝代", "历史事件",
    "民俗", "典故", "古人", "古代", "老祖宗", "俗语",
    "谚语", "传说", "民间故事", "历史名人", "帝王", "皇帝",
]


def grand_narrative_hit(*texts: str | None) -> str | None:
    """检查文本是否命中宏大叙事/古典民俗关键词。

    Returns:
        命中的第一个关键词；未命中返回 None
    """
    combined = " ".join(t for t in texts if t)
    return next((k for k in GRAND_NARRATIVE_MARKERS if k in combined), None)


def parse_chain_transitions(value: Any) -> int:
    """解析链条传动次数（兼容字符串数字，异常默认 1）。"""
    try:
        return int(str(value if value is not None else "1").strip())
    except (ValueError, TypeError):
        return 1
