# WorkBuddy Skills

个人 WorkBuddy 技能集合，用户级（跨项目可用）。

## Skills 一览

| Skill | 说明 | 来源 |
|-------|------|------|
| `creative-content-analysis` | 度小满品牌创意素材自动分析（抖音） | 自建 |
| `lark-unified` | 飞书统一 CLI 工具集 | Marketplace 安装 |
| `feishu-bitable-sync` | 视频号广告数据同步到飞书多维表格 | 自建 |

## 目录结构

```
~/.workbuddy/skills/           ← 本仓库（git）
├── creative-content-analysis/
│   ├── SKILL.md
│   ├── scripts/
│   └── references/
├── lark-unified/
│   ├── SKILL.md
│   ├── scripts/
│   └── references/
├── feishu-bitable-sync/
│   ├── SKILL.md
│   ├── scripts/
│   │   ├── sync_to_feishu.mjs
│   │   └── config.example.json
│   └── references/
│       └── setup_guide.md
├── .gitignore
└── README.md
```

## 使用方式

本仓库直接位于 `~/.workbuddy/skills/`，WorkBuddy 会自动加载此目录下的所有 skill。

```bash
# 拉取最新
cd ~/.workbuddy/skills && git pull

# 推送改动
cd ~/.workbuddy/skills && git add -A && git commit -m "update" && git push
```

## 新增 Skill

直接在此目录下创建新的 skill 文件夹，或从 WorkBuddy Marketplace 安装，然后 `git add` 跟踪即可。

## 环境变量

各自 skill 需要的环境变量见对应目录下的 `.env.example`。
