"""步骤 6-7 — 每个大纲写完整脚本 + 多维度评分。

输入：达人风格 JSON + 用户选中的大纲 + 素材库/历史数据库内容
输出：每个大纲的完整脚本 + 评分
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentSpec
from providers.llm import run_llm

logger = logging.getLogger(__name__)

SPEC = AgentSpec(
    name="script-writer",
    instructions="""你是一位顶尖的短视频脚本写手兼内容评分专家。

## 任务
为每个选中的大纲，撰写完整的短视频脚本，并按用户定义的 7 维度评分标准进行评分。

## 输入
1. 达人风格 JSON（7 维度，尤其关注"脚本生成指南"中的开头/中段/结尾约束、语态、用词风格）
2. 用户选中的大纲列表（每个含钩子、结构、情绪曲线、质检结果）
3. 网络素材库内容（含素材脚本文案、广告可借鉴点、内容方向等）
4. 历史投放数据（含脚本文案、播放量、转化是否达标等）

## 写稿要求
1. **完整脚本**：从第一句到最后一句，包含口播文案 + 画面/动作提示
2. **风格还原**：严格遵循达人的语态、用词习惯、节奏特点
3. **结构落地**：大纲中的每个段落都要在脚本中体现
4. **商业自然**：植入内容与内容本身无缝融合
5. **时长控制**：脚本总时长 60-90 秒（口播字数约 200-350 字）
6. **产品匹配**：脚本必须围绕素材库中的产品/主题展开（如度小满借贷相关），不能偏离

## 脚本格式
```
[画面：xxx]
（口播文案）

[画面：xxx]
（口播文案）
...
```

## 评分标准（7 维度，每维度 0-2 分，满分 14 分）

### 1. 开头吸引力度（0-2 分）
- **0 分**：看完前 3 秒就不想看了；和受众太遥远，不会有直接的利益相关，或者利益点大家不在乎
- **1 分**：看完前 3 秒有点好奇；有钩子但偏弱或延迟出现；和受众利益相关但受众较小或不觉得重要
- **2 分**：看完前 3 秒一定要看下去；强冲突/反常识/利益点直给，0 铺垫抓人；和受众利益息息相关

### 2. 创造需求准度（0-2 分）
场景内产生的问题和解决方案是否匹配，且匹配对应的场景卖点
- **0 分**：别的产品更能满足
- **1 分**：有好多个产品可以满足
- **2 分**：只有你这个产品可以满足

### 3. 达人匹配度（谁在说）（0-2 分）
- **0 分**：人设割裂——内容风格、语气、价值观与达人日常视频明显不符；像品牌方硬塞的广告文案
- **1 分**：形式贴合，内核生硬——使用了达人常用场景或口头禅，但产品植入突兀；逻辑和情绪不像真实分享
- **2 分**：人设融合，自然流露——产品作为解决方案从达人真实经历/观点中自然生长出来；去掉品牌名仍符合其内容主线

### 4. 创造需求速度（和钱相关，和个人相关）（0-2 分）
- **0 分**：【资金、工资、借贷】/【意外、门诊保险相关话题】等围绕钱的要素在 10s 后露出
- **1 分**：【资金、工资、借贷】/【意外、门诊保险相关话题】等围绕钱的要素 3-10s 后露出
- **2 分**：【资金、工资、借贷】/【意外、门诊保险相关话题】等围绕钱的要素前 3 秒露出

### 5. 植入逻辑链条（怎么说）（0-2 分）
- **0 分**：无铺垫，直接说"用 xx 产品"
- **1 分**：有痛点，但解决方案跳跃
- **2 分**：痛点 → 原则 → 标准 → 产品（完整链路）

### 6. 信息密度与节奏（0-2 分）
- **0 分**：多处 >3 秒信息真空，节奏拖沓断档，同义反复/废话多，核心观点被稀释
- **1 分**：存在 1-2 处平淡叙述，节奏平稳无亮点，核心清晰但夹杂过渡词或口语重复
- **2 分**：每 5-8 秒必有钩子/数据/金句/画面/情绪转折，零废话，每句承担明确功能

### 7. 剧情合理程度（如果是剧情号）（0-2 分）
每个角色的台词和表达内容是否符合该人设的利益点
- **0 分**：对白书面，行为不符合逻辑
- **1 分**：对白和行为略显瑕疵
- **2 分**：对白口语符合人设
- 注：非剧情号（纯口播/科普类）此维度默认 2 分

## 输出格式（严格 JSON）
```json
{
  "scripts": [
    {
      "outline_id": "1A",
      "outline_title": "大纲标题",
      "direction_title": "方向名称",
      "script": "完整脚本文案（含画面提示和口播）",
      "word_count": 280,
      "estimated_duration": "75s",
      "score": {
        "hook_appeal": 2,
        "demand_accuracy": 1,
        "influencer_fit": 2,
        "demand_speed": 2,
        "placement_logic": 1,
        "info_density": 2,
        "plot_rationality": 2,
        "total": 12,
        "total_max": 14
      },
      "score_notes": {
        "hook_appeal": "评分理由",
        "demand_accuracy": "评分理由",
        "influencer_fit": "评分理由",
        "demand_speed": "评分理由",
        "placement_logic": "评分理由",
        "info_density": "评分理由",
        "plot_rationality": "评分理由"
      },
      "style_fit_analysis": "脚本如何匹配达人风格的说明"
    }
  ]
}
```

## 约束
- 每个大纲产出 1 个完整脚本
- script 字段必须是完整可用的脚本文案，不要缩写
- 评分严格按上述标准，实事求是，不要全打满分
- total = 7 个维度分数之和，total_max 固定 14
- score_notes 中每个维度必须给出具体评分理由
- 只输出 JSON，不要其他文字
""",
    max_tokens=8192,
)


def run_script_writer(
    style_json: dict[str, Any],
    selected_outlines: list[dict[str, Any]],
    step2_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """步骤 6-7 主入口。

    Args:
        style_json: 达人风格 JSON
        selected_outlines: 用户选中的大纲列表
        step2_result: 步骤 2 的输出（含素材库/历史数据），用于提供产品上下文

    Returns:
        脚本 + 评分 JSON dict
    """
    logger.info("步骤 6: 为 %d 个大纲写脚本...", len(selected_outlines))

    user_text = _build_user_text(style_json, selected_outlines, step2_result)

    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=user_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.7,
    )

    return _parse_json(result.text)


def _build_user_text(
    style_json: dict,
    outlines: list[dict],
    step2_result: dict | None,
) -> str:
    parts: list[str] = []

    parts.append("## 达人风格 JSON\n")
    parts.append(json.dumps(style_json, ensure_ascii=False, indent=2))

    parts.append("\n\n## 用户选中的大纲\n")
    parts.append(json.dumps(outlines, ensure_ascii=False, indent=2))

    if step2_result:
        parts.append("\n\n## 网络素材库（产品/主题上下文，脚本必须围绕这些内容展开）\n")
        # 优先使用原始素材（含完整脚本文案），兜底用 LLM 匹配的摘要
        materials = step2_result.get("raw_materials") or step2_result.get("matched_materials", [])
        if materials:
            parts.append(json.dumps(materials, ensure_ascii=False, indent=2))
        else:
            parts.append("（无素材库数据）\n")

        parts.append("\n\n## 历史投放数据\n")
        history = step2_result.get("raw_history") or step2_result.get("matched_history", [])
        if history:
            parts.append(json.dumps(history, ensure_ascii=False, indent=2))
        else:
            parts.append("（无历史数据）\n")

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
