---
name: influencer-style-analysis
description: "达人风格识别技能。通过抖音主页链接或 sec_user_id，经 TikHub API 拉取达人数据（简介、视频列表、音频），使用多模态 LLM 听音频分析口吻语气，输出人设定位、内容风格标签和风格摘要的 JSON。当用户提到达人分析、达人风格、风格识别、创作者风格、达人画像、influencer profiler 等关键词时触发此技能。"
agent_created: true
---

# Influencer Style Analysis（达人风格识别）

## Overview

通过抖音达人主页链接，经 TikHub API 拉取达人数据（简介、最近视频标题、最新视频音频），使用多模态 LLM（Gemini 2.5 Flash）直接听 mp3 音频分析达人风格，输出包含人设定位和内容风格标签的结构化 JSON。

## 架构概览

```
用户输入（抖音主页链接）
    │
    ▼
TikHub API 拉取达人数据
    ├── bio（达人简介）
    ├── recent_videos（最近 10 条视频标题）
    └── latest_audio_url（最新视频音频链接）
    │
    ▼
音频处理
    ├── download_audio（下载 mp3）
    └── prepare_audio_for_profiler（截取前 60 秒）
    │
    ▼
多模态 LLM 分析
    ├── 听音频：口吻、语气、语速、停顿、情绪
    └── 读文本：bio + 视频标题 → 人设定位
    │
    ▼
JSON 输出
    ├── persona_positioning（人设定位）
    ├── content_style（内容风格 + 8 类标签）
    ├── influencer_profile_text（≤200 字摘要）
    └── analysis_mode（multimodal_audio|text_fallback|text_only）
```

## 触发条件

当用户出现以下意图时触发：
- "分析达人风格"、"达人风格识别"
- "创作者风格分析"、"达人画像"
- "influencer profiler"、"达人风格"
- 提供抖音主页链接要求分析

## 工作流程

### Step 1: 接收输入

输入形式（三选一）：

1. **抖音主页链接**（最常用）：
   ```
   {"douyin_profile_url": "https://www.douyin.com/user/MS4wLjABAAAA..."}
   ```
   或直接传入链接字符串。

2. **sec_user_id**：
   ```
   {"sec_user_id": "MS4wLjABAAAA..."}
   ```

3. **手动提供数据**（跳过 TikHub）：
   ```
   {
     "bio": "达人简介",
     "recent_videos": [{"title": "视频标题", "description": "描述"}],
     "latest_audio_url": "https://...",
     "audio_transcript": "音频转写文本（兜底）"
   }
   ```

### Step 2: TikHub 拉取达人数据

调用 `scripts/tools/tikhub.py` 的 `fetch_influencer_from_douyin()`：
- 从主页链接解析 sec_user_id
- 调用 TikHub API 拉取达人最近 10 条视频
- 提取：bio（简介）、recent_videos（视频标题列表）、latest_audio_url（最新视频音频链接）、author_nickname

**前置条件**：需配置 `TIKHUB_API_TOKEN` 环境变量。

### Step 3: 音频处理

调用 `scripts/tools/audio.py`：

1. `download_audio(audio_url)` — 下载 mp3
2. `prepare_audio_for_profiler(audio_bytes)` — 截取前 60 秒（默认），加速多模态分析
   - 依赖 pydub + ffmpeg
   - 未安装时自动降级为使用完整音频

### Step 4: 多模态 LLM 分析

调用 `scripts/providers/multimodal.py` 的 `run_multimodal()`：

- **模型**：Gemini 2.5 Flash（默认，通过 AiHubMix OpenAI 兼容接口）
- **输入**：系统 prompt（风格分析指令）+ 用户文本（bio + 视频标题）+ 音频 mp3
- **分析内容**：
  - 听音频：口吻、语气、语速、停顿、情绪
  - 读文本：人设定位、选题方向、受众

**三种分析模式**（按优先级自动选择）：

| 模式 | 条件 | 说明 |
|------|------|------|
| `multimodal_audio` | 有音频 mp3 | 最佳：直接听音频分析风格 |
| `text_fallback` | 无音频但有转写文本 | 兜底：根据文本分析 |
| `text_only` | 无音频无转写 | 仅根据 bio + 视频标题分析 |

### Step 5: 输出 JSON

LLM 输出 JSON，经 `_compact_result()` 硬截断超长字段后返回。

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
│   └── multimodal.py              # 多模态 LLM 调用（OpenAI 兼容接口）
├── tools/
│   ├── __init__.py
│   ├── tikhub.py                  # TikHub API 抖音数据拉取
│   └── audio.py                   # 音频下载、截取、转写
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
2. 安装 ffmpeg（音频截取需要）：
   ```bash
   brew install ffmpeg
   ```
3. 复制 `.env.example` 为 `.env` 并填写 API Key：
   ```bash
   cp scripts/.env.example scripts/.env
   ```

### 调用入口

```python
import sys
sys.path.insert(0, "scripts")

from agents.influencer_profiler import run_influencer_profiler

# 方式 1：传入 JSON 字符串
result = run_influencer_profiler('{"douyin_profile_url": "https://www.douyin.com/user/MS4w..."}')

# 方式 2：直接传入主页链接
result = run_influencer_profiler("https://www.douyin.com/user/MS4w...")

# 方式 3：手动提供数据
result = run_influencer_profiler(json.dumps({
    "bio": "达人简介",
    "recent_videos": [{"title": "标题", "description": "描述"}],
}))

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

### 调整音频截取时长

修改 `.env` 中的 `INFLUENCER_AUDIO_MAX_SECONDS`（默认 60 秒）。

## 注意事项

- TikHub API 有调用频率限制，注意控速
- 多模态模型需支持音频输入（默认 Gemini 2.5 Flash）
- 音频截取依赖 pydub + ffmpeg，未安装时自动降级为完整音频
- `influencer_profile_text` 字段硬限制 200 字，超长自动截断
- 无音频且无转写文本时降级为 `text_only` 模式，分析质量会下降
- 需要配置的 API Key：`TIKHUB_API_TOKEN`、`MULTIMODAL_API_KEY`（或 `ANTHROPIC_API_KEY`）
