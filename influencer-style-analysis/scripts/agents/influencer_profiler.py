"""达人风格识别：TikHub 拉取抖音数据 + Doubao 多模态看视频分析。"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional

from agents.base import AgentResult, AgentSpec
from providers.multimodal import run_text_analysis, run_video_analysis
from tools.tikhub import fetch_influencer_from_douyin

logger = logging.getLogger(__name__)

# ── 系统 Prompt ──────────────────────────────────────────────

_SYSTEM_PROMPT = """# Role
你是一位资深的短视频达人拆解专家与 AI 脚本工程师。你的任务是深度剖析达人的人设、受众、多模态风格、流量密码与商业逻辑，并输出高度结构化的分析结果，以直接赋能下游的 AI 脚本生成与商业评估。

# Guidelines
1. **拒绝僵化标签**：禁止使用"亲切唠嗑"、"朴实接地气"等空泛的枚举标签。必须使用**动态的语言描述**达人的语速节奏、情绪基调和视觉符号。
2. **解耦流量与商业**：严格区分"流量互动逻辑"（如何骗赞、骗评论）与"商业变现逻辑"（如何接商单、建信任）。禁止将两者混淆（例如：不要把"讲五代机"当成"卖五代机"的转化钩子）。
3. **克制推断边界**：基于提供的视频样本进行分析。如果是单视频，重点提取"内容结构公式"和"潜在信任机制"，不要过度推断具体的商单转化率或强行适配不相关的品类。
4. **多模态视角**：不仅要分析文本和语速，必须提取画面中的标志性视觉元素（如穿搭、道具、机位、特效）。
5. **严格遵循格式**：输出必须且只能是一个合法的 JSON 对象，严格遵循下方的 `_OUTPUT_SCHEMA`，不要输出任何额外的解释性文字。

# 输入说明
- 用户消息为 JSON 文本，包含 `bio`（达人简介）和 `nickname`（达人昵称）。
- 附带视频链接，请**直接看视频**分析口吻、语气、语速、情绪、画面风格、视觉元素，**不要**逐字复述口播稿。

# _OUTPUT_SCHEMA
{
  "basic_positioning": {
    "nickname": "达人昵称",
    "": "达人类型，这个类型需要给到"
    "core_persona": "人设一句话总结，需突出差异化与记忆点，<=40字",
    "content_tracks": [
      "核心赛道1（<=10字）",
      "核心赛道2（<=10字）"
    ]
  },
  "audience_insight": {
    "demographic": "人口统计学特征，如'25-45岁一二线男性'，<=20字",
    "psychological_needs": "受众心理诉求与痛点，如'渴望专业解读以获取社交谈资，缓解信息焦虑'，<=50字"
  },
  "multimodal_style": {
    "verbal_pace": "语速动态描述，而非单一静态标签。如'整体中等，铺垫时平稳，抛出反常识结论时突然加速并加重语气'，<=40字",
    "tone_and_emotion": "语气与情绪基调，如'专业自信、略带犀利、不卑不亢'，<=20字",
    "visual_symbols": "标志性视觉/听觉元素，如'固定机位、深色背景、手持实物道具、标志性手势'，<=50字",
    "style_tags": [
      "开放式提取的风格标签1（如：硬核拆解）",
      "开放式提取的风格标签2（如：降维打击）"
    ]
  },
  "traffic_logic": {
    "hook_strategy": "流量互动策略：开头如何3秒抓眼球（保完播），结尾如何留白引导互动（保评论），<=50字"
  },
  "commercial_logic": {
    "trust_builder": "信任构建机制，如'引用详实数据、拆解底层逻辑、展现行业 insider 视角'，<=40字",
    "brand_fit": [
      "适配的商业品类1",
      "适配的商业品类2"
    ],
    "placement_style": "商单植入风格约束，如'必须采用硬核参数拆解式植入，禁止叫卖式话术'，<=50字"
  },
  "taboos_and_risks": [
    "内容红线或掉粉点1（如：无数据支撑的地摊文学）",
    "内容红线或掉粉点2（如：过度情绪化消解专业底色）"
  ],
  "ai_scripting_guide": "供下游 LLM 生成脚本的结构化指令。必须分点说明：1. 开头约束；2. 中段行文与节奏约束；3. 结尾约束。整体风格需呼应前文分析，<=300字"
}

# 数组数量上限
- content_tracks: 2-3 个
- style_tags: 2-4 个
- brand_fit: 最多 3 个
- taboos_and_risks: 2-3 条

# 输出格式约束
使用简体中文。只输出一个合法的 JSON 对象，**禁止**用 ```json 或 ``` 包裹，禁止输出任何解释性文字。"""

SPEC = AgentSpec(
    name="influencer_profiler",
    description="识别达人风格：TikHub 拉取抖音主页 + Doubao 多模态看视频",
    instructions=_SYSTEM_PROMPT,
    max_tokens=8192,
)

# ── 合并 Prompt ───────────────────────────────────────────────

_MERGE_SYSTEM_PROMPT = """# Role
你是一位资深的短视频达人拆解专家。同一个达人的多个视频已分别完成风格分析，现在需要你综合所有分析结果，归纳出一份最终的风格画像。

# Guidelines
1. **拒绝僵化标签**：合并 style_tags 时，从所有分析结果中选取最有代表性、最精准的标签，而非简单取并集。
2. **解耦流量与商业**：合并时严格保持"流量互动逻辑"与"商业变现逻辑"的分离。
3. **多视频优先共识**：当多个视频分析出现分歧时，以多数共识为准；若分歧较大，取最具代表性的方向。
4. **严格遵循格式**：输出必须且只能是一个合法的 JSON 对象，严格遵循下方的 `_OUTPUT_SCHEMA`。

# _OUTPUT_SCHEMA
{
  "basic_positioning": {
    "nickname": "达人昵称",
    "core_persona": "人设一句话总结，需突出差异化与记忆点，<=40字",
    "content_tracks": [
      "核心赛道1（<=10字）",
      "核心赛道2（<=10字）"
    ]
  },
  "audience_insight": {
    "demographic": "人口统计学特征，如'25-45岁一二线男性'，<=20字",
    "psychological_needs": "受众心理诉求与痛点，<=50字"
  },
  "multimodal_style": {
    "verbal_pace": "语速动态描述，<=40字",
    "tone_and_emotion": "语气与情绪基调，<=20字",
    "visual_symbols": "标志性视觉/听觉元素，<=50字",
    "style_tags": ["开放式提取的风格标签", "2-4个"]
  },
  "traffic_logic": {
    "hook_strategy": "流量互动策略，<=50字"
  },
  "commercial_logic": {
    "trust_builder": "信任构建机制，<=40字",
    "brand_fit": ["适配的商业品类", "最多3个"],
    "placement_style": "商单植入风格约束，<=50字"
  },
  "taboos_and_risks": ["内容红线或掉粉点", "2-3条"],
  "ai_scripting_guide": "供下游 LLM 生成脚本的结构化指令，分点说明1.开头约束 2.中段行文 3.结尾约束，<=300字"
}

# 数组数量上限
- content_tracks: 2-3 个
- style_tags: 2-4 个
- brand_fit: 最多 3 个
- taboos_and_risks: 2-3 条

# 输出格式约束
使用简体中文。只输出一个合法的 JSON 对象，**禁止**用 ```json 或 ``` 包裹，禁止输出任何解释性文字。"""

# ── 字段长度限制（用于 _compact_result 硬截断）─────────────────

_STRING_FIELD_LIMITS: dict[str, int] = {
    "basic_positioning.core_persona": 40,
    "audience_insight.demographic": 20,
    "audience_insight.psychological_needs": 50,
    "multimodal_style.verbal_pace": 40,
    "multimodal_style.tone_and_emotion": 20,
    "multimodal_style.visual_symbols": 50,
    "traffic_logic.hook_strategy": 50,
    "commercial_logic.trust_builder": 40,
    "commercial_logic.placement_style": 50,
    "ai_scripting_guide": 300,
}

_ARRAY_FIELD_LIMITS: dict[str, int] = {
    "basic_positioning.content_tracks": 3,
    "multimodal_style.style_tags": 4,
    "commercial_logic.brand_fit": 3,
    "taboos_and_risks": 3,
}


# ── 输入解析 ──────────────────────────────────────────────────


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
    """构建发给 LLM 的用户消息 JSON 文本。"""
    nickname = ""
    if data.get("_tikhub_meta"):
        nickname = data["_tikhub_meta"].get("author_nickname") or ""

    payload: dict[str, Any] = {
        "nickname": nickname,
        "bio": data.get("bio") or "",
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


# ── 结果校验与截断 ────────────────────────────────────────────


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


def _truncate_string(obj: dict[str, Any], path: str, limit: int) -> None:
    """按 dotted path 截断字符串字段。"""
    keys = path.split(".")
    target = obj
    for k in keys[:-1]:
        if not isinstance(target, dict):
            return
        target = target.get(k)  # type: ignore
        if not isinstance(target, dict):
            return
    key = keys[-1]
    val = target.get(key)
    if isinstance(val, str) and len(val) > limit:
        target[key] = val[:limit]


def _truncate_array(obj: dict[str, Any], path: str, limit: int) -> None:
    """按 dotted path 截断数组字段。"""
    keys = path.split(".")
    target = obj
    for k in keys[:-1]:
        if not isinstance(target, dict):
            return
        target = target.get(k)  # type: ignore
        if not isinstance(target, dict):
            return
    key = keys[-1]
    val = target.get(key)
    if isinstance(val, list) and len(val) > limit:
        target[key] = val[:limit]


def _compact_result(result: AgentResult) -> AgentResult:
    """硬截断过长字段，保证各字段不超限。"""
    try:
        obj = json.loads(result.text)
    except json.JSONDecodeError:
        return result

    if not isinstance(obj, dict):
        return result

    for path, limit in _STRING_FIELD_LIMITS.items():
        _truncate_string(obj, path, limit)

    for path, limit in _ARRAY_FIELD_LIMITS.items():
        _truncate_array(obj, path, limit)

    return AgentResult(
        agent=result.agent,
        text=json.dumps(obj, ensure_ascii=False),
        model=result.model,
        usage=result.usage,
        raw=result.raw,
    )


# ── 合并 ──────────────────────────────────────────────────────


def _merge_multiple_analyses(
    results: list[AgentResult], bio: str, nickname: str, meta: dict[str, Any]
) -> AgentResult:
    """将多次视频分析结果通过 LLM 二次合并为最终 JSON。"""
    analyses_text: list[str] = []
    for i, r in enumerate(results):
        analyses_text.append(f"### 视频 {i + 1} 分析结果\n{r.text}")

    merge_input = json.dumps(
        {
            "nickname": nickname,
            "bio": bio,
            "video_count": len(results),
            "analyses": "\n\n".join(analyses_text),
            "data_source": meta,
            "note": "请综合以上多个视频的分析结果，合并为一份最终的风格画像 JSON。",
        },
        ensure_ascii=False,
        indent=2,
    )

    result = run_text_analysis(
        agent_name=SPEC.name,
        system=_MERGE_SYSTEM_PROMPT,
        user_text=merge_input,
        max_tokens=SPEC.max_tokens or 8192,
    )
    return _compact_result(_ensure_complete_json(result))


# ── 单视频分析（用于并行）──────────────────────────────────────


def _analyze_one_video(
    video_url: str, index: int, total: int, user_text: str
) -> tuple[int, Optional[AgentResult], Optional[Exception]]:
    """分析单个视频，返回 (index, result_or_None, error_or_None)。"""
    try:
        logger.info("视频 %d/%d 分析中: %s", index + 1, total, video_url[:80])
        result = run_video_analysis(
            agent_name=SPEC.name,
            system=SPEC.instructions,
            user_text=user_text,
            video_url=video_url,
            max_tokens=SPEC.max_tokens or 8192,
        )
        validated = _compact_result(_ensure_complete_json(result))
        logger.info("视频 %d/%d 分析成功", index + 1, total)
        return (index, validated, None)
    except Exception as exc:
        logger.warning("视频 %d/%d 分析失败: %s", index + 1, total, exc)
        return (index, None, exc)


# ── 主入口 ────────────────────────────────────────────────────


def run_influencer_profiler(user_input: str) -> AgentResult:
    """TikHub 拉取达人数据 -> 并行调 Doubao 多模态分析所有视频 -> LLM 二次合并。"""
    data = _merge_with_tikhub(_parse_input(user_input))
    video_urls: list[str] = data.get("video_urls") or []

    if not video_urls:
        raise ValueError("没有可以分析的视频")

    user_text = _build_text_payload(data)
    total = len(video_urls)

    # 并行分析所有视频
    with ThreadPoolExecutor(max_workers=total) as executor:
        futures = [
            executor.submit(_analyze_one_video, url, i, total, user_text)
            for i, url in enumerate(video_urls)
        ]
        indexed_results: list[tuple[int, Optional[AgentResult], Optional[Exception]]] = []
        for future in as_completed(futures):
            indexed_results.append(future.result())

    # 按原始索引排序，收集成功结果
    indexed_results.sort(key=lambda x: x[0])
    success_results: list[AgentResult] = []
    last_error: Optional[Exception] = None

    for _, result, error in indexed_results:
        if result is not None:
            success_results.append(result)
        if error is not None:
            last_error = error

    if not success_results:
        raise RuntimeError(
            f"所有视频分析均失败（共 {total} 个），请稍后重试。"
            f"最后错误: {last_error}"
        )

    if len(success_results) == 1:
        return success_results[0]

    nickname = ""
    if data.get("_tikhub_meta"):
        nickname = data["_tikhub_meta"].get("author_nickname") or ""

    logger.info("合并 %d 个视频分析结果...", len(success_results))
    return _merge_multiple_analyses(
        results=success_results,
        bio=data.get("bio") or "",
        nickname=nickname,
        meta=data.get("_tikhub_meta") or {},
    )
