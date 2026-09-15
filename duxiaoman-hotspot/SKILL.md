---
name: duxiaoman-hotspot
description: "度小满热点抓取工作流。从抖音/小红书/快手/微博/B站/政策解读/抖音头部达人采集全网热点，用 AI 判断是否符合度小满时事政策热点（金融经济、民生经济、和钱相关、普罗大众相关），并为符合的热点选语义锚点、数转折跳数、按跳数定植入方式（直接阐述/隐喻植入/仅蹭热度），写入飞书热点素材表；支持手动精筛——对入表热点做抖音搜索点赞定级（优秀/良好/一般/劣质）并回填评分。触发词：热点抓取、度小满热点、跑热点、精筛第N行、热点筛选、热点入表。"
agent_created: true
---

# 度小满热点抓取工作流

## 概述

围绕度小满品牌内容植入需求，从全网热点中发现"时事政策热点"（金融经济/民生经济、和普罗大众钱袋子相关），为符合的热点选语义锚点、数转折跳数、按跳数定植入方式，写入飞书热点素材表；支持手动精筛做优秀度检验。

**四段流程对应三个脚本**：

| 阶段 | 脚本 | 动作 |
|------|------|------|
| ① 数据源采集 | `scripts/hotspot_collect.js` | 媒体5平台热榜 + 政策解读 + 6达人近3天视频 |
| ② 符合度判断+锚点跳数+入表 | `scripts/hotspot_filter.js` | AI 判断是否符合 → 选锚点 → 数跳数 → 定植入方式 → 生成植入策略 → 写飞书11字段 |
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

符合的热点由 AI 按判例的推理风格生成植入策略，写入素材表"植入方向"字段。

## 转折判据：语义锚点 + 跳数（2026-09-15 新增）

判"能不能植入"不再靠"关联性强不强"这种模糊描述，改成两个可复现的数：**锚点**和**跳数**。

**语义锚点** = 热点与「借钱」共用的语义公共项，候选池闭口为 6 个：
`钱 / 收入 / 支出 / 借贷 / 征信 / 被骗`

**转折跳数** = 从热点到「借钱需求」需要显式说出来的转折次数。三条硬规则：

| 规则 | 说明 |
|------|------|
| 终点是「借钱」，不是品牌名 | 度小满本身就是借钱渠道，属同义替换，**不计跳**（把品牌算一跳会凭空放大难度） |
| 先定锚点，再数跳数 | 数出 ≥2 跳时先回头换一个更近的锚点重数，而不是直接放弃——很多时候不是热点太远，是锚点选远了 |
| 区分显式跳转 / 隐含前提 | 只有显式跳转计跳；隐含前提（如"人都有支出"）不计跳，但**不能真删**，要在转折句里一笔带过，否则会出现"刚说你有钱、转头让你借钱"的逻辑断裂 |

**跳数 → 植入方式**（代码硬判定，不采信 AI 自我判断）：

| 跳数 | 植入方式 | 处理 |
|------|---------|------|
| 0 | 直接阐述 | 概念同源，热点本身就是借钱话题，直接讲产品（例：贷款贴息） |
| 1 | 隐喻植入 | 标准做法，一次转折（例：数字人民币→利息收入→借钱） |
| ≥2 | 仅蹭热度 | 只借热度做泛内容，**不生成植入策略**（植入方向留空） |

## 到期复查机制（2026-09-15 新增）

汰换**不是删除**，是"到期做一次状态复查"，复查口径由热点类型决定：

| 热点类型 | 复查间隔 | 到期动作 |
|---------|---------|---------|
| 平台热榜 | +3 天 | **冷却淘汰**：到期直接下线，不复查（热榜多数 24–72h 见顶） |
| 时事政策 | +7 天 | **状态复查**：查有无新进展（细则落地/执行日/官方解读），有则续期。政策有"起–落–执行"三段，硬砍 7 天会丢掉执行期的第二波流量 |
| 头部达人 | +7 天 | **活跃度复查**：看该达人是否仍在系统性讲同一话题，是则保留 |

类型由 `classifyHotspotType()` 按 platform 判定：`gov/gov_jiedu/gov_zhengce` → 时事政策；`douyin_creator` → 头部达人；其余 → 平台热榜（source 关键词兜底）。

## 素材表字段（飞书「热点素材表」，11 字段）

| 字段 | 类型 | 写入阶段 |
|------|------|---------|
| 热点ID | text | 自动筛选（格式 `来源_日期_短述`） |
| 热点标题 | text | 自动筛选 |
| 热点概述 | text | 自动筛选（植入策略 + **转折判定依据**：锚点/跳数/转折路径/隐含前提 + 溯源信息） |
| 热点类型 | select | 自动筛选（时事政策 / 平台热榜 / 头部达人） |
| **语义锚点** | select | 自动筛选（钱/收入/支出/借贷/征信/被骗） |
| **转折跳数** | number | 自动筛选（整数，算到「借钱」为止） |
| **植入方式** | select | 自动筛选（直接阐述 / 隐喻植入 / 仅蹭热度） |
| 植入方向 | text | 自动筛选（AI 植入策略；仅蹭热度时留空） |
| 入库时间 | datetime | 自动筛选（当天） |
| **到期复查日** | datetime | 自动筛选（入库日 +3 或 +7，按热点类型） |
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
| `JUDGE_CONCURRENCY` | AI 判断并发数（2026-09-09 由串行改为并发限流，失败自动重试1次） | `6` |

复制 `.env.example` 为 `.env` 填入实际密钥即可。

## 执行方式

### 一条命令跑完采集+判断+入表

```bash
node scripts/hotspot_filter.js
```

这一条命令会自动完成：
1. 调用 `hotspot_collect.js` 采集全网热点（6渠道+达人）
2. AI 判断每个热点是否符合度小满时事政策热点
3. 对符合的热点选语义锚点、数转折跳数、按跳数定植入方式并生成植入策略
4. 按素材表 11 字段写入飞书热点素材表（素材评分留空；到期复查日按热点类型自动 +3/+7 天）

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
  "hop_distribution": [{ "hops": 0, "count": 1 }, { "hops": 1, "count": 4 }],
  "type_distribution": { "时事政策": 3, "平台热榜": 2 },
  "fit_hotspots": [{
    "hot_id": "...", "topic": "...", "platform": "gov_jiedu",
    "hotspot_type": "时事政策", "anchor": "钱", "hops": 1,
    "placement": "隐喻植入", "hop_path": "数字人民币（利息收入）→ 借钱需求",
    "review_date": "2026-09-22", "strategy": "..."
  }],
  "not_fit": [{ "topic": "...", "reason": "..." }],
  "bitable_write": { "success": 5 }
}
```

stdout 之外，stderr 会打印三行汇总便于肉眼核对口径是否漂移：

```
📊 跳数分布：0 跳 1 条 | 1 跳 5 条
📊 热点类型：时事政策 3 条 | 平台热榜 2 条 | 头部达人 1 条
📊 植入方式：直接阐述 1 | 隐喻植入 5 | 仅蹭热度 0
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
- **热度取双时点算增速**：当前是单次采集，只有一个热度值，无法区分"50 万已见顶"和"8 万但 6 小时涨 3 倍"。判定应改为「热度分位 + 增速」双条件，需要采集时打两个时间戳
- **到期复查自动化**：目前「到期复查日」只是写入字段，还没有脚本消费它。后续可加 `hotspot_review.js`，扫到期记录，按类型跑对应复查动作（热榜冷却下线 / 政策查新进展 / 达人查活跃度）
- **达人内容双落地**：达人热点现在只当话题线索走同一套复查。按方法论，达人的"表达方式"（钩子/句式/结构）属策略素材，应另进策略库且不汰换——可对接 strategy-review 的漏斗
