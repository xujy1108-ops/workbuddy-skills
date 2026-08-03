"""经 AiHubMix OpenAI 兼容接口调用多模态模型（直接听 mp3）。"""

from __future__ import annotations

import base64
import logging
from typing import Any, Optional

import httpx
from openai import OpenAI

from agents.base import AgentResult
from config.settings import get_settings

logger = logging.getLogger(__name__)


def _create_client() -> OpenAI:
    settings = get_settings()
    api_key = settings.multimodal_api_key or settings.anthropic_api_key
    proxy = settings.https_proxy or settings.http_proxy
    http_client = httpx.Client(proxy=proxy, timeout=180.0) if proxy else httpx.Client(timeout=180.0)
    return OpenAI(
        api_key=api_key,
        base_url=settings.multimodal_base_url.rstrip("/"),
        http_client=http_client,
    )


def _audio_format_from_bytes(audio_bytes: bytes, hint: str = "mp3") -> str:
    if audio_bytes[:3] == b"ID3" or audio_bytes[:2] == b"\xff\xfb":
        return "mp3"
    if audio_bytes[:4] == b"RIFF":
        return "wav"
    return hint


def _build_user_content(text: str, audio_bytes: Optional[bytes], audio_format: str) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
    if not audio_bytes:
        return parts

    b64 = base64.standard_b64encode(audio_bytes).decode("ascii")
    parts.append(
        {
            "type": "input_audio",
            "input_audio": {"data": b64, "format": audio_format},
        }
    )
    return parts


def _build_user_content_data_url(text: str, audio_bytes: bytes, mime: str = "audio/mpeg") -> list[dict[str, Any]]:
    b64 = base64.standard_b64encode(audio_bytes).decode("ascii")
    return [
        {"type": "text", "text": text},
        {
            "type": "audio_url",
            "audio_url": {"url": f"data:{mime};base64,{b64}"},
        },
    ]


def run_multimodal(
    *,
    agent_name: str,
    system: str,
    user_text: str,
    audio_bytes: Optional[bytes] = None,
    audio_format: str = "mp3",
    max_tokens: Optional[int] = None,
) -> AgentResult:
    """
    调用多模态 Chat Completions。
    有 audio_bytes 时直接听音频；失败时自动尝试 data-url 格式。
    """
    settings = get_settings()
    model = settings.multimodal_model
    client = _create_client()
    max_tok = max_tokens or settings.max_tokens

    if audio_bytes:
        fmt = _audio_format_from_bytes(audio_bytes, hint=audio_format)
        content_attempts = [
            _build_user_content(user_text, audio_bytes, fmt),
            _build_user_content_data_url(user_text, audio_bytes),
        ]
    else:
        content_attempts = [_build_user_content(user_text, None, audio_format)]

    last_error: Optional[Exception] = None
    response = None

    for content in content_attempts:
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": content},
                ],
                max_tokens=max_tok,
                temperature=0.3,
            )
            break
        except Exception as exc:
            last_error = exc
            logger.warning("multimodal call failed, try next format: %s", exc)

    if response is None:
        raise RuntimeError(
            f"多模态调用失败（model={model}）。"
            f"请确认 AiHubMix 支持该模型的音频输入，或改用 audio_transcript 文本兜底。"
            f" 原始错误: {last_error}"
        ) from last_error

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
    if finish_reason == "length" or out_tokens >= max_tok - 20:
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
