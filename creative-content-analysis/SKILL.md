---
name: creative-content-analysis
description: "度小满品牌创意素材自动分析工作流。围绕资金周转困难场景，自动生成抖音搜索关键词、搜索抖音视频、提取视频脚本、分析创意价值并同步到飞书多维表格。当用户提到创意分析、素材分析、抖音创意、跑一下创意、度小满素材等关键词时触发。当前支持抖音渠道，小红书和微信渠道后续补充。"
agent_created: true
---

# 创意内容分析工作流

## 概述

围绕"资金周转困难"核心场景，从抖音搜索真实用户内容视频，提取完整脚本，分析创意价值，为广告植入提供建议，最终将结果同步到飞书多维表格。

**一条命令跑完全流程**：查重 → 生成关键词 → 搜索抖音 → 提取脚本 → 分析创意 → 写入飞书表格 → 余额不足时发飞书通知。

当前支持 **抖音** 渠道。小红书和微信渠道后续补充。

## 前置条件

- **飞书连接器**：已连接（lark-cli 可用）
- **Node.js**：已安装（运行工作流脚本）

## 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `AIHUBMIX_API_KEY` | AIHubMix API 密钥 | 无（必填） |
| `AIHUBMIX_BASE_URL` | AIHubMix API 地址 | `https://api.inferera.com/v1` |
| `TIKHUB_TOKEN` | TikHub 抖音搜索 API 令牌 | 无（必填） |
| `BITABLE_BASE_TOKEN` | 飞书多维表格 Base Token | 无（必填） |
| `BITABLE_TABLE_ID` | 飞书多维表格 Table ID | 无（必填） |
| `DEEPSEEK_MODEL` | 关键词生成与分析模型 | `deepseek-v4-pro` |
| `DOUBAO_MODEL` | 视频脚本提取模型 | `doubao-seed-2-1-pro` |
| `WORKFLOW_CONCURRENCY` | 并行处理并发数 | `3` |

## 执行方式

### 完整运行（默认）

```bash
node scripts/run_workflow.js
```

这一条命令会自动完成全部步骤：
1. **自动查重** — 用 lark-cli 从飞书多维表格拉取已有素材 ID
2. **生成关键词** — DeepSeek 生成 2 个抖音搜索关键词
3. **搜索抖音** — TikHub API 搜索视频
4. **过滤去重** — 过滤时长 > 5 分钟、去除已有素材
5. **提取脚本** — 豆包模型转录视频台词（Promise.all 并行，并发 3）
6. **过滤禁止内容** — 跳过催收、医疗、上学等敏感场景
7. **分析创意** — DeepSeek 输出内容方向、素材逻辑、借鉴点、植入建议
8. **自动写入飞书** — lark-cli 将结果写入多维表格（含更新时间字段）
9. **余额不足通知** — 如果 API 余额耗尽，自动给飞书发消息

### 可选参数

| 参数 | 说明 |
|------|------|
| `--keywords "kw1,kw2"` | 使用自定义搜索关键词（跳过 AI 生成） |
| `--existing-ids "id1,id2"` | 手动传入已有素材 ID（跳过自动查重） |
| `--skip-bitable` | 跳过飞书多维表格读写（仅跑分析，不写入） |

### 使用自定义关键词

```bash
node scripts/run_workflow.js --keywords "急用钱不好意思开口,朋友借钱不还怎么办"
```

### 仅跑分析不写入表格

```bash
node scripts/run_workflow.js --skip-bitable
```

## 输出格式

JSON 输出到 stdout，进度日志输出到 stderr。

```json
{
  "keywords": ["关键词1", "关键词2"],
  "results": [
    {
      "aweme_id": "视频ID",
      "desc": "视频标题",
      "video_url": "https://www.douyin.com/video/视频ID",
      "script": "完整脚本内容",
      "analysis": {
        "内容方向": "...",
        "素材逻辑分析": "...",
        "对度小满的借鉴": "...",
        "植入修改建议": "..."
      }
    }
  ],
  "skipped": [
    { "aweme_id": "...", "reason": "duration_exceeded|duplicate|forbidden_content|quota_exhausted|..." }
  ],
  "failed": [
    { "aweme_id": "...", "error": "错误信息" }
  ],
  "quota_exhausted": false,
  "bitable_write": { "success": 13, "failed": 0, "errors": [] },
  "summary": {
    "total_searched": 20,
    "total_filtered": 10,
    "total_success": 13,
    "total_skipped": 5,
    "total_failed": 2,
    "bitable_success": 13,
    "bitable_failed": 0
  }
}
```

## 自动化行为说明

### 并行执行
Step 4 的视频脚本提取 + 创意分析使用 `Promise.all` 并行执行（默认并发 3）。单个任务出错不影响其他任务。

### API 余额不足处理
检测到 HTTP 402 / quota / insufficient 等错误时：
1. 设置 `quota_exhausted: true`，剩余未开始的任务自动跳过
2. 已成功的结果继续写入飞书多维表格
3. 自动给用户的飞书发消息通知（包含成功/放弃/失败数量）
4. 汇总报告中标注"API 余额不足"

### 飞书多维表格写入
脚本通过 `child_process.execFileSync` 调用 `lark-cli base +record-batch-create` 自动写入。字段映射：

| 字段名 | 写入值 |
|--------|--------|
| 素材id | `dy_` + aweme_id |
| 素材渠道 | `抖音` |
| 素材链接 | `https://www.douyin.com/video/` + aweme_id |
| 素材脚本文案 | script 字段完整内容 |
| 内容方向 | analysis.内容方向 |
| 内容分析 | analysis.素材逻辑分析 |
| 广告可借鉴点 | analysis.对度小满的借鉴 + "\n\n" + analysis.植入修改建议 |
| 更新时间 | 写入时的日期（yyyy/MM/dd 格式字符串） |

## 汇总报告

脚本执行完毕后，AI 向用户展示：
- 搜索关键词
- 搜索到的视频总数
- **成功**：N 条（已写入表格）— 列出标题 + 链接
- **被放弃**：M 条 — 列出原因（时长超限 / 重复 / 禁止内容 / 余额不足未开始）
- **执行失败**：K 条 — 列出错误信息
- 飞书写入结果
- 如果 `quota_exhausted: true`，标注"⚠️ API 余额不足，工作流提前终止"

## 单独使用视频脚本提取

如只需提取单个视频的脚本（不跑完整工作流），可直接使用 `scripts/video_script.js`：

```bash
node scripts/video_script.js "https://视频下载链接"
```

该脚本支持远程 URL 和本地文件路径。直传链接失败时会自动下载视频到本地，以 base64 方式重试。

## 参考文档

- [`references/prompts.md`](references/prompts.md) — 全部 LLM 提示词（关键词生成、脚本提取、创意分析）
- [`references/bitable_config.md`](references/bitable_config.md) — 飞书多维表格字段映射

## 后续扩展

- **小红书渠道**：补充小红书搜索 API 接入，素材 ID 前缀 `xhs_`，素材渠道选择"小红书"
- **微信渠道**：补充微信视频号搜索，素材 ID 前缀 `wx_`，素材渠道选择"微信"
- **关键词去重**：记录历史搜索关键词，避免一周内重复
- **适配达人类型**：分析脚本内容，自动推荐适合的达人类型
