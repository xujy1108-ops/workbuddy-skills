# 度小满策略素材沉淀工作流

从头条数据表的投放脚本中，按入池标准筛选优秀脚本，用AI分析提取可复用的策略素材，写入审核表供人工审核，审核通过后追加到策略库文档。

> 详细说明（数据资产、字段ID、环境变量、踩坑记录）见 [SKILL.md](./SKILL.md)。

## 工具链

```
头条数据表 ──筛选──> AI分析 ──> 审核表 ──人工审核──> 策略库文档
   (源数据)                  (待审核)               (热点/非热点)
```

## 用法

### 1. 跑分析（手动触发）

```bash
cd ~/Desktop/code/workbuddy-skills/strategy-review/scripts
node strategy_review.js
```

- 自动加载 .env（scripts/ → skill根目录 → duxiaoman-hotspot/.env）
- 入池标准：星推比>2.5 或 转化是否达标=是
- 评分等级：双达标→S，仅一项达标→A
- 按源脚本ID去重，重复跑不会重复写入
- 调试：`TEST_MODE=1 node strategy_review.js` 只分析第1条

### 2. 人工审核

飞书打开「策略素材审核表」：修改AI建议 → 确认入库目标 → 审核状态改"已通过"。

### 3. 同步到策略库

```bash
cd ~/Desktop/code/workbuddy-skills/strategy-review/scripts
node sync_to_strategy.js
```

- 只同步"已通过"记录，追加到对应策略库文档末尾
- 成功后自动回写状态为"已入库"，重跑不会重复追加
- 追加内容在"待补充素材"区域，需人工归位到方法库分类下

## 数据源

| 数据 | 位置 |
|---|---|
| 头条数据表 | Base: IusNb2cgTafYo4sTVntcHNJHn9f, Table: tblBEveR1P0gKRyy |
| 策略素材审核表 | 同 Base, Table: tblX7a3YpwLExN7Z |
| 策略库-非热点 | https://kwza968lz1u.feishu.cn/docx/BBx1dVk5aoNIn6xgON2cppNKnkb |
| 策略库-热点 | https://kwza968lz1u.feishu.cn/docx/SHdXdI0KQoJbfwxNq4mcePL5nxb |
