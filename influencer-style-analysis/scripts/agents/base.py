from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import anthropic
import httpx

from config.settings import get_settings


@dataclass(frozen=True)
class AgentSpec:
    name: str
    instructions: str
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    description: str = ""


@dataclass
class AgentResult:
    agent: str
    text: str
    model: str
    usage: dict[str, int] = field(default_factory=dict)
    raw: Any = None


def _build_client() -> anthropic.Anthropic:
    settings = get_settings()
    proxy = settings.https_proxy or settings.http_proxy
    http_client = httpx.Client(proxy=proxy, timeout=120.0) if proxy else httpx.Client(timeout=120.0)
    return anthropic.Anthropic(
        api_key=settings.anthropic_api_key,
        base_url=settings.anthropic_base_url.rstrip("/"),
        http_client=http_client,
    )


def run_agent(spec: AgentSpec, user_input: str) -> AgentResult:
    """调用 AiHubMix（Anthropic 原生）执行单个 Agent。"""
    settings = get_settings()
    model = spec.model or settings.default_model
    max_tokens = spec.max_tokens or settings.max_tokens

    client = _build_client()
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=spec.instructions,
        messages=[{"role": "user", "content": user_input}],
    )

    parts: list[str] = []
    for block in response.content:
        if block.type == "text":
            parts.append(block.text)

    usage = {}
    if response.usage:
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

    return AgentResult(
        agent=spec.name,
        text="".join(parts).strip(),
        model=model,
        usage=usage,
        raw=response,
    )
