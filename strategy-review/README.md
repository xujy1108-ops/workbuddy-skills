# 策略素材沉淀工作流（多品牌配置化）

从品牌投放数据表中，按入池标准筛选优秀脚本，用AI分析提取可复用的策略素材，写入审核表供人工审核，审核通过后追加到策略库文档。

品牌私有内容（品牌名、飞书表、阈值、分级规则、策略库文档、AI prompt）全部外置在 `config/<brand>/`，代码只保留通用流程逻辑，用 `--brand` 切换品牌。

> 详细说明（配置项、数据资产、环境变量、踩坑记录、策略库写作规范、合规红线）见 [SKILL.md](./SKILL.md)。

## 工具链

```
数据源表 ──筛选──> AI分析 ──> 审核表 ──人工审核──> 策略库文档
 (源数据)                  (待审核)          (热点/非热点)
```

## 用法

### 1. 跑分析（手动触发）

```bash
cd ~/Desktop/code/workbuddy-skills/strategy-review/scripts
node strategy_review.js                    # 默认品牌 duxiaoman
node strategy_review.js --brand weiyedai   # 指定品牌
```

- `--brand` > `env WORKFLOW_BRAND` > 默认 `duxiaoman`；入池/分级/分线规则来自 `config/<brand>/config.json`
- .env 按优先级合并加载：`config/<brand>/.env` → `scripts/.env` → skill 根 → 仓库根 → `duxiaoman-hotspot/.env`
- 入池标准（度小满）：星推比>2.5 或 转化是否达标=是；评分等级：双达标→S，仅一项达标→A
- 按源脚本ID去重，重复跑不会重复写入
- 调试：`TEST_MODE=1` 只分析第1条；`DRY_RUN=1` 全流程干跑但不写表

### 2. 人工审核

飞书打开「策略素材审核表」：修改AI建议 → 确认入库目标 → 审核状态改"已通过"。

### 3. 同步到策略库

```bash
cd ~/Desktop/code/workbuddy-skills/strategy-review/scripts
node sync_to_strategy.js --brand duxiaoman
```

- 只同步"已通过"记录，追加到对应策略库文档末尾
- 成功后自动回写状态为"已入库"，重跑不会重复追加
- 追加内容在"待补充素材"区域，需人工归位到方法库分类下
- 调试：`DRY_RUN=1` 打印待追加内容，不写文档

## 新增品牌

复制 `config/duxiaoman/` → 改 `config.json` 的表/阈值/分级 → 改 `prompts/review.md` 的**角色定位与打法枚举**（品牌核心资产，不能复用）→ 跑一次，配置加载器会列出未填的 TODO。

## 品牌资产现状

| 品牌 | 状态 |
|---|---|
| duxiaoman（度小满） | ✅ 完整可用 |
| weiyedai（微业贷） | ⚠️ 骨架（缺数据源表 / 审核表 / 策略库文档 / 角色枚举 / 红线文档） |

### 度小满数据源

| 数据 | 位置 |
|---|---|
| 头条数据表 | Base: IusNb2cgTafYo4sTVntcHNJHn9f, Table: tblBEveR1P0gKRyy |
| 策略素材审核表 | 同 Base, Table: tblX7a3YpwLExN7Z |
| 策略库-非热点 | https://kwza968lz1u.feishu.cn/docx/BBx1dVk5aoNIn6xgON2cppNKnkb |
| 策略库-热点 | https://kwza968lz1u.feishu.cn/docx/SHdXdI0KQoJbfwxNq4mcePL5nxb |
