from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    anthropic_api_key: str = Field(..., alias="ANTHROPIC_API_KEY")
    anthropic_base_url: str = Field(
        default="https://aihubmix.com",
        alias="ANTHROPIC_BASE_URL",
    )
    default_model: str = Field(default="claude-opus-4-7", alias="DEFAULT_MODEL")
    max_tokens: int = Field(default=4096, alias="MAX_TOKENS")

    api_host: str = Field(default="0.0.0.0", alias="API_HOST")
    api_port: int = Field(default=8000, alias="API_PORT")

    edge_gateway_url: Optional[str] = Field(default=None, alias="EDGE_GATEWAY_URL")
    edge_gateway_token: Optional[str] = Field(default=None, alias="EDGE_GATEWAY_TOKEN")

    http_proxy: Optional[str] = Field(default=None, alias="HTTP_PROXY")
    https_proxy: Optional[str] = Field(default=None, alias="HTTPS_PROXY")

    # 多模态（influencer_profiler 听 mp3，OpenAI 兼容 / AiHubMix）
    multimodal_api_key: Optional[str] = Field(default=None, alias="MULTIMODAL_API_KEY")
    multimodal_base_url: str = Field(
        default="https://aihubmix.com/v1",
        alias="MULTIMODAL_BASE_URL",
    )
    multimodal_model: str = Field(
        default="gemini-2.5-flash",
        alias="MULTIMODAL_MODEL",
    )

    whisper_model: str = Field(default="small", alias="WHISPER_MODEL")

    # TikHub（influencer_profiler 拉取抖音达人数据）
    tikhub_api_token: Optional[str] = Field(default=None, alias="TIKHUB_API_TOKEN")

    # influencer_profiler：送多模态前只保留前 N 秒（听口吻够用，显著提速）
    influencer_audio_max_seconds: int = Field(
        default=60,
        alias="INFLUENCER_AUDIO_MAX_SECONDS",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
