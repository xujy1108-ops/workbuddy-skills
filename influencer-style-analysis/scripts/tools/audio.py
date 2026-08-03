"""下载 HTTPS 音频；influencer_profiler 可截取前 N 秒以加速多模态。"""

from __future__ import annotations

import io
import logging
import os
import tempfile
from typing import Any, Optional

import httpx

from config.settings import get_settings

logger = logging.getLogger(__name__)


def _http_client() -> httpx.Client:
    settings = get_settings()
    proxy = settings.https_proxy or settings.http_proxy
    return httpx.Client(
        proxy=proxy,
        timeout=120.0,
        follow_redirects=True,
    )


def download_audio(url: str) -> bytes:
    """从 HTTPS 链接下载音频（支持 mp3 等）。"""
    with _http_client() as client:
        response = client.get(url)
        response.raise_for_status()
        content_type = (response.headers.get("content-type") or "").lower()
        if "text/html" in content_type:
            raise ValueError(f"URL 返回 HTML 而非音频，请检查链接: {url}")
        return response.content


def prepare_audio_for_profiler(audio_bytes: bytes) -> tuple[bytes, dict[str, Any]]:
    """
    截取 mp3 前 N 秒再送多模态（默认 60s），分析口吻/语气足够且更快。
    需 pydub + ffmpeg：pip install -e '.[audio]'
    若未安装或截取失败，返回原始音频。
    """
    settings = get_settings()
    max_seconds = settings.influencer_audio_max_seconds
    meta: dict[str, Any] = {
        "trimmed": False,
        "max_seconds": max_seconds,
        "original_bytes": len(audio_bytes),
    }

    if max_seconds <= 0:
        meta["used_bytes"] = len(audio_bytes)
        return audio_bytes, meta

    try:
        from pydub import AudioSegment
    except ImportError:
        logger.warning("未安装 pydub，跳过了音频截取。可执行: pip install -e '.[audio]'")
        meta["used_bytes"] = len(audio_bytes)
        return audio_bytes, meta

    try:
        audio = AudioSegment.from_file(io.BytesIO(audio_bytes), format="mp3")
    except Exception as exc:
        logger.warning("解析 mp3 失败，使用完整音频: %s", exc)
        meta["used_bytes"] = len(audio_bytes)
        return audio_bytes, meta

    original_ms = len(audio)
    meta["original_duration_ms"] = original_ms
    limit_ms = max_seconds * 1000

    if original_ms <= limit_ms:
        meta["used_bytes"] = len(audio_bytes)
        meta["used_duration_ms"] = original_ms
        return audio_bytes, meta

    trimmed = audio[:limit_ms]
    buf = io.BytesIO()
    trimmed.export(buf, format="mp3")
    out = buf.getvalue()
    meta.update(
        {
            "trimmed": True,
            "used_duration_ms": len(trimmed),
            "used_bytes": len(out),
        }
    )
    logger.info(
        "音频已截取前 %ss（原 %.1fs → %.1fs）",
        max_seconds,
        original_ms / 1000,
        len(trimmed) / 1000,
    )
    return out, meta


def transcribe_mp3_bytes(audio_bytes: bytes, language: str = "zh") -> str:
    """
    使用 faster-whisper 转写 mp3 字节流。
    需安装: pip install -e '.[audio]'
    系统建议安装 ffmpeg。
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "未安装音频转写依赖。请执行: pip install -e '.[audio]'"
        ) from exc

    settings = get_settings()
    model_size = getattr(settings, "whisper_model", "small")

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(tmp_path, language=language)
        parts = [segment.text.strip() for segment in segments if segment.text.strip()]
        text = "".join(parts)
        if not text:
            raise ValueError("音频转写结果为空，请检查音频链接或时长")
        return text
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def transcribe_mp3_url(url: str, language: str = "zh") -> str:
    """下载 HTTPS mp3 并转写为文本。"""
    audio_bytes = download_audio(url)
    return transcribe_mp3_bytes(audio_bytes, language=language)


def resolve_audio_transcript(
    audio_url: Optional[str],
    audio_transcript: Optional[str],
) -> tuple[str, str]:
    """
    返回 (transcript, source)。
    source: provided | whisper
    """
    if audio_transcript and audio_transcript.strip():
        return audio_transcript.strip(), "provided"

    if not audio_url or not audio_url.strip():
        raise ValueError("需提供 latest_audio_url 或 audio_transcript 之一")

    return transcribe_mp3_url(audio_url.strip()), "whisper"
