---
name: script-creation
description: "短视频脚本创作 skill（多品牌配置化）— 接收达人风格 JSON，创意策略表驱动生成创意方向（蹭热点/其他方向分线），选方向后按脚本 SOP 文档（热点/非热点）直出逐字稿并过生成期自检（红线一票否决 + 检验机制 pass/fail，不打分），产出可投放的短视频脚本。品牌私有内容（表 token / 文档 URL / prompt 模板 / 角色定位档位 / 达人类型枚举）全部外置在 config/<brand>/，用 --brand 切换品牌，代码零改动。"
version: 2.0.0
author: user
---

# 脚本创作 Skill

## 概述

基于达人风格分析结果，由创意策略多维表格驱动生成创意方向，用户选方向后按脚本 SOP 文档（热点/非热点分线）+ 对应策略库（方法与语料库）直接产出完整口播逐字稿，并过生成期自检（第0条红线一票否决 + SOP 检验机制逐项 pass/fail，**不打分**）。

**前置依赖**：需要先使用 `influencer-style-analysis` skill 获得达人风格 JSON（含 `career_identity` 职业身份核实字段）。

## 品牌配置化（2026-09-17）

品牌私有内容全部外置在 skill 根目录 `config/<brand>/`，**代码内零品牌硬编码**：

```
config/<brand>/
├── config.json      # 品牌名 / 飞书表 token+tableId / 文档 URL / 角色定位档位 /
│                    # 达人类型枚举（结构化 + 文本）/ prompt 占位符变量
├── prompts/         # 5 个 prompt 模板（品牌段落 + 占位符）
│   ├── script_writer.md        # 写稿主 prompt（含角色定位档位枚举）
│   ├── influencer_type.md      # 达人类型判定
│   ├── direction_match.md      # 策略匹配
│   ├── direction_generate.md   # 方向生成
│   └── material_match.md       # 素材匹配（match 旧步骤）
└── references/      # 品牌私有参考文档（达人类型标准 / 飞书表结构 / 策略库副本）
```

**品牌选择**：`--brand <name>`（等价于 env `WORKFLOW_BRAND`），默认 `duxiaoman`。

**失败即报错**（不静默回退到其它品牌）——以下情况 import 时直接抛 `RuntimeError`：
配置目录/文件缺失、JSON 非法、必填字段缺失、**值仍为 `TODO_` 占位**（骨架未补齐）、
prompt 模板缺失、prompt 模板为纯注释（未补齐）、或 prompt 内存在未注入的占位符。
> 未补齐检测的意义：骨架品牌在补齐前就明确报错，而不是一路跑到读表/调 LLM 才炸出难懂的飞书报错。

**新增品牌**：复制 `config/duxiaoman/` → 改 `config.json`（品牌名/表 token/文档 URL/档位/类型枚举）
→ 改 5 个 prompt 模板的品牌段落 → **无需改任何代码**。

## 触发条件

当用户提到"脚本创作""写脚本""创作脚本""script-creation"等关键词时触发。

## 工作流（步骤 directions → 交互点 1 → 步骤 scripts → 交互点 2 → 交付 → **交互点 3（人工修改回传与复盘沉淀）**，2026-09-09 改造：大纲步骤已移除；2026-09-18 增补交互点 3 闭环）

### 前置：接收输入

用户需要提供：
1. **达人风格 JSON**（来自 influencer-style-analysis skill 的输出，含 career_identity）
4. **用户手动创意方向**（可选，仅 match 旧步骤使用）

将达人风格 JSON 保存为临时文件，例如 `{工作目录}/style.json`。

### 步骤 1（流程步骤 3）：创意策略表驱动生成 5 个创意方向

执行命令：

```bash
cd {SKILL_ROOT}/scripts && {PYTHON} run.py \
  --step directions \
  --style {工作目录}/style.json \
  --output step3_directions.json
```

**创意策略表驱动逻辑（2026-09-09 改造；2026-09-21 晚按人工 SOP 整合为三段式匹配）**：
1. **第一段 类型门槛（LLM，硬门槛不变）**：拉取创意策略表（base/table 见 `config/<brand>/config.json` → `tables.strategy`）→ LLM 拿达人画像与每行的「适合达人」+「内容方向」共同判定命中哪些策略行（不简单按 influencer_type 分线；「适合达人」= 达人类型清单（一级／二级粒度），匹配是**或关系**：达人类型命中清单中任意一项即命中（清单为空或写作「所有类型／全部」→ 全命中）；类型命中后禁止二次否决，画像描述只作排序参考。2026-09-18 修订：删除原「职业身份一票否决」硬门槛——曾把含「生活」类型、本应命中的 8 条策略行误杀）
2. **第二段 候选集内精细化排序（LLM，只排队不踢人）**：authority_profile（is_big_v/tier，消费 influencer-style-analysis 大V判定）× career_identity（企业主类职业加权「企业主优先」策略）× narrative_skeleton（母题重合度——达人验证过的爆款话题优先）× influencer_demographic（长相/语速/气质精细契合）；信号冲突时 母题重合度 > 权威加权 > 画像契合；authority 缺失或 confidence=low → 中性处理（不升降序）
3. **「权威门槛」程序化硬过滤（纯规则，策略表新字段）**：大V专属 × is_big_v=false（可确认态）→ 排除并记 authority_notes；低置信/字段缺失/老版 style.json → 保留 + "待人工确认"标注（不错杀）
4. **热点线（程序+LLM 协作）**：先程序化**到期过滤**（「到期复查日」已过 → 剔除，评分再高也不行）+ 评分排序；**热点位配额程序判定**：无「优秀」级热点 → 0 位（宁缺毋滥）；有优秀 → 1 位；达人热点向居多（财经-泛财经类型【程序判】或母题谱系热点向【LLM 判 hotspot_affinity】）→ 2 位；热点选择 = 评分 × 与达人母题/内容赛道语义贴近度共同排序（style_fit 写明贴近依据）
5. **商单线（最高证据等级，消费 top_ad_video）**：LLM 判定商单 analysis（motifs/implant_mode）与策略行契合 → ad_verified_record_id；程序化校正（`_enforce_ad_verified`）：命中方向强制标 evidence_level=「商单已验证」且排第 1 位；未命中任何策略（adapt_fallback）→ 产出"商单改编方向"（复用商单三段骨架+implant_mode，产品话术全部换本品牌，**竞品话术禁止照搬**），强制标「商单架构改编」排第 1 位；top_ad_video 缺失 → 无商单线
6. 命中策略行为其他方向（揭秘自己/借钱高性价比/利息计算/有钱人借钱/网贷测评/回应解释/鸡汤/避坑/拒绝借钱）→ **其他方向线**：
   - 植入策略：直接取策略行「植入策略」字段**原文**（2026-09-18 起：禁止精炼成方法论概述，必须保留示例句、具体卖点与数字；写稿侧另有程序反查原文注入兜底）
   - 叙事策略：正向案例 + 按「素材链接ids」（dy_xxx，对应网络素材库「素材id」字段）反查网络素材库素材，**一起分析**后描述整体叙事逻辑（人物、场景、如何植入）；ids 为空则只用正向案例
   - 反查素材注入字段（2026-09-14 起）：**场景 + 内容分析 + 广告可借鉴点**（不再注入素材脚本文案原文）
7. 输出 5 个创意方向，每个含：内容方向定义 / **场景** / 植入策略 / 适合达人 / **evidence_level**（证据等级：商单架构改编｜商单已验证｜策略+素材｜策略表）；多条策略命中按 精细化排序+策略等级 S>A>B>X 优先；顶层附 manual_check_reminders（人工核验达人劣迹/品牌风险等固定提示）
8. **停用项**：《内容标准》文档注入与程序化校验（standard_check_dropped）、历史库匹配

读取输出 `step3_directions.json`，其中：
- `directions`：5 个创意方向（id/title/track/content_direction/**scene**/implant_strategy/suitable_influencer/narrative_strategy/source_material_ids/style_fit/**evidence_level**）
- `strategy_match`：策略匹配明细（精细化排序后的命中行 + priority_reason + 被类型门槛/权威门槛排除的行及原因 + hotspot_affinity + ad_analysis 商单判定）
- `hotspot_quota`：热点位配额与判定原因（程序算出）
- `authority_notes`：权威门槛过滤/待人工确认提示（有触发才输出）
- `manual_check_reminders`：人工核验提示（固定）
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

**SOP + 策略库驱动逻辑（2026-09-09 建，2026-09-15 补策略库，2026-09-18 补禁止红线）**：
1. 运行时实时拉取**六份文档**（URL 配置于 `config/<brand>/config.json` → `docs`，拉取失败即报错不降级；
   每次运行现拉、代码不缓存 → 文档在飞书改完，下次运行自动生效，无需改代码）：
   - 脚本SOP-热点（`docs.sopHotspot`）：蹭热点方向的结构与打法依据
   - 策略库-热点（`docs.libraryHotspot`）：蹭热点方向的语料与角色定位
   - 脚本SOP-非热点（`docs.sopNonhotspot`）：其他方向的结构与打法依据
   - 策略库-非热点（`docs.libraryNonhotspot`）：其他方向的语料与角色定位
   - 口播脚本评分标准（`docs.scoringStandard`）：**定义源**（生成期不打分——该文档
     「使用规则（先读这一节）」节明确：写稿只走 SOP 检验机制的 pass/fail）
   - **禁止红线（`docs.redline`）：合规红线唯一权威源**——两份 SOP、两份策略库、评分标准
     共 5 份文档的「第0条合规红线」全部指向它，所以它必须注入；红线正文不入上下文时，
     写稿侧只拿得到 SOP 里的一行摘要（如"A1 禁止「网贷 vs 银行」对比叙事"），
     一票否决条细则、豁免与背书登记、口径表（产品表述唯一合法来源）、投放审核口径全部不可达
     （2026-09-18 修复的断点 B）
2. 按 track 分线：蹭热点方向注入（热点 SOP + 策略库-热点），其他方向注入（非热点 SOP + 策略库-非热点）；
   两组均注入评分标准 + 禁止红线（后者与 SOP／评分标准冲突时以红线为准）；
   分线各自一次 LLM 调用，结果按方向顺序合并
5. **库内素材取用（SOP 顶部「素材取用流程」四步，2026-09-15 起真正落地）**：
   库级定位 → 条目级选择 → 产出留痕 → 缺口兜底。
   产出留痕落在脚本 JSON 新字段 `library_picks`（各模块「库内编号＋名称＋命中理由」）与 `material_gap`；
   编号体系纪律：库内编号与 SOP 模块子编号是两套体系（库内：热点钩子 A–C／非热点钩子 A–J；
   SOP：热点线为纯序号 1/2/3、非热点线为 A1–D2），**禁止按字母或序号对齐**，
   一律按库内各档「对应 SOP」字段反查；`【模块·打法】`标签沿用**对应 track 的 SOP 编号**，库内编号只进 `library_picks`
6. **角色定位必选（SOP 推导流程 Step 3，2026-09-15 补齐）**：
   非热点线从《策略库-非热点》角色定位方法库档位中选 1 档（档位表见 `config/<brand>/config.json` → `rolePositions.nonhotspot`）；
   热点线从 SOP-热点 模块④「热点专属角色定位」档位中选 1 档（档位表见 `rolePositions.hotspot`）；
   选中档位写进 `library_picks`（module=模块④角色定位），植入段口吻与【植入·…】标签须体现该角色定位
5. 产品上下文：方向自带的植入策略/叙事策略/场景 + 按 `source_material_ids` 现拉网络素材库素材
   （**场景 + 内容分析 + 广告可借鉴点**，2026-09-14 起不再注入素材脚本文案原文——实测原文逐字复用率≈0，
   骨架由「内容分析」承载、场景由「场景」字段承载）；历史数据库、step2 依赖已全部移除。
   **策略行原文透传（2026-09-18 起）**：按方向的 `strategy_record_id` 程序反查策略表原文注入（不经 LLM 转述），
   取两个字段：①「正向案例」——该策略行已验证过的整条爆款脚本，作用是「对齐其节奏与锋利度」，
   prompt 已注明只作语料、禁止复刻其案例/数字/金句；②「植入策略」——该策略行卖点原话
   （含具体卖点、示例句与数字），写稿必须把其中的卖点与数字落实进植入段，只按摘要写＝漏用素材。
   背景：direction_generate 曾授权「植入策略可精炼」，451 字原文被压成 51 字摘要，写稿拿不到具体卖点只能自造泛化话术；
   同批多方向骨架可同质，但措辞/案例/算账数字/金句不得复用
6. 写稿执行 SOP 推导流程（Step 0 达人风格定基调 → 钩子定类 → 转折收口 → 角色定位 → 植入 4 步 → 收尾叠加 → 自检）；产出完整口播逐字稿（含【模块·打法】标签）。**时长/字数口径由品牌 `config/<brand>/config.json` → `scriptSpec` 注入**（微业贷 60-180s／220-780 字，度小满 60-90s／220-390 字），prompt 内只留 `__DURATION_RANGE__`／`__WORD_COUNT_RANGE__`／`__CHARS_PER_MINUTE__` 占位符，禁止硬编码
9. **生成期自检（不打分，2026-09-15 口径）**：
   先过第 0 条合规红线（一票否决，记入 `compliance_check`）；通过后按对应 SOP「四、检验机制」逐项过 **pass / fail**，写入 `self_check`
   （键固定：`hook`／`influencer`／`speed`／`placement_chain`／`density`／`entry_direction`／`hotspot_fit`／`speakability`／`originality`／`redline`——`name_removal`（删名测试）已于 2026-09-18 移除，
   `originality`（原创检验，2026-09-19 新增）＝与策略行「正向案例原文」逐句比对，
   判定线为**连续重合 ≥12 字即算照抄**，只换语气词/改一两个字不算重写，开场句被整段搬用直接 fail；
   值只允许 `pass`｜`fail`｜`n/a`，`hotspot_fit` 仅蹭热点线适用，其他方向线填 `n/a`；未过项记入 `fail_items`）；
   同时输出 `verification` **核验行**（钱要素首现位置／总字数／过渡句数／逐句功能标签串）；
   `library_picks` 未覆盖模块①-⑤ 或角色定位缺档 → `placement_chain` 记 fail；
   **量化项由程序复算**（`agents/script_writer.py::_program_check`，明细落 `program_check` 字段）：字数（含/不含标点两口径）、
   钱要素首现位置（钱要素关键词的字符偏移 ÷ 全篇口播正文字数的**百分比**；折算秒数只作参考展示）、品牌名出现次数；
   **翻键规则（2026-09-20 起按异常类型，不再按 issue 文案里的中文关键词匹配）**：字数超区间 → `density`；钱要素缺位／超窗 → `speed`；
   品牌名 0 次 → `placement_chain`；**模型自报字数与复算不符只记入 `fail_items`、不翻任何键**（模型数不准字数，实测 5/5 误判，翻 density 属错判）。
   `program_check` 的真值优先于 `verification` 自报值；
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

### ⏸ 交互点 3：人工修改回传与复盘沉淀（2026-09-18 建，交付后闭环）

脚本交付不是终点——**人工修改是全流程唯一引入 SOP 之外信息的环节**（AI 初稿按 SOP 生成必然"满分"，自评无区分度；人工改动才是增量信息源），必须闭环回收。规则：

**A. 每次交付/修订后必须提醒（不可省略，两句话都要说）**：
1. 「如果你有修改，请把你的修改版本再发给我」
2. 明确告知当前版本状态——本版本是否 AI 侧最终版（如「这是最终版」/「仍可继续迭代」），不让用户猜哪版是终版

**B. 收到用户回传的人工修改版后**：
1. 先按红线 + SOP 检验机制**复查人工改动**（人工改动可能引入 A1/A2/B2 等合规问题——如时效承诺、无截止时间的数据、歪曲政策），有问题逐条指出并给修补版；无问题直接确认
2. 修补/确认后**再次回到 A 的两句提醒**，直到用户明确确认最终版

**C. 用户确认最终版后，触发复盘沉淀（一次性做完，不问用户要不要）**：
1. **对比复盘**：人工最终版 vs AI 各版本逐段对比，逐条回答三问——**改了哪些点？为什么这么改？有哪些优点？**
2. **沉淀进 SOP**：可复用经验按 track 追加到对应飞书 SOP 文档的「复盘沉淀」节（热点经验→`docs.sopHotspot`，非热点经验→`docs.sopNonhotspot`；**通用经验两份都写，分线专属只写对应线并标注适用边界**；写入前先读该节现有条目避免重复）
3. **记录 log**：追加一条到 `config/<brand>/revision-log.md`（无则创建），记录本次人工修改点、沉淀去向、human_revision 三要素与预期分——log 是流水账（改了什么），SOP「复盘沉淀」节是提炼后的规则（以后怎么写），两者通过日期+主题互查

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| WORKFLOW_BRAND | 生效品牌（= `--brand` 参数；`--brand` 优先级更高） | duxiaoman |
| DEEPSEEK_API_KEY | inferera API key | 必填 |
| DEEPSEEK_BASE_URL | API 端点 | https://api.inferera.com/v1 |
| DEEPSEEK_MODEL | 模型名 | deepseek-v4-pro |
| HTTP_PROXY | 代理 | 可选 |
| HTTPS_PROXY | 代理 | 可选 |

## 飞书数据源与文档

**全部来自品牌配置** `config/<brand>/config.json`，此处不再罗列 token/URL（避免双轨漂移）。

| 数据源 | 配置路径 | 用途 |
|--------|---------|------|
| 创意策略表 | `tables.strategy` | directions 步骤驱动源：达人画像匹配策略行 |
| 热点素材库 | `tables.hotspot` | 蹭热点线创意方向来源（按素材评分取优） |
| 网络素材库 | `tables.materials` | 策略行素材链接ids 反查源（素材id 字段）；scripts 步骤写稿参照；match 旧步骤按「适配达人 contains 达人类型：一级-二级」匹配 |
| 历史数据库-头条 | `tables.historyToutiao` | 仅 match 旧步骤使用；已退出主流程 |

| 文档 | 配置路径 | 用途 |
|------|---------|------|
| 脚本SOP-热点 | `docs.sopHotspot` | 蹭热点方向写稿依据（结构 + 各模块打法选择逻辑） |
| 脚本SOP-非热点 | `docs.sopNonhotspot` | 其他方向写稿依据（结构 + 各模块打法选择逻辑） |
| 策略库-热点 | `docs.libraryHotspot` | 蹭热点方向**语料库**：库内档位的台词公式/案例原句、热点承接方法库、热点痛点·缺口场景、热点角色定位、热点转折/收尾/切入方式/热点类型速查 |
| 策略库-非热点 | `docs.libraryNonhotspot` | 其他方向**语料库**：钩子方法库、痛点软肋方法库、转折句式方法库、角色定位方法库、收尾方法库、切入方式库 |
| 口播脚本评分标准 | `docs.scoringStandard` | **定义源 + 第0条红线依据 + 复盘归因标准**（生成期不打分；「使用规则」节规定 0/1/2 只对人工修改后版本打） |
| 达人类型基础标准 | `docs.influencerTypeStandard` | 达人类型判定的唯一合法枚举来源（品牌私有标准）；固化版本见 `references/` 下同名文件 |
| 禁止红线 | `docs.redline` | **合规红线唯一权威源**：一票否决条细则、计分项、豁免与背书登记、**第五节口径表（产品表述唯一合法来源）**、投放审核口径。与 SOP／评分标准冲突时以本文为准 |

> 2026-09-15 补齐策略库注入：此前只注入 SOP，而 SOP 正文的「素材取用流程」要求 LLM 去策略库取档位语料——单次补全的 LLM 打不开链接，该流程成为死指令。
> 2026-09-17 配置化：以上 token/URL 全部改由 `config/<brand>/config.json` 提供，改用 `--brand` 切品牌。

## 代码结构

```
script-creation/
├── SKILL.md
├── config/<brand>/                 # ★ 品牌配置（唯一品牌私有内容存放处）
│   ├── config.json                 # 品牌名/表 token/docs URL/角色定位档位/达人类型枚举/占位符变量
│   ├── prompts/*.md                # 5 个 prompt 模板（品牌段落 + 占位符）
│   ├── revision-log.md             # ★ 人工修改复盘 log（交互点 3 追加，append-only）
│   └── references/                 # 品牌私有参考文档（达人类型标准/飞书表结构/策略库副本）
├── references/                     # 通用参考文档（跨品牌共用）
│   ├── output-schemas.md
│   └── workflow.md
└── scripts/
    ├── run.py                         # 主入口（--step: match|directions|scripts；--brand 指定品牌）
    ├── config/settings.py             # 品牌配置加载器（唯一读取入口，import 时校验并注入占位符）
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
> 2026-09-17 配置化：agents/tools 一律从 `config.settings` 引用常量，Python 代码内零品牌硬编码。

## 注意事项

1. **品牌私有内容只放 config/**：新增/修改品牌相关内容（表 token、文档 URL、prompt 品牌段落、角色定位档位、达人类型枚举）**一律改 `config/<brand>/`，不改代码**；代码里出现品牌名品牌 token 即为 bug
2. **prompt 占位符不可删**：换品牌时模板里的 `__BRAND_NAME__` 等占位符必须保留，`load_prompt` 会校验未注入占位符并报错
3. **Python 路径**：使用隔离环境 `/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python`
4. **lark-cli 依赖**：飞书数据拉取依赖 lark-cli 已认证
5. **步骤间文件传递**：每步输出 JSON 文件，下一步读取上一步的文件
6. **回退机制**：2 个交互点都有"不认可就回退"的机制
7. **SOP + 策略库 + 禁止红线为写稿硬依据**：六份文档拉取失败不降级直接报错；**每次运行实时拉取（不缓存）→ 文档在飞书改完，下次创作自动生效，不需要改代码**
8. **库内取用必须留痕**：`library_picks` 覆盖模块①-⑤ 且角色定位有且仅有 1 档；运行末尾会打自检日志（缺失只警告不阻断），复盘时可据 `library_picks` 回溯素材来源
9. **两套编号不通用**：库内编号（策略库-热点钩子 A–C／策略库-非热点钩子 A–J）与 SOP 模块子编号（热点线为纯序号 1/2/3；非热点线为 A1–D2 且与评分维度一的 A-D 类绑定）**禁止按字母或序号对齐**，必须按库内各档「对应 SOP」字段反查
10. **生成期不打分（2026-09-15 定）**：写稿阶段只做红线一票否决 + 检验机制 pass/fail，输出 `self_check` 与核验行 `verification`；0/1/2 的「预期分」只对**人工修改后的版本**打、由人工填 `human_revision`，随脚本交付文档留存供投放数据复盘归因。AI 初稿按 SOP 生成必然"满分"，自评没有区分度（球员兼裁判）
11. **人工修改闭环（2026-09-18 定）**：交付必提醒回传（交互点 3A 两句话）；人工版先过红线复查（3B）；用户确认终版后必做复盘 → SOP「复盘沉淀」节 + `config/<brand>/revision-log.md`（3C）——复盘不问用户要不要，直接做
