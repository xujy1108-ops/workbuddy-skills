"""达人风格识别：TikHub 拉取抖音数据 + 多模态大模型（qwen3-vl-plus）看视频分析。"""

from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional

from agents.base import AgentResult, AgentSpec
from providers.multimodal import run_text_analysis, run_video_analysis
from tools.tikhub import fetch_influencer_from_douyin

logger = logging.getLogger(__name__)

# ── 系统 Prompt ──────────────────────────────────────────────

_SYSTEM_PROMPT = """# Role
你是一位资深的短视频达人拆解专家与 AI 脚本工程师。你的任务是深度剖析达人的定位、受众与多模态风格，并输出高度结构化的分析结果，以直接赋能下游的 AI 脚本生成与达人匹配。

# Guidelines
1. **拒绝僵化标签**：禁止使用"亲切唠嗑"、"朴实接地气"等空泛的枚举标签。必须使用**动态的语言描述**达人的语速节奏、情绪基调和视觉符号。
2. **克制推断边界**：基于提供的视频样本进行分析。如果是单视频，重点提取"内容结构公式"，不要过度推断或强行适配不相关的品类。
3. **多模态视角**：不仅要分析文本和语速，必须提取画面中的标志性视觉元素（如穿搭、道具、机位、特效）。
4. **达人自身画像**：结合 bio 文本和视频可视化信息，推断达人的年龄区间、职业身份、外貌特征、讲话风格、资产层次。资产层次需综合判断：bio 中暗示收入水平或社会阶层的身份标签（职业头衔、创业/高管经历等）、视频中暴露的穿搭/座驾/居住环境等客观线索。不预设任何职业分类，只根据实际看到和读到的内容动态推断。只描述看到和读到的，不编造。
5. **职业身份必须区分证据等级**（career_identity 字段，下游策略匹配以此为硬门槛）：
   - status=「有明确证据」：仅限 bio 自述或视频口述中明确提及的职业/行业/经营/从业经历（如"bio自述开面馆""口述我跑货运十年"）
   - status=「有间接线索」：仅能从画面场景/道具/环境推断（如厨房后厨场景、工地环境），无口述佐证
   - status=「无法判断」：bio 与视频均无职业身份相关信息
   - 禁止编造职业经历；status 如实输出，宁可「无法判断」不可拔高。
6. **达人类型判定**：influencer_type 必须严格依据下方「达人类型标准列表」选取，格式为"一级-二级"（如"财经-泛财经"），不得自创类型。若达人不匹配任何标准类型，输出"无匹配-需补充"。
7. **人工补充信息优先级最高**：若输入 JSON 中携带 `manual_supplement`（用户人工补充），其内容**权威性高于你的推断**，处理规则：
   - `occupation`（达人职业）：原样采纳为职业身份，不得改写、不得用画面推断结果覆盖
   - `asset_level`（资产层次）：原样采纳，不得改写
   - `other`（其他补充）：其中与达人呈现相关的内容（如拍摄方式、出镜人数、机位、是否双人共说台词等）**必须体现在 `visual_symbols`、`appearance`、`speech_style` 等相应字段中**
8. **严格遵循格式**：输出必须且只能是一个合法的 JSON 对象，严格遵循下方的 `_OUTPUT_SCHEMA`，不要输出任何额外的解释性文字。

# 达人类型标准列表（判定 influencer_type 必须从此表选取，不得自创；无匹配则输出"无匹配-需补充"）

| 一级-二级 | 范围限定 |
|---|---|
| 财经-泛财经 | 商业故事/个人财富/消费决策/搞钱思路/时政要闻/国内外热点等与金钱财富商业相关的点评；军事点评也算泛财经；方向可垂直但不涉及投资；也可很广任何时事要闻 |
| 财经-高价值 | 主要讲投资（贵金属/股票债券基金/房产/进出口等金融投资）；垂直赛道；政策分析/投资心得/市场洞察/投资产品推荐 |
| 财经-小微企业主 | 自己是老板/合伙人，有自己的公司业务；日常分析公司产业/吐槽创业/创业vlog |
| 生活-民生 | 选题来自普通人正在经历但说不清楚的事，抓大众体感；落点永远是"你个人怎么办"；站普通打工人；经济落点占比≥60%；人设=平视过来人无权威包装 |
| 生活-人文杂谈 | 选题源是"人活不明白"的困惑（人际体感），钱只是偶发话题；落点是处世方法论或认知消遣（非金钱）；无阶层对抗性；观众对该账号无"金钱托付感" |
| 三农-三农美食 | 围绕指定食材展开，有剧情演绎，核心是有爽感的做饭；人物出镜说话；场景农村或城乡结合部，突出三农原生感 |
| 三农-三农建造 | 建造房子/家具/生活用具等手工内容，记录建造阶段或全程；人物出镜口播；不提单一品牌；场景农村/野外/城市 |
| 剧情-常规剧情 | 1分钟以上；多人多场景；有人物关系/叙事结构/核心冲突；叙事环环相扣 |
| 剧情-剧情搞笑 | 逻辑不严谨，可不到1分钟；无脑/耍丑/肢体搞笑；叙事可万万没想到转折 |

# 输入说明
- 用户消息为 JSON 文本，包含 `bio`（达人简介）和 `nickname`（达人昵称）。注意 bio 中的职业/身份信息是判断达人自身画像和资产层次的核心线索，不预设身份分类。
- 若消息中出现 `manual_supplement`，那是用户人工提供的补充信息（occupation 达人职业 / asset_level 资产层次 / other 其他补充），**一律以其为准**，不得用画面或 bio 推断结果覆盖。
- 附带视频链接，请**直接看视频**分析口吻、语气、语速、情绪、画面风格、视觉元素，**不要**逐字复述口播稿，但必须提取达人本人的外貌特征（年龄感、长相风格、穿搭层次）。

# _OUTPUT_SCHEMA
{
  "basic_positioning": {
    "nickname": "达人昵称",
    "influencer_type": "达人类型，格式'一级-二级'（如'财经-泛财经''生活-民生'），必须从上方标准列表选取；无匹配则输出'无匹配-需补充'，<=10字",
    "core_persona": "人设一句话总结，需突出差异化与记忆点，<=50字",
    "content_tracks": [
      "核心赛道1（<=10字）",
      "核心赛道2（<=10字）"
    ],
    "influencer_demographic": {
      "age_range": "年龄区间（如30-35岁），从面部特征、言行推断，<=10字",
      "gender": "男/女/未知",
      "occupation": "职业身份（结合bio和视频口述，如'前驻港部队退役，现自媒体'），<=30字",
      "career_identity": {
        "status": "有明确证据/有间接线索/无法判断（bio自述或口述明确提及职业/经营/从业经历=有明确证据；仅画面场景道具推断=有间接线索；两者皆无=无法判断）",
        "description": "职业经历描述（如'bio自述经营面馆5年'），无证据则写'未发现'，<=30字",
        "evidence": "判定依据（引用bio原文或口述内容，或注明画面线索），<=50字"
      },
      "appearance": "外貌与气质（如'正气硬朗，身姿挺拔''和蔼可亲，面部圆润'），<=25字",
      "speech_style": "讲话风格与外显特质（如'伶牙俐齿，逻辑清晰''温和慢条斯理''直爽犀利'），<=35字",
      "asset_level": "资产层次推断（高/中/一般），理由。结合bio身份暗示和视频客观线索，如'bio中身份暗示较高收入+视频穿搭简约'或'未发现任何资产线索，整体偏一般'，<=40字",
      "verbal_pace": "语速：整体快/中/慢 + 约字数/分 + 关键变化点。禁止'随情绪动态调整'这类无结论描述。如'整体偏慢（约150字/分），讲核心观点时略提速'，<=45字",
      "tone_and_emotion": "语气与情绪基调，如'专业自信、略带犀利、不卑不亢'，<=20字",
      "visual_symbols": "标志性视觉/听觉元素，如'固定机位、深色背景、手持实物道具、标志性手势'，<=50字",
      "style_tags": [
        "开放式提取的风格标签1（如：硬核拆解）",
        "开放式提取的风格标签2（如：降维打击）"
      ]
    }
  },
  "audience_insight": {
    "demographic": "人口统计学特征，如'25-45岁一二线男性'，<=20字",
    "psychological_needs": "受众心理诉求与痛点，如'渴望专业解读以获取社交谈资，缓解信息焦虑'，<=50字"
  }
}

# 数组数量上限
- content_tracks: 2-3 个
- influencer_demographic.style_tags: 2-4 个

# 输出格式约束
使用简体中文。只输出一个合法的 JSON 对象，**禁止**用 ```json 或 ``` 包裹，禁止输出任何解释性文字。"""

SPEC = AgentSpec(
    name="influencer_profiler",
    description="识别达人风格：TikHub 拉取抖音主页 + qwen3-vl-plus 多模态看视频",
    instructions=_SYSTEM_PROMPT,
    max_tokens=8192,
)

# ── 合并 Prompt ───────────────────────────────────────────────

_MERGE_SYSTEM_PROMPT = """# Role
你是一位资深的短视频达人拆解专家。同一个达人的多个视频已分别完成风格分析，现在需要你综合所有分析结果，归纳出一份最终的风格画像。

# Guidelines
1. **拒绝僵化标签**：合并 style_tags 时，从所有分析结果中选取最有代表性、最精准的标签，而非简单取并集。
2. **多视频优先共识**：当多个视频分析出现分歧时，以多数共识为准；若分歧较大，取最具代表性的方向。
3. **达人类型判定**：influencer_type 必须严格依据下方「达人类型标准列表」选取，格式"一级-二级"；多视频类型不一致时以多数共识为准；无匹配输出"无匹配-需补充"。
4. **career_identity 证据等级从严合并**：多视频结果中，status 取最保守值（有明确证据 > 有间接线索 > 无法判断，向下兼容）；仅当 bio 或任一视频口述明确提及职业/经营/从业经历才可标"有明确证据"，evidence 引用具体出处。
5. **人工补充信息优先级最高**：若输入中出现 `manual_supplement`（用户人工补充），其 occupation（达人职业）/ asset_level（资产层次）必须原样采纳，优先于所有视频分析结论；other（其他补充）中与达人呈现相关的内容（拍摄方式、出镜人数、机位等）必须体现在 `visual_symbols` / `appearance` / `speech_style` 中。
6. **严格遵循格式**：输出必须且只能是一个合法的 JSON 对象，严格遵循下方的 `_OUTPUT_SCHEMA`。

# 达人类型标准列表（判定 influencer_type 必须从此表选取，不得自创；无匹配则输出"无匹配-需补充"）

| 一级-二级 | 范围限定 |
|---|---|
| 财经-泛财经 | 商业故事/个人财富/消费决策/搞钱思路/时政要闻/国内外热点等与金钱财富商业相关的点评；军事点评也算泛财经；方向可垂直但不涉及投资；也可很广任何时事要闻 |
| 财经-高价值 | 主要讲投资（贵金属/股票债券基金/房产/进出口等金融投资）；垂直赛道；政策分析/投资心得/市场洞察/投资产品推荐 |
| 财经-小微企业主 | 自己是老板/合伙人，有自己的公司业务；日常分析公司产业/吐槽创业/创业vlog |
| 生活-民生 | 选题来自普通人正在经历但说不清楚的事，抓大众体感；落点永远是"你个人怎么办"；站普通打工人；经济落点占比≥60%；人设=平视过来人无权威包装 |
| 生活-人文杂谈 | 选题源是"人活不明白"的困惑（人际体感），钱只是偶发话题；落点是处世方法论或认知消遣（非金钱）；无阶层对抗性；观众对该账号无"金钱托付感" |
| 三农-三农美食 | 围绕指定食材展开，有剧情演绎，核心是有爽感的做饭；人物出镜说话；场景农村或城乡结合部，突出三农原生感 |
| 三农-三农建造 | 建造房子/家具/生活用具等手工内容，记录建造阶段或全程；人物出镜口播；不提单一品牌；场景农村/野外/城市 |
| 剧情-常规剧情 | 1分钟以上；多人多场景；有人物关系/叙事结构/核心冲突；叙事环环相扣 |
| 剧情-剧情搞笑 | 逻辑不严谨，可不到1分钟；无脑/耍丑/肢体搞笑；叙事可万万没想到转折 |

# _OUTPUT_SCHEMA
{
  "basic_positioning": {
    "nickname": "达人昵称",
    "influencer_type": "达人类型，格式'一级-二级'，必须从上方标准列表选取；无匹配则输出'无匹配-需补充'，<=10字",
    "core_persona": "人设一句话总结，需突出差异化与记忆点，<=50字",
    "content_tracks": [
      "核心赛道1（<=10字）",
      "核心赛道2（<=10字）"
    ],
    "influencer_demographic": {
      "age_range": "年龄区间，<=10字",
      "gender": "男/女/未知",
      "occupation": "职业身份，<=30字",
      "career_identity": {
        "status": "有明确证据/有间接线索/无法判断",
        "description": "职业经历描述，无证据则写'未发现'，<=30字",
        "evidence": "判定依据（引用bio原文或口述内容），<=50字"
      },
      "appearance": "外貌与气质，<=25字",
      "speech_style": "讲话风格，<=35字",
      "asset_level": "资产层次推断（高/中/一般）及理由，<=40字",
      "verbal_pace": "语速：整体快/中/慢 + 约字数/分 + 关键变化点，<=45字",
      "tone_and_emotion": "语气与情绪基调，<=20字",
      "visual_symbols": "标志性视觉/听觉元素，<=50字",
      "style_tags": ["开放式提取的风格标签", "2-4个"]
    }
  },
  "audience_insight": {
    "demographic": "人口统计学特征，如'25-45岁一二线男性'，<=20字",
    "psychological_needs": "受众心理诉求与痛点，<=50字"
  }
}

# 数组数量上限
- content_tracks: 2-3 个
- influencer_demographic.style_tags: 2-4 个

# 输出格式约束
使用简体中文。只输出一个合法的 JSON 对象，**禁止**用 ```json 或 ``` 包裹，禁止输出任何解释性文字。"""

# ── 字段长度限制（用于 _compact_result 硬截断）─────────────────

_STRING_FIELD_LIMITS: dict[str, int] = {
    "basic_positioning.core_persona": 50,
    "basic_positioning.influencer_type": 10,
    "basic_positioning.influencer_demographic.age_range": 10,
    "basic_positioning.influencer_demographic.occupation": 30,
    "basic_positioning.influencer_demographic.career_identity.status": 8,
    "basic_positioning.influencer_demographic.career_identity.description": 30,
    "basic_positioning.influencer_demographic.career_identity.evidence": 50,
    "basic_positioning.influencer_demographic.appearance": 25,
    "basic_positioning.influencer_demographic.speech_style": 35,
    "basic_positioning.influencer_demographic.asset_level": 40,
    "basic_positioning.influencer_demographic.verbal_pace": 45,
    "basic_positioning.influencer_demographic.tone_and_emotion": 20,
    "basic_positioning.influencer_demographic.visual_symbols": 50,
    "audience_insight.demographic": 20,
    "audience_insight.psychological_needs": 50,
}

_ARRAY_FIELD_LIMITS: dict[str, int] = {
    "basic_positioning.content_tracks": 3,
    "basic_positioning.influencer_demographic.style_tags": 4,
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


def _parse_manual_supplement(data: dict[str, Any]) -> dict[str, str]:
    """解析人工补充信息，模板固定三项：达人职业 / 资产层次 / 其他补充。

    支持三种写法：
    1. {"manual_supplement": {"occupation": "...", "asset_level": "...", "other": "..."}}
    2. {"manual_supplement": "拍摄方式：两人共说台词"}   # 纯文本 → 归入 other
    3. 扁平写法：manual_occupation / manual_asset_level / manual_other
    """
    result: dict[str, str] = {"occupation": "", "asset_level": "", "other": ""}

    raw = data.get("manual_supplement")
    if isinstance(raw, str):
        result["other"] = raw.strip()
    elif isinstance(raw, dict):
        for key in ("occupation", "asset_level", "other"):
            val = raw.get(key)
            if isinstance(val, str):
                result[key] = val.strip()

    for flat_key, target in (
        ("manual_occupation", "occupation"),
        ("manual_asset_level", "asset_level"),
        ("manual_other", "other"),
    ):
        val = data.get(flat_key)
        if isinstance(val, str) and val.strip() and not result[target]:
            result[target] = val.strip()

    return result


def _parse_input(user_input: str) -> dict[str, Any]:
    data = _coerce_input_dict(user_input)

    douyin_profile_url = (data.get("douyin_profile_url") or "").strip() or None
    sec_user_id = (data.get("sec_user_id") or "").strip() or None
    bio = (data.get("bio") or "").strip()
    manual_supplement = _parse_manual_supplement(data)

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
        "manual_supplement": manual_supplement,
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

    manual = data.get("manual_supplement") or {}
    if isinstance(manual, dict) and any(manual.values()):
        payload["manual_supplement"] = {
            k: v for k, v in manual.items() if v
        }

    return json.dumps(payload, ensure_ascii=False, indent=2)


def _apply_manual_supplement(
    result: AgentResult, manual: dict[str, str] | None
) -> AgentResult:
    """人工补充优先：程序化覆盖对应字段，不依赖模型自觉。

    - occupation        ← 人工达人职业（原样）
    - career_identity   ← status=有明确证据 / description=人工职业 / evidence=人工补充
    - asset_level       ← 人工资产层次（原样，加"人工补充："前缀便于溯源）
    - other             ← 追加到 visual_symbols（如拍摄方式/出镜人数/机位），保证不丢失
    """
    if not manual or not any(manual.values()):
        return result

    try:
        obj = json.loads(result.text)
    except json.JSONDecodeError:
        return result
    if not isinstance(obj, dict):
        return result

    bp = obj.setdefault("basic_positioning", {})
    if not isinstance(bp, dict):
        return result
    demo = bp.setdefault("influencer_demographic", {})
    if not isinstance(demo, dict):
        return result

    occupation = (manual.get("occupation") or "").strip()
    asset_level = (manual.get("asset_level") or "").strip()
    other = (manual.get("other") or "").strip()

    if occupation:
        demo["occupation"] = occupation
        demo["career_identity"] = {
            "status": "有明确证据",
            "description": occupation,
            "evidence": "人工补充（用户提供）",
        }

    if asset_level:
        demo["asset_level"] = (
            asset_level if asset_level.startswith("人工补充") else f"人工补充：{asset_level}"
        )

    if other:
        vs = (demo.get("visual_symbols") or "").strip()
        if other not in vs:
            demo["visual_symbols"] = f"{vs}；{other}" if vs else other

    logger.info(
        "已应用人工补充：occupation=%s / asset_level=%s / other=%s",
        occupation or "—", asset_level or "—", other or "—",
    )

    return AgentResult(
        agent=result.agent,
        text=json.dumps(obj, ensure_ascii=False),
        model=result.model,
        usage=result.usage,
        raw=result.raw,
    )


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


# 截断回退优先级：先句末标点，再子句标点
_PAUSE_LEVELS: tuple[str, ...] = ("。！？；", "，、,;：")
_ALL_PAUSES = "".join(_PAUSE_LEVELS)


def _smart_truncate(val: str, limit: int) -> str:
    """超长时回退到最近标点，避免把句子拦腰切断。

    1. 未超限 → 原样返回
    2. 截断点恰好落在标点上 → 直接收
    3. 优先回退到最近句末标点（。！？；），再退到子句标点（，、,;：）；
       但回退后不得少于 limit 的 60%（下限 8 字），否则视为"标点太远"，放弃回退
    4. 无可用标点 → 去掉末尾一字补省略号，既语义可知又不超限
    """
    if len(val) <= limit:
        return val

    head = val[:limit]
    if head[-1] in _ALL_PAUSES:
        return head

    floor = max(8, int(limit * 0.6))
    for pauses in _PAUSE_LEVELS:
        idx = max(head.rfind(p) for p in pauses)
        if idx + 1 >= floor:
            return head[: idx + 1]

    return head[: limit - 1] + "…"


def _truncate_string(obj: dict[str, Any], path: str, limit: int) -> None:
    """按 dotted path 截断字符串字段（标点感知，避免拦腰切句）。"""
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
        target[key] = _smart_truncate(val, limit)


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
    results: list[AgentResult],
    bio: str,
    nickname: str,
    meta: dict[str, Any],
    manual: dict[str, str] | None = None,
) -> AgentResult:
    """将多次视频分析结果通过 LLM 二次合并为最终 JSON。"""
    analyses_text: list[str] = []
    for i, r in enumerate(results):
        analyses_text.append(f"### 视频 {i + 1} 分析结果\n{r.text}")

    merge_payload: dict[str, Any] = {
        "nickname": nickname,
        "bio": bio,
        "video_count": len(results),
        "analyses": "\n\n".join(analyses_text),
        "data_source": meta,
        "note": "请综合以上多个视频的分析结果，合并为一份最终的风格画像 JSON。",
    }
    if manual and any(manual.values()):
        merge_payload["manual_supplement"] = {k: v for k, v in manual.items() if v}

    merge_input = json.dumps(merge_payload, ensure_ascii=False, indent=2)

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
    t0 = time.perf_counter()
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
        logger.info(
            "视频 %d/%d 分析成功，耗时 %.1fs",
            index + 1, total, time.perf_counter() - t0,
        )
        return (index, validated, None)
    except Exception as exc:
        logger.warning(
            "视频 %d/%d 分析失败（耗时 %.1fs）: %s",
            index + 1, total, time.perf_counter() - t0, exc,
        )
        return (index, None, exc)


# ── 主入口 ────────────────────────────────────────────────────


def run_influencer_profiler(user_input: str) -> AgentResult:
    """TikHub 拉取达人数据 -> 并行调多模态模型分析所有视频 -> LLM 二次合并。"""
    t_total = time.perf_counter()

    t0 = time.perf_counter()
    data = _merge_with_tikhub(_parse_input(user_input))
    t_tikhub = time.perf_counter() - t0
    logger.info("TikHub 拉取耗时 %.1fs", t_tikhub)

    video_urls: list[str] = data.get("video_urls") or []

    if not video_urls:
        raise ValueError("没有可以分析的视频")

    user_text = _build_text_payload(data)
    total = len(video_urls)

    # 并行分析所有视频（耗时取 wall-clock，视频之间并行）
    t0 = time.perf_counter()
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

    t_video = time.perf_counter() - t0

    if not success_results:
        raise RuntimeError(
            f"所有视频分析均失败（共 {total} 个），请稍后重试。"
            f"最后错误: {last_error}"
        )

    if len(success_results) == 1:
        logger.info(
            "总耗时 %.1fs（TikHub %.1fs / 视频分析 %.1fs / 单视频无合并）",
            time.perf_counter() - t_total, t_tikhub, t_video,
        )
        return _apply_manual_supplement(
            success_results[0], data.get("manual_supplement")
        )

    nickname = ""
    if data.get("_tikhub_meta"):
        nickname = data["_tikhub_meta"].get("author_nickname") or ""

    t_merge = time.perf_counter()
    logger.info("合并 %d 个视频分析结果...", len(success_results))
    merged = _merge_multiple_analyses(
        results=success_results,
        bio=data.get("bio") or "",
        nickname=nickname,
        meta=data.get("_tikhub_meta") or {},
        manual=data.get("manual_supplement"),
    )
    logger.info(
        "总耗时 %.1fs（TikHub %.1fs / 视频分析 %.1fs / 合并 %.1fs）",
        time.perf_counter() - t_total,
        t_tikhub,
        t_video,
        time.perf_counter() - t_merge,
    )
    return _apply_manual_supplement(merged, data.get("manual_supplement"))
