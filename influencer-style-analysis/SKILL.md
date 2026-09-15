---
name: influencer-style-analysis
description: "达人风格识别技能。通过抖音主页链接或 sec_user_id，经 TikHub API 拉取达人数据（简介、视频列表），筛选视频并使用千问多模态大模型直接看视频分析达人风格，输出包含基础定位（含达人自身画像）、受众洞察的结构化 JSON。当用户提到达人分析、达人风格、风格识别、创作者风格、达人画像、influencer profiler 等关键词时触发此技能。"
agent_created: true
---

# Influencer Style Analysis（达人风格识别）

## Overview

通过抖音达人主页链接，经 TikHub API 拉取达人数据（简介、视频列表），筛选出可分析的视频，使用千问多模态大模型（qwen3-vl-plus）直接看视频分析达人风格（与 creative-content-analysis 同网关同模型），输出包含基础定位（含达人自身画像）、受众洞察的结构化 JSON。

## 架构概览

```
用户输入（抖音主页链接 / sec_user_id）
    │
    ▼
TikHub API 拉取达人作品列表
    ├── bio（达人简介）
    ├── author_nickname（达人昵称）
    └── aweme_list（作品列表）
    │
    ▼
视频筛选
    ├── 筛选 video.play_addr.data_size 存在的作品
    ├── 按 data_size 升序排序
    ├── 取前 2 个（不足则有几个选几个）
    └── 从 url_list 中选 api.amemv.com 域名链接（兜底取最后一个）
    │
    ▼
千问多模态 LLM 分析（逐个视频，方案A）
    ├── 看视频：口吻、语气、语速节奏、情绪、画面风格、视觉元素、达人外貌/年龄/穿搭
    └── 读文本：bio → 人设定位、职业身份、资产层次
    │
    ▼
LLM 二次合并（多视频时）
    └── 综合多次分析结果 → 归纳最终风格画像
    │
    ▼
JSON 输出（2 大维度）
    ├── basic_positioning（基础定位 + 达人自身画像）
    │   ├── nickname, influencer_type, core_persona, content_tracks[]
    │   └── influencer_demographic（年龄/性别/职业/career_identity职业身份核实/外貌/讲话/资产/语速/情绪/视觉/标签）
    └── audience_insight（受众洞察）
```

## 触发条件

当用户出现以下意图时触发：
- "分析达人风格"、"达人风格识别"
- "创作者风格分析"、"达人画像"
- "influencer profiler"、"达人风格"
- 提供抖音主页链接要求分析

## 工作流程

### Step 0: 询问人工补充信息（每次分析前必做）

开始分析前，**必须先问用户是否有需要人工补充的信息**，给出以下模板让用户填写（用户没有要补的就回"无"，直接进入 Step 1）：

```
1. 达人职业：
2. 资产层次：
3. 其他补充：
```

- **「其他补充」是兜底项**：凡不属于「达人职业」「资产层次」的信息（拍摄方式、出镜人数、单人/双人共说台词、机位、真实身份背景、从业经历等）统一写在这里
- 用户补充的内容**优先级最高**：产出时以人工补充为准，覆盖模型从 bio / 视频推断的结果

### Step 1: 接收输入

输入形式（二选一）：

1. **抖音主页链接**（最常用）：
   ```json
   {"douyin_profile_url": "https://www.douyin.com/user/MS4wLjABAAAA..."}
   ```
   或直接传入链接字符串。

2. **sec_user_id**：
   ```json
   {"sec_user_id": "MS4wLjABAAAA..."}
   ```

**带人工补充信息时**，在入参中加 `manual_supplement`：

```json
{
  "douyin_profile_url": "https://www.douyin.com/user/MS4w...",
  "manual_supplement": {
    "occupation": "金融助贷从业者",
    "asset_level": "高",
    "other": "拍摄方式：两个人（一男一女）都面向镜头，共说台词"
  }
}
```

`manual_supplement` 也支持传纯字符串（整体归入 other），或用扁平写法 `manual_occupation` / `manual_asset_level` / `manual_other`。

**程序化强制覆盖规则**（不依赖模型自觉，人工补充优先）：

| 人工字段 | 覆盖的产出字段 |
|---|---|
| `occupation` | `influencer_demographic.occupation`；同时 `career_identity` 置为 `{status: 有明确证据, description: 人工职业, evidence: 人工补充（用户提供）}` |
| `asset_level` | `influencer_demographic.asset_level`（加"人工补充："前缀便于溯源） |
| `other` | 追加到 `influencer_demographic.visual_symbols` 末尾，保证不丢失；同时注入 prompt，要求模型把其中与呈现相关的内容融入 `appearance` / `speech_style` |

### Step 2: TikHub 拉取达人数据

调用 `scripts/tools/tikhub.py` 的 `fetch_influencer_from_douyin()`：
- 从主页链接解析 sec_user_id
- 调用 TikHub API（`/api/v1/douyin/app/v3/fetch_user_post_videos`）拉取达人最近作品
- 提取：bio（简介）、author_nickname（昵称）

**前置条件**：需配置 `TIKHUB_API_TOKEN` 环境变量。

### Step 3: 视频筛选

在 `parse_influencer_bundle()` 中执行筛选逻辑：

1. 遍历 `aweme_list`，筛选 `video.play_addr.data_size` 字段存在且 > 0 的作品
2. 按 `data_size` **升序**排序（小文件优先，减少大模型处理时间）
3. 取前 2 个；不足 2 个则有几个选几个
4. 对每个作品，从 `video.play_addr.url_list` 中选取域名为 `api.amemv.com` 的链接
5. 找不到 `api.amemv.com` 时，取 `url_list` 最后一个链接兜底
6. **筛选结果为 0 个时，中断流程**，提示用户"没有可以分析的视频"

### Step 4: 千问多模态 LLM 分析

调用 `scripts/providers/multimodal.py` 的 `run_video_analysis()`（内置分阶段耗时日志：TikHub/视频分析/合并）：

- **模型**：qwen3-vl-plus（通过 inferera OpenAI 兼容接口；2026-09-09 实测单视频分析 ~15s，doubao-seed-2-1-pro 需数分钟）
- **API 地址**：`https://api.inferera.com/v1/chat/completions`
- **输入**：系统 prompt（风格分析指令）+ 用户文本（bio + nickname）+ video_url
- **参数**：max_tokens=8192, temperature=0.3, timeout=300s
- **分析维度**（2 大模块）：
  - **基础定位**：人设一句话、核心赛道、达人类型（格式"一级-二级"，依据《达人类型基础标准（终版）》，无匹配输出"无匹配-需补充"）；下属 `influencer_demographic` 子对象提取达人自身画像（年龄/性别/职业/外貌/讲话风格/资产层次/语速/情绪/视觉符号/风格标签）。
  - **career_identity（职业身份核实，下游 script-creation 策略匹配的硬门槛）**：status（有明确证据=bio自述或口述明确提及职业/经营/从业经历；有间接线索=仅画面场景推断；无法判断=均无信息）+ description（职业经历描述，无证据写'未发现'）+ evidence（判定依据）。禁止编造，宁可'无法判断'不可拔高
  - **受众洞察**：人口统计特征、心理诉求

**逐个视频调用（方案A）**：遍历选出的视频 URL，逐个调用大模型分析。全部成功后通过 LLM 二次合并为最终结果。单个失败则跳过继续，全部失败则报错中止。

### Step 5: 输出 JSON

LLM 输出 JSON，经 `_ensure_complete_json()` 校验完整性 + `_compact_result()` 硬截断超长字段后返回。

输出结构详见 `references/json-schema.md`。

## 代码结构

```
scripts/
├── agents/
│   ├── __init__.py
│   ├── base.py                    # AgentSpec, AgentResult, run_agent
│   └── influencer_profiler.py     # 主入口：run_influencer_profiler()
├── providers/
│   ├── __init__.py
│   └── multimodal.py              # 千问多模态调用（inferera OpenAI 兼容）
├── tools/
│   ├── __init__.py
│   └── tikhub.py                  # TikHub API 抖音数据拉取 + 视频筛选
├── config/
│   ├── __init__.py
│   └── settings.py                # 环境变量配置（.env）
├── requirements.txt
└── .env.example
```

## 运行方式

### 环境准备

1. 安装依赖：
   ```bash
   pip install -r scripts/requirements.txt
   ```
2. 复制 `.env.example` 为 `.env` 并填写 API Key：
   ```bash
   cp scripts/.env.example scripts/.env
   ```

### 需要配置的环境变量

| 变量 | 说明 |
|------|------|
| `TIKHUB_API_TOKEN` | TikHub API 令牌（拉取抖音达人数据） |
| `VIDEO_API_KEY` | inferera API Key（视频分析，缺省回退 ANTHROPIC_API_KEY） |
| `VIDEO_BASE_URL` | 接口地址，默认 `https://api.inferera.com/v1` |
| `VIDEO_MODEL` | 模型名，默认 `qwen3-vl-plus` |

### 调用入口

```python
import sys
sys.path.insert(0, "scripts")

from agents.influencer_profiler import run_influencer_profiler

# 方式 1：传入 JSON 字符串
result = run_influencer_profiler('{"douyin_profile_url": "https://www.douyin.com/user/MS4w..."}')

# 方式 2：直接传入主页链接
result = run_influencer_profiler("https://www.douyin.com/user/MS4w...")

print(result.text)  # JSON 字符串
```

## 分析设计原则

1. **拒绝僵化标签**：禁止使用空泛枚举标签，必须用动态语言描述语速节奏、情绪基调和视觉符号
2. **克制推断边界**：基于视频样本分析，不过度推断或强行适配不相关品类
3. **多模态视角**：必须提取画面中的标志性视觉元素（穿搭、道具、机位、特效），并提取达人本人的外貌特征（年龄感、长相风格、穿搭层次）
4. **达人自身画像**：从 bio + 视频可视化信息推断达人的年龄区间、职业身份、外貌特征、讲话风格、资产层次，不预设任何职业分类
5. **开放式标签**：style_tags 根据达人实际特征动态提取，不限于固定枚举

分析维度详见 `references/style-dimensions.md`。

## 扩展指南

### 新增平台支持

1. 在 `scripts/tools/` 中新增平台数据拉取脚本（参照 `tikhub.py`）
2. 在 `scripts/agents/influencer_profiler.py` 的 `_merge_with_tikhub()` 中增加平台分支
3. 输入 JSON 增加 `platform` 字段标识来源

## 注意事项

- **千问内容审核拦截（data_inspection_failed）**：qwen3-vl-plus 对个别视频会报 `400 InternalError.Algo.DataInspectionFailed`，默认"最小2个视频"可能全被拦截。处理方式：用 `fetch_influencer_from_douyin(video_count=5)` 多取候选，逐个分析、失败跳过、成功 2 个即停，再走 LLM 合并（参考 `scripts/_run_analysis_retry.py`）
- **勿复用 scripts 目录下的 analysis_result*.json 旧缓存**：这些是历史分析残留，可能是其他达人的结果，每次分析以本次运行输出为准
- TikHub API 有调用频率限制，注意控速
- 视频筛选按 `data_size` 升序排列，优先分析小文件以减少处理时间
- 视频链接优先选 `api.amemv.com` 域名，该域名通常稳定可访问
- 所有视频分析均失败时直接报错中止，不做文本兜底
- 各字符串和数组字段有硬限制，超长自动截断（详见 `references/json-schema.md`）
- 需要配置的 API Key：`TIKHUB_API_TOKEN`、`ANTHROPIC_API_KEY`（或 `VIDEO_API_KEY`）
