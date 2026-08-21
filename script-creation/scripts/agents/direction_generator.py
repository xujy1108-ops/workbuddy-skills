"""步骤 3 — 生成 5 个创意方向（内容标准约束版）。

输入：达人风格 JSON + 步骤 2 的原始创意
输出：5 个创意方向（含核心立意、叙事逻辑、情绪节奏）
流程：运行时实时拉取《内容标准》文档注入 prompt → LLM 生成 → 程序化校验淘汰违规方向
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentSpec
from agents.standard_guard import grand_narrative_hit, parse_chain_transitions
from config.settings import CONTENT_STANDARD_DOC_URL
from providers.llm import run_llm
from tools.feishu import fetch_doc_content

logger = logging.getLogger(__name__)

SPEC = AgentSpec(
    name="direction-generator",
    instructions="""你是一位资深的短视频内容策划总监。

## 任务
基于达人风格和原始创意种子，生成 5 个差异化的创意方向。

## 输入
1. 达人风格 JSON（7 维度）
2. 原始创意种子列表（步骤 2 产出）

## 内容标准（硬性约束，违反任一条的方向会被直接淘汰）
用户输入末尾附有《内容标准》文档全文（含正反案例），方向必须满足：

1. **切入方向**：必须**生活化/原生场景化**，和普通人息息相关、和钱息息相关。
   - **禁止宏大叙事切入**（历史事件、军事史、国际关系、名人轶事类比等）
   - **同样禁止古典民俗/典故切入**（民俗传说、古人故事、老祖宗规矩、俗语谚语等）
   - 唯一例外是时政热点，但也必须尽快落到"自己的钱"上
2. **转化链条**：从开头到广告植入的叙事逻辑**最多 1 次链条传动**，观众不能跟着多次跳跃
3. **铺垫转折**：植入前的铺垫要顺着内容逻辑链条，不能硬切

**特别注意**：即使达人是军事/历史/国际类账号，也**只能把其人设口吻作为表达风格**，切入必须是普通人的生活/钱场景。

## 要求
生成 5 个方向，每个方向必须：
- **差异化**：5 个方向在切入角度、情绪基调、叙事手法上各有不同
- **风格匹配**：与达人的风格定位、受众画像、流量逻辑高度契合
- **可执行**：方向足够具体，能指导后续大纲和脚本创作
- **符合内容标准**：见上方硬性约束

## 输出格式（严格 JSON）
```json
{
  "directions": [
    {
      "id": 1,
      "title": "方向名称（简短有力）",
      "core_thesis": "核心立意（这个方向要传达什么核心信息/价值观）",
      "entry_direction": "切入方向（从什么生活化场景/人群痛点切入，必须是普通人和钱的事）",
      "chain_transitions": 1,
      "narrative_logic": "叙事逻辑（信息如何组织、先后顺序、转折设计）",
      "emotion_rhythm": {
        "intent": "主题意图（想让观众感受到什么）",
        "curve": "情绪曲线描述（如：好奇→共鸣→冲击→释然，或 紧张→反转→爽感）"
      },
      "style_fit": "与达人风格的匹配说明（为什么这个方向适合这个达人）",
      "source_creatives": [1, 3]
    }
  ]
}
```

## 约束
- 必须 5 个方向
- chain_transitions 上限 1（叙事链条传动次数）
- source_creatives 引用步骤 2 中的 original_creatives id
- 每个字段 concise 有力，core_thesis 不超过 2 句话
- 只输出 JSON，不要其他文字
""",
    max_tokens=8192,
)


def run_direction_generator(
    style_json: dict[str, Any],
    step2_result: dict[str, Any],
) -> dict[str, Any]:
    """步骤 3 主入口。

    Args:
        style_json: influencer-style-analysis 输出的 7 维度风格 JSON
        step2_result: 步骤 2 的输出（含 original_creatives）

    Returns:
        5 个创意方向 JSON dict
    """
    logger.info("步骤 3: 生成 5 个创意方向...")

    content_standard = _load_content_standard()
    user_text = _build_user_text(style_json, step2_result, content_standard)

    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=user_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.8,
    )

    output = _parse_json(result.text)
    return _filter_violating_directions(output)


def _load_content_standard() -> str | None:
    """实时拉取《内容标准》文档，失败时降级为 None（不阻断流程）。"""
    try:
        text = fetch_doc_content(CONTENT_STANDARD_DOC_URL)
        logger.info("步骤 3: 已拉取内容标准文档（%d 字）", len(text))
        return text
    except Exception as e:  # noqa: BLE001
        logger.warning("步骤 3: 内容标准文档拉取失败，本次仅靠 prompt 内置约束: %s", e)
        return None


def _filter_violating_directions(output: dict[str, Any]) -> dict[str, Any]:
    """按内容标准程序化校验方向，淘汰违规项并重新编号。

    校验规则：
    - chain_transitions > 1 → 淘汰（转化链条超限）
    - title/core_thesis/entry_direction/narrative_logic 含宏大叙事/古典民俗关键词 → 淘汰
    """
    directions = output.get("directions", [])
    kept: list[dict] = []
    dropped: list[dict] = []

    for d in directions:
        reason = None
        ct = parse_chain_transitions(d.get("chain_transitions", "1"))
        if ct > 1:
            reason = f"转化链条 {ct} 次传动（上限 1 次）"
        else:
            hit = grand_narrative_hit(
                d.get("title", ""),
                d.get("core_thesis", ""),
                d.get("entry_direction", ""),
                d.get("narrative_logic", ""),
            )
            if hit:
                reason = f"疑似宏大叙事切入（关键词「{hit}」）"

        if reason:
            dropped.append({"title": d.get("title"), "reason": reason})
            logger.warning("内容标准校验淘汰: %s — %s", d.get("title"), reason)
        else:
            kept.append(d)

    for i, d in enumerate(kept, 1):
        d["id"] = i

    output["directions"] = kept
    output["standard_check_dropped"] = dropped
    if dropped:
        logger.warning("内容标准校验: 淘汰 %d 个方向，保留 %d 个", len(dropped), len(kept))
    return output


def _build_user_text(
    style_json: dict,
    step2_result: dict,
    content_standard: str | None = None,
) -> str:
    parts: list[str] = []

    parts.append("## 达人风格 JSON\n")
    parts.append(json.dumps(style_json, ensure_ascii=False, indent=2))

    parts.append("\n\n## 步骤 2 原始创意\n")
    creatives = step2_result.get("original_creatives", [])
    parts.append(json.dumps(creatives, ensure_ascii=False, indent=2))

    if content_standard:
        parts.append("\n\n## 《内容标准》文档全文（硬性约束，含正反案例）\n")
        parts.append(content_standard)

    return "".join(parts)


def _parse_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        start = 1
        end = len(lines) - 1
        for i, line in enumerate(lines[1:], 1):
            if line.strip().startswith("```"):
                end = i
                break
        text = "\n".join(lines[start:end])
    return json.loads(text)
