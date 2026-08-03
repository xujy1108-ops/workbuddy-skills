# creative-content-analysis

度小满品牌创意素材自动分析工作流。围绕"资金周转困难"场景，自动生成抖音搜索关键词、搜索抖音视频、提取视频脚本、分析创意价值并同步到飞书多维表格。

当前支持 **抖音** 渠道，小红书和微信渠道后续补充。

## 快速开始

### 1. 安装到 WorkBuddy

将本目录（或软链接）放到 `~/.workbuddy/skills/` 下：

```bash
ln -s /path/to/creative-content-analysis ~/.workbuddy/skills/creative-content-analysis
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入实际值：

```bash
cp .env.example .env
# 编辑 .env 填入 API 密钥和飞书表格 token
```

或在运行前 export 环境变量。

### 3. 运行

```bash
# 完整运行（查重 + 搜索 + 提取 + 分析 + 写入飞书）
node scripts/run_workflow.js

# 自定义关键词
node scripts/run_workflow.js --keywords "关键词1,关键词2"

# 仅跑分析不写入表格
node scripts/run_workflow.js --skip-bitable
```

## 前置条件

- **飞书连接器**：已在 WorkBuddy 中连接（lark-cli 可用）
- **Node.js**：已安装
- **AIHubMix API Key**：用于 DeepSeek 和豆包模型调用
- **TikHub Token**：用于抖音视频搜索

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `AIHUBMIX_API_KEY` | 是 | AIHubMix API 密钥 |
| `TIKHUB_TOKEN` | 是 | TikHub 抖音搜索 API 令牌 |
| `BITABLE_BASE_TOKEN` | 是 | 飞书多维表格 Base Token |
| `BITABLE_TABLE_ID` | 是 | 飞书多维表格 Table ID |
| `AIHUBMIX_BASE_URL` | 否 | API 地址（默认 `https://api.inferera.com/v1`） |
| `DEEPSEEK_MODEL` | 否 | 关键词生成与分析模型（默认 `deepseek-v4-pro`） |
| `DOUBAO_MODEL` | 否 | 视频脚本提取模型（默认 `doubao-seed-2-1-pro`） |
| `WORKFLOW_CONCURRENCY` | 否 | 并行并发数（默认 `3`） |

## 工作流程

1. **自动查重** — 从飞书多维表格拉取已有素材 ID
2. **生成关键词** — DeepSeek 生成 2 个抖音搜索关键词
3. **搜索抖音** — TikHub API 搜索视频
4. **过滤去重** — 过滤时长 > 5 分钟、去除已有素材
5. **提取脚本** — 豆包模型转录视频台词（Promise.all 并行）
6. **过滤禁止内容** — 跳过催收、医疗、上学等敏感场景
7. **分析创意** — DeepSeek 输出内容方向、素材逻辑、借鉴点、植入建议
8. **自动写入飞书** — 结果写入多维表格（含更新时间字段）
9. **余额不足通知** — API 余额耗尽时自动给飞书发消息

## 目录结构

```
creative-content-analysis/
├── SKILL.md              # WorkBuddy Skill 主文档
├── README.md             # 本文件
├── .env.example          # 环境变量模板
├── .gitignore
├── scripts/
│   ├── run_workflow.js   # 主工作流脚本
│   └── video_script.js   # 单视频脚本提取工具
└── references/
    ├── prompts.md        # LLM 提示词
    └── bitable_config.md # 飞书多维表格字段映射
```

## 后续扩展

- 小红书渠道：补充小红书搜索 API，素材 ID 前缀 `xhs_`
- 微信渠道：补充微信视频号搜索，素材 ID 前缀 `wx_`
- 关键词去重：记录历史搜索关键词，避免一周内重复
- 适配达人类型：分析脚本内容，自动推荐适合的达人类型
