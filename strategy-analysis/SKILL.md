# strategy-analysis —— 内容策略表唯一读写入口

## 概述

内容策略表（方向层资产：一行 = 内容方向一 + 内容方向二 的组合策略）此前散在 creative-content-analysis 内部读写。本 skill 把**策略表的所有读与写**收敛为独立 CLI 服务，任何工作流（creative-content-analysis / strategy-review / 后续新流程）都通过调用本 skill 与策略表交互。

**能力**：
- `list`：读策略表全量行（含 recordId、方向组合、两级方向定义 `definition` / `l2Definition`、素材数可用 materialIds 现算）；读失败自动退品牌 config 静态快照
- `sync`：素材的策略沉淀——按方向聚合 → AI 查重 → 合并/新建 → select 选项自动扩充
- `regen`：按正向案例脚本原文重写已有行的「植入策略」（正向案例为空的行跳过不臆造）

**沉淀规则**（口径来自《内容策略表字段填写指南》3.4/3.6，与 creative-content-analysis 原实现一致）：
- 已有方向 + 策略重复（打法概括与推理链均同）→ 仅并入「素材链接ids」
- 已有方向 + 实质新打法 → 追加`【素材补充 <id>】`块
- 新方向 → 新建策略行，等级取 `levelForNewStrategy`（默认 X = 未经业务验证），正向案例 = 素材脚本原文
- 适合达人合并走宽/窄粒度规则（一级覆盖二级；行上窄 + 新素材宽 → 收敛为宽），幂等
- AI 查重失败 → 全部仅并入素材ids、策略文本不动（宁可少存不堆重复，下轮重试）
- **定义两列（2026-09-21 起）**：「内容一方向定义」= **一级方向定义**（这个一级管什么、边界在哪；同一级下各行应逐字一致，创意链路会校验并告警），「内容二方向定义」= **二级方向定义**（每行各写自己的，用于同级之间互相区分）。新建行时**一级定义自动继承该一级已有行的值**（保证同级一致），只有全新一级才用 AI 随策略传的「一级方向定义」；两者都取不到则留空并打告警提示人工补写

## 使用方法

```bash
# 读策略表（供关键词来源 / 方向枚举 / 展示）
node scripts/sync.js list --brand duxiaoman

# 策略沉淀（dry-run 只读+查重不写表）
node scripts/sync.js sync --brand duxiaoman --input items.json --dry-run
node scripts/sync.js sync --brand duxiaoman --input items.json

# 按正向案例重写植入策略（--record-id 限单行；--dry-run 只生成不回写）
node scripts/sync.js regen --brand weiyedai --dry-run
node scripts/sync.js regen --brand weiyedai
```

stdout 只输出结果 JSON，进度/日志走 stderr（调用方 execSync 解析 stdout）。

### regen 说明

逐行取「正向案例」脚本原文 → AI 生成植入策略（打法概括 + 取材真实脚本的推理链示例，禁止虚构脚本外情节）→ 回写「植入策略」列。正向案例为空的行自动跳过。AI 单行生成约 1-5 分钟，AI 超时下限 300s（config `ai.timeoutSec` 低于此值时取 300s）。适用于：初始植入策略为推演稿、需以实证脚本重写校准的场景。

### sync 输入 schema

```json
{
  "items": [
    {
      "id": "dy_748xxx（评论洞察）",
      "script": "完整脚本文本（新建方向时写入正向案例）",
      "source": "material",
      "strategy": {
        "内容方向一": "蹭热点",
        "内容方向二": "时政新闻",
        "方向定义": "人群+叙事+落点（= 二级方向定义，写入「内容二方向定义」列）",
        "一级方向定义": "（可选，仅新建一级方向时才需要；复用已有一级时留空，程序自动继承）",
        "植入策略": "打法概括 + 示例推理链",
        "适合达人": "达人类型：财经-泛财经\n……"
      }
    }
  ]
}
```

### 返回值（sync）

`{ ok, dryRun, created, updated, appended, mergedOnly, items, skipped }`
- `created/appended` 计入"新策略"（反内循环统计用）；`mergedOnly` = 仅并入素材ids 条数
- `ok:false` 时 `error: read_failed|write_failed` + `detail`

## 品牌配置（config/<brand>/config.json）

| 字段 | 说明 |
|---|---|
| strategyTable.baseToken / tableId | 策略表（唯一权威源） |
| strategyTable.excludeL1 | list 结果中标注整类排除的一级方向（由调用方过滤，skill 不删行） |
| levelForNewStrategy | 新建策略行等级（默认 X） |
| rowLimit | 读表行数上限（默认 200） |
| ai.* | 查重模型（env DEEPSEEK_MODEL > env DOUBAO_MODEL > defaultModel）、超时、温度 |
| fallback.strategies / directionEnums | list 读表失败时的静态快照兜底 |

当前品牌：`duxiaoman`（度小满-网络创意策略表，真实数据）/ `weiyedai`（微业贷-内容策略表，2026-09-17 建）。

## 环境变量

| 变量 | 说明 |
|---|---|
| AIHUBMIX_API_KEY / AIHUBMIX_BASE_URL | 查重 LLM 网关（必需） |
| DEEPSEEK_MODEL / DOUBAO_MODEL | 查重模型覆盖 |

.env 查找顺序：`scripts/.env` → skill 根 `.env` → `../hotspot/.env`（共享凭证）。

## 技术要点

1. **进程内缓存由调用方负责**：本 skill 每次调用都是独立进程、实时读表；调用方（如 creative-content-analysis）需要快照语义时自己缓存 list 结果。
2. **写表路径永远实时读**：sync 内部强制 fresh 读，绝不用旧快照做「素材链接ids/植入策略」合并，防并发丢数据。
3. **方向值归一化**：读写两侧统一 `normalizeDirectionValue`（去首尾换行/空白），防飞书 select 选项分裂。
4. **选项扩充先行**：新建方向前先 field-get + field-update 扩「内容方向一/二」选项；扩充失败放弃新建（不产生脏选项）。
5. **调用方接入示例**（creative-content-analysis Step 6 / 策略清单）：

```js
const out = execFileSync('node', [SYNC_CLI, 'list', '--brand', BRAND], { encoding: 'utf8', timeout: 120000 });
const parsed = JSON.parse(out); // { rows, excludeL1, fallbackUsed, ... }
```
