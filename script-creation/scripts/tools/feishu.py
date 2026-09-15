"""飞书多维表格数据匹配式拉取（通过 lark-cli subprocess）。

与旧版的区别：不再"拉固定数量全量数据"，而是根据匹配条件
（达人类型、关键词）用 lark-cli 的 --filter-json / --sort-json
在服务端筛选，只拉取命中的记录。

lark-cli --json 返回结构：
{
  "ok": true,
  "data": {
    "data": [[行1字段值...], [行2字段值...]],  # 二维数组
    "fields": ["字段名1", "字段名2", ...],       # 列名
    "record_id_list": ["recXXX", ...],            # 记录 ID
    "has_more": true
  }
}
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess

from config.settings import (
    FEISHU_HISTORY_BASE,
    FEISHU_HISTORY_TABLE_TOUTIAO,
    FEISHU_HOTSPOT_BASE,
    FEISHU_HOTSPOT_TABLE,
    FEISHU_MATERIALS_BASE,
    FEISHU_MATERIALS_TABLE,
    FEISHU_STRATEGY_BASE,
    FEISHU_STRATEGY_TABLE,
)

logger = logging.getLogger(__name__)

_ENV = {
    "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1",
    "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1",
    "LARK_CLI_NO_PROXY_WARN": "1",
    **os.environ,
}


def _lark_cli(*args: str, timeout: int = 30) -> dict:
    """调用 lark-cli 并返回解析后的 JSON。"""
    cmd = ["lark-cli", *args, "--json"]
    result = subprocess.run(
        cmd, capture_output=True, text=True, env=_ENV, timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"lark-cli 失败 (exit={result.returncode}): {result.stderr[:500]}"
        )
    return json.loads(result.stdout)


def _parse_response(resp: dict) -> list[dict]:
    """将 lark-cli --json 的二维数组响应解析为 dict 列表。"""
    data = resp.get("data", {})
    field_names: list[str] = data.get("fields", [])
    rows: list[list] = data.get("data", [])
    record_ids: list[str] = data.get("record_id_list", [])

    records: list[dict] = []
    for i, row in enumerate(rows):
        record: dict[str, str] = {}
        for j, val in enumerate(row):
            if j < len(field_names) and val is not None:
                record[field_names[j]] = _simplify(val)
        if i < len(record_ids):
            record["_record_id"] = record_ids[i]
        records.append(record)
    return records


def _simplify(val) -> str:
    """将飞书字段值简化为字符串。"""
    if isinstance(val, str):
        return val
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, list):
        texts = []
        for item in val:
            if isinstance(item, str):
                texts.append(item)
            elif isinstance(item, dict):
                texts.append(item.get("text", item.get("name", str(item))))
            else:
                texts.append(str(item))
        return " ".join(texts)
    if isinstance(val, dict):
        return val.get("text", val.get("name", str(val)))
    return str(val)


def fetch_materials_by_type(
    material_match_text: str,
    limit: int = 30,
) -> list[dict]:
    """网络素材库按达人类型标准匹配拉取。

    规则：
    - "适配达人" contains "达人类型：一级-二级"（与标准文档统一的精确标注）
    - 标准来源：references/influencer-type-standard.md

    Args:
        material_match_text: 形如 "达人类型：财经-泛财经" 的匹配文本
        limit: 返回上限
    """
    if not material_match_text:
        logger.warning("素材库: 无类型匹配文本，返回空")
        return []

    filter_json = {
        "logic": "and",
        "conditions": [["适配达人", "contains", material_match_text]],
    }
    d = _lark_cli(
        "base", "+record-list",
        "--base-token", FEISHU_MATERIALS_BASE,
        "--table-id", FEISHU_MATERIALS_TABLE,
        "--filter-json", json.dumps(filter_json, ensure_ascii=False),
        "--limit", str(limit),
        "--as", "user",
    )
    records = _parse_response(d)
    logger.info("网络素材库: 按类型 %s 命中 %d 条记录", material_match_text, len(records))
    return records


def fetch_strategy_table(limit: int = 200) -> list[dict]:
    """创意策略表全量拉取（directions 步骤的驱动源）。

    表字段：内容方向一/二（select）、策略等级、内容一方向定义、
    植入策略、适合达人、正向案例、素材链接ids。
    """
    d = _lark_cli(
        "base", "+record-list",
        "--base-token", FEISHU_STRATEGY_BASE,
        "--table-id", FEISHU_STRATEGY_TABLE,
        "--limit", str(limit),
        "--as", "user",
    )
    records = _parse_response(d)
    logger.info("创意策略表: 拉取 %d 条策略记录", len(records))
    return records


def fetch_hotspot_table(limit: int = 200) -> list[dict]:
    """热点素材库全量拉取（蹭热点线创意方向来源）。

    表字段：热点ID/热点标题/热点概述/热点类型/植入方向/入库时间/素材评分。
    排序（素材评分降序）在调用方处理——评分是 select 文本（优秀/良好/一般/劣质），
    服务端排序语义不可靠，本地按定级顺序排。
    """
    d = _lark_cli(
        "base", "+record-list",
        "--base-token", FEISHU_HOTSPOT_BASE,
        "--table-id", FEISHU_HOTSPOT_TABLE,
        "--limit", str(limit),
        "--as", "user",
    )
    records = _parse_response(d)
    logger.info("热点素材库: 拉取 %d 条热点记录", len(records))
    return records


def fetch_materials_by_ids(material_ids: list[str]) -> list[dict]:
    """网络素材库按「素材id」列表反查素材（策略行素材链接ids 的回查源）。

    Args:
        material_ids: 形如 ["dy_xxx", "dy_yyy"] 的素材 id 列表
    """
    if not material_ids:
        return []
    records: list[dict] = []
    # 「素材id」是 text 字段，contains 只支持字符串值 → 逐 id 查询后合并
    for mid in material_ids:
        filter_json = {
            "logic": "and",
            "conditions": [["素材id", "contains", mid]],
        }
        d = _lark_cli(
            "base", "+record-list",
            "--base-token", FEISHU_MATERIALS_BASE,
            "--table-id", FEISHU_MATERIALS_TABLE,
            "--filter-json", json.dumps(filter_json, ensure_ascii=False),
            "--limit", "5",
            "--as", "user",
        )
        records.extend(_parse_response(d))
    logger.info("网络素材库: 按 ids 反查命中 %d/%d 条", len(records), len(material_ids))
    return records


def fetch_history_toutiao_by_types(
    daren_types: list[str],
    limit: int = 30,
) -> list[dict]:
    """历史数据库-头条匹配拉取。

    规则：
    - "达人类型" intersects 任一达人类型候选
    - 按"星推比"降序排序（星推比越高越优先）

    Args:
        daren_types: 达人类型候选（select 选项）
        limit: 返回上限
    """
    if not daren_types:
        logger.warning("历史库(头条): 无达人类型候选，返回空")
        return []

    filter_json = {"logic": "and", "conditions": [["达人类型", "intersects", daren_types]]}
    sort_json = [{"field": "星推比", "desc": True}]
    d = _lark_cli(
        "base", "+record-list",
        "--base-token", FEISHU_HISTORY_BASE,
        "--table-id", FEISHU_HISTORY_TABLE_TOUTIAO,
        "--filter-json", json.dumps(filter_json, ensure_ascii=False),
        "--sort-json", json.dumps(sort_json, ensure_ascii=False),
        "--limit", str(limit),
        "--as", "user",
    )
    records = _parse_response(d)
    logger.info("历史库(头条): 按达人类型命中 %d 条记录", len(records))
    return records


def fetch_doc_content(doc_url: str, timeout: int = 60) -> str:
    """拉取飞书文档正文并转为纯文本。

    用 XML 格式拉取（markdown 格式对表格转换有丢字问题），
    表格按行拼接为"单元格 | 单元格"文本。

    Args:
        doc_url: 飞书文档链接
        timeout: subprocess 超时秒数
    """
    cmd = [
        "lark-cli", "docs", "+fetch",
        "--doc", doc_url,
        "--doc-format", "xml",
        "--as", "user",
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, env=_ENV, timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"lark-cli docs fetch 失败 (exit={result.returncode}): {result.stderr[:500]}"
        )
    # stdout 可能带 [lark-cli] WARN 前缀行，需过滤后再解析 JSON
    stdout_lines = [
        l for l in result.stdout.split("\n") if not l.startswith("[lark-cli]")
    ]
    data = json.loads("\n".join(stdout_lines))
    content = data["data"]["document"]["content"]
    return _doc_xml_to_text(content)


def _doc_xml_to_text(content: str) -> str:
    """将文档 XML 正文转为可读纯文本：表格转行文本，其余保留段落换行。"""

    def table_repl(m: "re.Match[str]") -> str:
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(0), re.S)
        lines = []
        for r in rows:
            cells = [
                re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c)).strip()
                for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)
            ]
            lines.append(" | ".join(cells))
        return "\n" + "\n".join(lines) + "\n"

    text = re.sub(r"<table[^>]*>.*?</table>", table_repl, content, flags=re.S)
    text = re.sub(r"</(p|h[1-9]|li)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
