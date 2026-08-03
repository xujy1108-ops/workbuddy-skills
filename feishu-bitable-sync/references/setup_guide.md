# 飞书多维表格数据同步 - 团队使用指南

## 功能简介

将视频号广告数据（播放量、互动量、点赞量等）自动同步到飞书多维表格。

## 前置条件

### 1. 安装 Node.js

确保已安装 Node.js 18+（推荐 22+）。

```bash
node --version  # 检查版本
```

### 2. 安装并配置 lark-cli

lark-cli 是飞书命令行工具，用于读写多维表格数据。

#### 安装

lark-cli 已随 WorkBuddy 的 lark-unified skill 安装。如未安装，在 WorkBuddy 中加载 lark-unified skill 即可。

#### 配置（首次使用）

1. 运行配置脚本：
   ```bash
   cd ~/.workbuddy/skills/lark-unified
   python3 scripts/lark_setup.py
   ```
2. 浏览器会自动打开飞书授权页面，完成授权。

#### 用户身份授权（必须）

由于多维表格嵌在知识库中，需要额外的用户身份授权：

```bash
lark-cli auth login --domain base,wiki,drive
```

浏览器会打开授权页面，用飞书账号登录并确认授权。

### 3. 获取 Cookie

1. 在浏览器中打开 [视频号广告平台](https://huxuan.qq.com)
2. 登录账号
3. 打开浏览器开发者工具（F12）→ Network 标签
4. 刷新页面，找到任意请求，复制请求头中的 `cookie` 值

> **注意：Cookie 会过期！** 如果脚本报 401/403 错误，说明 cookie 过期了，需要重新获取。

### 4. 创建配置文件

复制配置模板：

```bash
cp .workbuddy/skills/feishu-bitable-sync/scripts/config.example.json ~/.feishu_sync_config.json
```

编辑 `~/.feishu_sync_config.json`，填入你的 cookie：

```json
{
  "cookie": "你从浏览器复制的完整 cookie 字符串",
  "base_token": "D6NXbZxAjaPltKs4MEecz5xgnSf",
  "table_id": "tblE7SEdyF7UpiCi",
  "start_time": "20260717",
  "account_id": "85142655"
}
```

### 5. 飞书表格权限

确保你的飞书账号已被添加为目标多维表格的协作者（至少可编辑权限）。

## 使用方法

```bash
# 基本用法：处理第1行到第10行
node .workbuddy/skills/feishu-bitable-sync/scripts/sync_to_feishu.mjs 1 10

# 指定配置文件
node .workbuddy/skills/feishu-bitable-sync/scripts/sync_to_feishu.mjs 1 10 --config ~/my_config.json
```

## 字段说明

脚本会从飞书多维表格读取【订单ID】字段，获取以下数据并写回：

| 脚本字段 | 飞书字段名 | 说明 |
|---------|-----------|------|
| bfl | 播放量 | 视频播放量 |
| hdsl | 互动量=点赞+评论+分享 | 互动总量 |
| dzl | 点赞量 | 点赞数 |
| pll | 评论量 | 评论数 |
| fxl | 分享量 | 分享数 |
| zpb | 赞评比 | 评论/点赞比（文本） |
| wbl | 完播率 | 完播率（百分比） |
| hdl | 互动率 | 互动率（百分比） |
| cpm | cpm | 千次曝光成本 |
| cpe | CPE | 单次互动成本 |
| zjcpm | 组件cpm | 组件千次曝光成本 |
| zjcpe | 组件CPE | 组件单次点击成本 |
| cvt_show | 组件曝光量 | 组件曝光数 |
| cvt_click | 组件点击量 | 组件点击数 |
| cvt_rate | 组件点击率 | 组件点击率（百分比） |

## 常见问题

### Cookie 过期

错误现象：脚本输出 `❌ Cookie 已过期 (HTTP 401)！`

解决方法：重新从浏览器获取 cookie，更新 `~/.feishu_sync_config.json` 中的 `cookie` 字段。

### lark-cli 未授权

错误现象：脚本输出 `读取记录失败` 或权限相关错误。

解决方法：重新运行 `lark-cli auth login --domain base,wiki,drive` 完成授权。

### 多维表格无权限

错误现象：lark-cli 报权限错误。

解决方法：联系表格管理员，将你的飞书账号添加为协作者。
