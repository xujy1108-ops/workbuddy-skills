"""TikHub 抖音达人数据拉取。"""

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import httpx

from config.settings import get_settings

_TIKHUB_HOST = "api.tikhub.io"
_FETCH_POSTS_PATH = "/api/v1/douyin/app/v3/fetch_user_post_videos"
_SEC_USER_ID_PATTERN = re.compile(r"/user/([^/?#]+)")


def extract_sec_user_id(profile_url: str) -> str:
    """
    从抖音主页链接解析 sec_user_id。
    例: https://www.douyin.com/user/MS4wLjABAAAA...?from_tab_name=main
    """
    url = (profile_url or "").strip()
    if not url:
        raise ValueError("douyin_profile_url 不能为空")

    match = _SEC_USER_ID_PATTERN.search(urlparse(url).path)
    if not match:
        raise ValueError(
            "无法从链接解析 sec_user_id，请确认格式为 "
            "https://www.douyin.com/user/{sec_user_id}"
        )

    sec_user_id = unquote(match.group(1)).strip()
    if not sec_user_id:
        raise ValueError("解析到的 sec_user_id 为空")
    return sec_user_id


def _http_client() -> httpx.Client:
    settings = get_settings()
    proxy = settings.https_proxy or settings.http_proxy
    return httpx.Client(
        proxy=proxy,
        timeout=60.0,
        follow_redirects=True,
    )


def fetch_user_post_videos(sec_user_id: str, count: int = 10) -> dict[str, Any]:
    """调用 TikHub 拉取达人作品列表。"""
    settings = get_settings()
    token = (settings.tikhub_api_token or "").strip()
    if not token:
        raise ValueError("未配置 TIKHUB_API_TOKEN，无法拉取抖音达人数据")

    params = {
        "sec_user_id": sec_user_id,
        "max_cursor": "0",
        "count": str(count),
    }

    headers = {"Authorization": f"Bearer {token}"}

    with _http_client() as client:
        response = client.get(
            f"https://{_TIKHUB_HOST}{_FETCH_POSTS_PATH}",
            params=params,
            headers=headers,
        )
        response.raise_for_status()
        payload = response.json()

    if isinstance(payload, dict) and payload.get("code") not in (None, 0, 200):
        message = payload.get("message") or payload.get("msg") or payload
        raise RuntimeError(f"TikHub API 错误: {message}")

    return payload


def _unwrap_aweme_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data", payload)
    if isinstance(data, dict) and "aweme_list" not in data and isinstance(data.get("data"), dict):
        data = data["data"]

    aweme_list = data.get("aweme_list") if isinstance(data, dict) else None
    if not isinstance(aweme_list, list):
        raise ValueError("TikHub 响应中未找到 aweme_list")
    return aweme_list


def _pick_audio_url(aweme: dict[str, Any]) -> Optional[str]:
    music = aweme.get("music") or {}
    play_url = music.get("play_url") or {}

    uri = play_url.get("uri")
    if isinstance(uri, str) and uri.strip():
        return uri.strip()

    url_list = play_url.get("url_list")
    if isinstance(url_list, list) and url_list:
        first = url_list[0]
        if isinstance(first, str) and first.strip():
            return first.strip()

    return None


def parse_influencer_bundle(payload: dict[str, Any], limit: int = 10) -> dict[str, Any]:
    """
    从 TikHub 响应提取 influencer_profiler 所需字段。
    - bio: aweme_list[0].author.signature
    - latest_audio_url: aweme_list[0].music.play_url.uri
    - recent_videos: share_info.share_title（最多 limit 条）
    """
    aweme_list = _unwrap_aweme_list(payload)
    if not aweme_list:
        raise ValueError("达人暂无作品，无法分析")

    latest = aweme_list[0]
    author = latest.get("author") or {}
    bio = (author.get("signature") or "").strip()

    latest_audio_url = _pick_audio_url(latest)
    if not latest_audio_url:
        raise ValueError("最近一条作品未找到 music.play_url 音频链接")

    recent_videos: list[dict[str, str]] = []
    for aweme in aweme_list[:limit]:
        share_info = aweme.get("share_info") or {}
        share_title = (share_info.get("share_title") or "").strip()
        recent_videos.append(
            {
                "title": share_title,
                "description": share_title,
            }
        )

    return {
        "bio": bio,
        "latest_audio_url": latest_audio_url,
        "recent_videos": recent_videos,
        "author_nickname": (author.get("nickname") or "").strip(),
        "video_count_fetched": len(recent_videos),
    }


def fetch_influencer_from_douyin(
    *,
    profile_url: Optional[str] = None,
    sec_user_id: Optional[str] = None,
    video_count: int = 10,
) -> dict[str, Any]:
    """主页链接或 sec_user_id → 达人基础数据 bundle。"""
    user_id = (sec_user_id or "").strip()
    if profile_url and profile_url.strip():
        user_id = extract_sec_user_id(profile_url)

    if not user_id:
        raise ValueError("需提供 douyin_profile_url 或 sec_user_id")

    raw = fetch_user_post_videos(user_id, count=video_count)
    bundle = parse_influencer_bundle(raw, limit=video_count)
    bundle["sec_user_id"] = user_id
    if profile_url:
        bundle["douyin_profile_url"] = profile_url.strip()
    return bundle
