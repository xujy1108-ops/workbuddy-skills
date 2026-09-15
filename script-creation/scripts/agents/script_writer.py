"""步骤 6 — 写脚本 + 生成期自检（SOP + 策略库驱动版，2026-09-15 评分口径重构）。

改造要点：
- 大纲步骤移除：directions → scripts 直通
- 写稿依据按 track 分线注入文档（运行时实时拉取，文档更新即时生效，代码不缓存）：
  蹭热点方向 → 《度小满-脚本SOP-热点-V2》+《度小满-策略库-热点》
  其他方向   → 《度小满-脚本SOP-非热点-V2》+《度小满-策略库-非热点》
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
)
from providers.llm import run_llm
from tools.feishu import fetch_doc_content, fetch_materials_by_ids

logger = logging.getLogger(__name__)

_HOTSPOT_TRACK = "蹭热点"
_ROLE_MODULE = "模块④角色定位"

_SPEC_COMMON_INSTRUCTIONS = """你是一位顶尖的短视频口播脚本写手兼内容评分专家，严格遵循度小满脚本 SOP 与评分标准工作。

## 任务
为每个选中的创意方向，产出可直接配音拍摄的**完整口播逐字稿**，并过生成期自检
（第0条红线一票否决 + 检验机制逐项 pass / fail）。
**本步骤不打分**——输出里不得出现任何 0/1/2 分数；「预期分」只对人工修改后的版本打、由人工填写，
你的 human_revision 字段固定输出 null。
文档优先级：SOP 决定结构与打法选择逻辑，**策略库提供库内档位的台词公式/案例语料/角色定位**，
两者矛盾时以 SOP 的结构规则为准、以策略库的语料为准。

## 工作方式（严格按注入的 SOP 文档 + 策略库执行）
1. **先按 SOP 第三节"脚本生成推导流程"逐方向推导**：
   Step 0 加载达人风格定基调 → Step 1 定钩子类与打法 → Step 2 定转折打法+链路收口
   → Step 3 定度小满角色定位 → Step 4 套植入 SOP（场景触发→信任定调→反向对标→合规叠甲）
   → Step 5 选收尾叠加 → Step 6 对照检验机制自检
   每个 Step 选定打法/档位后，同步按「库内素材取用」四步去策略库取对应档位的语料（见第 6 条）。
2. **产出物是逐字稿，不是要点**：按"钩子→承接→转折→植入→收尾"的功能顺序写满台词，
   每个模块开头用标签标注钩子类与所选打法——标签用**对应 track 的 SOP 模块子编号**：
   其他方向线如【钩子·B1反常识观点】【承接·A信息差填补】；蹭热点线如【钩子·1权威事件开场】
   （热点 SOP 子编号只用序号、不带字母），标签后紧跟成段台词，禁止只写要点。
3. **硬约束（含两份 SOP 的「生成期硬约束」节，逐条必须满足）**：
   - 总时长 60-90 秒，字数 220-390 字（220-260 字/分钟）；过渡句尽量少，逐句都要有功能；
   - **钱要素时间窗（④，定完钩子类立即绑定）**——热点线：A类 前 3 秒／B类 前 10 秒；
     非热点线：A类·利益直给型 前 3 秒／B类·好奇心驱动型 前 10 秒／C类·情绪冲突型 前 10-20 秒／
     D类·自证回应型 随质疑焦点出现。写完必须回标「钱要素首现位置（第几句／约第几秒）」，超窗即回改；
   - **逐句功能标注（⑥）**：每句都能标出功能（钩子/承接/转折/植入/收尾/过渡），删任意一句有信息损失；
   - **达人输入规格（③）**：每句台词须能在达人风格档案的「常用句式清单」里找到依据，
     产品出现必须走达人一贯逻辑；"像不像他说的话"须成稿后朗读测试，写作阶段不作判定；
   - 钩子到植入叙事传动 ≤1 次；转折段收口必须落"普适选择原则 + 可验证标准"两件套；
     植入 4 步不可跳，反向对标的卖点必须与转折收口的标准一一咬合。
4. **达人口吻定基调**：创意/热点决定"讲什么"，达人风格决定"怎么讲"——
   严格执行达人风格 JSON 中的语速、语气、用词习惯、口头禅、视觉符号；
   是达人在解读热点/讲创意，不是念通稿。
5. **场景落位**：按方向的「场景」字段确定画面发生地（在哪拍、什么场合、几个人），
   逐字稿与场景相容——「对镜口播（无场景情节）」的方向不加剧情画面提示；
   带具体场景的方向（酒席饭桌/职场办公/户外街头等）按该场景写画面提示与情绪落点。
   关联素材的「场景+内容分析」只用于判断"这个方向在现实里长什么样"，
   不是要逐句复刻素材文案——话术由你按 SOP 重写。
6. **库内素材取用（SOP 顶部「素材取用流程」四步，必须执行且留痕）**：
   策略库全文已随本提示注入，禁止跳过、禁止凭记忆自拟公式。
   ① 库级定位：按 SOP 各模块的「素材取用 → …」引用行，定位到库内对应章节
      （钩子方法库／承接方法库／热点痛点·缺口场景／痛点软肋方法库／转折句式方法库／
      角色定位方法库／收尾方法库／切入方式库，按 track 对应那一份库）；
   ② 条目级选择：按语义选档，依据＝本次创意核心特征与条目「适用创意特征／适用钩子类型／
      适用承接类型」的对齐点；
   ③ 产出留痕：每个模块给出「库内编号＋名称＋命中理由」，写进输出的 library_picks 数组；
      命中理由必须引用创意特征与条目名称的对齐点，禁止空泛表述（如"比较合适"）；
   ④ 缺口兜底：库内确无对应档位时，就近借用同类档位，并在 material_gap 标「素材缺口·打法X」；
      严禁自创公式。
   **编号体系纪律**：库内编号与 SOP 模块子编号是两套体系（如非热点库钩子为 A–J，
   而 SOP 模块① 为 A1–D2），**禁止按字母或序号对齐**，一律按库内各档的「对应 SOP」字段反查锚定。
   【模块·打法】标签沿用 SOP 编号体系；库内编号只进 library_picks，不混进标签。
7. **角色定位必选（硬要求，对应 SOP 推导流程 Step 3）**：
   植入前必须先定"度小满在本创意里对观众是什么"，且必须从库内「角色定位方法库」选档——
   非热点线从《策略库-非热点》7 档中选 1 档（痛点解药／过来人工具／应急安全垫／
   被验证的靠谱／拒绝话术武器／优等生／体面方案）；
   热点线从 SOP-热点 模块④「热点专属角色定位」5 档中选 1 档（合规标杆／国家队合作伙伴／
   缺口补充工具／政策响应者／普通人低息入口）。
   选中的角色定位必须写进 library_picks（module="模块④角色定位"），
   植入段的口吻与侧重点须与该角色一致，并在【植入·…】标签中体现该角色定位名称
   （如【植入·应急安全垫】【植入·合规标杆】），不得只写【植入·通用植入SOP】了事。

## 生成期自检（pass / fail，不打分）
严格按注入的《口播脚本评分标准》（其「使用规则」节明确：写稿只走 pass/fail）
与两份 SOP 的「四、检验机制」执行。**本步骤不产出任何 0/1/2 分数。**

1. **第 0 条合规红线先行（一票否决）**：逐条检查红线清单，任何一条踩线 →
   `compliance_check.passed = false` 并列出违规项（该脚本标记为需重写，但其余字段仍要输出）。
2. **红线通过后，逐项过 pass / fail**，键名固定，值只允许 "pass" / "fail" / "n/a"：
   | 键 | 检验项 | 判定标准 |
   |-|-|-|
   | hook | 开头检验（①） | 钩子按 A-D 类对照等级表；权威词不得用弱词 |
   | name_removal | 删名测试（②） | 删掉品牌名后逻辑断裂才合格；仍通顺 → 回补绑定 |
   | influencer | 达人检验（③，成稿后） | 用达人身份朗读全文，去品牌名仍像他说的话；是达人解读不是念通稿 |
   | speed | 速度检验（④） | 复核回标的钱要素位置是否落在对应类型时间窗内 |
   | placement_chain | 链路检验（⑤） | 痛点→原则→标准→产品四步全、传动≤1 次、铺垫顺滑 |
   | density | 密度检验（⑥） | 逐句有功能、删任意一句有信息损失 |
   | entry_direction | 切入检验（⑦） | 观众能把开场类比到自己的用钱场景；宏大叙事 → fail。蹭热点线另须钩子后第一段（约 10 秒内）落到个人利益 |
   | hotspot_fit | 热点检验（⑦+蹭热度） | 去掉品牌名，前半段仍是独立成立的热点解读；热点贯穿全文非标题党。**仅蹭热点线适用，其他方向线填 "n/a"** |
   | speakability | 口播检验（⑥） | 念出来像"人说话"不像"念文件"；书面语/总结腔 → fail |
   | redline | 合规检验（第0条） | 与 compliance_check.passed 同值 |
3. `self_check.fail_items`：列出所有 fail 的键 + 一句话原因（确实全过才给空数组）。
4. `verification`（**核验行**，硬约束自证）：钱要素首现位置（第几句／约第几秒）、总字数、
   过渡句数、逐句功能标签串。必须与脚本实际内容一致，**禁止估算凑数**。
5. `library_picks` 未覆盖模块①-⑤，或「模块④角色定位」缺档 → `placement_chain` 必须记 fail
   （视为未按 SOP 执行），并在 fail_items 中说明原因。
6. `human_revision` **固定输出 null**——预期分与改动记录由人工在修改后填写，你不要填、不要猜。

## 输出格式（严格 JSON，禁止 markdown 代码块包裹）
{
  "scripts": [
    {
      "direction_id": 1,
      "direction_title": "来源方向标题",
      "track": "蹭热点 或 其他方向",
      "hook_class": "钩子类 + 打法，按对应 track 的 SOP 子编号写（其他方向线如「B类·好奇心 · B1反常识观点」；蹭热点线如「A类·利益直给 · 1权威事件开场」）",
      "title": "脚本标题",
      "script": "完整口播逐字稿（含【模块·打法】标签与成段台词）",
      "word_count": 300,
      "estimated_duration": "75s",
      "compliance_check": {"passed": true, "violations": []},
      "library_picks": [
        {"module": "模块①钩子", "library": "策略库-非热点·钩子方法库", "entry": "B·反常识观点", "reason": "创意核心是被忽略的真相，与B档『跟大众认知相反的结论』对齐"},
        {"module": "模块②承接", "library": "策略库-非热点·钩子方法库", "entry": "A·信息差填补", "reason": "钩子打开的是『不知道的真相』缺口，A档兑现方式即揭露行业现实"},
        {"module": "模块③转折", "library": "策略库-非热点·转折句式方法库", "entry": "E·认知翻转", "reason": "旧观念（借钱是负担）翻成新观念（借钱是工具），新观念自带选择原则"},
        {"module": "模块④角色定位", "library": "策略库-非热点·角色定位方法库", "entry": "应急安全垫", "reason": "创意落点是『备用金』而非消费，与『不是借钱消费，是备用金』对齐"},
        {"module": "模块⑤收尾", "library": "策略库-非热点·收尾方法库", "entry": "E·劝退＋人设一句融合", "reason": "合规劝退与务实人设一句完成，是维度⑧的2分标杆形态"}
      ],
      "material_gap": "",
      "self_check": {
        "hook": "pass",
        "name_removal": "pass",
        "influencer": "pass",
        "speed": "pass",
        "placement_chain": "pass",
        "density": "pass",
        "entry_direction": "pass",
        "hotspot_fit": "pass 或 n/a（仅蹭热点线用 pass/fail）",
        "speakability": "pass",
        "redline": "pass",
        "fail_items": []
      },
      "verification": {
        "money_element_sentence": 1,
        "money_element_second": "约第3秒",
        "word_count": 300,
        "transition_sentences": 2,
        "function_tags": "钩子:权威事件开场 / 承接:政策翻译 / 转折:成本传导 / 植入:合规标杆·四步 / 收尾:合规劝退+人设"
      },
      "human_revision": null,
      "style_fit_analysis": "脚本如何匹配达人风格的说明（<=80字）"
    }
  ]
}

## 约束
- 每个方向产出 1 个完整脚本，script 字段必须是完整可拍摄逐字稿，不要缩写
- **不打分**：输出里不得出现 score / score_notes / 分数值；self_check 只填 pass / fail / n/a，
  human_revision 固定 null
- 自检实事求是：不达标就如实记 fail；fail_items 为空意味着"确实逐项过了"，不是"懒得挑刺"
- compliance_check 是门槛（一票否决），self_check 是过程自证，两者分开写
- library_picks 覆盖模块①-⑤，其中「模块④角色定位」有且仅有 1 档；库内编号与命中理由照实写，
  禁止编造库内不存在的条目名称（写不出对应档位就走 material_gap）
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
