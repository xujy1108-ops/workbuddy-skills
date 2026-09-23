"""步骤 6 — 写脚本 + 生成期自检（SOP + 策略库驱动版，2026-09-15 评分口径重构）。

改造要点：
- 大纲步骤移除：directions → scripts 直通
- 写稿依据按 track 分线注入文档（运行时实时拉取，文档更新即时生效，代码不缓存）：
  蹭热点方向 → 品牌配置的 脚本SOP-热点 + 策略库-热点
  其他方向   → 品牌配置的 脚本SOP-非热点 + 策略库-非热点
  两条线共用 → 口播脚本评分标准（定义源）+ 禁止红线（第 0 条唯一权威源，2026-09-18 接入）
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
- 2026-09-18 三处修复：
  ① 字数/时长口径从 prompt 移入品牌 config（scriptSpec）——此前 prompt 硬编码的是度小满口径
     （60-90s / 220-390 字，抄自度小满），写稿目标本身即错（微业贷实测产出 502-647 字 /
     折算 126-162 秒，超出当时的 90-120 秒目标）；
  ② 补传策略行原文（按方向的 strategy_record_id 反查策略表，取两字段）：
     「正向案例」——此前只有 LLM 转述的叙事策略摘要进入写稿上下文，已验证爆款原句整条丢失；
     「植入策略」——此前 direction_generate 授权"可精炼"，451 字原文被压成 51 字摘要（断点A），
     写稿拿不到具体卖点只能自造泛化话术；
  ③ 自检量化项改程序复算 program_check（字数、钱要素位置、品牌名出现次数），
     超出品牌配置的区间／位置窗时把对应 self_check 项翻 fail——此前核验行由写稿模型自报、
     无人复算（运动员兼裁判）；同时移除删名测试（name_removal，用户 2026-09-18 判定无意义）。
     翻键规则 2026-09-20 修正：按异常类型翻（word_count→density／money→speed／brand→placement_chain），
     「模型自报字数与复算不符」只记 fail_items、不翻键（原按文案关键词匹配，会连带误翻 density）。
- 2026-09-23 钩子质量与检验前置（三处）：⑦ 新增钩子磨损句式黑名单 + 钩子三问留痕 + ≥3 版候选
     （程序拦截进 _program_check，写稿约束进 _write_group prompt，清单 hook_ban_phrases.json）；
  ⑧ originality 加程序兜底：与正向案例 LCS ≥12 字程序复算翻 fail（此前自检错判 pass 无拦截）；
  ⑨ 新增 _build_constraint_card 生成「生成期硬约束卡」前置 prompt 顶部——SOP 检验机制虽已随全文
     注入，但被模型当"事后考试"而非"写稿规格"（2026-09-22/23 微业贷两稿复盘：规则提前、计算留后）；
     卡片与 _program_check 从同一批常量/config 生成，阈值改代码卡片自动同步，永不漂移。
     热点 SOP 已同步写入「钩子三问」节与检验机制新增项（非热点 SOP 待同步）。
- 2026-09-18 追加两处：
  ④ 时长/字数口径放宽（用户定，每次均同步 config + 飞书三份文档）：
     2026-09-18 上限 120→180 秒、520→780 字；2026-09-19 下限 90→60 秒、330→220 字。
     现微业贷 60-180 秒 / 220-780 字（下限 60 秒 × 字速下限 220 字/分 = 220 字，字速未变）；
  ⑤ 断点A：策略行「植入策略」不再经 LLM 精炼——写稿侧程序反查原文注入
     （_fetch_strategy_originals 一次拉表取「正向案例」+「植入策略」两字段）。
  ⑥ 接入《禁止红线》文档（断点B，两品牌同步）：5 份文档（SOP×2／策略库×2／评分标准）的
     「第0条合规红线」全部指向品牌私有《禁止红线》，但它从未进 config.docs、也从未注入——
     写稿侧只拿得到 SOP 里的一行摘要（如"A1 禁止「网贷 vs 银行」对比叙事"），
     一票否决 10 条细则、豁免与背书登记、口径表（产品表述唯一合法来源）、投放审核口径
     全部不可达。修复后 _load_reference_docs 增拉一份、_write_group 注入全文并声明
     「本文与 SOP／评分标准冲突时以本文为准」；红线文档拉取失败即报错不降级。

- 2026-09-23 钩子质量机制（起因：两篇微业贷脚本人工复盘——初稿钩子照搬库内案例原句、
  修订稿钩子"宣言式开场"形式全 pass 但观众没兴趣看）：
  ⑦ 写稿侧「钩子三问」硬约束：动笔前必须留痕 hook_rationale（①前3秒观众看到什么画面
     ②靠什么拽住人·开放式机制不限类别 ③观众心里升起的、后文会回答的具体问题），
     且钩子至少出 3 版不同机制候选（hook_candidates）择优进正文；
  ⑧ 检验侧三道程序拦截（_program_check）：
     a. 磨损句式扫描——钩子段命中 agents/hook_ban_phrases.json 任一模式 → self_check.hook=fail
        （清单只收磨损模板与 retention 话术，不收库内正式打法的台词公式；持续追加）；
     b. hook_rationale 三问缺一或空 → self_check.hook=fail（程序验存在性，质量由人工复盘核对）；
     c. 与正向案例最长连续重合 ≥12 字 → self_check.originality=fail（程序复算 LCS，
        2026-09-22 模型自检 originality 错判 pass 的兜底）；库内案例查重由写稿自检项
        originality_library 承担（库全文已注入，程序无法在生成期拿到案例句清单）。

产出：完整口播逐字稿（含【模块·打法】标签，字数/时长按品牌 config 的 scriptSpec）
      + 合规检查（pass/fail）+ self_check（检验机制逐项 pass/fail）
      + verification（核验行）+ program_check（程序复算）
      + library_picks / material_gap（库内取用留痕）+ human_revision（固定 null，待人工填）。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from agents.base import AgentSpec
from config.settings import (
    BRAND_NAME,
    LIBRARY_HOTSPOT_DOC_URL,
    LIBRARY_NONHOTSPOT_DOC_URL,
    REDLINE_DOC_URL,
    SCORING_STANDARD_DOC_URL,
    SCRIPT_CHARS_PER_MINUTE,
    SCRIPT_MONEY_WINDOW,
    SCRIPT_WORD_COUNT_MAX,
    SCRIPT_WORD_COUNT_MIN,
    SOP_HOTSPOT_DOC_URL,
    SOP_NONHOTSPOT_DOC_URL,
    load_prompt,
)
from providers.llm import run_llm
from tools.feishu import fetch_doc_content, fetch_materials_by_ids, fetch_strategy_table

logger = logging.getLogger(__name__)

_HOTSPOT_TRACK = "蹭热点"
_ROLE_MODULE = "模块④角色定位"

# 钱要素（④）相关词：用于程序复算「钱要素首现位置」
# _MONEY_KEYWORDS = 硬要素（利率/额度/期限/价格类）→ 参与时间窗判定
# _MONEY_WEAK = 泛化表达（融资/资金/现金流…）→ 不参与时间窗，但"只有泛化表达"要提示
#   （借贷类脚本钱要素必须落到硬要素，否则④不通过；痛点语境里的"资金压力"不算钱要素）
_MONEY_KEYWORDS = (
    "利率", "年化", "利息", "息费", "月供", "手续费", "贴息", "免息", "放款", "贷款",
    "借款", "借钱", "借条", "还款", "额度", "万元", "万块", "块钱",
)
_MONEY_WEAK_KEYWORDS = ("融资", "资金", "现金流", "授信", "服务费", "万", "千", "元")
# 钱要素位置窗（SOP「生成期硬约束 ④」）自 2026-09-20 起从品牌 config 读取：
# config/<brand>/config.json → scriptSpec.moneyWindow → settings.SCRIPT_MONEY_WINDOW。
# 单位由「秒」改为「钱要素首字位置 ÷ 全篇口播正文字数的百分比」；秒数仅作参考展示。
_TAG_RE = re.compile(r"【[^】]*】")
_SENT_SPLIT_RE = re.compile(r"[。！？!?…\n]+")

# 钩子磨损句式黑名单（2026-09-23）：钩子段命中 → self_check.hook=fail
_HOOK_BAN_FILE = Path(__file__).with_name("hook_ban_phrases.json")


def _load_hook_ban_phrases() -> list[dict[str, str]]:
    """读取磨损句式清单；读取失败按空清单继续（不阻断写稿，只失去这一道拦截）。"""
    try:
        data = json.loads(_HOOK_BAN_FILE.read_text(encoding="utf-8"))
        return data.get("patterns", [])
    except Exception as e:  # noqa: BLE001
        logger.warning("钩子磨损句式清单读取失败，本次运行按空清单执行: %s", e)
        return []


_HOOK_BAN_PATTERNS = _load_hook_ban_phrases()

# 钩子段提取：第一个【标签】到下一个【标签】（或文末）之间的正文
_HOOK_SEGMENT_RE = re.compile(r"【[^】]*】([^【]*)")
# 与正向案例连续重合红线：≥12 字连续重合判 fail（与 SOP 查重口径一致）
_POSITIVE_CASE_OVERLAP_LIMIT = 12


def _hook_segment(script: str) -> str:
    """取脚本钩子段正文（第一个【模块·打法】标签之后的内容）。"""
    m = _HOOK_SEGMENT_RE.search(script or "")
    return (m.group(1) if m else "").strip()


def _longest_common_substring_len(a: str, b: str) -> int:
    """两段口播正文的最长连续公共子串长度（剥标签与空白后比对）。"""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    best = 0
    for ch_a in a:
        cur = [0] * (len(b) + 1)
        for j, ch_b in enumerate(b, 1):
            if ch_a == ch_b:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


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

    # 2b. 反查策略行原文（正向案例 + 植入策略，按方向的 strategy_record_id，2026-09-18）
    strategy_originals = _fetch_strategy_originals(selected_directions)

    # 3. 按 track 分线：蹭热点 → 热点 SOP + 策略库-热点；其他 → 非热点 SOP + 策略库-非热点
    hotspot_dirs = [d for d in selected_directions if d.get("track") == _HOTSPOT_TRACK]
    other_dirs = [d for d in selected_directions if d.get("track") != _HOTSPOT_TRACK]
    logger.info("分线: 蹭热点 %d 个 / 其他方向 %d 个", len(hotspot_dirs), len(other_dirs))

    scripts: list[dict[str, Any]] = []
    if hotspot_dirs:
        scripts += _write_group(
            style_json, hotspot_dirs, docs["hotspot"], docs["library_hotspot"],
            docs["scoring"], docs["redline"], materials_by_direction, strategy_originals,
        )
    if other_dirs:
        scripts += _write_group(
            style_json, other_dirs, docs["nonhotspot"], docs["library_nonhotspot"],
            docs["scoring"], docs["redline"], materials_by_direction, strategy_originals,
        )

    # 按原始方向顺序排列
    order = {d.get("id"): i for i, d in enumerate(selected_directions)}
    scripts.sort(key=lambda s: order.get(s.get("direction_id"), 99))

    # 4. 库内取用留痕自检（SOP「产出留痕」是否真的执行了）
    _check_library_trace(scripts)

    # 5. 量化项程序复算（字数/钱要素位置/品牌名出现次数/钩子三道拦截/正向案例查重），覆盖模型自报值
    _program_check(scripts, strategy_originals)
    return {"scripts": scripts}


def _load_reference_docs() -> dict[str, str]:
    """拉取两套 SOP + 两套策略库 + 评分标准 + 禁止红线文档全文。

    每次运行实时拉取（不缓存、不落盘）→ 飞书文档更新后无需改代码，下次运行自动生效。
    """
    docs: dict[str, str] = {}
    for key, url, name in [
        ("hotspot", SOP_HOTSPOT_DOC_URL, "脚本SOP-热点"),
        ("nonhotspot", SOP_NONHOTSPOT_DOC_URL, "脚本SOP-非热点"),
        ("library_hotspot", LIBRARY_HOTSPOT_DOC_URL, "策略库-热点"),
        ("library_nonhotspot", LIBRARY_NONHOTSPOT_DOC_URL, "策略库-非热点"),
        ("scoring", SCORING_STANDARD_DOC_URL, "口播脚本评分标准"),
        ("redline", REDLINE_DOC_URL, "禁止红线"),
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


def _program_check(
    scripts: list[dict[str, Any]],
    strategy_originals: dict[int, dict[str, str]] | None = None,
) -> None:
    """量化自检项程序复算（2026-09-18，翻键机制 2026-09-20 修正）。

    此前 verification 的字数／钱要素位置由写稿模型自报，没有任何程序复算（运动员兼裁判）。
    这里按成稿正文重算：字数（含标点 / 不含标点两口径）、钱要素首现句与「占全篇百分比」、品牌名出现次数；
    超区间时把对应 self_check 项翻成 fail 并写进 fail_items。
    钱要素位置窗的阈值来自品牌 config（settings.SCRIPT_MONEY_WINDOW），本函数不写死档位。

    翻键规则（2026-09-20 起按「异常类型」而非 issue 文案里的中文关键词）：
      - 字数超区间          → density（信息密度与节奏，维度⑥）翻 fail
      - 钱要素缺位／超窗    → speed（速度检验，维度④）翻 fail
      - 品牌名 0 次         → placement_chain（链路检验，维度⑤）翻 fail
      - 钩子磨损句式／hook_rationale 三问缺失 → hook（开头吸引力，维度①）翻 fail（2026-09-23）
      - 与正向案例连续重合 ≥12 字 → originality（原创性）翻 fail（2026-09-23，程序兜底
        模型自检错判——2026-09-22 微业贷脚本 originality 实际照搬正向案例却自报 pass）
      - 模型自报字数与复算不符 → 只记进 fail_items，**不翻任何键**（模型数不准字数，翻 density 属错判）
    """
    if not scripts:
        return
    nums = [int(x) for x in re.findall(r"\d+", str(SCRIPT_CHARS_PER_MINUTE))]
    cps = (sum(nums) / len(nums) / 60) if nums else 4.0  # 字/秒

    for s in scripts:
        text = _spoken_text(s.get("script") or "")
        with_punct = len(text)
        no_punct = len(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", text))
        issues: list[str] = []
        issue_kinds: set[str] = set()

        def add_issue(kind: str, text: str) -> None:
            """记录一条异常并打上类型标签。

            类型标签只供本函数内部「翻 self_check 键」用，不进输出。
            2026-09-20 改动缘由：此前翻键靠 issue 文案里的中文关键词匹配
            （含"字数"→density／含"钱要素"→speed／含"品牌名"→placement_chain），
            文案改一个字就翻错或翻不到；且"模型自报字数与复算不符"也含"字数"二字，
            连带把 density 翻成 fail（密度本身没问题，实测 5/5 误判）。
            现改为按类型精确翻键，并把自报字数不符单独归为 self_report（不翻键）。
            """
            issues.append(text)
            issue_kinds.add(kind)

        # ① 字数：超上限用最严口径（不含标点），不足用最宽口径（含标点），避免口径歧义误判
        if no_punct > SCRIPT_WORD_COUNT_MAX:
            add_issue("word_count", f"字数 {no_punct}（不含标点）超出上限 {SCRIPT_WORD_COUNT_MAX}")
        elif with_punct < SCRIPT_WORD_COUNT_MIN:
            add_issue("word_count", f"字数 {with_punct}（含标点）不足下限 {SCRIPT_WORD_COUNT_MIN}")

        # ② 钱要素首现位置：按关键词字符偏移定位（不是"该句末尾"，避免高估位置）
        sentences = [x for x in _SENT_SPLIT_RE.split(text) if x]
        offsets, cursor = [], 0
        for sent in sentences:
            offsets.append(cursor)
            cursor += len(sent)

        def _first_pos(words: tuple[str, ...]) -> tuple[int, str]:
            best = None
            for kw in words:
                pos = text.find(kw)
                if pos >= 0 and (best is None or pos < best[0]):
                    best = (pos, kw)
            return best or (-1, "")

        def _sentence_no(pos: int) -> int:
            return sum(1 for off in offsets if off <= pos) or 1 if pos >= 0 else 0

        pos, money_hit = _first_pos(_MONEY_KEYWORDS)
        money_idx = _sentence_no(pos)
        money_sec = max(1, round(pos / cps)) if pos >= 0 else 0
        # 判定依据（2026-09-20 起）：钱要素首字占全篇口播正文的百分比；秒数仅作参考展示
        # （脚本未配音，秒数是按字速折出的推算值，且同一套秒数在长/短稿上折成的百分比能差 3-4 倍）
        total_chars = len(text)
        money_pct = round(pos / total_chars * 100, 1) if pos >= 0 and total_chars else 0.0
        if pos < 0:
            weak_pos, weak_hit = _first_pos(_MONEY_WEAK_KEYWORDS)
            if weak_pos >= 0:
                weak_pct = round(weak_pos / total_chars * 100, 1) if total_chars else 0.0
                add_issue(
                    "money",
                    f"钱要素只以泛化表达出现（首个：『{weak_hit}』第{_sentence_no(weak_pos)}句／"
                    f"全篇前{weak_pct}%），未落到利率／额度／期限等硬要素 → ④不通过",
                )
            else:
                add_issue("money", "正文未检出钱要素（④ 硬约束要求钱要素必须出现）")
        cls_match = re.search(r"([ABCD])类", str(s.get("hook_class") or ""))
        cls = cls_match.group(1) if cls_match else ""
        window = SCRIPT_MONEY_WINDOW.get(cls)
        window_ok, window_txt = True, ""
        if window:
            lo, hi = window
            if lo and hi:
                window_txt = f"全篇前{lo:g}%-{hi:g}%"
            elif hi:
                window_txt = f"全篇前{hi:g}%"
            else:
                window_txt = "随质疑焦点出现（不限）"
        if window and money_idx:
            lo, hi = window
            if lo and money_pct < lo:
                window_ok = False
                add_issue(
                    "money",
                    f"钱要素首现于全篇前{money_pct}%（约第{money_sec}秒），"
                    f"早于 {cls} 类位置窗（{window_txt}）",
                )
            if hi and money_pct > hi:
                window_ok = False
                add_issue(
                    "money",
                    f"钱要素首现于全篇前{money_pct}%（约第{money_sec}秒），"
                    f"晚于 {cls} 类位置窗（{window_txt}）",
                )

        # ③ 品牌名出现次数（0 次 → 植入缺位）
        brand_mentions = text.count(BRAND_NAME)
        if brand_mentions == 0:
            add_issue("brand", f"正文未出现品牌名「{BRAND_NAME}」")

        # ④ 钩子质量三道程序拦截（2026-09-23）：
        #    a. 磨损句式扫描（hook 段命中黑名单 → hook=fail）
        #    b. hook_rationale「钩子三问」存在性（缺/空 → hook=fail）
        #    c. 与正向案例最长连续重合 ≥12 字（→ originality=fail）
        hook_text = _hook_segment(str(s.get("script") or ""))
        cliche_hits = [
            p["label"]
            for p in _HOOK_BAN_PATTERNS
            if p.get("pattern") and re.search(p["pattern"], hook_text)
        ]
        if cliche_hits:
            add_issue(
                "hook",
                f"钩子段命中磨损句式（{'、'.join(cliche_hits)}）→ 换机制重写，不得沿用模板开场",
            )

        rationale = s.get("hook_rationale")
        rationale_missing: list[str] = []
        if not isinstance(rationale, dict):
            rationale_missing = ["整个 hook_rationale 未留痕"]
        else:
            for key, hint in (
                ("picture", "画面：前3秒观众看到什么"),
                ("mechanism", "机制：靠什么拽住人（开放式）"),
                ("open_loop", "开放回路：观众心里升起的问题"),
            ):
                if not str(rationale.get(key) or "").strip():
                    rationale_missing.append(hint)
        if rationale_missing:
            add_issue(
                "hook",
                "钩子三问留痕缺失（" + "；".join(rationale_missing) + "）→ 动笔前未回答「画面/机制/开放回路」",
            )

        overlap_len = 0
        overlap_sample = ""
        if strategy_originals:
            positive = (strategy_originals.get(s.get("direction_id")) or {}).get("正向案例", "")
            if positive:
                overlap_len = _longest_common_substring_len(text, _spoken_text(positive))
                if overlap_len >= _POSITIVE_CASE_OVERLAP_LIMIT:
                    add_issue(
                        "originality",
                        f"与正向案例最长连续重合 {overlap_len} 字（≥{_POSITIVE_CASE_OVERLAP_LIMIT} 字线）→ 照搬正稿，须重写",
                    )
        hook_candidates = s.get("hook_candidates")
        if not isinstance(hook_candidates, list) or len(hook_candidates) < 3:
            add_issue(
                "hook",
                f"钩子候选不足 3 版（实交 {len(hook_candidates) if isinstance(hook_candidates, list) else 0} 版）→ 未做多机制择优",
            )

        verification = s.setdefault("verification", {})
        model_wc_raw = verification.get("word_count")
        model_wc = None
        if isinstance(model_wc_raw, bool):
            model_wc = None
        elif isinstance(model_wc_raw, (int, float)):
            model_wc = int(model_wc_raw)
        elif isinstance(model_wc_raw, str) and model_wc_raw.strip().lstrip("+-").isdigit():
            model_wc = int(model_wc_raw.strip())
        model_wc_ok = (no_punct <= model_wc <= with_punct) if model_wc is not None else None
        if model_wc_ok is False:
            add_issue("self_report", f"自报字数 {model_wc} 与复算不符（{no_punct}-{with_punct}）")

        s["word_count"] = with_punct
        verification["word_count_recomputed"] = with_punct
        verification["word_count_recomputed_no_punct"] = no_punct
        if money_idx:
            verification["money_element_sentence_recomputed"] = money_idx
            verification["money_element_percent_recomputed"] = f"全篇前{money_pct}%"
            verification["money_element_second_recomputed"] = f"约第{money_sec}秒（仅供参考）"
        s["program_check"] = {
            "word_count_with_punct": with_punct,
            "word_count_no_punct": no_punct,
            "word_count_range": f"{SCRIPT_WORD_COUNT_MIN}-{SCRIPT_WORD_COUNT_MAX}",
            "word_count_in_range": not (
                no_punct > SCRIPT_WORD_COUNT_MAX or with_punct < SCRIPT_WORD_COUNT_MIN
            ),
            "model_reported_word_count": model_wc,
            "model_word_count_matches": model_wc_ok,
            "money_element_sentence": money_idx,
            "money_element_percent": money_pct,
            "money_element_second": money_sec,
            "money_element_keyword": money_hit,
            "money_window": window_txt,
            "money_window_ok": window_ok,
            "brand_mentions": brand_mentions,
            "hook_cliche_hits": cliche_hits,
            "hook_rationale_complete": not rationale_missing,
            "hook_candidates_count": len(hook_candidates) if isinstance(hook_candidates, list) else 0,
            "overlap_with_positive_case": {
                "max_len": overlap_len,
                "limit": _POSITIVE_CASE_OVERLAP_LIMIT,
                "ok": overlap_len < _POSITIVE_CASE_OVERLAP_LIMIT,
            },
            "issues": issues,
        }

        if issues:
            self_check = s.setdefault("self_check", {})
            fail_items = self_check.setdefault("fail_items", [])
            for item in issues:
                if item not in fail_items:
                    fail_items.append(item)
            # 按异常类型精确翻键（2026-09-20 起；此前按 issue 文案里的中文关键词匹配）
            if "word_count" in issue_kinds:
                self_check["density"] = "fail"
            if "money" in issue_kinds:
                self_check["speed"] = "fail"
            if "brand" in issue_kinds:
                self_check["placement_chain"] = "fail"
            if "hook" in issue_kinds:
                self_check["hook"] = "fail"
            if "originality" in issue_kinds:
                self_check["originality"] = "fail"
            # self_report（模型自报字数与复算不符）只记进 fail_items、不翻键：
            # 模型无法可靠数字数，实测 5/5 误判，此前连带把 density 翻 fail 属错判
            logger.warning(
                "方向 %s 程序复算不通过：%s", s.get("direction_id"), "；".join(issues)
            )
        else:
            logger.info(
                "方向 %s 程序复算通过（字数 %d／钱要素全篇前%.1f%%／品牌名 %d 次）",
                s.get("direction_id"), with_punct, money_pct, brand_mentions,
            )


def _spoken_text(script: str) -> str:
    """去掉【模块·打法】标签与所有空白后的口播正文。"""
    return re.sub(r"\s+", "", _TAG_RE.sub("", script or ""))


def _fetch_direction_materials(
    directions: list[dict[str, Any]],
) -> dict[int, list[dict]]:
    """按方向的 source_material_ids 反查网络素材库，作为写稿参照。"""
    result: dict[int, list[dict]] = {}
    for d in directions:
        ids = d.get("source_material_ids") or []
        if not ids:
            # 2026-09-22 补：方向挂着策略行却无素材 ids → 曾发生 LLM 漏填导致
            # 写稿静默跳过素材反查（商单线方向1 断链事故），这里必须告警
            if d.get("strategy_record_id"):
                logger.warning(
                    "方向 %s（策略行 %s）source_material_ids 为空：写稿将无素材反查，"
                    "请检查方向生成是否漏填/程序回填是否生效",
                    d.get("id"), d.get("strategy_record_id"),
                )
            continue
        mats = fetch_materials_by_ids(ids)
        if mats:
            result[d.get("id")] = mats
            logger.info("方向 %s: 反查到 %d/%d 条素材", d.get("id"), len(mats), len(ids))
    return result


def _fetch_strategy_originals(
    directions: list[dict[str, Any]],
) -> dict[int, dict[str, str]]:
    """按方向的 strategy_record_id 反查策略行原文（2026-09-18）。

    取两个字段，都必须程序反查、不经 LLM 转手：
    ①「正向案例」——该策略行**已验证过的整条爆款脚本**，是「这个方向这么写能成」的行级实证
      （对手是谁/指控是什么/怎么算账/反转在哪）；此前 directions 步骤把它喂给 LLM，
      scripts 步骤只拿到转述后的叙事策略摘要，原句全丢。
    ②「植入策略」——策略行里的**具体卖点与示例句**（如"企业经营满2年""额度最高1000万"
      "国家贴息政策"）；此前 direction_generate 授权"可精炼"，451 字原文被压成 51 字摘要，
      写稿拿不到具体卖点，只能自造泛化话术（2026-09-18 断点A 修复）。
    """
    originals: dict[int, dict[str, str]] = {}
    want = {
        d.get("strategy_record_id"): d.get("id")
        for d in directions
        if d.get("strategy_record_id")
    }
    if not want:
        logger.info("策略行原文反查：方向未带 strategy_record_id，跳过")
        return originals
    try:
        rows = {r.get("_record_id"): r for r in fetch_strategy_table()}
    except Exception as e:  # noqa: BLE001
        logger.warning("策略行原文反查失败（策略表拉取异常，按缺省继续）: %s", e)
        return originals
    for rid, did in want.items():
        row = rows.get(rid) or {}
        picked = {
            key: row.get(key)
            for key in ("正向案例", "植入策略")
            if row.get(key)
        }
        if picked:
            originals[did] = picked
    missing = [did for rid, did in want.items() if did not in originals]
    logger.info(
        "策略行原文反查：命中 %d/%d 个方向%s",
        len(originals), len(want), f"（缺失方向 {missing}）" if missing else "",
    )
    return originals


def _build_constraint_card() -> dict[str, Any]:
    """生成「生成期硬约束卡」（2026-09-23）。

    缘由：SOP 检验机制虽随全文注入写稿上下文，但被定性为「输出前的考试」而非
    「写稿时的规格」——钩子曾带着"形式全 pass、选类/吸引力不合格"一路绿灯
    （2026-09-22/23 微业贷两稿复盘结论：规则必须提前、计算必须留后）。

    本卡把 _program_check 将要复算的每一项判据（含阈值）从**同一批常量与品牌
    config** 生成，前置到 prompt 顶部：阈值改代码/配置，卡片自动同步，永不与
    程序复算漂移。库内案例查重（originality_library）程序在生成期拿不到案例句
    清单，仍由模型自检承担，卡中单列声明。
    """
    window_desc: dict[str, str] = {}
    for cls, (lo, hi) in SCRIPT_MONEY_WINDOW.items():
        if lo and hi:
            window_desc[cls] = f"全篇前{lo:g}%-{hi:g}%"
        elif hi:
            window_desc[cls] = f"全篇前{hi:g}%"
        elif lo:
            window_desc[cls] = f"不早于全篇前{lo:g}%"
        else:
            window_desc[cls] = "随质疑焦点出现（不限）"
    return {
        "说明": (
            "以下判据与写完后程序复算（program_check）完全同源；命中即直接 "
            "fail 并打回重写，无人工豁免。把这张卡当写作规格，不是事后考试。"
        ),
        "字数（density）": (
            f"口播正文 {SCRIPT_WORD_COUNT_MIN}-{SCRIPT_WORD_COUNT_MAX} 字"
            "（超上限按不含标点口径、不足下限按含标点口径判）"
        ),
        "钱要素首现位置（speed）": {
            "判定": "钱要素（利率/额度/期限等硬要素）首字位置 ÷ 全篇正文字数",
            "位置窗": window_desc,
            "注意": "只有泛化表达（融资/资金/现金流）不算钱要素，未检出硬要素即 fail",
        },
        "品牌名（placement_chain）": (
            f"正文必须出现品牌名「{BRAND_NAME}」至少 1 次，0 次即 fail"
        ),
        "钩子段磨损句式（hook）": (
            "命中「钩子硬约束」块注入的黑名单任一句式即 fail"
            f"（黑名单共 {len(_HOOK_BAN_PATTERNS)} 条，清单以配置文件为唯一权威源）"
        ),
        "钩子三问留痕（hook）": (
            "hook_rationale 的 picture/mechanism/open_loop 逐条非空，"
            "且 hook_candidates ≥3 版，缺一即 fail"
        ),
        "与正向案例连续重合（originality）": (
            f"与该策略行正向案例最长连续重合 ≥{_POSITIVE_CASE_OVERLAP_LIMIT} 字即 fail"
            "（程序复算，模型自检报 pass 不作数）"
        ),
        "库内案例查重（originality_library，自检项）": (
            "程序在生成期拿不到库内案例句清单，此项由模型自检承担："
            "钩子句与库内钩子方法库案例原句 12 字以上连续重合须自报 fail"
        ),
        "程序不判、人工复盘项": (
            "风格契合、锋利度、删名测试、达人检验、链路顺滑度、口语化——"
            "不打分也不由程序拦截，按 SOP 检验机制人工执行"
        ),
    }


def _write_group(
    style_json: dict[str, Any],
    directions: list[dict[str, Any]],
    sop_text: str,
    library_text: str,
    scoring_text: str,
    redline_text: str,
    materials_by_direction: dict[int, list[dict]],
    strategy_originals: dict[int, dict[str, str]],
) -> list[dict[str, Any]]:
    """同一 track 的一组方向，注入对应 SOP + 策略库 + 评分标准 + 禁止红线，一次 LLM 调用产出。"""

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
            "策略行植入策略原文（未经精炼的具体卖点与示例句；写稿时以此为准，信息点与数字不得丢，"
            "上面「植入策略」摘要只作方向意图理解；措辞可改写，含其它品牌名或非本品牌产品参数"
            "一律按本品牌口径重写）":
                (strategy_originals.get(did) or {}).get("植入策略", ""),
            "正向案例原文（该策略行已验证爆款，只作节奏/锋利度参照，禁止整句或近似复刻、"
            "禁止照抄其具体案例与数字；含其它品牌名或非本品牌产品参数一律按本品牌口径重写）":
                (strategy_originals.get(did) or {}).get("正向案例", ""),
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
        "生成期硬约束卡（写前必读；与程序复算同源，命中即 fail 无人工豁免）": _build_constraint_card(),
        "达人风格": style_json,
        "选中的创意方向": [slim_direction(d) for d in directions],
        "钩子硬约束（2026-09-23，优先级高于库内档位的默认写法）": (
            "1) 动笔前先回答「钩子三问」，逐条写进输出字段 hook_rationale："
            "picture＝前 3 秒观众「看到」了什么（必须是具体的人/场景/数字/动作，"
            "抽象概念式开场如「我最怕的不是A是B」属于宣言、直接不合格）；"
            "mechanism＝这个钩子靠什么拽住人（开放式：数字反差/没回的消息/倒计时/荒诞事实/"
            "身份点名/时代对比……不限任何类别，但必须写明，禁止只写「引发好奇」）；"
            "open_loop＝观众看完钩子心里升起的具体问题（必须是脚本后文真正会回答的问题，"
            "「这是啥广告」不算开放回路）。三问缺一即程序判 fail。"
            "2) 每个方向至少产出 3 版机制不同的钩子候选写进 hook_candidates"
            "（每版含 hook_text 与 mechanism 标签），择优 1 版进正文——禁止一稿定生死。"
            "3) 磨损句式黑名单（钩子段命中即程序 fail）：" + json.dumps(
                [p["pattern"] + "（" + p["label"] + "）" for p in _HOOK_BAN_PATTERNS],
                ensure_ascii=False,
            ) + "。"
            "4) 原创性扩展：钩子句不得与库内钩子方法库任何案例原句有 12 字以上连续重合，"
            "库内档位只取公式与机制，案例句必须重新组织语言；"
            "并在 self_check 增加 originality_library 项（与库内案例比对，pass/fail+说明）。"
        ),
        "组织要求": (
            "每个方向产出 1 个完整口播逐字稿 + 合规检查（第0条红线一票否决）+ "
            "self_check（SOP 检验机制逐项 pass/fail，不打分，含新增 originality_library）+ "
            "hook_rationale（钩子三问：picture/mechanism/open_loop，逐条非空）+ "
            "hook_candidates（≥3 版不同机制的钩子候选）+ "
            "verification（核验行：钱要素首现位置／总字数／过渡句数／逐句功能标签串）+ "
            "library_picks（各模块库内编号与命中理由）+ material_gap + human_revision（固定 null）；"
            "同一批多条脚本骨架可以相似，但具体措辞、案例、算账数字、金句不得复用；"
            "方向里的「策略行植入策略原文」是该策略行卖点原话——写稿必须把其中的具体卖点与数字"
            "落实进植入段，不得只按摘要写泛化话术；「正向案例原文」只作节奏与锋利度参照，不得复刻"
        ),
    }, ensure_ascii=False, indent=2)

    full_text = (
        f"{user_text}\n\n"
        f"## 脚本 SOP 文档全文（结构与打法依据，按推导流程执行）\n{sop_text}\n\n"
        f"## 策略库全文（方法与语料库；按 SOP 顶部「素材取用流程」四步取用库内档位，"
        f"编号须按库内各档「对应 SOP」字段反查，禁止按字母对齐）\n{library_text}\n\n"
        f"## 《口播脚本评分标准》全文（定义源；**评分生成期不打分，但顶部硬约束卡所列判据"
        f"由程序逐项复算、命中即 fail 无需人工**——按该文档「使用规则（先读这一节）」节，"
        f"写稿阶段只走 SOP 检验机制的 pass / fail）\n{scoring_text}\n\n"
        f"## 《禁止红线》全文（**合规红线唯一权威源，第 0 条判定与产品口径一律以此为准**）：\n"
        f"逐条核对「一票否决清单」全部细则（通用／热点附加／违禁话题），不得只看 SOP 里的摘要；\n"
        f"植入段的产品表述只能取自本文档的口径表／白名单节"
        f"（微业贷「五、标准口径与衍生表述」、度小满「四、豁免与白名单」），表外表述一律不得使用；\n"
        f"背书、担保、推荐类表述须已在本文档的白名单节登记，未登记不得使用；\n"
        f"措辞与内容底线按本文档的「投放审核口径」节自检。本文与 SOP／评分标准冲突时以本文为准。\n{redline_text}"
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
