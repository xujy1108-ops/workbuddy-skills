---
name: script-creation
description: "短视频脚本创作 skill — 接收达人风格 JSON，从飞书素材库和历史数据库匹配素材，经创意方向→大纲→写稿→评分的多轮交互流程，产出可投放的短视频脚本。"
version: 1.0.0
author: user
---

# 脚本创作 Skill

## 概述

基于达人风格分析结果，结合网络素材库和历史投放数据库，通过多轮交互流程产出短视频脚本。

**前置依赖**：需要先使用 `influencer-style-analysis` skill 获得达人风格 JSON。

## 触发条件

当用户提到"脚本创作""写脚本""创作脚本""script-creation"等关键词时触发。

## 工作流（6 步，含 3 个用户交互点）

### 前置：接收输入

用户需要提供：
1. **达人风格 JSON**（来自 influencer-style-analysis skill 的输出）
2. **用户手动创意方向**（可选）

将达人风格 JSON 保存为临时文件，例如 `{工作目录}/style.json`。

### 步骤 1（流程步骤 2）：匹配风格 + 产生原始创意

执行命令：

```bash
cd {SKILL_ROOT}/scripts && {PYTHON} run.py \
  --step match \
  --style {工作目录}/style.json \
  [--user-input "用户的创意方向"] \
  --output step2_materials.json
```

**匹配逻辑（达人类型标准 + 程序化查询 + LLM 生成）**：
1. LLM 依据《度小满-达人类型基础标准》（`references/influencer-type-standard.md`，源文档 https://kwza968lz1u.feishu.cn/docx/Bt2wdpZmBo5Jk1xrfoxcAcoZnwe ）判定达人的一级/二级类型，只能从标准枚举中选取（财经：泛财经/高价值/小微企业主/常规/鸡汤；三农：三农美食/三农建造；剧情：常规剧情/剧情搞笑）；**军事点评账号归入财经-泛财经**
2. 程序按判定类型在飞书服务端筛选（lark-cli `--filter-json` / `--sort-json`）：
   - **网络素材库**：`适配达人` contains `达人类型：一级-二级`（素材库已按标准统一标注）
   - **历史库-头条**：`达人类型` intersects 大类映射（财经系→财经；三农系→三农；剧情-常规剧情→剧情；剧情-剧情搞笑→剧情搞笑），并按 `星推比` 降序
3. 运行时实时拉取《内容标准》文档（https://kwza968lz1u.feishu.cn/docx/ZdJMd6L1uo7lkwxSgKkcvXawnLc ，配置于 `config/settings.py` 的 `CONTENT_STANDARD_DOC_URL`），注入创意生成 prompt 作硬约束
4. LLM 基于**真实命中的记录**生成创意，每个创意绑定来源记录的 `_record_id`（可追溯）；创意须契合判定类型的范围限定，且必须满足内容标准三方向：**转化链条最多 1 次传动、切入方向生活化（禁止宏大叙事）、铺垫转折顺内容逻辑**
5. 程序化校验淘汰违规创意：`chain_transitions` > 1、concept/entry_direction 含宏大叙事疑似关键词 → 淘汰并记录到 `standard_check_dropped`

读取输出 `step2_materials.json`，其中包含：
- `match_conditions`：类型判定结果（primary_type / secondary_type / reason / 派生查询条件）
- `style_summary`：风格摘要
- `matched_materials`：匹配的素材（含 record_id）
- `matched_history`：匹配的历史数据（含 record_id）
- `original_creatives`：5-8 个原始创意种子（每个绑定 source_material_ids / source_history_ids，含 entry_direction / chain_transitions / transition_setup）
- `standard_check_dropped`：被内容标准校验淘汰的创意及原因

### 步骤 2（流程步骤 3）：生成 5 个创意方向

执行命令：

```bash
{PYTHON} run.py \
  --step directions \
  --style {工作目录}/style.json \
  --step2 step2_materials.json \
  --output step3_directions.json
```

读取输出 `step3_directions.json`，其中 `directions` 数组包含 5 个创意方向。

**内容标准约束**：运行时实时拉取《内容标准》飞书文档（`CONTENT_STANDARD_DOC_URL`）注入 prompt；方向必须生活化切入、链条传动 ≤1、禁止宏大叙事/古典民俗开场；生成后程序化校验，违规方向淘汰并记录在 `standard_check_dropped`。

### ⏸ 交互点 1：用户选择创意方向

向用户展示 5 个创意方向（编号、标题、核心立意、情绪曲线），使用 AskUserQuestion 让用户选择：
- 用户可多选（如 1,3,5）
- 如果用户全不认可 → 回到步骤 1 重新生成

### 步骤 3（流程步骤 5）：生成大纲 + 质检

执行命令（selected 为用户选中的方向编号，逗号分隔）：

```bash
{PYTHON} run.py \
  --step outlines \
  --style {工作目录}/style.json \
  --directions step3_directions.json \
  --selected 1,3,5 \
  --output step5_outlines.json
```

读取输出 `step5_outlines.json`，其中 `outlines` 数组包含每个方向的 2 个大纲 + 质检评分。

**内容标准约束**：同步骤 2，实时拉取《内容标准》文档注入 prompt；开头钩子必须生活化、从开头到植入最多 1 次链条传动、植入铺垫不得硬切；生成后程序化校验（标题/切入/钩子/结构内容关键词筛查 + chain_transitions 检查），违规大纲淘汰并记录在 `standard_check_dropped`。

### ⏸ 交互点 2：用户选择大纲

向用户展示所有大纲（编号如 1A/1B、3A/3B、5A/5B，含标题、钩子、情绪曲线、质检评分），使用 AskUserQuestion 让用户选择：
- 用户可多选
- 如果用户全不认可 → 重新执行步骤 3

### 步骤 4（流程步骤 6-7）：写脚本 + 评分

执行命令（selected 为用户选中的大纲 ID，逗号分隔）：

```bash
{PYTHON} run.py \
  --step scripts \
  --style {工作目录}/style.json \
  --outlines step5_outlines.json \
  --selected 1A,3B,5A \
  --output step6_scripts.json
```

读取输出 `step6_scripts.json`，其中 `scripts` 数组包含每个大纲的完整脚本 + 多维度评分。

### ⏸ 交互点 3：用户选择最终脚本

向用户展示所有脚本（含完整文案、评分、风格匹配说明），使用 AskUserQuestion 让用户选择：
- 用户可多选
- 如果用户全不认可 → 重新执行步骤 4

### 输出

将用户选中的脚本整理为最终 JSON 输出，包含：
- 选中脚本的完整文案
- 评分信息
- 对应的创意方向和大纲信息
- 达人风格摘要

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| DEEPSEEK_API_KEY | inferera API key | 必填 |
| DEEPSEEK_BASE_URL | API 端点 | https://api.inferera.com/v1 |
| DEEPSEEK_MODEL | 模型名 | deepseek-v4-pro |
| HTTP_PROXY | 代理 | 可选 |
| HTTPS_PROXY | 代理 | 可选 |

## 飞书数据源

| 数据源 | Base Token | Table ID | 匹配规则 |
|--------|-----------|----------|----------|
| 网络素材库 | RFAqblL7FahLxps2SsNcoyxjnWh | tblYEQ0raRDrB4tb | 适配达人 contains "达人类型：一级-二级"（已按标准统一标注） |
| 历史数据库-头条 | IusNb2cgTafYo4sTVntcHNJHn9f | tblBEveR1P0gKRyy | 达人类型 intersects（二级→大类映射）+ 星推比降序 |

> 历史数据库-视频号表因达人风格字段为空、无星推比字段，已排除在匹配之外。

## 代码结构

```
scripts/
├── run.py                         # 主入口（--step 参数）
├── config/settings.py             # 环境变量 + 飞书配置
├── providers/llm.py               # deepseek-v4-pro 调用
├── tools/feishu.py                # 飞书数据拉取（lark-cli subprocess）
├── agents/
│   ├── base.py                    # AgentResult, AgentSpec
│   ├── match_condition_extractor.py # 步骤 2a：达人类型判定（标准枚举）
│   ├── material_matcher.py        # 步骤 2
│   ├── direction_generator.py     # 步骤 3
│   ├── outline_writer.py          # 步骤 5
│   └── script_writer.py           # 步骤 6-7
└── .env
```

## 注意事项

1. **Python 路径**：使用隔离环境 `/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python`
2. **lark-cli 依赖**：飞书数据拉取依赖 lark-cli 已认证
3. **步骤间文件传递**：每步输出 JSON 文件，下一步读取上一步的文件
4. **回退机制**：3 个交互点都有"不认可就回退"的机制
5. **步骤 8 精细化生产**：第一版暂未实现
