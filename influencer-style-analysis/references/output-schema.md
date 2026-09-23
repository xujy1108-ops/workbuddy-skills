# influencer-style-analysis 输出数据使用指南

> **文档性质**：一次性固定文档（2026-09-21 随选样逻辑改造定稿），描述本技能输出 JSON 的完整字段结构、取值约束与下游消费建议。**不随每次分析重新生成**。技能输出 schema 变更时才更新本文档。
> **读者**：下游技能（script-creation 及后续任何消费方），以及需要人工核验分析结果的操作者。

---

## 一、如何调用本技能（获取输入数据）

```bash
# 带人工补充（推荐入口，可全部省略补充项）
python scripts/_run_with_manual.py \
  --url "https://www.douyin.com/user/<sec_user_id>" \   # 三选一：主页链接
  --sec-user-id "<sec_user_id>" \                       # 三选一：sec_user_id
  --search "达人昵称" \                                  # 三选一：昵称搜索
  --occupation "达人职业（可选）" \
  --asset-level "高/中/一般（可选）" \
  --other "其他补充，如拍摄方式（可选）" \
  --out 输出路径.json
```

产出：单个 JSON 文件，结构见下文第二节。

## 二、输出 JSON 完整结构

顶层共 **4 个数据块**：`basic_positioning`（基础定位）、`narrative_skeleton`（叙事骨架）、`audience_insight`（受众洞察）、`top_ad_video`（爆款商单）。

### 2.1 `basic_positioning` — 基础定位与达人自身画像

| 字段 | 类型 | 内容 | 约束/取值 |
|------|------|------|----------|
| `nickname` | string | 达人昵称 | — |
| `influencer_type` | string | 达人类型 | 格式"一级-二级"（如"财经-泛财经"），依据《达人类型基础标准（终版）》；无匹配输出"无匹配-需补充"，≤10字 |
| `core_persona` | string | 人设一句话 | ≤50字 |
| `content_tracks` | list | 核心赛道 | 2-3 个 |
| `influencer_demographic` | dict | 达人自身画像子对象 | 见下表 |

`influencer_demographic` 子字段：

| 字段 | 内容 | 约束 |
|------|------|------|
| `age_range` | 年龄段推断 | ≤10字 |
| `gender` | 性别 | — |
| `occupation` | 职业推断 | ≤30字 |
| `career_identity.status` | **职业身份核实状态**（下游策略匹配硬门槛） | 枚举：`有明确证据`（bio自述或口述职业/经营/从业经历）｜`有间接线索`（仅画面场景推断）｜`无法判断` |
| `career_identity.description` | 职业经历描述 | ≤30字，无证据写"未发现" |
| `career_identity.evidence` | 判定依据 | ≤50字；**禁止编造，宁可"无法判断"不可拔高** |
| `appearance` | 外貌/穿搭 | ≤25字 |
| `speech_style` | 讲话风格 | ≤35字 |
| `asset_level` | 资产层次（高/中/一般）及理由 | ≤40字 |
| `verbal_pace` | 语速：整体快/中/慢 + 约字数/分 + 关键变化点 | ≤45字 |
| `tone_and_emotion` | 语气与情绪基调 | ≤20字 |
| `visual_symbols` | 标志性视觉/听觉元素（机位/背景/道具/手势） | ≤50字 |
| `style_tags` | 开放式风格标签 | 2-4 个 |

> **人工补充优先级最高**：若调用时传了 `--occupation / --asset-level / --other`，对应字段为人工值，权威性高于模型推断，下游可直接采信。

`authority_profile` 子字段（**大V 判定，2026-09-21 新增**，位于 `basic_positioning` 下）：

| 字段 | 类型 | 内容 | 约束/取值 |
|------|------|------|----------|
| `available` | bool | 判定是否成功产出 | false 时仅有粉丝/认证数据 |
| `is_big_v` | bool/null | **是否大V** | 阅历型权威四特征全命中 **AND 粉丝 >100万**（双条件硬门槛）；粉丝未知时为 false + note 说明 |
| `tier` | string | 量级+形态综合标签 | 枚举：`头部大V`（>500万）｜`标准大V`（100-500万）｜`中腰部阅历型`（形态成立量级不足）｜`内容能力型`（无阅历证据） |
| `authority_source` | string | 权威来源 | 枚举：`阅历身份型`（身份先于内容，=大V形态）｜`内容能力型`（靠内容建立权威，如达哥的认知差拆解） |
| `follower_count` | int/null | 真实粉丝数 | 来自 `handler_user_profile` 端点；接口失败为 null |
| `verification` | string | 认证信息 | 个人认证（custom_verify）优先，企业认证兜底，无认证为空串 |
| `traits.age_35_50` | dict | 中年特征（35-50） | `{hit, evidence}`；程序解析 age_range 优先（区间与[35,50]重叠≥3年） |
| `traits.narratable_experience` | dict | 可叙述阅历资历 | `{hit, evidence}`；军旅/创业/企业主/媒体/学界/从业年限，失败经历也算；人工补充职业强制命中 |
| `traits.oral_opinion_form` | dict | 口播观点形态 | `{hit, evidence}`；区别于剧情/图文/vlog |
| `traits.mentor_relationship` | dict | 观众仰视导师关系 | `{hit, evidence}`；区别于闺蜜安利/平视 |
| `confidence` | string | 置信度 | `high`（阅历型+职业身份有明确证据）｜`medium`｜`low`（粉丝未知） |
| `note` | string | 判定结论说明 | ≤60字 |

> **下游使用要点**：`is_big_v=true` 可承接**权威叙事型策略**（专家背书/政策解读/权威拆解）；`内容能力型` 走认知差/拆解型策略，权威类策略对其**打折而非禁用**。`中腰部阅历型`（如崔校长 81 万粉）形态成立但量级不足，权威类策略同样打折。**注意大V判定是形态判断不含善恶**——劣迹/品牌风险（如封禁败诉史）不在本字段范围，需人工补充核实。

### 2.2 `narrative_skeleton` — 叙事骨架（本技能核心新增，2026-09-21 版）

来源：点赞 Top5 → 时长 <10 分钟 → 前 2 名视频逐条多模态分析 → LLM 归并。

| 字段 | 类型 | 内容 | 约束 |
|------|------|------|------|
| `skeleton_mode` | string | 惯用叙事骨架主模式 | **枚举 6 选 1**：`反常识结论前置`｜`悬念递进`｜`故事化叙事`｜`数据实证`｜`场景剧情`｜`盘点清单`，≤12字 |
| `opening` | 惯用开场策略 | ≤30字 |
| `turn` | 惯用中段推进方式 | ≤30字 |
| `ending` | 惯用收尾方式 | ≤30字 |
| `motif_spectrum` | list | 常打母题，按出现频次排序 | 3-5 个 |
| `hit_hook_patterns` | list | **多视频共现的钩子模式** | 0-2 个；**仅当 ≥2 条视频出现同一模式才写入**，不足共现输出空数组——禁止从标题/简介推断 |
| `emotion` | 整体情绪基调 | ≤8字 |

> **下游使用要点**：`skeleton_mode` + `hit_hook_patterns` 是创意方向匹配的最强先验（达人验证过的结构），创意钩子应沿用该结构只换内容母题。`hit_hook_patterns` 为空数组 = 视频样本未收敛出共性，此时不要臆测共性。

### 2.3 `audience_insight` — 受众洞察

| 字段 | 内容 | 约束 |
|------|------|------|
| `demographic` | 人口统计特征（如"25-45岁一二线男性"） | ≤20字 |
| `psychological_needs` | 受众心理诉求与痛点 | ≤50字 |

### 2.4 `top_ad_video` — 爆款商单分析（2026-09-21 新增）

来源：星图链路（sec_user_id → kolid → 最近 15 条星图商单含**真实播放量** → 取播放量最高的一条 → 多模态视频分析）。

| 字段 | 类型 | 内容 |
|------|------|------|
| `available` | bool | 是否产出商单分析 |
| `note` | string | 产出/跳过原因说明 |
| `item_id` | string | 商单视频 aweme_id（真实可校验） |
| `title` | string | 商单标题 |
| `item_date` | string | 发布日期 |
| `duration_s` | number | 时长（秒） |
| `stats` | dict | `play`（真实播放量）/ `like` / `comment` / `share` |
| `url` | string | 视频分享链接（可人工点开复核） |
| `analysis` | dict | 视频级拆解，见下表 |

`analysis` 子字段：

| 字段 | 内容 | 约束 |
|------|------|------|
| `form` | 内容形式 | 枚举：口播｜情景剧情｜图文混剪｜其他 |
| `hook_type` | 开场前 3 秒钩子类型（基于视频实际开头，非模板） | ≤15字 |
| `skeleton.opening` | 开场策略 | ≤25字 |
| `skeleton.turn` | 中段推进 + **产品/品牌出现的位置与方式** | ≤30字 |
| `skeleton.ending` | 收尾方式（含行动引导如何自然给出） | ≤25字 |
| `implant_mode` | 产品植入方式一句话 | ≤30字 |
| `motifs` | 该商单借用的内容母题 | 1-2 个 |
| `emotion` | 情绪基调 | 3-8字 |
| `commercial_signals` | 品牌名/产品口播原话关键词摘录（如利率、额度原话） | ≤60字 |
| `native_fit` | 广告原生化程度（广告与日常内容形态融合度） | ≤35字 |

**跳过规则（`available=false`）**：达人未注册星图 / 近期无星图商单 / 星图接口失败。跳过**不是错误**，流程正常输出其余三块。

> **下游使用要点**：`analysis` 是该达人**已被市场验证过的广告植入范式**（真实播放量排序取最优），创意的植入方式应优先对齐 `implant_mode` + `skeleton.turn/ending`，而不是让写手自由发挥。注意 `commercial_signals` 中的历史商单可能是竞品（如其他借贷品牌），植入创意应参考其**结构**而非照抄产品话术。

## 三、异常与降级分支（消费方必须处理）

| 情形 | 表现 | 消费方处理 |
|------|------|-----------|
| Top5 视频全部 ≥10 分钟 | 抛 `UnfitInfluencerError`，错误信息为"达人不适合本次投放：视频太长"，**无 JSON 产出** | 换达人或人工确认 |
| 无可分析视频（无播放链接等） | 报错中止 | 同上 |
| 商单跳过 | `top_ad_video.available=false` + `note` 说明原因 | 正常消费其余字段 |
| 大V判定降级 | `authority_profile.available=false`（用户信息接口失败致粉丝未知，或 LLM 特征判定失败）+ `note` | 正常消费其余字段；粉丝未知时不要据 `is_big_v=false` 下否定结论（是"不可确认"不是"不是"） |
| 千问内容审核拦截个别视频 | 自动换下一条候选重试（多拉候选逐个分析），对输出透明 | 无需处理 |
| 人工补充覆盖 | `career_identity` 等字段被人工值覆盖 | 直接采信人工值 |

## 四、数据口径须知（避免误用）

1. **非商单视频没有真实播放量**：抖音不公开播放数，作品列表端点 `play_count` 恒为 0。因此 Top5 按**点赞数**排序；`narrative_skeleton` 的热度证据是点赞口径。
2. **商单数据是真实播放量**：星图接口返回真实 `play`，`top_ad_video.stats` 与日常视频热度**不可直接混比**（口径不同）。
3. **`hit_hook_patterns` 证据等级 = 视频级共现**：每条模式都有 ≥2 条视频的多模态分析交叉印证；除此之外本技能不输出任何标题级推测的"爆款共性"。
4. **字段长度均受程序硬截断**：超长内容会被截到上限，不是 LLM 自由输出长度（authority_profile 的 evidence ≤40字、note ≤60字同样程序截断）。
5. **每条视频分析独立调用多模态模型**：`skeleton_mode` 等归并字段基于 2 条视频样本，是"双例印证"量级，重大决策建议人工抽检复核（点开 `top_ad_video.url` 或原始视频链接核对）。
6. **`follower_count` 是真实粉丝数**：来自用户主页信息端点（`handler_user_profile`），与作品列表端点（author 对象不含粉丝数）口径不同。认证字段以个人认证（custom_verify）优先。
7. **大V四特征中 `age_35_50` 是程序判定**（解析 age_range 区间与 [35,50] 重叠≥3年），其余三特征是 LLM 判定（依据 bio/认证/视频分析/人工补充）；`is_big_v`/`tier` 是纯规则计算——LLM 只填特征，不做大V结论，可审计可复算。

## 五、参考样例

真实运行样例（达哥有点味，2026-09-21）已归档于工作区：`达人风格分析_达哥有点味_改造后样例.json`。其关键产出摘要：

- `narrative_skeleton.skeleton_mode` = 反常识结论前置；`hit_hook_patterns` = 2 条（视频级共现）
- `top_ad_video`：播放量最高的商单恰为度小满广告（54.7 万播放），`implant_mode` = "中段政策解读后场景化衔接至度小满新人福利"，`native_fit` = "完全套用日常口播结构，仅在中后段嵌入产品信息与数据图示"

## 六、变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-21 | 选样规则改为"点赞Top5→时长<10分钟→前2名"（废除按文件体积选样）；新增 `narrative_skeleton` 字段；新增 `top_ad_video` 星图商单分析；`hit_hook_patterns` 禁止标题级推断；新增 `UnfitInfluencerError` 不可投放判定 |
| 2026-09-21（晚） | 新增 `basic_positioning.authority_profile` 大V判定：粉丝>100万硬门槛（大宽哥103万校准）+ 阅历型权威四特征（中年/可叙述阅历/口播观点/仰视导师关系）；tier 枚举（头部大V/标准大V/中腰部阅历型/内容能力型）；`follower_count`+认证走 `handler_user_profile` 端点。双向验证：大威哥352万→标准大V(high)、达哥48万无阅历→内容能力型(medium) |
