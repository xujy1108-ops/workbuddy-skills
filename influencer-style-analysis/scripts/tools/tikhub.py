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


def _pick_video_url(play_addr: dict[str, Any]) -> Optional[str]:
    """
    从 video.play_addr.url_list 中选取域名为 api.amemv.com 的链接。
    若找不到则取 url_list 最后一个链接兜底。
    """
    url_list = play_addr.get("url_list")
    if not isinstance(url_list, list) or not url_list:
        return None

    for url in url_list:
        if isinstance(url, str) and "api.amemv.com" in url:
            return url.strip()

    last = url_list[-1]
    if isinstance(last, str) and last.strip():
        return last.strip()

    return None


def parse_influencer_bundle(payload: dict[str, Any], limit: int = 3) -> dict[str, Any]:
    """
    从 TikHub 响应提取 influencer_profiler 所需字段。
    - bio: aweme_list[0].author.signature
    - author_nickname: aweme_list[0].author.nickname
    - video_urls: 筛选 video.play_addr.data_size 存在 → 升序 → 取前 limit 个 → 选 api.amemv.com 链接
    """
    aweme_list = _unwrap_aweme_list(payload)
    if not aweme_list:
        raise ValueError("达人暂无作品，无法分析")

    latest = aweme_list[0]
    author = latest.get("author") or {}
    bio = (author.get("signature") or "").strip()
    author_nickname = (author.get("nickname") or "").strip()

    # 筛选 video.play_addr.data_size 存在的作品
    candidates: list[dict[str, Any]] = []
    for aweme in aweme_list:
        video = aweme.get("video") or {}
        play_addr = video.get("play_addr") or {}
        data_size = play_addr.get("data_size")
        if data_size is None:
            continue
        try:
            size_val = float(data_size)
        except (TypeError, ValueError):
            continue
        if size_val <= 0:
            continue

        video_url = _pick_video_url(play_addr)
        if not video_url:
            continue

        candidates.append({"data_size": size_val, "video_url": video_url})

    # 按 data_size 升序排序
    candidates.sort(key=lambda x: x["data_size"])

    # 取前 limit 个
    selected = candidates[:limit]

    if not selected:
        raise ValueError("没有可以分析的视频")

    video_urls = [item["video_url"] for item in selected]

    return {
        "bio": bio,
        "author_nickname": author_nickname,
        "video_urls": video_urls,
        "video_count": len(video_urls),
    }


def fetch_influencer_from_douyin(
    *,
    profile_url: Optional[str] = None,
    sec_user_id: Optional[str] = None,
    video_count: int = 3,
) -> dict[str, Any]:
    """主页链接或 sec_user_id → 达人基础数据 bundle。"""
    user_id = (sec_user_id or "").strip()
    if profile_url and profile_url.strip():
        user_id = extract_sec_user_id(profile_url)

    if not user_id:
        raise ValueError("需提供 douyin_profile_url 或 sec_user_id")

    # 拉取作品列表（多拉一些用于筛选）
    fetch_count = max(video_count * 3, 10)
    raw = fetch_user_post_videos(user_id, count=fetch_count)
    bundle = parse_influencer_bundle(raw, limit=video_count)
    bundle["sec_user_id"] = user_id
    if profile_url:
        bundle["douyin_profile_url"] = profile_url.strip()
    return bundle
