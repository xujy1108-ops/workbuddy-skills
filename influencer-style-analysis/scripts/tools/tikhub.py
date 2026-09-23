"""TikHub 抖音达人数据拉取。"""

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import httpx

from config.settings import get_settings

_TIKHUB_HOST = "api.tikhub.io"
_FETCH_POSTS_PATH = "/api/v1/douyin/app/v3/fetch_user_post_videos"
_FETCH_ONE_VIDEO_PATH = "/api/v1/douyin/app/v3/fetch_one_video_v3"
_XINGTU_KOLID_PATH = "/api/v1/douyin/xingtu_v2/get_xingtu_kolid_by_sec_user_id"
_XINGTU_VIDEO_PERF_PATH = "/api/v1/douyin/xingtu/kol_video_performance_v1"
# 2026-09-21 实测：作品列表端点 author 对象不含 follower_count（custom_verify 也常为空），
# 粉丝量级与认证信息必须走用户主页信息端点 handler_user_profile
_USER_PROFILE_PATH = "/api/v1/douyin/web/handler_user_profile"
_SEC_USER_ID_PATTERN = re.compile(r"/user/([^/?#]+)")

# 2026-09-21 实测：fetch_user_post_videos 端点 count=3/10 返回 400，count=20 正常
_FETCH_COUNT = 20
# 视频选样参数（2026-09-21 用户定）：按点赞排序取 Top5，时长 <10 分钟的前 2 名做多模态分析
_TOP_N = 5
_MAX_DURATION_MS = 10 * 60 * 1000
_ANALYZE_COUNT = 2


class UnfitInfluencerError(ValueError):
    """达人不符合投放条件（如 Top5 视频全部超长）。"""


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


def fetch_user_post_videos(sec_user_id: str, count: int = _FETCH_COUNT) -> dict[str, Any]:
    """调用 TikHub 拉取达人作品列表。

    注意：2026-09-21 实测该端点仅支持 count=20（传 3/10 等值会 400），
    因此实际请求固定使用 _FETCH_COUNT，参数 count 仅作兼容保留。
    """
    settings = get_settings()
    token = (settings.tikhub_api_token or "").strip()
    if not token:
        raise ValueError("未配置 TIKHUB_API_TOKEN，无法拉取抖音达人数据")

    params = {
        "sec_user_id": sec_user_id,
        "max_cursor": "0",
        "count": str(_FETCH_COUNT),
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


def parse_influencer_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    """
    从 TikHub 响应提取 influencer_profiler 所需字段。

    选样规则（2026-09-21 用户定，替代旧"按文件体积升序"逻辑）：
    1. 全部作品按点赞数（statistics.digg_count）降序排序，取 Top5
       （TikHub 作品列表端点 statistics.play_count 恒为 0，无法按播放量排序）
    2. Top5 中筛选时长 < 10 分钟的视频，按排名取前 2 个做多模态分析
    3. Top5 全部 ≥ 10 分钟 → 抛 UnfitInfluencerError（达人不适合本次投放）
    """
    aweme_list = _unwrap_aweme_list(payload)
    if not aweme_list:
        raise ValueError("达人暂无作品，无法分析")

    latest = aweme_list[0]
    author = latest.get("author") or {}
    bio = (author.get("signature") or "").strip()
    author_nickname = (author.get("nickname") or "").strip()

    # 收集有播放链接的作品（记录点赞/时长供排序筛选）
    candidates: list[dict[str, Any]] = []
    for aweme in aweme_list:
        video = aweme.get("video") or {}
        play_addr = video.get("play_addr") or {}
        video_url = _pick_video_url(play_addr)
        if not video_url:
            continue

        duration_ms = aweme.get("duration") or video.get("duration") or 0
        try:
            duration_ms = int(duration_ms)
        except (TypeError, ValueError):
            duration_ms = 0

        stats = aweme.get("statistics") or {}
        try:
            digg = int(stats.get("digg_count") or 0)
        except (TypeError, ValueError):
            digg = 0

        candidates.append(
            {
                "aweme_id": str(aweme.get("aweme_id") or ""),
                "duration_ms": duration_ms,
                "digg_count": digg,
                "video_url": video_url,
            }
        )

    if not candidates:
        raise ValueError("没有可以分析的视频")

    # 1. 点赞降序 Top5
    candidates.sort(key=lambda x: x["digg_count"], reverse=True)
    top5 = candidates[:_TOP_N]

    # 2. Top5 内筛时长 < 10 分钟，按排名取前 2
    qualified = [v for v in top5 if 0 < v["duration_ms"] < _MAX_DURATION_MS]

    if not qualified:
        durations = [round(v["duration_ms"] / 60000, 1) for v in top5]
        raise UnfitInfluencerError(
            f"该达人不适合本次投放：点赞 Top5 视频时长均超过 10 分钟（"
            f"{durations} 分钟），短视频投放场景下完播与分发都会受压制"
        )

    selected = qualified[:_ANALYZE_COUNT]

    return {
        "bio": bio,
        "author_nickname": author_nickname,
        "video_urls": [v["video_url"] for v in selected],
        "video_count": len(selected),
        "top5_digest": [
            {
                "aweme_id": v["aweme_id"],
                "digg_count": v["digg_count"],
                "duration_s": round(v["duration_ms"] / 1000, 1),
                "selected": v in selected,
            }
            for v in top5
        ],
    }


# ── 用户主页信息（粉丝量级 + 认证，authority_profile 数据源）────────


def fetch_user_profile_info(sec_user_id: str) -> dict[str, Any]:
    """sec_user_id → 用户主页信息（follower_count / 认证 / 简介）。

    2026-09-21 实测：`/api/v1/douyin/web/handler_user_profile` 返回
    data.user 下含 follower_count（真实粉丝数）、custom_verify（个人认证）、
    enterprise_verify_reason（企业认证）、is_verified 等。

    失败不抛异常——粉丝量级缺失只降级 authority_profile 置信度，
    不影响主流程。返回 dict 恒含 follower_count（失败为 None）+ note。
    """
    fallback: dict[str, Any] = {"follower_count": None}
    try:
        with _http_client() as client:
            payload = _xingtu_get(
                client, _USER_PROFILE_PATH, {"sec_user_id": sec_user_id}
            )
    except Exception as exc:  # noqa: BLE001
        fallback["note"] = f"用户信息接口失败（{str(exc)[:80]}），粉丝量级未知"
        return fallback

    user = (payload.get("data") or {}).get("user") or {}
    if not user:
        fallback["note"] = "用户信息响应为空，粉丝量级未知"
        return fallback

    try:
        follower_count = int(user.get("follower_count"))
    except (TypeError, ValueError):
        follower_count = None

    # 认证信息：个人认证优先，企业认证兜底，均无则空串
    custom_verify = (user.get("custom_verify") or "").strip()
    enterprise_verify = (user.get("enterprise_verify_reason") or "").strip()
    verification = custom_verify or enterprise_verify

    profile: dict[str, Any] = {
        "follower_count": follower_count,
        "verification": verification,
        "is_verified": bool(user.get("is_verified")),
        "nickname": (user.get("nickname") or "").strip(),
        "aweme_count": user.get("aweme_count"),
        "total_favorited": user.get("total_favorited"),
        "ip_location": (user.get("ip_location") or "").strip(),
    }
    if follower_count is None:
        profile["note"] = "响应中无 follower_count，粉丝量级未知"
    return profile


def fetch_influencer_from_douyin(
    *,
    profile_url: Optional[str] = None,
    sec_user_id: Optional[str] = None,
    video_count: int = 2,
) -> dict[str, Any]:
    """主页链接或 sec_user_id → 达人基础数据 bundle。

    video_count 参数已废弃（2026-09-21 选样规则改为 点赞Top5→时长筛选→前2个），
    仅作兼容保留。
    """
    user_id = (sec_user_id or "").strip()
    if profile_url and profile_url.strip():
        user_id = extract_sec_user_id(profile_url)

    if not user_id:
        raise ValueError("需提供 douyin_profile_url 或 sec_user_id")

    raw = fetch_user_post_videos(user_id)
    bundle = parse_influencer_bundle(raw)
    bundle["sec_user_id"] = user_id
    bundle["user_profile"] = fetch_user_profile_info(user_id)
    if profile_url:
        bundle["douyin_profile_url"] = profile_url.strip()
    return bundle


# ── 星图（商单）数据 ──────────────────────────────────────────


def _xingtu_get(client: httpx.Client, path: str, params: dict[str, Any]) -> dict[str, Any]:
    """星图接口统一 GET（含鉴权与计费错误处理）。"""
    settings = get_settings()
    token = (settings.tikhub_api_token or "").strip()
    headers = {"Authorization": f"Bearer {token}"}
    response = client.get(
        f"https://{_TIKHUB_HOST}{path}",
        params=params,
        headers=headers,
        timeout=60.0,
    )
    response.raise_for_status()
    return response.json()


def get_xingtu_kolid(sec_user_id: str) -> Optional[str]:
    """sec_user_id → 星图 kol_id。未注册星图/查询失败返回 None。"""
    with _http_client() as client:
        payload = _xingtu_get(
            client, _XINGTU_KOLID_PATH, {"sec_user_id": sec_user_id}
        )
    data = payload.get("data") or {}
    kolid = (data.get("id") or "").strip()
    return kolid or None


def fetch_star_items(kolid: str) -> list[dict[str, Any]]:
    """星图 kol_id → 最近 15 条星图商单（latest_star_item_info），按发布时间倒序。

    每条归一化为：item_id / title / item_date / duration_s / play / like / comment / share / url。
    """
    with _http_client() as client:
        payload = _xingtu_get(
            client,
            _XINGTU_VIDEO_PERF_PATH,
            {"kolId": kolid, "onlyAssign": "true"},
        )
    data = payload.get("data") or {}
    items = data.get("latest_star_item_info")
    if not isinstance(items, list):
        return []

    normalized: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            duration_s = float(it.get("duration") or 0)
        except (TypeError, ValueError):
            duration_s = 0.0

        def _int(key: str) -> int:
            try:
                return int(it.get(key) or 0)
            except (TypeError, ValueError):
                return 0

        normalized.append(
            {
                "item_id": str(it.get("item_id") or ""),
                "title": (it.get("item_title") or it.get("title") or "").strip(),
                "item_date": str(it.get("item_date") or ""),
                "duration_s": duration_s,
                "play": _int("play"),
                "like": _int("like"),
                "comment": _int("comment"),
                "share": _int("share"),
                "url": (it.get("url") or "").strip(),
            }
        )
    return normalized


def fetch_best_star_item(sec_user_id: str) -> tuple[Optional[dict[str, Any]], str]:
    """星图链路主入口：sec_user_id → 最近15条商单中播放量最高的一条。

    返回 (best_item_or_None, note)。未注册星图 / 无商单 / 接口异常时返回 (None, 原因)，
    不抛异常——商单分析是附加产出，失败不应影响主流程。
    """
    try:
        kolid = get_xingtu_kolid(sec_user_id)
        if not kolid:
            return None, "星图未收录该达人或查询失败，跳过商单分析"

        items = fetch_star_items(kolid)
        if not items:
            return None, "星图无商单记录，跳过商单分析"

        best = max(items, key=lambda x: (x["play"], x["like"]))
        return best, f"星图商单 {len(items)} 条，取播放量最高（{best['play']} 播放）"
    except Exception as exc:  # noqa: BLE001
        return None, f"星图接口异常（{str(exc)[:80]}），跳过商单分析"


def fetch_video_play_url(aweme_id: str) -> Optional[str]:
    """aweme_id → 单视频播放地址（fetch_one_video_v3 无版权限制版）。"""
    with _http_client() as client:
        payload = _xingtu_get(client, _FETCH_ONE_VIDEO_PATH, {"aweme_id": aweme_id})
    data = payload.get("data") or {}
    aweme = data.get("aweme_detail") or {}
    play_addr = (aweme.get("video") or {}).get("play_addr") or {}
    return _pick_video_url(play_addr)
