---
name: influencer-style-analysis
description: "达人风格识别技能。通过抖音主页链接或 sec_user_id，经 TikHub API 拉取达人数据（简介、视频列表），按点赞Top5+时长筛选选出视频，用千问多模态大模型直接看视频分析达人风格，输出包含基础定位（含达人自身画像）、叙事骨架、受众洞察、爆款商单分析的结构化 JSON。当用户提到达人分析、达人风格、风格识别、创作者风格、达人画像、influencer profiler 等关键词时触发此技能。"
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
Step 0 询问人工补充（达人职业 / 资产层次 / 其他补充，可全部留空）
    │
    ▼
TikHub API 拉取达人作品列表（固定最近 20 条；play_count 恒为 0，热度排序用点赞数）
    ├── bio（达人简介）
    ├── author_nickname（达人昵称）
    ├── user_profile（粉丝量级 + 认证，走 handler_user_profile 端点）
    └── aweme_list（作品列表）
    │
    ▼
视频选样（2026-09-21 规则）
    ├── 全部作品按点赞数降序 → Top5
    ├── Top5 中筛时长 < 10 分钟 → 按排名取前 2 个做多模态分析
    └── Top5 全部 ≥ 10 分钟 → UnfitInfluencerError（达人不适合本次投放：视频太长）
    │
    ▼
千问多模态 LLM 分析（逐个视频，失败跳过）
    ├── 看视频：口吻、语气、语速节奏、情绪、画面风格、视觉元素、达人外貌/年龄/穿搭
    ├── 叙事骨架：前3秒钩子类型、开场/中段/收尾三段结构、母题、情绪、商业信号
    └── 读文本：bio → 人设定位、职业身份、资产层次
    │
    ▼
LLM 二次合并（多视频时）
    ├── 综合多次分析结果 → 归纳最终风格画像
    └── 叙事骨架归并（skeleton_mode 枚举 + 母题谱系 + 多视频共现钩子模式；禁标题推断）
    │
    ▼
爆款商单附加分析（星图链路，失败不影响主流程）
    ├── sec_user_id → 星图 kol_id（get_xingtu_kolid_by_sec_user_id）
    ├── kol_id → 最近 15 条星图商单（kol_video_performance_v1, onlyAssign=true）
    ├── 取播放量最高的 1 条 → aweme_id 换播放地址（fetch_one_video_v3）
    └── 多模态分析商单视频 → top_ad_video 字段；无商单则跳过
    │
    ▼
人工补充强制覆盖（occupation / asset_level / other；留空则保持模型推断）
    │
    ▼
大V（阅历型权威）判定（2026-09-21 新增，附加产出，失败降级）
    ├── 数据源：user_profile.follower_count（>100万硬门槛）+ 认证信息
    ├── LLM 判四特征：中年(35-50)/可叙述阅历资历/口播观点形态/观众仰视导师关系
    ├── 程序化计算 tier（头部大V>500万｜标准大V 100-500万｜中腰部阅历型｜内容能力型）
    └── 输出 basic_positioning.authority_profile（is_big_v/tier/traits/evidence/confidence）
    │
    ▼
JSON 输出（4 大模块）
    ├── basic_positioning（基础定位 + 达人自身画像 + authority_profile 大V判定）
    │   ├── nickname, influencer_type, core_persona, content_tracks[]
    │   ├── influencer_demographic（年龄/性别/职业/career_identity职业身份核实/外貌/讲话/资产/语速/情绪/视觉/标签）
    │   └── authority_profile（is_big_v/tier/authority_source/follower_count/traits四特征/confidence）
    ├── narrative_skeleton（叙事骨架）
    │   └── skeleton_mode枚举/开场/转折/收尾/motif_spectrum母题谱系/hit_hook_patterns共现钩子模式/emotion
    ├── audience_insight（受众洞察）
    └── top_ad_video（爆款商单分析，可空）
        └── 商单数据（播放/点赞/日期）+ 视频分析（钩子/骨架/植入方式/原生化程度）
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

### Step 3: 视频选样（2026-09-21 规则）

在 `parse_influencer_bundle()` 中执行：

1. 拉取达人最近 20 条作品（端点实测仅支持 count=20，传其他值 400）
2. 全部作品按 `statistics.digg_count`（点赞）降序排序，取 Top5
   - 注意：该端点 `statistics.play_count` 恒为 0（抖音不公开播放数），无法按播放量排序
3. Top5 中筛选时长 < 10 分钟的视频，按排名取前 2 个做多模态分析
4. **Top5 全部 ≥ 10 分钟时抛 `UnfitInfluencerError`**，报"该达人不适合本次投放：视频太长"，流程中止
5. 时长缺失（duration=0）的视频视为不合格，不参与选中
6. 对每个选中作品，从 `video.play_addr.url_list` 中选取域名为 `api.amemv.com` 的链接（找不到则取最后一个兜底）

### Step 3.5: 爆款商单附加分析（星图链路）

主流程输出后，通过 TikHub 星图接口附加 `top_ad_video` 字段（**任何环节失败只降级不报错，不影响主流程**）：

1. `get_xingtu_kolid_by_sec_user_id`：sec_user_id → 星图 kol_id（未注册星图返回 None，跳过）
2. `kol_video_performance_v1`（onlyAssign=true）：kol_id → `latest_star_item_info` = 最近 15 条星图商单（含真实播放量/点赞/时长/日期）
3. 取播放量最高的 1 条 → `fetch_one_video_v3`（aweme_id 换播放地址）
4. 千问多模态分析商单视频：钩子类型、三段骨架、植入方式、内容母题、品牌口播信号、广告原生化程度
5. 无商单 / 未取到播放地址 / 分析失败 → `top_ad_video.available=false` + 原因说明

**成本**：星图链路每次分析约 +0.021$（kol_id 查询 + 商单列表 0.02$）+ 1 次视频分析；大V判定 +1 次用户信息接口 + 1 次文本 LLM 调用（约几千 token，成本可忽略）。

### Step 3.6: 大V（阅历型权威）判定

主分析产出后，附加 `basic_positioning.authority_profile`（**失败降级不报错，不影响主流程**）：

1. **数据源**：`fetch_user_profile_info()`（`/api/v1/douyin/web/handler_user_profile`）拉取 `follower_count`（真实粉丝数）+ 认证（`custom_verify` 个人认证 / `enterprise_verify_reason` 企业认证）。注意：作品列表端点的 author 对象**不含** follower_count，必须走此端点；接口失败 → 粉丝未知 → confidence=low，不确认大V
2. **LLM 判四特征**（一次文本调用，输入为主分析 JSON 紧凑子集 + bio + 粉丝/认证）：
   - `age_35_50`：中年（35-50 岁）——程序解析 `age_range` 优先（区间与 [35,50] 重叠 ≥3 年），LLM 兜底
   - `narratable_experience`：可叙述阅历资历（军旅/创业/企业主/媒体/学界/从业年限，失败经历也算；自我否认不构成否定）
   - `oral_opinion_form`：口播观点形态（非剧情/非图文/非vlog）
   - `mentor_relationship`：观众仰视导师关系（区别于闺蜜安利/平视）
   - 人工补充职业 → `narratable_experience` 强制命中（人工优先）
3. **程序化计算**（纯规则，可单测，`tests/test_authority.py`）：
   - 四特征全命中 → `authority_source = 阅历身份型`（大V 形态成立）
   - **`is_big_v` = 阅历身份型 AND 粉丝 > 100 万**（用户 2026-09-21 定硬门槛，大宽哥 103 万校准；崔校长 81 万 → 形态成立但量级不足）
   - `tier` 枚举：`头部大V`（>500万）｜`标准大V`（100-500万）｜`中腰部阅历型`（形态成立量级不足）｜`内容能力型`（无阅历证据，如达哥）
4. **confidence**：粉丝未知=low；阅历型成立且 career_identity 有明确证据=high；其余=medium
5. **消费含义**：is_big_v=true 可承接权威叙事型策略（专家背书/政策解读/权威拆解）；内容能力型走认知差/拆解型策略，权威类策略对其打折

### Step 4: 千问多模态 LLM 分析

调用 `scripts/providers/multimodal.py` 的 `run_video_analysis()`（内置分阶段耗时日志：TikHub/视频分析/合并）：

- **模型**：qwen3-vl-plus（通过 inferera OpenAI 兼容接口；2026-09-09 实测单视频分析 ~15s，doubao-seed-2-1-pro 需数分钟）
- **API 地址**：`https://api.inferera.com/v1/chat/completions`
- **输入**：系统 prompt（风格分析指令）+ 用户文本（bio + nickname）+ video_url
- **参数**：max_tokens=8192, temperature=0.3, timeout=300s
- **分析维度**（3 大模块）：
  - **基础定位**：人设一句话、核心赛道、达人类型（格式"一级-二级"，依据《达人类型基础标准（终版）》，无匹配输出"无匹配-需补充"）；下属 `influencer_demographic` 子对象提取达人自身画像（年龄/性别/职业/外貌/讲话风格/资产层次/语速/情绪/视觉符号/风格标签）。
  - **career_identity（职业身份核实，下游 script-creation 策略匹配的硬门槛）**：status（有明确证据=bio自述或口述明确提及职业/经营/从业经历；有间接线索=仅画面场景推断；无法判断=均无信息）+ description（职业经历描述，无证据写'未发现'）+ evidence（判定依据）。禁止编造，宁可'无法判断'不可拔高
  - **narrative_skeleton（叙事骨架，2026-09-21 新增）**：hook_type（前3秒钩子类型，必须基于视频实际开头）、开场/中段转折/收尾三段结构、motifs（内容母题1-3个）、emotion（情绪基调）、commercial_signals（品牌口播/推销信号，区分硬广与自然提及）
  - **受众洞察**：人口统计特征、心理诉求

**逐视频调用（方案A）**：遍历选出的视频 URL，逐个调用大模型分析。全部成功后通过 LLM 二次合并为最终结果。单个失败则跳过继续，全部失败则报错中止。

**合并规则（narrative_skeleton）**：合并时 skeleton_mode 从枚举（反常识结论前置/悬念递进/故事化叙事/数据实证/场景剧情/盘点清单）选最主要 1 个；hit_hook_patterns 只收多视频共现的钩子模式（≥2 个视频出现同一模式），**禁止从标题/简介文本推断**（2026-09-21 教训：标题推断出的"时效性强"共性证据等级低，曾误导下游热点嫁接规则）。

### Step 5: 输出 JSON

LLM 输出 JSON，经 `_ensure_complete_json()` 校验完整性 + `_compact_result()` 硬截断超长字段后返回。

输出结构详见 `references/json-schema.md`。

**下游技能消费本技能输出时，必读 `references/output-schema.md`（输出数据使用指南）**：完整字段清单、枚举值、异常降级分支（如"视频太长不适合投放"）、数据口径须知（非商单视频无真实播放量、hit_hook_patterns 仅收视频级共现证据等）。该指南为一次性固定文档，schema 变更时才更新。

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
├── _run_with_manual.py            # 运行入口：带人工补充 + 多候选视频 + 失败跳过
├── _run_analysis_retry.py         # 运行入口：遇内容审核拦截时多取候选视频重试
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

### 带人工补充信息运行（推荐入口）

```bash
cd scripts

# 带全部三项补充
python _run_with_manual.py \
  --url "https://www.douyin.com/user/MS4w..." \
  --occupation "金融助贷从业者" \
  --asset-level "高" \
  --other "拍摄方式：一男一女双人共说台词"

# 只补「其他补充」，前两项留空即不覆盖
python _run_with_manual.py --url "https://www.douyin.com/user/MS4w..." --other "双人出镜共说台词"

# 不做人工补充（等价纯推断）
python _run_with_manual.py --url "https://www.douyin.com/user/MS4w..."
```

| 参数 | 说明 |
|------|------|
| `--url` / `--sec-user-id` | 二选一，达人定位 |
| `--occupation` | 人工补充：达人职业 |
| `--asset-level` | 人工补充：资产层次 |
| `--other` | 人工补充：其他补充 |
| `--candidates` | （已废弃）选样规则固定为 点赞Top5→时长筛选→前2个，此参数仅兼容保留 |
| `--target` | 成功分析目标数，默认 2 |
| `--out` | 输出路径，默认 `analysis_result_manual_<日期>.json` |

脚本内部流程：按选样规则取视频 → 逐个分析、失败跳过、凑够 target 个即停 → LLM 二次合并 → 星图商单附加分析（top_ad_video）→ 人工补充程序化强制覆盖 → 落盘 JSON。

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

- **带人工补充信息一律走 `scripts/_run_with_manual.py`**：它是唯一支持 `--occupation/--asset-level/--other` 的入口，跑完自动执行人工补充强制覆盖；直接调 `run_influencer_profiler()` 需要自己按 Step 1 的 JSON 结构传 `manual_supplement`
- **达人不适合投放的判定**：点赞 Top5 视频时长全部 ≥10 分钟时抛 `UnfitInfluencerError`（如口播长视频达人），这是用户 2026-09-21 定的硬规则，提示"达人不适合本次投放：视频太长"
- **大V判定是形态判断不含善恶**：劣迹/品牌风险（如刘雯式封禁败诉史）不进 authority_profile，走 manual_supplement 人工补充；粉丝量级是硬门槛（>100万），量级不足但四特征命中 → 中腰部阅历型（权威类策略打折而非禁用）
- **大V判定附加产出，失败降级**：用户信息接口失败（粉丝未知）或 LLM 特征判定失败 → `authority_profile.available=false` + note，主流程正常输出其余字段
- **千问内容审核拦截（data_inspection_failed）**：qwen3-vl-plus 对个别视频会报 `400 InternalError.Algo.DataInspectionFailed`。处理方式：逐个分析、失败跳过、成功 2 个即停（`_run_with_manual.py` 已内置该逻辑）
- **勿复用 scripts 目录下的 analysis_result*.json 旧缓存**：这些是历史分析残留，可能是其他达人的结果，每次分析以本次运行输出为准
- TikHub API 有调用频率限制，注意控速；星图接口（kol_video_performance_v1）收费 0.02$/次
- 星图商单分析是附加产出，`top_ad_video.available=false` 时附原因（未注册星图/无商单/接口异常），不影响主流程
- 所有视频分析均失败时直接报错中止，不做文本兜底
- 各字符串和数组字段有硬限制，超长按**标点感知**方式截断（回退到最近标点，不会拦腰切句；无标点可用时补 `…`），详见 `references/json-schema.md`
- 需要配置的 API Key：`TIKHUB_API_TOKEN`、`ANTHROPIC_API_KEY`（或 `VIDEO_API_KEY`）
- **Python 环境**：依赖（anthropic / openai / httpx / pydantic-settings）已装在托管虚拟环境 `/Users/dzsb-002295/.workbuddy/binaries/python/envs/default`，直接用它运行脚本即可（`/Users/dzsb-002295/.workbuddy/binaries/python/envs/default/bin/python _run_with_manual.py ...`），不要往系统 Python 里装包
