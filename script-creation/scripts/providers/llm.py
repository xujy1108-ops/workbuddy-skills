"""DeepSeek-v4-pro LLM 调用（通过 inferera OpenAI 兼容接口）。"""

from __future__ import annotations

import logging

from openai import OpenAI

from agents.base import AgentResult
from config.settings import get_settings

logger = logging.getLogger(__name__)

_client: OpenAI | None = None


def _create_client() -> OpenAI:
    global _client
    if _client is None:
        s = get_settings()
        _client = OpenAI(
            api_key=s.deepseek_api_key,
            base_url=s.deepseek_base_url,
        )
    return _client


def run_llm(
    *,
    agent_name: str,
    system: str,
    user_text: str,
    max_tokens: int = 8192,
    temperature: float = 0.7,
) -> AgentResult:
    """调用 deepseek-v4-pro Chat Completions。"""
    s = get_settings()
    model = s.deepseek_model
    client = _create_client()

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_text},
        ],
        max_tokens=max_tokens,
        temperature=temperature,
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

    logger.info(
        "%s 完成: model=%s, finish=%s, tokens(in=%d, out=%d)",
        agent_name, model, finish_reason,
        usage.get("input_tokens", 0),
        usage.get("output_tokens", 0),
    )

    if finish_reason == "length":
        raise RuntimeError(
            f"模型输出被截断（finish_reason=length, output_tokens={usage.get('output_tokens', 0)}, "
            f"max_tokens={max_tokens}）。请调大 max_tokens 后重试。"
        )

    return AgentResult(
        agent=agent_name,
        text=text,
        model=model,
        usage=usage,
        raw=response,
    )
