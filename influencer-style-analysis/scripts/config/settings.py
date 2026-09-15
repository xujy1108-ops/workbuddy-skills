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

    anthropic_api_key: Optional[str] = Field(default=None, alias="ANTHROPIC_API_KEY")
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

    # 视频多模态分析（inferera OpenAI 兼容网关；qwen3-vl-plus，与 creative-content-analysis 一致）
    video_api_key: Optional[str] = Field(default=None, alias="VIDEO_API_KEY")
    video_base_url: str = Field(
        default="https://api.inferera.com/v1",
        alias="VIDEO_BASE_URL",
    )
    video_model: str = Field(
        default="qwen3-vl-plus",
        alias="VIDEO_MODEL",
    )

    # TikHub（influencer_profiler 拉取抖音达人数据）
    tikhub_api_token: Optional[str] = Field(default=None, alias="TIKHUB_API_TOKEN")


@lru_cache
def get_settings() -> Settings:
    return Settings()
