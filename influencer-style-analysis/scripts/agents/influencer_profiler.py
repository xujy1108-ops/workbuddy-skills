"""达人风格识别：TikHub 拉取抖音数据 + Doubao 多模态看视频分析。"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from agents.base import AgentResult, AgentSpec
from providers.multimodal import run_video_analysis
from tools.tikhub import fetch_influencer_from_douyin

logger = logging.getLogger(__name__)

_STYLE_LABELS = """
## 内容风格标签（8 选，最多选 3 个）
必须从下列标签中**原样选用**（不得自造标签），按匹配度从高到低排列，最多 3 个：
1. 亲切唠嗑：像朋友聊天，自然随性
2. 激情造势：语速快、情绪足
3. 专业沉稳：用词严谨，干货 / 测评专用
4. 幽默吐槽：诙谐玩梗，轻松有笑点
5. 温柔舒缓：语调柔和
6. 利落酷飒：短句干脆，气场强
7. 朴实接地气：大白话，真诚不花哨
8. 悬念吊胃口：停顿造势，勾起好奇
"""

_OUTPUT_SCHEMA = """
## 输出要求（全文简练，禁止长篇解释）
只输出一个 JSON 对象（不要用 markdown 代码块包裹）。

**总原则**：所有字符串字段宜短；`influencer_profile_text` 为唯一可稍长字段，**不得超过 200 字**。

{
  "persona_positioning": {
    "summary": "人设一句话，≤30字",
    "target_audience": "受众，≤15字",
    "core_topics": ["最多3个，每个≤8字"]
  },
  "content_style": {
    "style_labels": ["最多3个标签，见枚举"],
    "style_summary": "口吻+节奏+风格综合，≤50字",
    "speech_pace": "快|中|慢",
    "tone": "语气，≤12字",
    "taboos": ["忌写法，最多2条，每条≤12字"]
  },
  "influencer_profile_text": "供 script_scorer 使用：人设+风格标签+语气节奏，**≤200字**，简单说明，不要分点罗列",
  "analysis_mode": "multimodal_video",
  "author_nickname": "达人昵称，可选"
}
"""

SPEC = AgentSpec(
    name="influencer_profiler",
    description="识别达人风格：TikHub 拉取抖音主页 + Doubao 多模态看视频",
    instructions=f"""你是抖音达人风格分析专家。

## 输入形式
用户消息为 JSON 文本；附带视频，请**直接看视频**分析口吻、语气、语速、停顿、情绪、画面风格，**不要**逐字复述全文。

### 文本字段（通常由系统自动从 TikHub 填充）
- bio：达人个人简介

### 视频
- 已附视频链接：分析 content_style 时必须以**视频观感**为主（口吻、画面、节奏、剪辑风格）

## 分析要求
1. **persona_positioning**：依据 bio + 视频内容，字段宜短。
2. **content_style**：有视频时依据**观感**；选 8 类风格标签中**最多 3 个**（原样写入 style_labels），style_summary ≤50 字。
3. **influencer_profile_text**：整段 **≤200 字**，口语化简单说明，给后续脚本打分用；不要证据罗列、不要复述口播稿。
4. **禁止**输出 evidence、长列表、markdown 分点。

{_STYLE_LABELS}

{_OUTPUT_SCHEMA}

使用简体中文。只输出 JSON，**禁止**用 ```json 或 ``` 包裹。""",
    max_tokens=8192,
)


def _coerce_input_dict(user_input: str) -> dict[str, Any]:
    """兼容：标准 JSON / 纯主页链接 / 误写在 input 字段里的链接。"""
    raw = user_input.strip()
    if not raw:
        raise ValueError("input 不能为空")

    if raw.startswith("http") and "douyin.com/user/" in raw:
        return {"douyin_profile_url": raw}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        if "douyin.com/user/" in raw:
            return {"douyin_profile_url": raw}
        raise ValueError(
            'input 格式错误。正确示例：{"douyin_profile_url":"https://www.douyin.com/user/MS4w..."} '
            "或在 API 的 input 字段里直接填抖音主页链接。"
        ) from None

    if not isinstance(data, dict):
        raise ValueError("input 必须是 JSON 对象")

    nested = data.get("input")
    if isinstance(nested, str) and "douyin.com/user/" in nested:
        if not data.get("douyin_profile_url"):
            data = {**data, "douyin_profile_url": nested.strip()}

    return data


def _parse_input(user_input: str) -> dict[str, Any]:
    data = _coerce_input_dict(user_input)

    douyin_profile_url = (data.get("douyin_profile_url") or "").strip() or None
    sec_user_id = (data.get("sec_user_id") or "").strip() or None
    bio = (data.get("bio") or "").strip()

    has_manual = bool(bio)
    has_douyin = bool(douyin_profile_url or sec_user_id)

    if not has_manual and not has_douyin:
        raise ValueError(
            "至少提供 douyin_profile_url / sec_user_id，或手动提供 bio"
        )

    return {
        "douyin_profile_url": douyin_profile_url,
        "sec_user_id": sec_user_id,
        "bio": bio,
    }


def _merge_with_tikhub(data: dict[str, Any]) -> dict[str, Any]:
    """优先 TikHub 拉取；用户手动字段可覆盖。"""
    if not data.get("douyin_profile_url") and not data.get("sec_user_id"):
        return data

    fetched = fetch_influencer_from_douyin(
        profile_url=data.get("douyin_profile_url"),
        sec_user_id=data.get("sec_user_id"),
    )

    merged = {
        **data,
        "bio": data.get("bio") or fetched.get("bio") or "",
        "video_urls": fetched.get("video_urls") or [],
        "_tikhub_meta": {
            "sec_user_id": fetched.get("sec_user_id"),
            "author_nickname": fetched.get("author_nickname"),
            "video_count": fetched.get("video_count"),
            "douyin_profile_url": fetched.get("douyin_profile_url"),
        },
    }

    if not merged["bio"] and not merged.get("video_urls"):
        raise ValueError("TikHub 拉取成功但未解析到简介或视频")

    return merged


def _build_text_payload(data: dict[str, Any]) -> str:
    payload: dict[str, Any] = {
        "bio": data.get("bio") or "",
        "analysis_mode": "multimodal_video",
    }
    if data.get("_tikhub_meta"):
        payload["data_source"] = data["_tikhub_meta"]
    payload["note"] = (
        "请根据 bio、视频内容分析 persona_positioning；"
        "根据视频观感分析 content_style，analysis_mode 填 multimodal_video。"
    )
    return json.dumps(payload, ensure_ascii=False, indent=2)


_PROFILE_TEXT_MAX_LEN = 200
_FIELD_MAX = {
    "style_summary": 50,
    "summary": 30,
    "tone": 12,
}


def _strip_markdown_fence(text: str) -> str:
    """去掉模型常加的 ```json ... ``` 包裹。"""
    t = text.strip()
    if not t.startswith("```"):
        return t
    lines = t.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _ensure_complete_json(result: AgentResult) -> AgentResult:
    """输出 token 顶满或 JSON 无法解析时，明确报错而非返回半截。"""
    cleaned = _strip_markdown_fence(result.text)
    out_tokens = (result.usage or {}).get("output_tokens", 0)

    try:
        json.loads(cleaned)
    except json.JSONDecodeError as exc:
        hint = "模型输出不完整"
        if out_tokens >= 1800:
            hint += f"（已用 {out_tokens} output tokens，可能触达 max_tokens 上限）"
        raise RuntimeError(
            f"{hint}，请重试或调大 MAX_TOKENS。解析错误: {exc}"
        ) from exc

    return AgentResult(
        agent=result.agent,
        text=cleaned,
        model=result.model,
        usage=result.usage,
        raw=result.raw,
    )


def _compact_result(result: AgentResult) -> AgentResult:
    """硬截断过长字段，保证 influencer_profile_text ≤200 字。"""
    try:
        obj = json.loads(result.text)
    except json.JSONDecodeError:
        return result

    if isinstance(obj.get("influencer_profile_text"), str):
        text = obj["influencer_profile_text"].strip()
        if len(text) > _PROFILE_TEXT_MAX_LEN:
            obj["influencer_profile_text"] = text[:_PROFILE_TEXT_MAX_LEN]
            obj["_profile_text_truncated"] = True

    content = obj.get("content_style")
    if isinstance(content, dict):
        for key, limit in _FIELD_MAX.items():
            val = content.get(key)
            if isinstance(val, str) and len(val) > limit:
                content[key] = val[:limit]

    persona = obj.get("persona_positioning")
    if isinstance(persona, dict):
        summary = persona.get("summary")
        if isinstance(summary, str) and len(summary) > 30:
            persona["summary"] = summary[:30]

    return AgentResult(
        agent=result.agent,
        text=json.dumps(obj, ensure_ascii=False),
        model=result.model,
        usage=result.usage,
        raw=result.raw,
    )


def run_influencer_profiler(user_input: str) -> AgentResult:
    """TikHub 拉取达人数据 → 遍历视频逐个调 Doubao 多模态分析 → 用第一个成功结果。"""
    data = _merge_with_tikhub(_parse_input(user_input))
    video_urls: list[str] = data.get("video_urls") or []

    if not video_urls:
        raise ValueError("没有可以分析的视频")

    user_text = _build_text_payload(data)

    last_error: Optional[Exception] = None
    for i, video_url in enumerate(video_urls):
        try:
            logger.info("视频 %d/%d 分析中: %s", i + 1, len(video_urls), video_url[:80])
            result = run_video_analysis(
                agent_name=SPEC.name,
                system=SPEC.instructions,
                user_text=user_text,
                video_url=video_url,
                max_tokens=SPEC.max_tokens or 8192,
            )
            return _compact_result(_ensure_complete_json(result))
        except Exception as exc:
            last_error = exc
            logger.warning("视频 %d/%d 分析失败: %s", i + 1, len(video_urls), exc)
            continue

    raise RuntimeError(
        f"所有视频分析均失败（共 {len(video_urls)} 个），请稍后重试。"
        f"最后错误: {last_error}"
    )
