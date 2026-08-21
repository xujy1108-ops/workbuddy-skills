---
name: duxiaoman-hotspot
description: "度小满热点抓取工作流。从抖音/小红书/快手/微博/B站/政策解读/抖音头部达人采集全网热点，用 AI 判断是否符合度小满时事政策热点（金融经济、民生经济、和钱相关、普罗大众相关），为符合的热点生成植入策略并写入飞书热点素材表；支持手动精筛——对入表热点做抖音搜索点赞定级（优秀/良好/一般/劣质）并回填评分。触发词：热点抓取、度小满热点、跑热点、精筛第N行、热点筛选、热点入表。"
agent_created: true
---

# 度小满热点抓取工作流

## 概述

围绕度小满品牌内容植入需求，从全网热点中发现"时事政策热点"（金融经济/民生经济、和普罗大众钱袋子相关），为符合的热点生成植入策略并写入飞书热点素材表；支持手动精筛做优秀度检验。

**四段流程对应四个脚本**：

| 阶段 | 脚本 | 动作 |
|------|------|------|
| ① 数据源采集 | `scripts/hotspot_collect.js` | 媒体5平台热榜 + 政策解读 + 6达人近3天视频 |
| ② 符合度判断+入表 | `scripts/hotspot_filter.js` | AI 判断是否符合 + 生成植入策略 + 写飞书7字段 |
| ③ 优秀度精筛 | `scripts/hotspot_refine.js` | 抖音搜热点→按点赞排序→前20条近7天+点赞>1万占比定级→回填评分 |

## 数据源

| 来源 | 渠道 | 接口 |
|------|------|------|
| 抖音实时+飙升热点 | TikHub | `/api/v1/douyin/index/fetch_current_hot_topic` |
| 小红书热门灵感 | TikHub | `/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed` |
| 快手热榜 | TikHub | `/api/v1/kuaishou/web/fetch_kuaishou_hot_list_v2` |
| 微博热搜 | TikHub | `/api/v1/weibo/app/fetch_hot_search` |
| B站综合热门 | TikHub | `/api/v1/bilibili/web/fetch_com_popular` |
| 政策解读 | gov.cn 官方JSON | `zhengce/jiedu/ZCJD_QZ.json` |
| 抖音头部达人视频 | TikHub | `get_sec_user_id` → `fetch_user_post_videos`（6达人见 `scripts/hotspot_creators.json`） |

## 符合度判断标准（度小满需求文档第二部分）

两条硬条件必须同时满足：
1. **领域**：金融经济、民生经济相关。排除娱乐、网络游戏及赛事、汽车、美妆、时尚等非金融经济领域。
2. **受众与相关性**：和普罗大众相关且和钱直接/间接相关（养老、公积金、社保、国补、投资市场新政策、借贷、利率、税收、消费补贴等）。排除美国伊朗打仗、日韩摩擦等与普通人钱袋子无关的宏大叙事。

符合的热点由 AI 按 3 个示例（数字人民币/借贷新规/小额快救）的推理风格生成植入策略，写入素材表"植入方向"字段。

## 素材表字段（飞书「热点素材表」，7字段）

| 字段 | 类型 | 写入阶段 |
|------|------|---------|
| 热点ID | text | 自动筛选（格式 `来源_日期_短述`） |
| 热点标题 | text | 自动筛选 |
| 热点概述 | text | 自动筛选（含植入策略 + 溯源信息：平台/热度/链接/采集时间） |
| 热点类型 | select | 自动筛选（符合的统一填"时事政策"） |
| 植入方向 | text | 自动筛选（AI 植入策略） |
| 入库时间 | datetime | 自动筛选（当天） |
| 素材评分 | select | **手动精筛回填**（优秀/良好/一般/劣质） |

## 优秀度检验标准（度小满需求文档第三部分）

在抖音搜索该热点 → 仅视频 → 按点赞排序 → 取前 20 条 → 统计其中"近 7 天发布 且 点赞 > 1 万"的数量：

| 数量 | 评级 |
|------|------|
| ≥10 | 优秀 |
| 5-9 | 良好 |
| 3-5（含5） | 一般 |
| <3 | 劣质 |

## 前置条件

- **飞书连接器**：已连接（lark-cli 可用），用于读写热点素材表
- **Node.js**：已安装（运行脚本）
- **TikHub API 令牌**：媒体平台热点 + 达人视频 + 抖音搜索
- **AIHubMix API 密钥**：AI 符合度判断与植入策略生成

## 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `AIHUBMIX_API_KEY` | AIHubMix API 密钥 | 无（必填，filter 用） |
| `AIHUBMIX_BASE_URL` | AIHubMix API 地址 | `https://api.inferera.com/v1` |
| `TIKHUB_TOKEN` | TikHub API 令牌 | 无（采集/精筛用） |
| `TIKHUB_BASE_URL` | TikHub API 地址 | `https://api.tikhub.io` |
| `HOTSPOT_BASE_TOKEN` | 热点素材表 Base Token | `STMrbQgqma35dksI3WsclJlNnlc` |
| `HOTSPOT_TABLE_ID` | 热点素材表 Table ID | `tblDpxkM7psozqeO` |
| `DEEPSEEK_MODEL` | AI 判断模型 | `deepseek-v4-pro` |

复制 `.env.example` 为 `.env` 填入实际密钥即可。

## 执行方式

### 一条命令跑完采集+判断+入表

```bash
node scripts/hotspot_filter.js
```

这一条命令会自动完成：
1. 调用 `hotspot_collect.js` 采集全网热点（6渠道+达人）
2. AI 判断每个热点是否符合度小满时事政策热点
3. 对符合的热点生成植入策略
4. 按素材表 7 字段写入飞书热点素材表（素材评分留空）

### 仅采集不判断（观察数据源）

```bash
node scripts/hotspot_collect.js --channels douyin,xhs,kuaishou,weibo,bilibili,gov,creator --top 10
```

### 用已采集结果做判断（节省采集成本）

```bash
node scripts/hotspot_filter.js --input /path/to/collect_output.json
```

### 干跑判断不入表（观察 AI 判断质量）

```bash
node scripts/hotspot_filter.js --dry-run
```

### 手动精筛第 N 行（优秀度检验+回填评分）

```bash
node scripts/hotspot_refine.js --row 23
```

读取素材表第 23 行热点 → 抖音搜索按点赞排序 → 前 20 条统计 → 回填"素材评分"。

### 精筛但不回填（只看结果）

```bash
node scripts/hotspot_refine.js --row 23 --dry-run
```

## 输出格式

JSON 输出到 stdout，进度日志输出到 stderr。

**hotspot_filter.js 输出**：
```json
{
  "captured_at": "...",
  "total_judged": 20,
  "total_fit": 5,
  "fit_hotspots": [{ "hot_id": "...", "topic": "...", "strategy": "..." }],
  "not_fit": [{ "topic": "...", "reason": "..." }],
  "bitable_write": { "success": 5 }
}
```

**hotspot_refine.js 输出**：
```json
{
  "row": 23,
  "record_id": "...",
  "title": "...",
  "total_searched": 20,
  "qualified_count": 12,
  "grade": "优秀",
  "videos": [{ "title": "...", "digg_count": 50000, "qualified": true }],
  "bitable_update": { "success": true }
}
```

## 参考文档

- [`references/prompts.md`](references/prompts.md) — AI 符合度判断与植入策略生成的完整 prompt
- [`scripts/hotspot_creators.json`](scripts/hotspot_creators.json) — 6 个抖音头部达人清单

## 后续扩展

- 知乎/头条等热点源补充
- 植入策略多版本生成与 A/B 测试
- 精筛支持批量行号（一次精筛多行）
- 热点历史趋势追踪（同热点多日热度变化）
