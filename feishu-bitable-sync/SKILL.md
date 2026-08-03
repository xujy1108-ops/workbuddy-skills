---
name: feishu-bitable-sync
description: 将视频号广告数据（播放量、互动量、点赞量等）自动同步到飞书多维表格。当用户需要批量拉取视频号广告投放数据并更新到飞书多维表格时使用此技能。支持指定行范围、自动读取订单ID、获取数据并回写表格。触发词：同步数据到飞书、跑数据、更新多维表格、视频号广告数据。
agent_created: true
---

# 飞书多维表格数据同步

## 功能概述

从视频号广告平台（huxuan.qq.com）批量拉取广告投放数据，包括播放量、互动量、点赞量、评论量、分享量、完播率、互动率、CPM、组件点击率等 15 项指标，自动同步到飞书多维表格。

## 使用场景

- 需要将视频号广告数据同步到飞书多维表格
- 需要批量处理多行订单数据
- 用户提到"同步数据到飞书表格""跑数据""更新多维表格"等

## 自动环境检测与配置（必须按顺序执行）

当触发此技能时，**必须先执行以下环境检查**，逐步引导用户完成所有前置配置。不要跳过任何步骤，不要让用户自己去查文档。

### 步骤 0：安装 lark-unified skill（如果尚未安装）

检查 lark-cli 是否可用：

```bash
lark-cli --version 2>/dev/null && echo "INSTALLED" || echo "NOT_INSTALLED"
```

如果输出 `NOT_INSTALLED`，自动加载 lark-unified skill：
1. 调用 `Skill` 工具，参数为 `lark-unified`
2. 安装完成后再次验证 `lark-cli --version`

### 步骤 1：配置 lark-cli（如果尚未配置）

检查配置状态：

```bash
lark-cli config show 2>&1 | grep -q "app_id" && echo "CONFIG_OK" || echo "NOT_CONFIGURED"
```

如果输出 `NOT_CONFIGURED`，运行配置脚本（后台执行，因为需要用户在浏览器授权）：

```bash
cd ~/.workbuddy/skills/lark-unified && python3 scripts/lark_setup.py
```

- 脚本会输出一个授权链接（格式：`https://open.feishu.cn/page/launcher?user_code=XXXX-XXXX`）
- **立即将链接发给用户**，告知在浏览器中完成飞书授权
- 等待用户确认授权完成后继续

### 步骤 2：飞书用户身份授权（必须，用于读写多维表格）

检查用户身份授权状态：

```bash
lark-cli auth status --json 2>&1
```

如果未授权 base/wiki/drive 域名，发起授权（后台执行，因为需要用户在浏览器完成）：

```bash
lark-cli auth login --domain base,wiki,drive --json
```

- 脚本会输出一个授权链接和 user_code
- **立即将链接发给用户**，告知在浏览器中完成飞书授权
- 可选：生成二维码图片方便手机扫码
- 等待用户确认授权完成后继续

### 步骤 3：创建配置文件（如果尚未创建）

检查配置文件是否存在：

```bash
test -f ~/.feishu_sync_config.json && echo "EXISTS" || echo "NOT_EXISTS"
```

如果输出 `NOT_EXISTS`：
1. 复制模板：`cp .workbuddy/skills/feishu-bitable-sync/scripts/config.example.json ~/.feishu_sync_config.json`
2. **告知用户需要填写 cookie**，说明获取方法：
   - 打开 https://huxuan.qq.com 并登录
   - F12 打开开发者工具 → Network 标签
   - 刷新页面，找到任意请求，复制请求头中的 `cookie` 值
3. 等待用户提供 cookie 后，自动写入配置文件
4. 配置文件中 `base_token`、`table_id`、`start_time`、`account_id` 已有默认值，除非用户另有指定

### 步骤 4：验证环境就绪

一次性检查所有条件：

```bash
lark-cli --version && lark-cli auth status --json 2>&1 | grep -q "base" && test -f ~/.feishu_sync_config.json && echo "ALL_READY" || echo "NOT_READY"
```

如果输出 `ALL_READY`，进入执行流程。否则回到对应步骤继续配置。

## 执行流程

环境就绪后，**用户只需要提供起始行和结束行**，其余全自动：

```
用户: "帮我同步第4到第7行的数据"
```

WorkBuddy 执行：

```bash
node .workbuddy/skills/feishu-bitable-sync/scripts/sync_to_feishu.mjs <起始行> <结束行>
```

参数说明：
- `<起始行>` — 从第几行开始处理（从 1 开始）
- `<结束行>` — 处理到第几行
- `--config <路径>` — 可选，指定自定义配置文件路径

### 执行后处理（必须向用户汇报）

执行完成后，**必须将脚本的输出结果清晰汇报给用户**，特别是：

1. **成功汇总** — 成功了几行，每行的播放量/互动量/点赞量
2. **失败行明细** — 如果有行处理失败，必须逐行列出：第几行、订单ID、失败原因
3. **Cookie 过期提醒** — 如果脚本报 Cookie 过期，立即通知用户重新获取 cookie，不要自行处理
4. **未执行的行** — 如果因 Cookie 过期提前终止，明确告知哪些行未执行

汇报格式示例：
```
✅ 成功 3 行:
   第4行 (订单ID: xxx) — 播放量: 1234, 互动量: 56, 点赞: 30
   第5行 (订单ID: xxx) — 播放量: 5678, 互动量: 90, 点赞: 45
   第6行 (订单ID: xxx) — 播放量: 901, 互动量: 12, 点赞: 8

❌ 失败 1 行:
   第7行 (订单ID: xxx) — 原因: Cookie 已过期

🚫 Cookie 已过期，请重新获取 cookie 并发给我，我会自动更新后继续处理第7行。
```

### Cookie 过期处理

- 脚本检测到 401/403 会自动终止后续行
- **通知用户 cookie 已过期**，说明获取新 cookie 的方法（打开 huxuan.qq.com → F12 → Network → 复制请求头中的 cookie）
- **当用户在对话中发来新 cookie 时，WorkBuddy 自动更新配置文件**，不需要用户手动编辑：
  1. 读取 `~/.feishu_sync_config.json`
  2. 替换其中的 `cookie` 字段为用户提供的值
  3. 保存文件
  4. 告知用户已更新，并重新执行之前失败的行
- **绝对不要让用户自己去改文件**，用户只需把 cookie 文本发过来即可

## 关键注意事项

- **用户只需提供行号** — 不要让用户操心环境配置、命令参数，这些全自动
- **必须汇报失败行** — 任何行失败都要明确告知用户，不能悄悄跳过
- **Cookie 会过期** — 脚本检测到过期会提前终止，必须通知用户
- **飞书授权会过期** — 如 lark-cli 报权限错误，需重新运行步骤 2 的授权命令
- **请求间隔** — 脚本内置 500-1500ms 随机延迟，避免请求过快被封
- **百分比字段** — 完播率、互动率、组件点击率在飞书中为百分比类型，脚本会自动将 "12.34%" 转为 0.1234
- **自动检测** — 每次执行前都应检查环境状态，不要假设上次配置仍然有效

## 资源文件

### scripts/
- `sync_to_feishu.mjs` — 主同步脚本，读取配置文件，执行数据拉取和回写
- `config.example.json` — 配置文件模板，包含 cookie、表格 token 等必填字段

### references/
- `setup_guide.md` — 团队成员使用指南（人工参考用，WorkBuddy 会自动执行配置流程，不需要用户手动查看）
