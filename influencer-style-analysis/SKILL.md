---
name: influencer-style-analysis
description: "达人风格识别技能。通过抖音主页链接或 sec_user_id，经 TikHub API 拉取达人数据（简介、视频列表），筛选视频并使用 Doubao 多模态大模型直接看视频分析口吻语气，输出人设定位、内容风格标签和风格摘要的 JSON。当用户提到达人分析、达人风格、风格识别、创作者风格、达人画像、influencer profiler 等关键词时触发此技能。"
agent_created: true
---

# Influencer Style Analysis（达人风格识别）

## Overview

通过抖音达人主页链接，经 TikHub API 拉取达人数据（简介、视频列表），筛选出可分析的视频，使用 Doubao 多模态大模型（doubao-seed-2-1-pro）直接看视频分析达人风格，输出包含人设定位和内容风格标签的结构化 JSON。

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
Doubao 多模态 LLM 分析（逐个视频，方案A）
    ├── 看视频：口吻、语气、语速、停顿、情绪、画面风格
    └── 读文本：bio → 人设定位
    │
    ▼
JSON 输出
    ├── persona_positioning（人设定位）
    ├── content_style（内容风格 + 8 类标签）
    ├── influencer_profile_text（≤200 字摘要）
    └── analysis_mode（multimodal_video）
```

## 触发条件

当用户出现以下意图时触发：
- "分析达人风格"、"达人风格识别"
- "创作者风格分析"、"达人画像"
- "influencer profiler"、"达人风格"
- 提供抖音主页链接要求分析

## 工作流程

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

### Step 4: Doubao 多模态 LLM 分析

调用 `scripts/providers/multimodal.py` 的 `run_video_analysis()`：

- **模型**：doubao-seed-2-1-pro（通过 inferera OpenAI 兼容接口）
- **API 地址**：`https://api.inferera.com/v1/chat/completions`
- **输入**：系统 prompt（风格分析指令）+ 用户文本（bio）+ video_url
- **参数**：max_tokens=8192, temperature=0.3, timeout=300s
- **分析内容**：
  - 看视频：口吻、语气、语速、停顿、情绪、画面风格、剪辑节奏
  - 读文本：人设定位、选题方向、受众

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
│   └── multimodal.py              # Doubao 多模态调用（inferera OpenAI 兼容）
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
| `DOUBAO_API_KEY` | Doubao/inferera API Key（视频分析） |
| `DOUBAO_BASE_URL` | 接口地址，默认 `https://api.inferera.com/v1` |
| `DOUBAO_MODEL` | 模型名，默认 `doubao-seed-2-1-pro` |

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

## 8 类内容风格标签

LLM 从以下 8 个标签中最多选 3 个（按匹配度排序）：

| 标签 | 说明 |
|------|------|
| 亲切唠嗑 | 像朋友聊天，自然随性 |
| 激情造势 | 语速快、情绪足 |
| 专业沉稳 | 用词严谨，干货/测评专用 |
| 幽默吐槽 | 诙谐玩梗，轻松有笑点 |
| 温柔舒缓 | 语调柔和 |
| 利落酷飒 | 短句干脆，气场强 |
| 朴实接地气 | 大白话，真诚不花哨 |
| 悬念吊胃口 | 停顿造势，勾起好奇 |

## 扩展指南

### 新增平台支持

1. 在 `scripts/tools/` 中新增平台数据拉取脚本（参照 `tikhub.py`）
2. 在 `scripts/agents/influencer_profiler.py` 的 `_merge_with_tikhub()` 中增加平台分支
3. 输入 JSON 增加 `platform` 字段标识来源

### 调整风格标签

修改 `scripts/agents/influencer_profiler.py` 中的 `_STYLE_LABELS` 变量。标签定义详见 `references/style-dimensions.md`。

## 注意事项

- TikHub API 有调用频率限制，注意控速
- 视频筛选按 `data_size` 升序排列，优先分析小文件以减少处理时间
- 视频链接优先选 `api.amemv.com` 域名，该域名通常稳定可访问
- 所有视频分析均失败时直接报错中止，不做文本兜底
- `influencer_profile_text` 字段硬限制 200 字，超长自动截断
- 需要配置的 API Key：`TIKHUB_API_TOKEN`、`DOUBAO_API_KEY`
