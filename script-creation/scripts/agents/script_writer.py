"""步骤 6 — 写脚本 + 生成期自检（SOP + 策略库驱动版，2026-09-15 评分口径重构）。

改造要点：
- 大纲步骤移除：directions → scripts 直通
- 写稿依据按 track 分线注入文档（运行时实时拉取，文档更新即时生效，代码不缓存）：
  蹭热点方向 → 品牌配置的 脚本SOP-热点 + 策略库-热点
  其他方向   → 品牌配置的 脚本SOP-非热点 + 策略库-非热点
- 策略库为「方法与语料库」：SOP 顶部「素材取用流程」四步（库级定位→条目级选择→产出留痕→缺口兜底）
  的取用对象即策略库；库内档位承载台词公式、案例原句、角色定位等语料。
  2026-09-15 前只注入 SOP 不注入策略库 → 该四步流程成为死指令（SOP 正文里的链接 LLM 打不开），
  已修复；角色定位（SOP Step 3）此前整步缺失，现作为硬要求 + library_picks 留痕字段强制落地。
- **生成期不打分**（2026-09-15 口径，见评分标准「使用规则（先读这一节）」节）：
  写稿阶段只做两件事——① 红线一票否决（compliance_check）；② SOP 检验机制逐项 pass / fail（self_check）。
  ③达人匹配度／④创造需求速度／⑥信息密度与节奏 已前移为两份 SOP 的「生成期硬约束」：
  ④ 定类即绑时间窗、⑥ 逐句标功能并数过渡句、③ 只能前置"输入规格"（成稿后仍须朗读测试）。
  产出核验行 verification 留痕供复核，但不给 0/1/2 分。
  **0/1/2 的「预期分」只对人工修改后的版本打**，由人工填写 human_revision，
  连同改动位置／性质／幅度随脚本交付文档留存，供投放数据复盘归因——AI 初稿按 SOP 生成必然满分，
  自评没有区分度（球员兼裁判）。
- 产品上下文：方向自带的植入策略/叙事策略 + source_material_ids 现拉网络素材库
  （历史数据库、step2 依赖全部移除）

产出：完整口播逐字稿（含【模块·打法】标签，220-390 字 / 60-90s）+ 合规检查（pass/fail）
      + self_check（检验机制逐项 pass/fail）+ verification（核验行）
      + library_picks / material_gap（库内取用留痕）+ human_revision（固定 null，待人工填）。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agents.base import AgentSpec
from config.settings import (
    LIBRARY_HOTSPOT_DOC_URL,
    LIBRARY_NONHOTSPOT_DOC_URL,
    SCORING_STANDARD_DOC_URL,
    SOP_HOTSPOT_DOC_URL,
    SOP_NONHOTSPOT_DOC_URL,
    load_prompt,
)
from providers.llm import run_llm
from tools.feishu import fetch_doc_content, fetch_materials_by_ids

logger = logging.getLogger(__name__)

_HOTSPOT_TRACK = "蹭热点"
_ROLE_MODULE = "模块④角色定位"

_SPEC_COMMON_INSTRUCTIONS = load_prompt("script_writer.md")

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
    logger.info("步骤 6: 为 %d 个方向写脚本（SOP + 策略库驱动）...", len(selected_directions))

    # 1. 拉取 SOP、策略库与评分标准文档（失败即报错：写稿依据缺失不应静默降级）
    docs = _load_reference_docs()

    # 2. 反查网络素材库（方向的 source_material_ids）
    materials_by_direction = _fetch_direction_materials(selected_directions)

    # 3. 按 track 分线：蹭热点 → 热点 SOP + 策略库-热点；其他 → 非热点 SOP + 策略库-非热点
    hotspot_dirs = [d for d in selected_directions if d.get("track") == _HOTSPOT_TRACK]
    other_dirs = [d for d in selected_directions if d.get("track") != _HOTSPOT_TRACK]
    logger.info("分线: 蹭热点 %d 个 / 其他方向 %d 个", len(hotspot_dirs), len(other_dirs))

    scripts: list[dict[str, Any]] = []
    if hotspot_dirs:
        scripts += _write_group(
            style_json, hotspot_dirs, docs["hotspot"], docs["library_hotspot"],
            docs["scoring"], materials_by_direction,
        )
    if other_dirs:
        scripts += _write_group(
            style_json, other_dirs, docs["nonhotspot"], docs["library_nonhotspot"],
            docs["scoring"], materials_by_direction,
        )

    # 按原始方向顺序排列
    order = {d.get("id"): i for i, d in enumerate(selected_directions)}
    scripts.sort(key=lambda s: order.get(s.get("direction_id"), 99))

    # 4. 库内取用留痕自检（SOP「产出留痕」是否真的执行了）
    _check_library_trace(scripts)
    return {"scripts": scripts}


def _load_reference_docs() -> dict[str, str]:
    """拉取两套 SOP + 两套策略库 + 评分标准文档全文。

    每次运行实时拉取（不缓存、不落盘）→ 飞书文档更新后无需改代码，下次运行自动生效。
    """
    docs: dict[str, str] = {}
    for key, url, name in [
        ("hotspot", SOP_HOTSPOT_DOC_URL, "脚本SOP-热点"),
        ("nonhotspot", SOP_NONHOTSPOT_DOC_URL, "脚本SOP-非热点"),
        ("library_hotspot", LIBRARY_HOTSPOT_DOC_URL, "策略库-热点"),
        ("library_nonhotspot", LIBRARY_NONHOTSPOT_DOC_URL, "策略库-非热点"),
        ("scoring", SCORING_STANDARD_DOC_URL, "口播脚本评分标准"),
    ]:
        try:
            text = fetch_doc_content(url)
            docs[key] = text
            logger.info("已拉取《%s》（%d 字）", name, len(text))
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"拉取《{name}》失败（写稿依据缺失，不降级）: {e}") from e
    return docs


def _check_library_trace(scripts: list[dict[str, Any]]) -> None:
    """自检 SOP「产出留痕」执行情况：library_picks 与角色定位档位是否落地。

    SOP 要求输出「选中库内编号 + 命中理由」并写进脚本备注；漏了就只是警告，
    不阻断产出（脚本仍可用，但可据此判断是否需要重跑）。
    """
    if not scripts:
        return
    with_picks = [s for s in scripts if s.get("library_picks")]
    roles = [
        p
        for s in scripts
        for p in (s.get("library_picks") or [])
        if isinstance(p, dict) and p.get("module") == _ROLE_MODULE
    ]
    if len(with_picks) < len(scripts):
        missing = [s.get("direction_id") for s in scripts if not s.get("library_picks")]
        logger.warning(
            "库内取用留痕缺失：%d/%d 脚本无 library_picks（方向 %s）→ 未按 SOP「产出留痕」执行",
            len(scripts) - len(with_picks), len(scripts), missing,
        )
    gaps = [s.get("direction_id") for s in scripts if s.get("material_gap")]
    logger.info(
        "库内取用留痕：library_picks %d/%d ｜ 角色定位 %d/%d ｜ 素材缺口 %d 个%s",
        len(with_picks), len(scripts), len(roles), len(scripts), len(gaps),
        (f"（方向 {gaps}）" if gaps else ""),
    )


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
    library_text: str,
    scoring_text: str,
    materials_by_direction: dict[int, list[dict]],
) -> list[dict[str, Any]]:
    """同一 track 的一组方向，注入对应 SOP + 策略库 + 评分标准，一次 LLM 调用产出。"""

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
        "组织要求": (
            "每个方向产出 1 个完整口播逐字稿 + 合规检查（第0条红线一票否决）+ "
            "self_check（SOP 检验机制逐项 pass/fail，不打分）+ "
            "verification（核验行：钱要素首现位置／总字数／过渡句数／逐句功能标签串）+ "
            "library_picks（各模块库内编号与命中理由）+ material_gap + human_revision（固定 null）"
        ),
    }, ensure_ascii=False, indent=2)

    full_text = (
        f"{user_text}\n\n"
        f"## 脚本 SOP 文档全文（结构与打法依据，按推导流程执行）\n{sop_text}\n\n"
        f"## 策略库全文（方法与语料库；按 SOP 顶部「素材取用流程」四步取用库内档位，"
        f"编号须按库内各档「对应 SOP」字段反查，禁止按字母对齐）\n{library_text}\n\n"
        f"## 《口播脚本评分标准》全文（定义源 + 第0条红线依据；**生成期不打分**——"
        f"按该文档「使用规则（先读这一节）」节，写稿阶段只走 SOP 检验机制的 pass / fail）\n{scoring_text}"
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
