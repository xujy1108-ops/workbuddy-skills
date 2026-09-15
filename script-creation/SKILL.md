---
name: script-creation
description: "短视频脚本创作 skill — 接收达人风格 JSON，创意策略表驱动生成创意方向（蹭热点/其他方向分线），选方向后按脚本 SOP 文档（热点/非热点）直出逐字稿并过生成期自检（红线一票否决 + 检验机制 pass/fail，不打分），产出可投放的短视频脚本。"
version: 2.0.0
author: user
---

# 脚本创作 Skill

## 概述

基于达人风格分析结果，由创意策略多维表格驱动生成创意方向，用户选方向后按脚本 SOP 文档（热点/非热点分线）+ 对应策略库（方法与语料库）直接产出完整口播逐字稿，并过生成期自检（第0条红线一票否决 + SOP 检验机制逐项 pass/fail，**不打分**）。

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
   依据反查素材的「场景」字段与内容分析判断，蹭热点线从热点概述判断；多条策略命中按策略等级 S>A>B>X 优先；
   **蹭热点方向最多 2 个**（2026-09-15 定：热点优先但限流，其余 3+ 名额由其他方向线按等级补足）
5. **停用项**：《内容标准》文档注入与程序化校验（standard_check_dropped）、历史库匹配

读取输出 `step3_directions.json`，其中：
- `directions`：5 个创意方向（id/title/track/content_direction/**scene**/implant_strategy/suitable_influencer/narrative_strategy/source_material_ids/style_fit）
- `strategy_match`：策略匹配明细（命中行 + 命中原因 + 被职业身份门槛排除的行及原因）
- 无策略命中时 `directions` 为空并给出提示（回退：补充策略行或人工指定方向）

### ⏸ 交互点 1：用户选择创意方向

向用户展示 5 个创意方向（编号、标题、track、内容方向定义、**场景**、植入策略、叙事策略），使用 AskUserQuestion 让用户选择：
- 用户可多选（如 1,3,5）
- 如果用户全不认可 → 回到步骤 1 重新生成

### 步骤 2（流程步骤 6）：写脚本（SOP 驱动）+ 生成期自检（不打分）

执行命令（selected 为用户选中的方向编号，逗号分隔）：

```bash
{PYTHON} run.py \
  --step scripts \
  --style {工作目录}/style.json \
  --directions step3_directions.json \
  --selected 1,3,5 \
  --output step6_scripts.json
```

**SOP + 策略库驱动逻辑（2026-09-09 建，2026-09-15 补策略库）**：
1. 运行时实时拉取**五份文档**（配置于 `config/settings.py`，拉取失败即报错不降级；
   每次运行现拉、代码不缓存 → 文档在飞书改完，下次运行自动生效，无需改代码）：
   - 《度小满-脚本SOP-热点-V2》（`SOP_HOTSPOT_DOC_URL`）：蹭热点方向的结构与打法依据
   - 《度小满-策略库-热点》（`LIBRARY_HOTSPOT_DOC_URL`）：蹭热点方向的语料与角色定位
   - 《度小满-脚本SOP-非热点-V2》（`SOP_NONHOTSPOT_DOC_URL`）：其他方向的结构与打法依据
   - 《度小满-策略库-非热点》（`LIBRARY_NONHOTSPOT_DOC_URL`）：其他方向的语料与角色定位
   - 《度小满-口播脚本评分标准-V2》（`SCORING_STANDARD_DOC_URL`）：**定义源 + 第0条红线依据**
     （生成期不打分——该文档「使用规则（先读这一节）」节明确：写稿只走 SOP 检验机制的 pass/fail）
2. 按 track 分线：蹭热点方向注入（热点 SOP + 策略库-热点），其他方向注入（非热点 SOP + 策略库-非热点）；
   两组均注入评分标准；分线各自一次 LLM 调用，结果按方向顺序合并
3. **库内素材取用（SOP 顶部「素材取用流程」四步，2026-09-15 起真正落地）**：
   库级定位 → 条目级选择 → 产出留痕 → 缺口兜底。
   产出留痕落在脚本 JSON 新字段 `library_picks`（各模块「库内编号＋名称＋命中理由」）与 `material_gap`；
   编号体系纪律：库内编号与 SOP 模块子编号是两套体系（库内：热点钩子 A–C／非热点钩子 A–J；
   SOP：热点线为纯序号 1/2/3、非热点线为 A1–D2），**禁止按字母或序号对齐**，
   一律按库内各档「对应 SOP」字段反查；`【模块·打法】`标签沿用**对应 track 的 SOP 编号**，库内编号只进 `library_picks`
4. **角色定位必选（SOP 推导流程 Step 3，2026-09-15 补齐）**：
   非热点线从《策略库-非热点》角色定位方法库 7 档选 1 档（痛点解药/过来人工具/应急安全垫/被验证的靠谱/拒绝话术武器/优等生/体面方案）；
   热点线从 SOP-热点 模块④「热点专属角色定位」5 档选 1 档（合规标杆/国家队合作伙伴/缺口补充工具/政策响应者/普通人低息入口）；
   选中档位写进 `library_picks`（module=模块④角色定位），植入段口吻与【植入·…】标签须体现该角色定位
5. 产品上下文：方向自带的植入策略/叙事策略/场景 + 按 `source_material_ids` 现拉网络素材库素材
   （**场景 + 内容分析 + 广告可借鉴点**，2026-09-14 起不再注入素材脚本文案原文——实测原文逐字复用率≈0，
   骨架由「内容分析」承载、场景由「场景」字段承载）；历史数据库、step2 依赖已全部移除
6. 写稿执行 SOP 推导流程（Step 0 达人风格定基调 → 钩子定类 → 转折收口 → 角色定位 → 植入 4 步 → 收尾叠加 → 自检）；产出完整口播逐字稿（含【模块·打法】标签，60-90s / 220-390 字）
7. **生成期自检（不打分，2026-09-15 口径）**：
   先过第 0 条合规红线（一票否决，记入 `compliance_check`）；通过后按对应 SOP「四、检验机制」逐项过 **pass / fail**，写入 `self_check`
   （键固定：`hook`／`name_removal`／`influencer`／`speed`／`placement_chain`／`density`／`entry_direction`／`hotspot_fit`／`speakability`／`redline`；
   值只允许 `pass`｜`fail`｜`n/a`，`hotspot_fit` 仅蹭热点线适用，其他方向线填 `n/a`；未过项记入 `fail_items`）；
   同时输出 `verification` **核验行**（钱要素首现位置／总字数／过渡句数／逐句功能标签串）；
   `library_picks` 未覆盖模块①-⑤ 或角色定位缺档 → `placement_chain` 记 fail；
   **不产出 0/1/2 分数**——「预期分」只对人工修改后版本打、由人工填 `human_revision`（AI 输出固定 `null`）
8. 运行末尾自动自检并打日志：`库内取用留痕：library_picks x/x ｜ 角色定位 x/x ｜ 素材缺口 n 个`（缺失只警告不阻断）

读取输出 `step6_scripts.json`，其中 `scripts` 数组包含每个方向的完整脚本 + 合规检查（pass/fail）+ 生成期自检 `self_check` + 核验行 `verification` + 库内取用留痕 + `human_revision`（固定 null，待人工填）。

### ⏸ 交互点 2：用户选择最终脚本

向用户展示所有脚本（含完整逐字稿、合规检查结果、自检 `self_check` 逐项结论与 `fail_items`、核验行、风格匹配说明），使用 AskUserQuestion 让用户选择：
- 用户可多选
- 如果用户全不认可 → 重新执行步骤 2（换方向或换打法）
- compliance_check.passed=false 的脚本标注"需重写"

### 输出

将用户选中的脚本整理为最终 JSON 输出，包含：
- 选中脚本的完整逐字稿
- 合规检查结果（pass/fail）+ 生成期自检 `self_check`（逐项 pass/fail）+ 核验行 `verification`
- **库内取用留痕**（`library_picks`：各模块库内编号+命中理由；`material_gap`：素材缺口）
- 对应的创意方向信息（track/植入策略/叙事策略）
- 达人风格摘要
- **人工修改记录 `human_revision`**（AI 初值 `null`，由人工在修改后填写）——**全流程唯一的定量数据源**，复盘归因靠它：

  ```json
  {
    "expected_score": {"开头吸引力": 2, "创造需求准度": 2, "达人匹配度": 1, "创造需求速度": 2,
                       "植入逻辑链条": 2, "信息密度与节奏": 1, "切入方向": 2, "收尾质量": 2, "total": 14},
    "revisions": [{"position": "第3句", "nature": "补真实感", "magnitude": "重写"}],
    "note": "改动思路一句话"
  }
  ```

  | 字段 | 说明 |
  |------|------|
  | `expected_score` | 对**人工修改后版本**按《评分标准-V2》打的 8 维度预期分（每维 0-2，满分 16） |
  | `revisions[].position` | 改动位置（第几句 / 哪个功能模块） |
  | `revisions[].nature` | 改动性质（补真实感／删废话／强化钩子／换打法／合规改写…） |
  | `revisions[].magnitude` | 改动幅度（轻改／重写／换结构） |

  **为什么三要素必填**：只记总分，复盘只能得到"分数 vs 效果"，无法归因"哪种人工改动有效"；
  记了三要素，才能回答"补真实感 vs 删废话，哪个带来星推比提升最多"，进而反哺策略库。
  > 已知限制：预期分与改动记录随**脚本交付文档**留存（不落 Base 字段）→ 无法批量算相关系数，只能人工抽样。
  > 将来要做量化归因，需在投放数据表补「预期分／改动位置／改动性质」三个字段。

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
| 脚本SOP-热点-V2 | https://kwza968lz1u.feishu.cn/docx/OBkUdT47XoctsxxHBExce92Xn1c | 蹭热点方向写稿依据（结构 + 各模块打法选择逻辑） |
| 脚本SOP-非热点-V2 | https://kwza968lz1u.feishu.cn/docx/D3DQdyllxoEIgyxhHi4cyYzfnng | 其他方向写稿依据（结构 + 各模块打法选择逻辑） |
| **策略库-热点** | https://kwza968lz1u.feishu.cn/docx/SHdXdI0KQoJbfwxNq4mcePL5nxb | 蹭热点方向**语料库**：库内档位的台词公式/案例原句、热点承接方法库、热点痛点·缺口场景、热点角色定位（5 档）、热点转折/收尾/切入方式/热点类型速查 |
| **策略库-非热点** | https://kwza968lz1u.feishu.cn/docx/BBx1dVk5aoNIn6xgON2cppNKnkb | 其他方向**语料库**：钩子方法库（A–J 10 档）、痛点软肋方法库、转折句式方法库、角色定位方法库（7 档）、收尾方法库、切入方式库 |
| 口播脚本评分标准-V2 | https://kwza968lz1u.feishu.cn/docx/WxwmdfYIeowjPLxvznWcfS7Nnle | **定义源 + 第0条红线依据 + 复盘归因标准**（生成期不打分；「使用规则」节规定 0/1/2 只对人工修改后版本打） |
| 内容标准（已停用） | https://kwza968lz1u.feishu.cn/docx/ZdJMd6L1uo7lkwxSgKkcvXawnLc | 2026-09-09 起停用 |

> 2026-09-15 补齐策略库注入：此前只注入 SOP，而 SOP 正文的「素材取用流程」要求 LLM 去策略库取档位语料（正文含 20 处指向策略库的链接）——单次补全的 LLM 打不开链接，该流程成为死指令。

## 代码结构

```
scripts/
├── run.py                         # 主入口（--step: match|directions|scripts）
├── config/settings.py             # 环境变量 + 飞书配置 + SOP/策略库/评分文档 URL
├── providers/llm.py               # deepseek-v4-pro 调用
├── tools/feishu.py                # 飞书数据拉取（lark-cli subprocess）
├── agents/
│   ├── base.py                    # AgentResult, AgentSpec
│   ├── match_condition_extractor.py # match 旧步骤：达人类型判定
│   ├── material_matcher.py        # match 旧步骤（主流程不经过）
│   ├── direction_generator.py     # 步骤 directions：创意策略表驱动
│   └── script_writer.py           # 步骤 scripts：SOP + 策略库驱动写稿 + 生成期自检（pass/fail，不打分）+ 库内取用留痕自检
└── .env
```

> outline_writer.py / standard_guard.py 已于 2026-09-09 移除（大纲步骤取消）。

## 注意事项

1. **Python 路径**：使用隔离环境 `/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python`
2. **lark-cli 依赖**：飞书数据拉取依赖 lark-cli 已认证
3. **步骤间文件传递**：每步输出 JSON 文件，下一步读取上一步的文件
4. **回退机制**：2 个交互点都有"不认可就回退"的机制
5. **SOP + 策略库为写稿硬依据**：五份文档拉取失败不降级直接报错；**每次运行实时拉取（不缓存）→ 文档在飞书改完，下次创作自动生效，不需要改代码**
6. **库内取用必须留痕**：`library_picks` 覆盖模块①-⑤ 且角色定位有且仅有 1 档；运行末尾会打自检日志（缺失只警告不阻断），复盘时可据 `library_picks` 回溯素材来源
7. **两套编号不通用**：库内编号（策略库-热点钩子 A–C／策略库-非热点钩子 A–J）与 SOP 模块子编号（热点线为纯序号 1/2/3；非热点线为 A1–D2 且与评分维度一的 A-D 类绑定）**禁止按字母或序号对齐**，必须按库内各档「对应 SOP」字段反查
8. **生成期不打分（2026-09-15 定）**：写稿阶段只做红线一票否决 + 检验机制 pass/fail，输出 `self_check` 与核验行 `verification`；0/1/2 的「预期分」只对**人工修改后的版本**打、由人工填 `human_revision`，随脚本交付文档留存供投放数据复盘归因。AI 初稿按 SOP 生成必然"满分"，自评没有区分度（球员兼裁判）
