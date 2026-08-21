"""基础数据结构。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentResult:
    """LLM 调用结果。"""
    agent: str
    text: str
    model: str
    usage: dict[str, int] = field(default_factory=dict)
    raw: Any = None


@dataclass
class AgentSpec:
    """Agent 规格。"""
    name: str
    instructions: str
    max_tokens: int = 8192
