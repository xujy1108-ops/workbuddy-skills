"""经 inferera OpenAI 兼容接口调用多模态模型（发送 video_url 分析视频）。

模型：qwen3-vl-plus（与 creative-content-analysis 的转录模型一致，走同一 AIHubMix/inferera 网关）。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx
from openai import OpenAI

from agents.base import AgentResult
from config.settings import get_settings

logger = logging.getLogger(__name__)


def _create_client() -> OpenAI:
    settings = get_settings()
    api_key = settings.video_api_key or settings.anthropic_api_key
    proxy = settings.https_proxy or settings.http_proxy
    http_client = (
        httpx.Client(proxy=proxy, timeout=300.0)
        if proxy
        else httpx.Client(timeout=300.0)
    )
    return OpenAI(
        api_key=api_key,
        base_url=settings.video_base_url.rstrip("/"),
        http_client=http_client,
    )


def _build_user_content(text: str, video_url: str) -> list[dict[str, Any]]:
    return [
        {"type": "text", "text": text},
        {"type": "video_url", "video_url": {"url": video_url}},
    ]


def run_video_analysis(
    *,
    agent_name: str,
    system: str,
    user_text: str,
    video_url: str,
    max_tokens: int = 8192,
) -> AgentResult:
    """
    调用多模态 Chat Completions，发送 video_url 让大模型直接看视频分析。
    失败时直接抛异常，由调用方决定是否尝试下一个视频。
    """
    settings = get_settings()
    model = settings.video_model
    client = _create_client()
    max_tok = max_tokens or 8192

    content = _build_user_content(user_text, video_url)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
        max_tokens=max_tok,
        temperature=0.3,
    )

    choice = response.choices[0]
    text = (choice.message.content or "").strip()
    finish_reason = getattr(choice, "finish_reason", None)

    usage: dict[str, int] = {}
    if response.usage:
        usage = {
            "input_tokens": response.usage.prompt_tokens or 0,
            "output_tokens": response.usage.completion_tokens or 0,
        }

    out_tokens = usage.get("output_tokens", 0)
    if finish_reason == "length":
        raise RuntimeError(
            f"模型输出被截断（finish_reason={finish_reason}, output_tokens={out_tokens}, "
            f"max_tokens={max_tok}）。请调大 MAX_TOKENS 后重试。"
        )

    return AgentResult(
        agent=agent_name,
        text=text,
        model=model,
        usage=usage,
        raw=response,
    )


def run_text_analysis(
    *,
    agent_name: str,
    system: str,
    user_text: str,
    max_tokens: int = 8192,
) -> AgentResult:
    """调用 Chat Completions（纯文本，无视频），用于合并多次视频分析结果。"""
    settings = get_settings()
    model = settings.video_model
    client = _create_client()
    max_tok = max_tokens or 8192

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_text},
        ],
        max_tokens=max_tok,
        temperature=0.3,
    )

    choice = response.choices[0]
    text = (choice.message.content or "").strip()
    finish_reason = getattr(choice, "finish_reason", None)

    usage: dict[str, int] = {}
    if response.usage:
        usage = {
            "input_tokens": response.usage.prompt_tokens or 0,
            "output_tokens": response.usage.completion_tokens or 0,
        }

    out_tokens = usage.get("output_tokens", 0)
    if finish_reason == "length":
        raise RuntimeError(
            f"模型输出被截断（finish_reason={finish_reason}, output_tokens={out_tokens}, "
            f"max_tokens={max_tok}）。请调大 MAX_TOKENS 后重试。"
        )

    return AgentResult(
        agent=agent_name,
        text=text,
        model=model,
        usage=usage,
        raw=response,
    )
