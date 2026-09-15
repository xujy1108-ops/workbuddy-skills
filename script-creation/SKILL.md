---
name: script-creation
description: "短视频脚本创作 skill — 接收达人风格 JSON，创意策略表驱动生成创意方向（蹭热点/其他方向分线），选方向后按脚本 SOP 文档（热点/非热点）直出逐字稿并按评分标准 V2 打分，产出可投放的短视频脚本。"
version: 2.0.0
author: user
---

# 脚本创作 Skill

## 概述

基于达人风格分析结果，由创意策略多维表格驱动生成创意方向，用户选方向后按脚本 SOP 文档（热点/非热点分线）直接产出完整口播逐字稿并评分。

**前置依赖**：需要先使用 `influencer-style-analysis` skill 获得达人风格 JSON（含 `career_identity` 职业身份核实字段）。

## 触发条件

当用户提到"脚本创作""写脚本""创作脚本""script-creation"等关键词时触发。

## 工作流（步骤 directions → 交互点 1 → 步骤 scripts → 交互点 2，2026-09-09 改造：大纲步骤已移除）

### 前置：接收输入

用户需要提供：
1. **达人风格 JSON**（来自 influencer-style-analysis skill 的输出，含 career_identity）
2. **用户手动创意方向**（可选，仅 match 旧步骤使用）

将达人风格 JSON 保存为临时文件，例如 `{工作目录}/style.json`。

### 步骤 1（流程步骤 3）：创意策略表驱动生成 5 个创意方向

执行命令：

```bash
cd {SKILL_ROOT}/scripts && {PYTHON} run.py \
  --step directions \
  --style {工作目录}/style.json \
  --output step3_directions.json
```

**创意策略表驱动逻辑（2026-09-09 改造）**：
1. 拉取创意策略表（base `EPYhbxo9TaUclysWuM0cgjkdnFf` / table `tblSZ8LbahG9GnCH`）→ LLM 拿达人画像与每行的「适合达人」+「内容方向」共同判定命中哪些策略行（不简单按 influencer_type 分线；「适合达人」= 策略反推的匹配条件；蹭热点行「适合达人」= 所有类型即无过滤；**职业身份条件是一票否决硬门槛**：策略行指定职业身份（企业主/前企业主/金融从业者等）时，达人画像的 career_identity 必须 status=有明确证据且身份相符才可命中，缺失/无法判断/不符 → 该策略行不推荐且记入 excluded_strategies，不得以角色代入绕过）
2. 命中策略行中「内容方向一」= 蹭热点 → **蹭热点线**：从热点素材库（base `STMrbQgqma35dksI3WsclJlNnlc` / table `tblDpxkM7psozqeO`）按「素材评分」降序（优秀>良好>一般>劣质）取优组织创意方向
3. 命中策略行为其他方向（揭秘自己/借钱高性价比/利息计算/有钱人借钱/网贷测评/回应解释/鸡汤/避坑/拒绝借钱）→ **其他方向线**：
   - 植入策略：直接取策略行「植入策略」字段
   - 叙事策略：正向案例 + 按「素材链接ids」（dy_xxx，对应网络素材库「素材id」字段）反查网络素材库素材，**一起分析**后描述整体叙事逻辑（人物、场景、如何植入）；ids 为空则只用正向案例
   - 反查素材注入字段（2026-09-14 起）：**场景 + 内容分析 + 广告可借鉴点**（不再注入素材脚本文案原文）
4. 输出 5 个创意方向，每个含四维度：内容方向定义 / **场景** / 植入策略 / 适合达人；
   场景写明"在哪里发生、什么场合、几个人"（如"酒席饭桌，多人聚餐当众讨债"；纯对镜讲述写"对镜口播（无场景情节）"），
   依据反查素材的「场景」字段与内容分析判断，蹭热点线从热点概述判断；多条策略命中按策略等级 S>A>B>X 优先
5. **停用项**：《内容标准》文档注入与程序化校验（standard_check_dropped）、历史库匹配

读取输出 `step3_directions.json`，其中：
- `directions`：5 个创意方向（id/title/track/content_direction/**scene**/implant_strategy/suitable_influencer/narrative_strategy/source_material_ids/style_fit）
- `strategy_match`：策略匹配明细（命中行 + 命中原因 + 被职业身份门槛排除的行及原因）
- 无策略命中时 `directions` 为空并给出提示（回退：补充策略行或人工指定方向）

### ⏸ 交互点 1：用户选择创意方向

向用户展示 5 个创意方向（编号、标题、track、内容方向定义、**场景**、植入策略、叙事策略），使用 AskUserQuestion 让用户选择：
- 用户可多选（如 1,3,5）
- 如果用户全不认可 → 回到步骤 1 重新生成

### 步骤 2（流程步骤 6）：写脚本（SOP 驱动）+ 评分

执行命令（selected 为用户选中的方向编号，逗号分隔）：

```bash
{PYTHON} run.py \
  --step scripts \
  --style {工作目录}/style.json \
  --directions step3_directions.json \
  --selected 1,3,5 \
  --output step6_scripts.json
```

**SOP 驱动逻辑（2026-09-09 改造）**：
1. 运行时实时拉取三份文档（配置于 `config/settings.py`，拉取失败即报错不降级）：
   - 《度小满-脚本SOP-热点-V2》（`SOP_HOTSPOT_DOC_URL`）：蹭热点方向的写稿依据
   - 《度小满-脚本SOP-非热点-V2》（`SOP_NONHOTSPOT_DOC_URL`）：其他方向的写稿依据
   - 《度小满-口播脚本评分标准-V2》（`SCORING_STANDARD_DOC_URL`）：评分依据
2. 按 track 分线：蹭热点方向注入热点 SOP，其他方向注入非热点 SOP；两组均注入评分标准；分线各自一次 LLM 调用，结果按方向顺序合并
3. 产品上下文：方向自带的植入策略/叙事策略/场景 + 按 `source_material_ids` 现拉网络素材库素材
   （**场景 + 内容分析 + 广告可借鉴点**，2026-09-14 起不再注入素材脚本文案原文——实测原文逐字复用率≈0，
   骨架由「内容分析」承载、场景由「场景」字段承载）；历史数据库、step2 依赖已全部移除
4. 写稿执行 SOP 推导流程（Step 0 达人风格定基调 → 钩子定类 → 转折收口 → 角色定位 → 植入 4 步 → 收尾叠加 → 自检）；产出完整口播逐字稿（含【模块·打法】标签，60-90s / 220-390 字）
5. 评分：先过第 0 条合规红线（一票否决，记入 compliance_check），通过后按 8 维度评分（每维 0-2 分，满分 16）：开头吸引力/创造需求准度/达人匹配度/创造需求速度/植入逻辑链条/信息密度与节奏/切入方向/收尾质量，每维带具体评分理由

读取输出 `step6_scripts.json`，其中 `scripts` 数组包含每个方向的完整脚本 + 合规检查 + 评分。

### ⏸ 交互点 2：用户选择最终脚本

向用户展示所有脚本（含完整逐字稿、合规检查结果、8 维度评分及理由、风格匹配说明），使用 AskUserQuestion 让用户选择：
- 用户可多选
- 如果用户全不认可 → 重新执行步骤 2（换方向或换打法）
- compliance_check.passed=false 的脚本标注"需重写"

### 输出

将用户选中的脚本整理为最终 JSON 输出，包含：
- 选中脚本的完整逐字稿
- 合规检查结果 + 评分信息（8 维度 + 理由）
- 对应的创意方向信息（track/植入策略/叙事策略）
- 达人风格摘要

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| DEEPSEEK_API_KEY | inferera API key | 必填 |
| DEEPSEEK_BASE_URL | API 端点 | https://api.inferera.com/v1 |
| DEEPSEEK_MODEL | 模型名 | deepseek-v4-pro |
| HTTP_PROXY | 代理 | 可选 |
| HTTPS_PROXY | 代理 | 可选 |

## 飞书数据源与文档

| 数据源 | Base Token | Table ID | 用途 |
|--------|-----------|----------|------|
| 创意策略表 | EPYhbxo9TaUclysWuM0cgjkdnFf | tblSZ8LbahG9GnCH | directions 步骤驱动源：达人画像匹配策略行 |
| 热点素材库 | STMrbQgqma35dksI3WsclJlNnlc | tblDpxkM7psozqeO | 蹭热点线创意方向来源（按素材评分取优） |
| 网络素材库 | RFAqblL7FahLxps2SsNcoyxjnWh | tblYEQ0raRDrB4tb | 策略行素材链接ids 反查源（素材id 字段）；scripts 步骤写稿参照；match 旧步骤按「适配达人 contains 达人类型：一级-二级」匹配 |
| 历史数据库-头条 | IusNb2cgTafYo4sTVntcHNJHn9f | tblBEveR1P0gKRyy | 仅 match 旧步骤使用；已退出主流程 |

| 文档 | URL | 用途 |
|------|-----|------|
| 脚本SOP-热点-V2 | https://kwza968lz1u.feishu.cn/docx/OBkUdT47XoctsxxHBExce92Xn1c | 蹭热点方向写稿依据 |
| 脚本SOP-非热点-V2 | https://kwza968lz1u.feishu.cn/docx/D3DQdyllxoEIgyxhHi4cyYzfnng | 其他方向写稿依据 |
| 口播脚本评分标准-V2 | https://kwza968lz1u.feishu.cn/docx/WxwmdfYIeowjPLxvznWcfS7Nnle | 评分依据（红线+8维度） |
| 内容标准（已停用） | https://kwza968lz1u.feishu.cn/docx/ZdJMd6L1uo7lkwxSgKkcvXawnLc | 2026-09-09 起停用 |

## 代码结构

```
scripts/
├── run.py                         # 主入口（--step: match|directions|scripts）
├── config/settings.py             # 环境变量 + 飞书配置 + SOP/评分文档 URL
├── providers/llm.py               # deepseek-v4-pro 调用
├── tools/feishu.py                # 飞书数据拉取（lark-cli subprocess）
├── agents/
│   ├── base.py                    # AgentResult, AgentSpec
│   ├── match_condition_extractor.py # match 旧步骤：达人类型判定
│   ├── material_matcher.py        # match 旧步骤（主流程不经过）
│   ├── direction_generator.py     # 步骤 directions：创意策略表驱动
│   └── script_writer.py           # 步骤 scripts：SOP 驱动写稿 + 评分
└── .env
```

> outline_writer.py / standard_guard.py 已于 2026-09-09 移除（大纲步骤取消）。

## 注意事项

1. **Python 路径**：使用隔离环境 `/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python`
2. **lark-cli 依赖**：飞书数据拉取依赖 lark-cli 已认证
3. **步骤间文件传递**：每步输出 JSON 文件，下一步读取上一步的文件
4. **回退机制**：2 个交互点都有"不认可就回退"的机制
5. **SOP 文档为写稿硬依据**：拉取失败不降级直接报错；文档更新后无需改代码（运行时实时拉取）
