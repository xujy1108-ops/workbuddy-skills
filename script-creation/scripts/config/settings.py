"""配置管理：环境变量 + 品牌配置。

品牌私有内容（飞书表 token / 文档 URL / prompt 模板 / 角色定位档位 / 达人类型枚举）
全部外置在 skill 根目录 `config/<brand>/`，本模块是唯一读取入口——
agents / tools 一律从 `config.settings` 引用常量，代码内零品牌硬编码。

品牌选择：环境变量 `WORKFLOW_BRAND` > 默认 `duxiaoman`
（run.py 的 `--brand` 参数会在 import agents 之前写入该环境变量）

失败即报错：配置目录/文件缺失、JSON 非法、必填字段缺失、prompt 模板缺失
或存在未注入占位符 → import 时直接抛 RuntimeError，不静默回退到其它品牌。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# skill 根目录：scripts/config/settings.py → scripts/config → scripts → skill 根
SKILL_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_ROOT = SKILL_ROOT / "config"

DEFAULT_BRAND = "duxiaoman"

# 必填校验：顶层键 + 三张核心表的 baseToken/tableId
_REQUIRED_TOP_KEYS = (
    "brand", "brandName", "tables", "docs", "rolePositions", "promptVars", "scriptSpec",
)
_REQUIRED_TABLES = ("strategy", "hotspot", "materials")

# prompt 模板支持的占位符（换品牌时模板必须沿用同一套）
_PLACEHOLDER_RE = re.compile(r"__[A-Z0-9_]+__")


def available_brands() -> list[str]:
    """列出 config/ 下所有带 config.json 的品牌目录。"""
    if not CONFIG_ROOT.is_dir():
        return []
    return sorted(p.name for p in CONFIG_ROOT.iterdir() if (p / "config.json").is_file())


def _scan_unfilled(node, prefix: str = "") -> list[str]:
    """递归扫描仍未补齐的占位值（以 TODO_ 开头的字符串）。

    骨架品牌（复制 duxiaoman 目录改配置）在补齐前不应能跑起来——
    否则会一路跑到读表/调 LLM 才炸出难懂的飞书 `NOTEXIST` 报错。
    说明性字段（键名以 `_` 开头，如 `_note`）不参与扫描。
    """
    unfilled: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(key, str) and key.startswith("_"):
                continue
            unfilled += _scan_unfilled(value, f"{prefix}.{key}" if prefix else str(key))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            unfilled += _scan_unfilled(value, f"{prefix}[{i}]")
    elif isinstance(node, str) and node.startswith("TODO_"):
        unfilled.append(prefix)
    return unfilled


def _load_brand_config(brand: str) -> dict:
    """读取并校验 config/<brand>/config.json。"""
    path = CONFIG_ROOT / brand / "config.json"
    if not path.is_file():
        brands = available_brands()
        raise RuntimeError(
            f"品牌配置不存在：{path}"
            f"（可用品牌：{', '.join(brands) if brands else '无'}）"
        )
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"品牌配置 JSON 解析失败：{path} → {exc}") from exc

    missing: list[str] = [k for k in _REQUIRED_TOP_KEYS if k not in cfg]
    tables = cfg.get("tables") or {}
    for name in _REQUIRED_TABLES:
        table = tables.get(name) or {}
        if not table.get("baseToken") or not table.get("tableId"):
            missing.append(f"tables.{name}.baseToken / tables.{name}.tableId")
    if missing:
        raise RuntimeError(f"品牌配置缺必填字段：{path} → {', '.join(missing)}")

    unfilled = _scan_unfilled(cfg)
    if unfilled:
        raise RuntimeError(
            f"品牌配置未补齐（仍含 TODO_ 占位值）：{path}\n"
            f"  待填字段：{', '.join(unfilled[:12])}"
            f"{f' 等 {len(unfilled)} 处' if len(unfilled) > 12 else ''}\n"
            f"  补齐后方可使用 --brand {brand} 运行"
        )
    return cfg


# ── 生效品牌（import 时确定） ──
BRAND = os.environ.get("WORKFLOW_BRAND") or DEFAULT_BRAND
BRAND_CONFIG = _load_brand_config(BRAND)
BRAND_NAME = BRAND_CONFIG["brandName"]
PROMPT_DIR = CONFIG_ROOT / BRAND / "prompts"

_P = BRAND_CONFIG.get("promptVars") or {}
_ROLES = BRAND_CONFIG.get("rolePositions") or {}

# 写稿硬约束口径（时长/字数/字速）——prompt 用占位符注入，程序复算也用同一份数值，
# 保证「prompt 要求」与「程序校验」永不脱钩（此前 prompt 里硬编码的是别品牌口径）。
_SCRIPT_SPEC = BRAND_CONFIG.get("scriptSpec") or {}
SCRIPT_DURATION_RANGE: str = str(_SCRIPT_SPEC.get("durationRange") or "")
SCRIPT_WORD_COUNT_MIN: int = int(_SCRIPT_SPEC.get("wordCountMin") or 0)
SCRIPT_WORD_COUNT_MAX: int = int(_SCRIPT_SPEC.get("wordCountMax") or 0)
SCRIPT_CHARS_PER_MINUTE: str = str(_SCRIPT_SPEC.get("charsPerMinute") or "")
SCRIPT_WORD_COUNT_RANGE = f"{SCRIPT_WORD_COUNT_MIN}-{SCRIPT_WORD_COUNT_MAX}"

# 钱要素位置窗（SOP「生成期硬约束 ④」）——单位：钱要素首字位置 ÷ 全篇口播正文字数的百分比（%）。
# 2026-09-20 由「秒数」改为「百分比」并移入品牌配置（用户定）：秒数脚本尚未配音、是按字速折出的
# 推算值，且同一套秒数在不同长度脚本上折成的百分比能差 3-4 倍（220 字稿 C 类 10-20 秒＝18%-36%，
# 780 字稿＝5%-10%），不自洽。此前是本模块之外的模块级常量（script_writer._MONEY_WINDOW），
# 不分品牌、不分线别，调一档要改 .py —— 现改为配置驱动。
_MONEY_WINDOW_CFG: dict[str, dict] = {
    k: v for k, v in (_SCRIPT_SPEC.get("moneyWindow") or {}).items()
    if isinstance(v, dict)
}
SCRIPT_MONEY_WINDOW: dict[str, tuple[float | None, float | None]] = {
    k: (v.get("min"), v.get("max")) for k, v in _MONEY_WINDOW_CFG.items()
}
if not SCRIPT_MONEY_WINDOW:
    raise RuntimeError(
        f"品牌配置缺 scriptSpec.moneyWindow（钱要素位置窗）："
        f"{CONFIG_ROOT / BRAND / 'config.json'}\n"
        f"  该窗口缺失会让写稿没有位置依据、程序复算失去标尺，故不降级。"
    )

# 热点线 SOP 只定义 A／B 两类钩子（无 C／D），生成窗口文案时按此裁剪
HOTSPOT_MONEY_CLASSES: tuple[str, ...] = ("A", "B")


def money_window_text(classes: tuple[str, ...] | None = None) -> str:
    """把配置里的钱要素位置窗拼成可直接写进 prompt 的中文表述。

    Args:
        classes: 要输出的钩子类；None = 配置里的全部（非热点线顺序）。

    Returns:
        如「A类·利益直给型 前 3%／B类·好奇心驱动型 前 8%／
        C类·情绪冲突型 8%-16%／D类·自证回应型 随质疑焦点出现（不限）」
    """
    keys = classes if classes is not None else tuple(SCRIPT_MONEY_WINDOW)
    parts: list[str] = []
    for key in keys:
        lo, hi = SCRIPT_MONEY_WINDOW.get(key, (None, None))
        label = str((_MONEY_WINDOW_CFG.get(key) or {}).get("label") or "")
        name = f"{key}类·{label}" if label else f"{key}类"
        if lo is None and hi is None:
            desc = "随质疑焦点出现（不限）"
        elif lo is None:
            desc = f"前 {hi:g}%"
        elif hi is None:
            desc = f"{lo:g}% 之后"
        else:
            desc = f"{lo:g}%-{hi:g}%"
        parts.append(f"{name} {desc}")
    return "／".join(parts)

# 达人类型标准（结构化）：一级类型 → 二级类型列表，供枚举合法性校验
# （与 promptVars.influencerTypeEnum 的文本枚举同源，改一处要同步另一处）
INFLUENCER_TYPE_STANDARD_MAP: dict[str, list[str]] = {
    k: list(v)
    for k, v in (BRAND_CONFIG.get("influencerTypeStandardMap") or {}).items()
    if not k.startswith("_") and isinstance(v, list)
}


def load_prompt(name: str, **extra: str) -> str:
    """加载品牌 prompt 模板并注入占位符。

    Args:
        name: prompts/ 下的文件名，如 "script_writer.md"
        **extra: 额外占位符（覆盖内置变量）

    Returns:
        注入完成的 prompt 文本

    Raises:
        RuntimeError: 模板缺失，或存在未注入的占位符（防止换品牌时漏改模板）
    """
    path = PROMPT_DIR / name
    if not path.is_file():
        raise RuntimeError(
            f"品牌 prompt 模板缺失：{path}"
            f"（品牌 {BRAND} 的 prompts/ 需包含全部模板，见 config/duxiaoman/prompts/）"
        )
    text = path.read_text(encoding="utf-8")

    # 骨架品牌的模板是纯说明性注释，去注释后为空 → 视为未补齐，直接报错
    # （否则会把一段注释当 prompt 发给 LLM，产出无法解释的结果）
    body = "\n".join(
        line for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    if not body.strip():
        raise RuntimeError(
            f"品牌 prompt 模板未补齐（除注释外无内容）：{path}\n"
            f"  参考模板：config/{DEFAULT_BRAND}/prompts/{name}"
        )

    nonhotspot = list(_ROLES.get("nonhotspot") or [])
    hotspot = list(_ROLES.get("hotspot") or [])
    variables = {
        "__BRAND_NAME__": BRAND_NAME,
        "__DURATION_RANGE__": SCRIPT_DURATION_RANGE,
        "__WORD_COUNT_RANGE__": SCRIPT_WORD_COUNT_RANGE,
        "__CHARS_PER_MINUTE__": SCRIPT_CHARS_PER_MINUTE,
        "__MONEY_WINDOW_NONHOTSPOT__": money_window_text(),
        "__MONEY_WINDOW_HOTSPOT__": money_window_text(HOTSPOT_MONEY_CLASSES),
        "__ROLE_POSITIONS_NONHOTSPOT__": "／".join(nonhotspot) or "（未配置）",
        "__ROLE_POSITIONS_NONHOTSPOT_COUNT__": str(len(nonhotspot)),
        "__ROLE_POSITIONS_HOTSPOT__": "／".join(hotspot) or "（未配置）",
        "__ROLE_POSITIONS_HOTSPOT_COUNT__": str(len(hotspot)),
        "__INFLUENCER_TYPE_ENUM__": _P.get("influencerTypeEnum", ""),
        "__INFLUENCER_TYPE_REFERENCE_ANCHORS__": _P.get("influencerTypeReferenceAnchors", ""),
    }
    variables.update(extra)
    for key, value in variables.items():
        text = text.replace(key, value)

    leftover = sorted(set(_PLACEHOLDER_RE.findall(text)))
    if leftover:
        raise RuntimeError(
            f"prompt 模板 {name} 存在未注入的占位符：{', '.join(leftover)}"
            f"（模板占位符需与 settings.load_prompt 提供的变量一致）"
        )
    return text


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── LLM (inferera / deepseek-v4-pro) ──
    deepseek_api_key: str
    deepseek_base_url: str = "https://api.inferera.com/v1"
    deepseek_model: str = "deepseek-v4-pro"

    # ── 代理 ──
    http_proxy: str | None = None
    https_proxy: str | None = None


# ── 飞书多维表格（品牌配置，非密钥） ──

# 创意策略表（步骤 directions 的驱动源：达人画像匹配策略行）
FEISHU_STRATEGY_BASE = BRAND_CONFIG["tables"]["strategy"]["baseToken"]
FEISHU_STRATEGY_TABLE = BRAND_CONFIG["tables"]["strategy"]["tableId"]

# 热点素材库（蹭热点线创意方向来源，按素材评分取优）
FEISHU_HOTSPOT_BASE = BRAND_CONFIG["tables"]["hotspot"]["baseToken"]
FEISHU_HOTSPOT_TABLE = BRAND_CONFIG["tables"]["hotspot"]["tableId"]

# 网络素材库（策略行素材链接ids 反查源）
FEISHU_MATERIALS_BASE = BRAND_CONFIG["tables"]["materials"]["baseToken"]
FEISHU_MATERIALS_TABLE = BRAND_CONFIG["tables"]["materials"]["tableId"]

# 历史数据库（2026-09-09 改造：历史库退出 directions 流程，保留配置供其他步骤可能使用）
_history = BRAND_CONFIG["tables"].get("historyToutiao") or {}
FEISHU_HISTORY_BASE = _history.get("baseToken", "")
FEISHU_HISTORY_TABLE_TOUTIAO = _history.get("tableId", "")


# ── 飞书文档（品牌配置，运行时实时拉取不缓存） ──

def _doc_url(key: str) -> str:
    return (BRAND_CONFIG["docs"].get(key) or {}).get("url", "")


def _doc_name(key: str, fallback: str) -> str:
    return (BRAND_CONFIG["docs"].get(key) or {}).get("name") or fallback


# 内容标准文档（2026-09-09 停用：大纲步骤已移除，写作约束改由脚本 SOP 文档承载）
# 2026-09-18：config 中已删除 `docs.contentStandard` 项（两品牌），本常量恒为空串；
# 仅退役的 match 旧步骤（agents/material_matcher.py，主流程不经过）仍引用它。
CONTENT_STANDARD_DOC_URL = _doc_url("contentStandard")

# 脚本 SOP 文档（写稿依据，按 track 分线注入：蹭热点→热点 SOP；其他方向→非热点 SOP）
SOP_HOTSPOT_DOC_URL = _doc_url("sopHotspot")
SOP_NONHOTSPOT_DOC_URL = _doc_url("sopNonhotspot")
SOP_HOTSPOT_DOC_NAME = _doc_name("sopHotspot", "脚本SOP-热点")
SOP_NONHOTSPOT_DOC_NAME = _doc_name("sopNonhotspot", "脚本SOP-非热点")

# 策略库文档（SOP 顶部「素材取用流程」四步的取用对象：库内档位的台词公式／案例原句／角色定位等语料）
# 按 track 分线注入：蹭热点方向 → 策略库-热点；其他方向 → 策略库-非热点
LIBRARY_HOTSPOT_DOC_URL = _doc_url("libraryHotspot")
LIBRARY_NONHOTSPOT_DOC_URL = _doc_url("libraryNonhotspot")
LIBRARY_HOTSPOT_DOC_NAME = _doc_name("libraryHotspot", "策略库-热点")
LIBRARY_NONHOTSPOT_DOC_NAME = _doc_name("libraryNonhotspot", "策略库-非热点")

# 口播脚本评分标准文档（生成期**不打分**：注入用途为 ① 四类时间窗／链路四步／"传动"等定义源；
# ② 第0条红线的「处置方式」。其「使用规则」节规定 0/1/2 只对人工修改后版本打）
SCORING_STANDARD_DOC_URL = _doc_url("scoringStandard")
SCORING_STANDARD_DOC_NAME = _doc_name("scoringStandard", "口播脚本评分标准")

# 禁止红线文档（合规红线**唯一权威源**，2026-09-18 接入）：
# 两份 SOP、两份策略库、评分标准共 5 份文档的「第0条合规红线」全部指向本文，
# 但实际上红线条款正文（一票否决 10 条细则／计分项／豁免与背书登记／第五节口径表＝产品表述
# 唯一合法来源／第六节投放审核口径）此前从未被注入写稿链路——写稿侧只拿得到 SOP 里的一行摘要。
# 本次修复后随 SOP 一起注入；红线文档缺失直接报错，不降级（踩线即打回，不能靠摘要猜）。
REDLINE_DOC_URL = _doc_url("redline")
REDLINE_DOC_NAME = _doc_name("redline", "禁止红线")


def get_settings() -> Settings:
    return Settings()
