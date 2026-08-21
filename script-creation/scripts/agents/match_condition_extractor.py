"""步骤 2a — 依据《度小满-达人类型基础标准》判定达人类型。

输入：达人风格 JSON（influencer-style-analysis 输出）
输出：类型判定 JSON（primary_type 一级类型、secondary_type 二级类型）

标准文档：https://kwza968lz1u.feishu.cn/docx/Bt2wdpZmBo5Jk1xrfoxcAcoZnwe
固化版本：references/influencer-type-standard.md
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentSpec
from providers.llm import run_llm

logger = logging.getLogger(__name__)

# 达人类型标准（唯一合法枚举）：一级类型 -> 二级类型列表
TYPE_STANDARD: dict[str, list[str]] = {
    "财经": ["泛财经", "高价值", "小微企业主", "常规", "鸡汤"],
    "三农": ["三农美食", "三农建造"],
    "剧情": ["常规剧情", "剧情搞笑"],
}

# 二级类型 -> 历史库(头条)「达人类型」select 枚举映射
SECONDARY_TO_HISTORY_TYPES: dict[tuple[str, str], list[str]] = {
    ("财经", "泛财经"): ["财经"],
    ("财经", "高价值"): ["财经"],
    ("财经", "小微企业主"): ["财经"],
    ("财经", "常规"): ["财经"],
    ("财经", "鸡汤"): ["财经"],
    ("三农", "三农美食"): ["三农"],
    ("三农", "三农建造"): ["三农"],
    ("剧情", "常规剧情"): ["剧情"],
    ("剧情", "剧情搞笑"): ["剧情搞笑"],
}

SPEC = AgentSpec(
    name="influencer-type-classifier",
    instructions="""你是达人类型判定专家。任务：依据《度小满-达人类型基础标准》，判定达人属于哪个一级类型和二级类型。

## 类型标准（唯一合法枚举，禁止自创）

### 财经
- 泛财经：商业故事、个人财富、消费决策、搞钱思路、时政要闻、国内外热点等所有与"金钱""财富""商业活动"相关的点评，输出观点；**军事点评也算入泛财经**；方向可垂直但不涉及投资；方向也可以很广，任何时事要闻、小道新闻都要表达看法
- 高价值：主要讲投资（贵金属、二级市场投资即股票债券基金、房产、进出口等金融投资）；垂直赛道；政策分析、投资心得、市场洞察、投资产品推荐
- 小微企业主：自己必须是老板/合伙人，有自己的公司和业务；分析自己公司产业、吐槽或点评创业；创业 vlog
- 常规：真实借贷故事分享（借贷用途不是小微企业主方向）；全程教他人怎么拒绝借钱/怎么解决，干货分享，一定有解决方法
- 鸡汤：情感鸡汤类分享，无故事讲述，从情感共鸣切入，大概描述借贷场景（人情债、借钱难等），多用金句讲整体观点

### 三农
- 三农美食：围绕指定食材+剧情演绎，核心是把食材有爽感地做饭；人物出镜说话；场景在农村（含草原、窑洞等少数民族场景）或城乡结合部，场景多元化
- 三农建造：建造房子、家具、生活用具（泳池、猪圈等）手工内容；人物出镜口播；不单提某品牌；场景农村/野外/城市均可

### 剧情
- 常规剧情：1 分钟以上；多人（非一人分饰多角）演出；多场景；有人物关系、叙事结构、核心冲突；起因发展高潮结束完整；环环相扣
- 剧情搞笑：逻辑不严谨，可不到 1 分钟，无脑、耍丑、肢体动作搞笑；叙事可不用环环相扣，有万万没想到的转折

## 判定规则
1. 只依据达人风格 JSON 中的内容赛道、人设定位、内容形式、脚本风格等信息判定
2. 只能输出上述枚举中的组合；达人不属于任何类型时，输出 "未匹配" 并说明原因
3. 军事点评/军事杂谈类达人 → 财经-泛财经（标准明确定义）
4. 判定到二级类型；若两个二级都可能，选内容形式最契合的，并在 reason 中说明

## 输出格式（严格 JSON，无其他文字）
```json
{
  "primary_type": "财经",
  "secondary_type": "泛财经",
  "reason": "判定依据（2-3 句话，引用达人风格 JSON 中的关键证据）"
}
```
""",
    max_tokens=1024,
)


def run_match_condition_extractor(style_json: dict[str, Any]) -> dict[str, Any]:
    """判定达人类型。"""
    logger.info("步骤 2a: 依据达人类型标准判定类型...")
    user_text = (
        "## 达人风格 JSON\n"
        + json.dumps(style_json, ensure_ascii=False, indent=2)
    )
    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=user_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.1,
    )
    judgment = _parse_json(result.text)
    judgment.setdefault("primary_type", "")
    judgment.setdefault("secondary_type", "")
    judgment.setdefault("reason", "")

    primary = judgment["primary_type"]
    secondary = judgment["secondary_type"]
    # 校验枚举合法性
    if primary not in TYPE_STANDARD or secondary not in TYPE_STANDARD.get(primary, []):
        logger.warning(
            "类型判定超出标准枚举: %s-%s，视为未匹配", primary, secondary
        )
        judgment["primary_type"] = ""
        judgment["secondary_type"] = ""

    # 派生查询条件
    judgment["material_match_text"] = (
        f"达人类型：{judgment['primary_type']}-{judgment['secondary_type']}"
        if judgment["primary_type"] and judgment["secondary_type"]
        else ""
    )
    judgment["history_daren_types"] = SECONDARY_TO_HISTORY_TYPES.get(
        (judgment["primary_type"], judgment["secondary_type"]), []
    )
    logger.info(
        "类型判定: %s-%s | 素材匹配词=%s | 历史库类型=%s",
        judgment["primary_type"], judgment["secondary_type"],
        judgment["material_match_text"], judgment["history_daren_types"],
    )
    return judgment


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
