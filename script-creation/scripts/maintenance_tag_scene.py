"""素材库「场景」字段回填脚本。

用途：网络素材库（tblYEQ0raRDrB4tb）的「场景」多选字段，用 AI 从「素材脚本文案」
判定场景标签，回填历史素材；新素材入库时由 creative-content-analysis 管道自动打标。

用法（在 scripts 目录下运行）：
    python maintenance_tag_scene.py --dry-run   # 只判定并打印结果，不写回
    python maintenance_tag_scene.py             # 判定并写回飞书
    python maintenance_tag_scene.py --all       # 覆盖已有场景（默认只补空缺）
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config.settings import FEISHU_MATERIALS_BASE, FEISHU_MATERIALS_TABLE  # noqa: E402
from providers.llm import run_llm  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("tag_scene")

# 与飞书字段选项严格一致（fldKapI96Z「场景」多选）
SCENE_OPTIONS = [
    "对镜口播", "酒席饭桌", "居家室内", "职场办公", "户外街头",
    "店铺商户", "车内出行", "线上通话", "工地工厂", "其他",
]

_ENV = {
    "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1",
    "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1",
    "LARK_CLI_NO_PROXY_WARN": "1",
    **os.environ,
}

_TAG_PROMPT = f"""你是短视频素材标注员。给定若干条素材（含 素材id 与 素材脚本文案），
为每条素材判定「场景」标签——即该视频画面/情节发生在哪里。

## 可选标签（只能从中选，可多选，一条素材可跨多个场景）
{json.dumps(SCENE_OPTIONS, ensure_ascii=False)}

## 判定规则
1. 只依据素材脚本文案中出现的场景动作/地点线索（如"酒席上""从单元门走出""办公室""在电话里"）；
2. **全片为博主/讲师/女主等对镜讲述、无任何场景情节的 → 「对镜口播」**（这是最常见的一类，
   不要把纯口播归入「其他」）；
3. 一条素材若跨越多个场景（如先在家、再到办公室），列出全部命中场景；
4. 文案信息不足以判断具体场所、但也不是纯对镜口播的 → 「其他」，不要编造具体场景；
5. 场景是"物理/情境发生地"，不是内容主题——不要输出"借钱""职场故事"这类主题词。

## 输出（严格 JSON 数组，禁止 markdown 包裹）
[{{"素材id": "dy_xxx", "场景": ["居家室内"]}}]
"""


def _dump_records() -> list[dict]:
    """导出素材库全表为 JSON 记录列表（lark-cli --output 仅允许 cwd / /tmp / ~/files）。"""
    path = "/tmp/materials_dump.ndjson"
    Path(path).unlink(missing_ok=True)  # lark-cli 拒绝覆盖已存在文件，需先删
    subprocess.run(
        ["lark-cli", "base", "+record-list",
         "--base-token", FEISHU_MATERIALS_BASE,
         "--table-id", FEISHU_MATERIALS_TABLE,
         "--format", "ndjson", "--output", path, "--limit", "2000", "--overwrite"],
        capture_output=True, text=True, env=_ENV, timeout=120, check=True,
    )
    records = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    logger.info("素材库: 导出 %d 条记录", len(records))
    return records


def _as_text(val) -> str:
    if val is None:
        return ""
    if isinstance(val, list):
        return " ".join(
            (v.get("text") or v.get("name") or "") if isinstance(v, dict) else str(v)
            for v in val
        ).strip()
    return str(val).strip()


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _tag_batch(batch: list[dict]) -> dict[str, list[str]]:
    """一批素材交给 LLM 判定场景，返回 {素材id: [场景]}。"""
    payload = [
        {"素材id": r.get("素材id"), "素材脚本文案": _as_text(r.get("素材脚本文案"))[:1200]}
        for r in batch
    ]
    result = run_llm(
        agent_name="scene-tagger",
        system=_TAG_PROMPT,
        user_text=json.dumps(payload, ensure_ascii=False, indent=2),
        max_tokens=2048,
        temperature=0.0,  # 打标需可复现，禁止随机性
    )
    text = result.text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip().startswith("```") else lines[1:])
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("批次解析失败，跳过: %s", text[:200])
        return {}
    out: dict[str, list[str]] = {}
    for item in data:
        sid = item.get("素材id")
        scenes = [s for s in (item.get("场景") or []) if s in SCENE_OPTIONS]
        if sid and scenes:
            out[sid] = scenes
    return out


def _write_back(mapping: dict[str, list[str]], record_by_sid: dict[str, str]) -> int:
    """按 record_id 批量写回「场景」字段。"""
    updates = {
        record_by_sid[sid]: {"场景": scenes}
        for sid, scenes in mapping.items() if sid in record_by_sid
    }
    if not updates:
        return 0
    written = 0
    for chunk in _chunks(list(updates.items()), 50):
        payload = {"update_records": dict(chunk)}
        proc = subprocess.run(
            ["lark-cli", "base", "+record-batch-update",
             "--base-token", FEISHU_MATERIALS_BASE,
             "--table-id", FEISHU_MATERIALS_TABLE,
             "--json", json.dumps(payload, ensure_ascii=False),
             "--format", "json"],
            capture_output=True, text=True, env=_ENV, timeout=120,
        )
        if proc.returncode != 0 or '"ok": true' not in proc.stdout.replace(" ", " "):
            logger.error("写回失败: %s", (proc.stdout or proc.stderr)[:300])
            continue
        written += len(chunk)
    return written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只判定不写回")
    ap.add_argument("--all", action="store_true", help="覆盖已有场景（默认只补空缺）")
    ap.add_argument("--batch-size", type=int, default=8)
    args = ap.parse_args()

    records = _dump_records()
    record_by_sid = {_as_text(r.get("素材id")): r.get("record_id") for r in records}

    targets = []
    for r in records:
        sid = _as_text(r.get("素材id"))
        has_scene = bool(r.get("场景"))
        if not sid or not _as_text(r.get("素材脚本文案")):
            continue
        if has_scene and not args.all:
            continue
        targets.append(r)

    logger.info("待标注: %d 条（跳过已有场景 %d 条 / 无文案 %d 条）",
                len(targets), len(records) - len(targets), 0)
    if not targets:
        print("无需标注")
        return

    mapping: dict[str, list[str]] = {}
    for i, batch in enumerate(_chunks(targets, args.batch_size), 1):
        got = _tag_batch(batch)
        mapping.update(got)
        logger.info("批次 %d: %d/%d 条已判定", i, len(got), len(batch))

    out_path = Path(__file__).resolve().parent / "scene_tag_mapping.json"
    existing: dict[str, list[str]] = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
    existing.update(mapping)
    out_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("判定结果已留痕（累计 %d 条）: %s", len(existing), out_path)

    # 分布统计
    from collections import Counter
    cnt = Counter(s for scenes in mapping.values() for s in scenes)
    print("场景分布:", dict(cnt.most_common()))

    if args.dry_run:
        for sid, scenes in list(mapping.items())[:10]:
            print(f"  {sid} → {scenes}")
        print("[dry-run] 未写回")
        return

    written = _write_back(mapping, record_by_sid)
    print(f"已写回 {written}/{len(mapping)} 条")


if __name__ == "__main__":
    main()
