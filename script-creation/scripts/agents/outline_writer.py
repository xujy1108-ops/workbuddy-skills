"""步骤 5 — 每个创意方向生成 2 个大纲 + 模型质检（内容标准约束版）。

输入：达人风格 JSON + 用户选中的创意方向
输出：每个方向 2 个大纲（含钩子/痛点 + 动态脚本结构）+ 质检结果
流程：运行时实时拉取《内容标准》文档注入 prompt → LLM 生成 → 程序化校验淘汰违规大纲
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
    name="outline-writer",
    instructions="""你是一位资深短视频编剧兼内容质检专家。

## 任务
为每个选中的创意方向，生成 2 个差异化的任务大纲，并对每个大纲做模型质检。

## 输入
1. 达人风格 JSON（7 维度，尤其关注"脚本生成指南"维度）
2. 用户选中的创意方向列表（每个含核心立意、叙事逻辑、情绪节奏）

## 内容标准（硬性约束，违反任一条的大纲会被直接淘汰）
用户输入末尾附有《内容标准》文档全文（含正反案例），大纲必须满足：

1. **切入方向**：开头钩子必须**生活化/原生场景化**，和普通人、和钱息息相关。
   - **禁止宏大叙事开场**（历史事件、军事史、国际关系、名人轶事类比等）
   - **同样禁止古典民俗/典故开场**（民俗传说、古人故事、老祖宗规矩、俗语谚语等）
   - 唯一例外是时政热点，但也必须尽快落到"自己的钱"上
2. **转化链条**：从开头钩子到商业植入**最多 1 次叙事链条传动**，结构里不能出现多次话题跳跃
3. **铺垫转折**：商业植入前的铺垫段要顺着内容逻辑链条推进，"聊到借钱"必须显得自然，不能硬切

**特别注意**：即使达人是军事/历史/国际类账号，也**只能把其人设口吻作为表达风格**，开场必须是普通人的生活/钱场景。

## 大纲要求
每个方向产出 2 个大纲，2 个大纲必须：
- **差异化切入**：同一方向但不同的开头钩子、叙事节奏、情绪曲线实现
- **开放式钩子**：开头 3 秒必须抓住注意力（痛点/悬念/反差/共鸣）
- **动态脚本结构**：不套固定模板，根据内容和情绪需要灵活设计段落

## 大纲结构
每个大纲包含：
- 开头钩子（0-3s）：用什么方式抓住注意力
- 铺垫段（3-15s）：如何引入主题、建立语境
- 核心段（15-45s）：主要内容呈现，信息密度和情绪推进
- 商业植入点：在什么位置、以什么方式自然植入
- 收尾段（最后 5-10s）：如何收束、引导互动

## 质检维度（模型自检）
对每个大纲评分（1-10 分）：
1. **风格匹配度**：大纲是否符合达人的人设、语态、视觉风格
2. **方向一致性**：大纲是否准确传达了创意方向的核心立意
3. **钩子吸引力**：开头是否足够抓人
4. **情绪节奏**：情绪曲线是否有起伏、是否到位
5. **商业自然度**：植入是否生硬

## 输出格式（严格 JSON）
```json
{
  "outlines": [
    {
      "direction_id": 1,
      "direction_title": "方向名称",
      "outline_id": "1A",
      "outline_title": "大纲标题",
      "entry_direction": "切入方向（从什么生活化场景/人群痛点开场，必须是普通人和钱的事）",
      "chain_transitions": 1,
      "hook": {
        "type": "钩子类型（痛点/悬念/反差/共鸣/好奇）",
        "content": "开头钩子具体内容"
      },
      "structure": [
        {
          "segment": "开头钩子",
          "duration": "0-3s",
          "content": "具体内容描述",
          "emotion": "情绪标记"
        },
        {
          "segment": "铺垫",
          "duration": "3-15s",
          "content": "具体内容描述",
          "emotion": "情绪标记"
        },
        {
          "segment": "核心内容",
          "duration": "15-45s",
          "content": "具体内容描述",
          "emotion": "情绪标记"
        },
        {
          "segment": "商业植入",
          "duration": "嵌入位置",
          "content": "植入方式和内容",
          "emotion": "情绪标记"
        },
        {
          "segment": "收尾",
          "duration": "最后5-10s",
          "content": "收尾内容",
          "emotion": "情绪标记"
        }
      ],
      "emotion_curve": "情绪曲线描述（如：好奇→紧张→爽感→信任）",
      "qc": {
        "style_fit": 8,
        "direction_consistency": 9,
        "hook_appeal": 7,
        "emotion_rhythm": 8,
        "commercial_naturalness": 7,
        "overall": 7.8,
        "notes": "质检备注（优缺点简述）"
      }
    }
  ]
}
```

## 约束
- 每个方向必须 2 个大纲（outline_id 用 {direction_id}A 和 {direction_id}B）
- chain_transitions 上限 1（从开头到植入的叙事链条传动次数）
- structure 段落可根据内容灵活调整，不强制 5 段
- 质检分数实事求是，不要全打高分
- 只输出 JSON，不要其他文字
""",
    max_tokens=8192,
)


def run_outline_writer(
    style_json: dict[str, Any],
    selected_directions: list[dict[str, Any]],
) -> dict[str, Any]:
    """步骤 5 主入口。

    Args:
        style_json: 达人风格 JSON
        selected_directions: 用户选中的创意方向列表

    Returns:
        大纲 + 质检 JSON dict
    """
    logger.info("步骤 5: 为 %d 个方向生成大纲...", len(selected_directions))

    content_standard = _load_content_standard()
    user_text = _build_user_text(style_json, selected_directions, content_standard)

    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=user_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.7,
    )

    output = _parse_json(result.text)
    return _filter_violating_outlines(output)


def _load_content_standard() -> str | None:
    """实时拉取《内容标准》文档，失败时降级为 None（不阻断流程）。"""
    try:
        text = fetch_doc_content(CONTENT_STANDARD_DOC_URL)
        logger.info("步骤 5: 已拉取内容标准文档（%d 字）", len(text))
        return text
    except Exception as e:  # noqa: BLE001
        logger.warning("步骤 5: 内容标准文档拉取失败，本次仅靠 prompt 内置约束: %s", e)
        return None


def _filter_violating_outlines(output: dict[str, Any]) -> dict[str, Any]:
    """按内容标准程序化校验大纲，淘汰违规项。

    校验规则：
    - chain_transitions > 1 → 淘汰（转化链条超限）
    - 标题/切入/钩子/结构内容 含宏大叙事/古典民俗关键词 → 淘汰
    """
    outlines = output.get("outlines", [])
    kept: list[dict] = []
    dropped: list[dict] = []

    for o in outlines:
        reason = None
        ct = parse_chain_transitions(o.get("chain_transitions", "1"))
        if ct > 1:
            reason = f"转化链条 {ct} 次传动（上限 1 次）"
        else:
            structure_text = " ".join(
                seg.get("content", "") for seg in o.get("structure", []) if isinstance(seg, dict)
            )
            hook = o.get("hook", {})
            hook_content = hook.get("content", "") if isinstance(hook, dict) else str(hook)
            hit = grand_narrative_hit(
                o.get("outline_title", ""),
                o.get("entry_direction", ""),
                hook_content,
                structure_text,
            )
            if hit:
                reason = f"疑似宏大叙事切入（关键词「{hit}」）"

        if reason:
            dropped.append({"title": o.get("outline_title"), "reason": reason})
            logger.warning("内容标准校验淘汰: %s — %s", o.get("outline_title"), reason)
        else:
            kept.append(o)

    output["outlines"] = kept
    output["standard_check_dropped"] = dropped
    if dropped:
        logger.warning("内容标准校验: 淘汰 %d 个大纲，保留 %d 个", len(dropped), len(kept))
    return output


def _build_user_text(
    style_json: dict,
    directions: list[dict],
    content_standard: str | None = None,
) -> str:
    parts: list[str] = []

    parts.append("## 达人风格 JSON\n")
    parts.append(json.dumps(style_json, ensure_ascii=False, indent=2))

    parts.append("\n\n## 用户选中的创意方向\n")
    parts.append(json.dumps(directions, ensure_ascii=False, indent=2))

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
