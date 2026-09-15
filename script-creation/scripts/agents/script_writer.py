"""步骤 6 — 写脚本 + 评分（SOP 文档驱动版，2026-09-09 改造）。

改造要点：
- 大纲步骤移除：directions → scripts 直通
- 写稿依据按 track 分线注入 SOP 文档（运行时实时拉取）：
  蹭热点方向 → 《度小满-脚本SOP-热点-V2》
  其他方向   → 《度小满-脚本SOP-非热点-V2》
- 评分依据：《度小满-口播脚本评分标准-V2》（第0条合规红线一票否决 + 8 维度各 0-2 分，满分 16）
- 产品上下文：方向自带的植入策略/叙事策略 + source_material_ids 现拉网络素材库
  （历史数据库、step2 依赖全部移除）

产出：完整口播逐字稿（含【模块·打法】标签，220-390 字 / 60-90s）+ 合规检查 + 8 维度评分。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentSpec
from config.settings import (
    SCORING_STANDARD_DOC_URL,
    SOP_HOTSPOT_DOC_URL,
    SOP_NONHOTSPOT_DOC_URL,
)
from providers.llm import run_llm
from tools.feishu import fetch_doc_content, fetch_materials_by_ids

logger = logging.getLogger(__name__)

_HOTSPOT_TRACK = "蹭热点"

_SPEC_COMMON_INSTRUCTIONS = """你是一位顶尖的短视频口播脚本写手兼内容评分专家，严格遵循度小满脚本 SOP 与评分标准工作。

## 任务
为每个选中的创意方向，产出可直接配音拍摄的**完整口播逐字稿**，并按《口播脚本评分标准》评分。

## 工作方式（严格按注入的 SOP 文档执行）
1. **先按 SOP 第三节"脚本生成推导流程"逐方向推导**：
   Step 0 加载达人风格定基调 → Step 1 定钩子类与打法 → Step 2 定转折打法+链路收口
   → Step 3 定度小满角色定位 → Step 4 套植入 SOP（场景触发→信任定调→反向对标→合规叠甲）
   → Step 5 选收尾叠加 → Step 6 对照检验机制自检
2. **产出物是逐字稿，不是要点**：按"钩子→承接→转折→植入→收尾"的功能顺序写满台词，
   每个模块开头用标签标注钩子类与所选打法（如【钩子·B1反常识观点】【热点承接·A政策翻译】），
   标签后紧跟成段台词，禁止只写要点。
3. **硬约束**：总时长 60-90 秒，字数 220-390 字（220-260 字/分钟）；
   钩子到植入叙事传动 ≤1 次；转折段收口必须落"普适选择原则 + 可验证标准"两件套；
   植入 4 步不可跳，反向对标的卖点必须与转折收口的标准一一咬合。
4. **达人口吻定基调**：创意/热点决定"讲什么"，达人风格决定"怎么讲"——
   严格执行达人风格 JSON 中的语速、语气、用词习惯、口头禅、视觉符号；
   是达人在解读热点/讲创意，不是念通稿。
5. **场景落位**：按方向的「场景」字段确定画面发生地（在哪拍、什么场合、几个人），
   逐字稿与场景相容——「对镜口播（无场景情节）」的方向不加剧情画面提示；
   带具体场景的方向（酒席饭桌/职场办公/户外街头等）按该场景写画面提示与情绪落点。
   关联素材的「场景+内容分析」只用于判断"这个方向在现实里长什么样"，
   不是要逐句复刻素材文案——话术由你按 SOP 重写。

## 评分（写完自评，严格按注入的《口播脚本评分标准》）
1. **第 0 条合规红线先行**：逐条检查红线清单，任何一条踩线 → compliance_check.passed=false
   并列出违规项（该脚本标记为需重写）。
2. 通过红线后按 **8 维度**评分（每维 0-2 分，满分 16）：
   ①开头吸引力（按脚本所用 A-D 类对应标准）②创造需求准度（删名测试）③达人匹配度
   （朗读去品牌名测试）④创造需求速度（按钩子类型时间窗）⑤植入逻辑链条
   （四步完整+传动≤1+铺垫顺滑三重校验）⑥信息密度与节奏（逐句功能标注）⑦切入方向
   （代入测试；蹭热点须第一段约10秒内落到个人利益）⑧收尾质量（替换测试）
3. 每个维度必须在 score_notes 中给出具体评分理由（引用脚本原文佐证）。

## 输出格式（严格 JSON，禁止 markdown 代码块包裹）
{
  "scripts": [
    {
      "direction_id": 1,
      "direction_title": "来源方向标题",
      "track": "蹭热点 或 其他方向",
      "hook_class": "钩子类（A/B/C/D）+ 打法（如 A1权威事件开场）",
      "title": "脚本标题",
      "script": "完整口播逐字稿（含【模块·打法】标签与成段台词）",
      "word_count": 300,
      "estimated_duration": "75s",
      "compliance_check": {"passed": true, "violations": []},
      "score": {
        "hook_appeal": 2,
        "demand_accuracy": 2,
        "influencer_fit": 2,
        "demand_speed": 2,
        "placement_logic": 1,
        "info_density": 2,
        "entry_direction": 2,
        "ending_quality": 2,
        "total": 15,
        "total_max": 16
      },
      "score_notes": {
        "hook_appeal": "评分理由",
        "demand_accuracy": "评分理由",
        "influencer_fit": "评分理由",
        "demand_speed": "评分理由",
        "placement_logic": "评分理由",
        "info_density": "评分理由",
        "entry_direction": "评分理由",
        "ending_quality": "评分理由"
      },
      "style_fit_analysis": "脚本如何匹配达人风格的说明（<=80字）"
    }
  ]
}

## 约束
- 每个方向产出 1 个完整脚本，script 字段必须是完整可拍摄逐字稿，不要缩写
- 评分实事求是，不要全打满分；不达标就如实扣分
- compliance_check 与 8 维度评分分开：红线是门槛，评分是质量
- 只输出 JSON，不要其他文字
"""

SPEC = AgentSpec(
    name="script-writer",
    instructions=_SPEC_COMMON_INSTRUCTIONS,
    max_tokens=16384,
)


def run_script_writer(
    style_json: dict[str, Any],
    selected_directions: list[dict[str, Any]],
) -> dict[str, Any]:
    """步骤 6 主入口（SOP 驱动版）。

    Args:
        style_json: 达人风格 JSON
        selected_directions: 用户选中的创意方向列表（directions 步骤输出的子集）

    Returns:
        脚本 + 评分 JSON dict
    """
    logger.info("步骤 6: 为 %d 个方向写脚本（SOP 驱动）...", len(selected_directions))

    # 1. 拉取 SOP 与评分标准文档（失败即报错：写稿依据缺失不应静默降级）
    sop_docs = _load_sop_docs()

    # 2. 反查网络素材库（方向的 source_material_ids）
    materials_by_direction = _fetch_direction_materials(selected_directions)

    # 3. 按 track 分线：蹭热点 → 热点 SOP；其他 → 非热点 SOP
    hotspot_dirs = [d for d in selected_directions if d.get("track") == _HOTSPOT_TRACK]
    other_dirs = [d for d in selected_directions if d.get("track") != _HOTSPOT_TRACK]
    logger.info("分线: 蹭热点 %d 个 / 其他方向 %d 个", len(hotspot_dirs), len(other_dirs))

    scripts: list[dict[str, Any]] = []
    if hotspot_dirs:
        scripts += _write_group(
            style_json, hotspot_dirs, sop_docs["hotspot"], sop_docs["scoring"],
            materials_by_direction,
        )
    if other_dirs:
        scripts += _write_group(
            style_json, other_dirs, sop_docs["nonhotspot"], sop_docs["scoring"],
            materials_by_direction,
        )

    # 按原始方向顺序排列
    order = {d.get("id"): i for i, d in enumerate(selected_directions)}
    scripts.sort(key=lambda s: order.get(s.get("direction_id"), 99))
    return {"scripts": scripts}


def _load_sop_docs() -> dict[str, str]:
    """拉取两套 SOP + 评分标准文档全文。"""
    docs: dict[str, str] = {}
    for key, url, name in [
        ("hotspot", SOP_HOTSPOT_DOC_URL, "脚本SOP-热点"),
        ("nonhotspot", SOP_NONHOTSPOT_DOC_URL, "脚本SOP-非热点"),
        ("scoring", SCORING_STANDARD_DOC_URL, "口播脚本评分标准"),
    ]:
        try:
            text = fetch_doc_content(url)
            docs[key] = text
            logger.info("已拉取《%s》（%d 字）", name, len(text))
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"拉取《{name}》失败（写稿依据缺失，不降级）: {e}") from e
    return docs


def _fetch_direction_materials(
    directions: list[dict[str, Any]],
) -> dict[int, list[dict]]:
    """按方向的 source_material_ids 反查网络素材库，作为写稿参照。"""
    result: dict[int, list[dict]] = {}
    for d in directions:
        ids = d.get("source_material_ids") or []
        if not ids:
            continue
        mats = fetch_materials_by_ids(ids)
        if mats:
            result[d.get("id")] = mats
            logger.info("方向 %s: 反查到 %d/%d 条素材", d.get("id"), len(mats), len(ids))
    return result


def _write_group(
    style_json: dict[str, Any],
    directions: list[dict[str, Any]],
    sop_text: str,
    scoring_text: str,
    materials_by_direction: dict[int, list[dict]],
) -> list[dict[str, Any]]:
    """同一 track 的一组方向，注入对应 SOP，一次 LLM 调用产出。"""

    def slim_direction(d: dict) -> dict:
        did = d.get("id")
        mats = materials_by_direction.get(did, [])
        return {
            "id": did,
            "title": d.get("title"),
            "track": d.get("track"),
            "hotspot_id": d.get("hotspot_id") or "",
            "内容方向定义": d.get("content_direction"),
            "场景": d.get("scene") or "",
            "植入策略": d.get("implant_strategy"),
            "适合达人": d.get("suitable_influencer"),
            "叙事策略": d.get("narrative_strategy") or "",
            "source_material_ids": d.get("source_material_ids") or [],
            "关联素材（场景+内容分析+可借鉴点）": [
                {
                    "素材id": m.get("素材id"),
                    "场景": m.get("场景") or "",
                    "内容分析": (m.get("内容分析") or "")[:800],
                    "广告可借鉴点": (m.get("广告可借鉴点") or "")[:800],
                }
                for m in mats
            ],
            "风格适配说明": d.get("style_fit"),
        }

    user_text = json.dumps({
        "达人风格": style_json,
        "选中的创意方向": [slim_direction(d) for d in directions],
        "组织要求": "每个方向产出 1 个完整口播逐字稿 + 合规检查 + 8 维度评分",
    }, ensure_ascii=False, indent=2)

    full_text = (
        f"{user_text}\n\n"
        f"## 脚本 SOP 文档全文（硬性依据，按推导流程执行）\n{sop_text}\n\n"
        f"## 《口播脚本评分标准》全文（评分依据）\n{scoring_text}"
    )

    result = run_llm(
        agent_name=SPEC.name,
        system=SPEC.instructions,
        user_text=full_text,
        max_tokens=SPEC.max_tokens,
        temperature=0.7,
    )
    parsed = _parse_json(result.text)
    return parsed.get("scripts", [])


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
