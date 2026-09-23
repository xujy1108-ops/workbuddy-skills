---
name: strategy-review
description: "内容飞轮「复盘→沉淀」工作流（多品牌配置化）。从品牌投放数据表筛选优秀脚本（星推比阈值或转化达标），用 doubao 模型分析提取4类可复用策略素材（钩子/承接/转折/角色定位），写入飞书策略素材审核表；人工审核通过后，一键追加到该品牌的热点/非热点策略库飞书文档。支持 --brand 切换品牌（度小满 duxiaoman / 微业贷 weiyedai 骨架）。触发词：策略沉淀、素材复盘、跑策略分析、策略入池、同步策略库、策略审核表。"
agent_created: true
---

# 策略素材沉淀工作流（多品牌配置化）

## 概述

内容飞轮的"复盘→沉淀"环节：脚本上线产出投放数据 → 从数据中筛出优秀脚本 → AI 提取可复用素材 → 人工审核 → 沉淀进策略库，供创意洞察/脚本编写/大纲编写时引用。

**品牌私有内容全部外置**（品牌名、飞书表、筛选阈值、分级规则、策略库文档、AI prompt 模板），代码只保留通用流程逻辑。

## 目录结构

```
strategy-review/
├── config/
│   ├── duxiaoman/                 # 度小满（已完整可用）
│   │   ├── config.json            # 表 token / 字段名映射 / 阈值 / 分级 / 分线 / 策略库 / AI 参数
│   │   └── prompts/
│   │       ├── review.md          # 4类素材分析 prompt（含角色枚举、打法枚举）
│   │       └── sync_section.md    # 策略库追加章节模板
│   └── weiyedai/                  # 微业贷（骨架，TODO 待补）
├── scripts/
│   ├── lib/
│   │   ├── brand.js               # 品牌配置加载（--brand 解析 / .env 加载 / 模板渲染 / TODO 拦截）
│   │   └── lark.js                # lark-cli 封装（代理分治 / 字段名解析 / NDJSON 拉数 / 批写）
│   ├── strategy_review.js         # ① 筛选 + AI 分析 + 入审核表
│   └── sync_to_strategy.js        # ② 审核通过 → 追加策略库 + 状态回写
├── .env.example
└── SKILL.md
```

## 两段流程

| 阶段 | 脚本 | 动作 |
|------|------|------|
| ① 筛选+AI分析+入审核表 | `scripts/strategy_review.js` | 数据源表 → 入池筛选 → 去重 → doubao 分析4类素材 → 写审核表 |
| ② 审核通过后同步策略库 | `scripts/sync_to_strategy.js` | 读审核表"已通过"记录 → 按热点/非热点分组 → append 到策略库文档 → 回写状态"已入库" |

```
数据源表 → 筛选(星推比>阈值 或 转化达标) → AI分析 → 审核表(待审核)
                                                      ↓ 人工审核改"已通过"
                                    热点/非热点策略库文档（append + 状态回写"已入库"）
```

## 使用方法

### 1. 跑分析

```bash
cd ~/Desktop/code/workbuddy-skills/strategy-review/scripts
node strategy_review.js                  # 默认品牌 duxiaoman
node strategy_review.js --brand weiyedai # 指定品牌（config/<brand>/）
```

- `--brand` 参数 > `env WORKFLOW_BRAND` > 默认 `duxiaoman`
- `.env` 按优先级合并加载：`config/<brand>/.env` → `scripts/.env` → skill 根 `.env` → 仓库根 `.env` → `hotspot/.env`（历史共用兜底）
- 入池/分级/分线规则全部来自 `config/<brand>/config.json`，改配置不改代码
- 去重：按"源脚本ID"跳过审核表中已存在的脚本，重复跑不会重复写入
- AI 分析单条实测约 2-5 分钟（2026-09-17 实测单条 267 秒，doubao-seed-2-1-pro 生成 4 段 JSON 较慢），`ai.requestTimeoutSec` 默认 420 秒、失败重试 3 次
  - ⚠️ 120 秒下会全量超时（实测 3 次重试全败、AI 建议字段全空），不要改回 120
  - 超时/失败时该条仍会写入审核表，只是 AI 建议字段留空（便于人工补，不丢数据）
  - 串行处理：43 条候选≈3 小时。需要提速可换更快的模型（`DOUBAO_MODEL` 环境变量覆盖）或给脚本加并发
- `TEST_MODE=1 node strategy_review.js` 只分析第 1 条（调试用）
- `DRY_RUN=1 node strategy_review.js` 干跑：完整走完筛选+AI，但不写审核表（打印 payload 预览）

### 2. 人工审核

飞书多维表格打开「策略素材审核表」（与数据源表同 Base）：
- 查看/修改 AI 建议（钩子/承接/转折/角色定位 4 个字段）
- 确认"入库目标"（脚本主题含"热点"自动归热点，可手动改）
- 审核状态改为"已通过"（或"已拒绝"）

### 3. 同步到策略库

```bash
cd ~/Desktop/code/workbuddy-skills/strategy-review/scripts
node sync_to_strategy.js --brand duxiaoman
```

- 只同步审核状态="已通过"的记录
- 按入库目标 append 到对应策略库文档末尾（"待补充素材"区域，需人工归位到方法库分类）
- 成功后自动把状态回写为"已入库"，重跑不会重复追加
- `DRY_RUN=1 node sync_to_strategy.js` 干跑：打印待追加内容，不写文档、不回写状态

## 新增品牌的方法

1. 复制 `config/duxiaoman/` 为 `config/<新品牌>/`
2. 改 `config.json`：品牌名、受众、两张表的 base/table token、字段名映射、阈值、分级、策略库文档 token
3. 改 `prompts/review.md`：**角色定位枚举与打法枚举是该品牌方法库的核心资产，必须换成本品牌的**（度小满的那套不能直接复用）
4. 改 `prompts/sync_section.md`：策略库章节文案
5. 跑 `node strategy_review.js --brand <新品牌>`，配置加载器会列出所有未填的 TODO 后再放行

> 配置加载器内置 TODO 拦截：`config.json` 里任何以 `TODO` 开头的值都会让脚本报错退出并列清单，避免骨架配置被误跑。

## 品牌资产现状

| 品牌 | 状态 | 缺什么 |
|------|------|--------|
| duxiaoman（度小满） | ✅ 完整可用 | — |
| weiyedai（微业贷） | ⚠️ 骨架 | ① 投放数据源表（对应度小满"头条数据表"）② 策略素材审核表 ③ 策略库文档（热点/非热点或单库）④ 角色定位/打法枚举需按微业贷方法库确认 ⑤ 合规红线文档 |

### 度小满数据资产

| 数据 | 位置 |
|------|------|
| 头条数据表（源） | Base `IusNb2cgTafYo4sTVntcHNJHn9f`, Table `tblBEveR1P0gKRyy` |
| 策略素材审核表 | 同 Base, Table `tblX7a3YpwLExN7Z` |
| 策略库-非热点 | https://kwza968lz1u.feishu.cn/docx/BBx1dVk5aoNIn6xgON2cppNKnkb |
| 策略库-热点 | https://kwza968lz1u.feishu.cn/docx/SHdXdI0KQoJbfwxNq4mcePL5nxb |
| 策略标准文件夹 | 飞书云空间 folder `EpuLftyVvlUA0TdLSlocUjCqnRf` |

**审核表字段（10个）**：脚本主题 / 源脚本ID / 脚本文案 / AI建议-钩子 / AI建议-承接 / AI建议-转折 / AI建议-角色定位 / 评分等级(S/A/B) / 入库目标(非热点/热点) / 审核状态(待审核/已通过/已拒绝/已入库)

> 字段名（不是 field_id）写在 `config/<brand>/config.json` 的 `tables.*.fieldNames` 里，运行时用 `+field-list` 动态解析成 field_id —— 换表/改列名只需改配置。

## 环境变量（.env）

| 变量 | 说明 |
|------|------|
| AIHUBMIX_API_KEY | AIHubMix 网关 key（必需） |
| AIHUBMIX_BASE_URL | 默认 `https://api.inferera.com/v1` |
| DOUBAO_MODEL | 默认 `doubao-seed-2-1-pro` |
| WORKFLOW_BRAND | 默认品牌（`--brand` 优先级更高） |
| TOUTIAO_BASE_TOKEN / TOUTIAO_TABLE_ID / REVIEW_TABLE_ID | 度小满表覆盖（可选，不填用配置默认值） |
| WEIYEDAI_*_BASE_TOKEN / WEIYEDAI_*_TABLE_ID | 微业贷表覆盖（可选） |

## 技术要点（踩过的坑）

1. **代理分治**：本机有系统代理时，Node.js 原生 fetch 走代理会连不上 AIHubMix API（超时）。脚本做法：进程内删掉代理变量让 AI 调用走 curl 直连，调 lark-cli 时把代理变量注入子进程 env（飞书 API 需要走代理）。实现集中在 `scripts/lib/lark.js`。
2. **curl 代替 fetch**：Node fetch 在此环境下有兼容性问题，AI API 调用统一用 `execSync('curl ...')`，请求体写临时文件避免命令行长度限制。
3. **NDJSON 模式拉数据**：`+record-list --format json` 对大数据不稳，用 `--format ndjson --output <file>`，stdout 返回 manifest（含 record_file 路径），再读文件解析。
4. **文档写入权限**：`docs +update --command append` 需要 `docx:document:write_only` scope（用户已完成授权）。权限失效时报错就引导重新授权。
5. **幂等性**：两个脚本都做了去重/状态回写，重复执行不会产生脏数据。
6. **字段名驱动**：不要硬编码 field_id（度小满旧版硬编码了 5 个），统一走 `+field-list` 解析，避免换表即坏。
7. **记录主键是 `record_id`**：lark-cli NDJSON 每行是 `{record_id, 字段名: 值}`。历史代码误用 `rec._record_id`（恒为 undefined），导致「源脚本ID」全空、去重静默失效、每跑一次都重复入表。现已在 `lib/lark.js` 的 `fetchRecords` 里统一归一化，勿删。

## 策略库文档写作规范（2026-09-14 定，追加素材时必须遵守）

1. **示例只留原句**：案例/增补案例/金句/可复用表述一律只写脚本原句，**不带 `[记录号]` 前缀、不带 `（达人／主题）` 后缀**。记录号只保留在逐条对照清单 CSV 里，不进正文。
2. **同句去重**：去掉记录号后，同一句话来自多条记录会显示为重复行；同一小节内同句（忽略空白与句末标点）只列一次，条数标注写成"本轮命中 N 条，去重后列 M 条"。
3. **表格多值分隔**：单元格内多值用 `；`，不能用 `<br>`；拼多句时先 `rstrip('。')` 再连，避免出现 `。；`。
4. **编号纪律**：三套编号互不复用，引用必须写明出处——① 策略库库内打法编号（非热点库、热点库各自独立）；②《评分标准-V2》开头吸引力 A–D 四类（按吸引力来源分类）；③ 收尾打法 A/B/C/D/E。
5. **收尾编号定稿**：A 合规劝退／B 价值观升华／C 引导行动／D 引发讨论／E 劝退＋人设一句融合（2 分标杆）。旧复盘稿曾用 D 指代"融合档"，属误用。

## 合规红线：单一权威源（度小满，2026-09-14 定，必须遵守）

**红线条款只写在一份文档里，其余文档一律引用，禁止复述。**

- **唯一权威源**：《度小满-禁止红线》`docx/OYCIdmjLDoABrrxQ8fGcLxKXnkg`（一票否决 8 条＋计分项 4 条＋投放审核口径＋白名单）
- **引用方**（都只写"见《度小满-禁止红线》"+链接，不得复述条款）：《口播脚本评分标准-V2》第0条、两份《脚本SOP-V2》第五节、两份《大纲策略-热点》第五节、策略库-非热点/热点的合规章节
- **一票否决 8 条**：A1 借款不得定位为投资本金｜A2 不得超口径承诺利率｜A3 不得贬低同行｜A4 不得绝对化用语｜B1 热点不得歪曲政策｜B2 热点不得以国家队/官方身份背书担保推荐｜B3 热点不得借灾难事故蹭热度｜E1 借款用途不得写成看病/还房贷车贷/彩礼/婚房/上学
- **计分项 4 条**（不作一票否决，按维度扣分）：劝退式收尾→维度八；非热点宏大叙事→维度七；时政拉回时限→维度七；时长字数→维度六
- **白名单**：国家田径队官方合作伙伴／阿根廷国家队中国区官方合作伙伴／浪姐·《乘风2026》独家冠名——只可作事实陈述，除此以外一切背书担保推荐均禁止
- **复盘用法**：素材入池前过红文档；踩一票否决 → 不入池仅留档；计分项缺失（缺劝退收尾、绝对化用语）→ 属发稿端补件，照常入池并列入整改清单
- **改动流程**：只在红文档改 → 登记变更记录 → 通知引用方。**禁止在引用方单边改红线**（历史上就是因为三份 SOP＋评分标准各写一套，才出现"必须带国家队合作伙伴"与"只能陈述"的正面冲突）

> 微业贷需另建自己的红线文档，不得复用度小满条款；在 `config/weiyedai/` 补齐前，微业贷素材不做入池。

## 后续适配（迁移 MySQL 时）

数据源从飞书数据表迁移到 MySQL 时，只需改 `scripts/lib/lark.js` 的取数函数（或新增一个 `lib/mysql.js` 同签名实现）：
1. `fetchRecords(baseToken, tableId, fieldNames, opts)` → 改 MySQL 查询（保留筛选逻辑）
2. 写审核表 → 改 MySQL insert
3. 写策略库逻辑不变（仍用 lark-cli docs +update append）
4. 品牌配置结构不用动，只把 `tables` 段换成连接信息
