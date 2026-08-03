# 飞书多维表格配置

## 表格信息

| 属性 | 值 | 环境变量 |
|------|------|----------|
| Base 名称 | 度小满-网络素材库 | — |
| Base Token | （通过环境变量配置） | `BITABLE_BASE_TOKEN` |
| Table ID | （通过环境变量配置） | `BITABLE_TABLE_ID` |
| View ID | `vew48Iyxek` | — |

## 字段映射

| 字段名 | 字段 ID | 类型 | 写入内容 |
|--------|---------|------|----------|
| 素材id | `fldwVHl75N` | text | `dy_` + aweme_id |
| 素材渠道 | `fldmmIORlA` | select | `抖音`（选项已存在） |
| 关键词 | — | text | 搜索该素材时使用的关键词 |
| 素材链接 | `fld1Z0XXyY` | text | `https://www.douyin.com/video/` + aweme_id |
| 素材脚本文案 | `fldtV7VsGp` | text | video_script.js 提取的完整台词 |
| 内容方向 | `fldjSH90xr` | text | 分析结果的"内容方向"字段 |
| 内容分析 | `fldV6b9qrz` | text | 分析结果的"素材逻辑分析"字段 |
| 广告可借鉴点 | `fldcpPBrPA` | text | 分析结果的"对度小满的借鉴" + "植入修改建议"合并 |
| 更新时间 | `fldTeYhJxo` | datetime | 写入日期字符串 `yyyy/MM/dd`（如 `2026/08/03`） |
| 适配达人类型 | `fldghRpznP` | text | （暂不写入，后续补充） |

## 去重规则

查询"素材id"字段，筛选已存在的记录。抖音素材 ID 格式为 `dy_<aweme_id>`。

> 以上所有操作（查重、写入、通知）均已集成到 `run_workflow.js` 中，通过 `child_process.execFileSync` 自动调用 lark-cli 完成，无需手动执行。

### lark-cli 命令（参考，脚本内部自动调用）

```bash
# 查询已有素材 ID（用于去重）
lark-cli base +record-list \
  --base-token "$BITABLE_BASE_TOKEN" \
  --table-id "$BITABLE_TABLE_ID" \
  --field-id "素材id" \
  --limit 200 \
  --as user --format json

# 写入新记录（JSON 文件需在当前目录下，用 @./ 引用）
lark-cli base +record-batch-create \
  --base-token "$BITABLE_BASE_TOKEN" \
  --table-id "$BITABLE_TABLE_ID" \
  --json @./bitable_payload.json \
  --as user --yes --format json
```

### 写入 JSON 格式

```json
{
  "create_records": [
    {
      "素材id": "dy_7604166385288092755",
      "素材渠道": "抖音",
      "关键词": "朋友借钱不还怎么办",
      "素材链接": "https://www.douyin.com/video/7604166385288092755",
      "素材脚本文案": "脚本内容...",
      "内容方向": "内容方向...",
      "内容分析": "分析内容...",
      "广告可借鉴点": "借鉴点...\n\n植入建议...",
      "更新时间": "2026/08/03"
    }
  ]
}
```

> 注意：`create_records` 中字段直接平铺，不需要 `fields` 层。`--json` 的 `@file` 必须是相对路径。

## 素材渠道选项

| 渠道 | 状态 |
|------|------|
| 抖音 | ✅ 已支持 |
| 小红书 | 🔲 待补充 |
| 微信 | 🔲 待补充 |
