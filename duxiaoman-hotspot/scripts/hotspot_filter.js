#!/usr/bin/env node

/**
 * 度小满热点筛选 + 入表脚本（hotspot_filter.js）
 *
 * 流程：采集热点（复用 hotspot_collect.js）→ AI 判断是否符合度小满时事政策热点
 *       → 选语义锚点 + 数转折跳数 → 定植入方式 + 生成植入策略
 *       → 按素材表 11 字段写入飞书多维表格
 *
 * 判断标准（度小满需求文档第二部分）：
 *   1. 和金融经济、民生经济相关；排除娱乐/网络游戏&赛事/汽车/美妆/时尚等非金融经济领域
 *   2. 和普罗大众相关且和钱直接/间接相关（养老/公积金/社保/国补/投资新政策等）；
 *      排除美国伊朗打仗、日韩摩擦等与普通人无关的宏大叙事
 *
 * 转折判据（2026-09-15 新增）：
 *   锚点 = 热点与「借钱」共用的语义公共项，候选池：钱/收入/支出/借贷/征信/被骗
 *   跳数 = 从热点到「借钱需求」的显式转折次数，**不算到品牌名**（度小满＝借钱渠道，同义替换不计跳）
 *   植入方式由跳数决定：0 跳→直接阐述 / 1 跳→隐喻植入 / ≥2 跳→仅蹭热度（不生成植入策略）
 *
 * 到期复查（2026-09-15 新增，汰换=状态复查而非删除）：
 *   时事政策 +7 天（查有无新进展：细则/执行日，有则续期）
 *   头部达人 +7 天（查是否仍在讲同一话题）
 *   平台热榜 +3 天（冷却淘汰，到期直接下线）
 *
 * 表级去重（2026-09-16 新增）：
 *   入表前先读素材表已有「热点标题」，按归一化标题（去话题标签与标点）比对，
 *   已存在则跳过——修复"每轮全量重写入表导致同题重复"的问题。
 *   需要强制全量写入时加 --force-write。
 *
 * 使用方法：
 *   node hotspot_filter.js [--input <collect.json>] [--channels ...] [--top 20] [--dry-run] [--force-write] [--debug]
 *
 * 参数：
 *   --input <file>   直接读取 hotspot_collect.js 已生成的 JSON 结果（跳过采集）
 *   --channels       采集渠道（仅未指定 --input 时生效），默认 douyin,xhs,kuaishou,weibo,bilibili,gov,creator
 *   --top N          每渠道取前 N 条送 AI 判断（默认 20）
 *   --dry-run        只判断不入表（用于观察 AI 判断结果）
 *   --force-write    跳过表级去重，全部入表（默认跳过表中已存在同标题的热点）
 *   --debug          输出 AI 原始返回片段
 *
 * 环境变量：
 *   AIHUBMIX_API_KEY / AIHUBMIX_BASE_URL / DEEPSEEK_MODEL
 *   HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID  （飞书热点素材表，--dry-run 时可不配）
 *   TIKHUB_TOKEN / TIKHUB_BASE_URL         （仅采集时需要）
 *
 * 输出：JSON 到 stdout（含 fit/strategy/write 结果），进度日志到 stderr
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ============ 配置 ============
const AIHUBMIX_API_KEY = process.env.AIHUBMIX_API_KEY;
const AIHUBMIX_BASE_URL = (process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1').replace(/\/+$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const HOTSPOT_BASE_TOKEN = process.env.HOTSPOT_BASE_TOKEN;
const HOTSPOT_TABLE_ID = process.env.HOTSPOT_TABLE_ID;
const LARK_CLI = 'lark-cli';
const SCRIPT_DIR = __dirname;

// 平台 → 热点ID 前缀（gov 的子源 gov_jiedu/gov_zhengce 统一归 gov）
const PLATFORM_PREFIX = {
  douyin: 'douyin', douyin_creator: 'douyin',
  xiaohongshu: 'xhs', kuaishou: 'kuaishou',
  weibo: 'weibo', bilibili: 'bilibili',
  gov: 'gov', gov_jiedu: 'gov', gov_zhengce: 'gov'
};
// ==============================

function log(msg) {
  process.stderr.write(msg + '\n');
}

// ============ 预筛规则（A 方案 + 第五点禁止） ============
// 抖音 category 白名单：只送这些类目给 AI（跳过娱乐/游戏/汽车/美食/旅行/体育/站内玩法/话题互动）
const DOUYIN_CATEGORY_WHITELIST = ['时政', '财经', '社会', '科技', '金融', '经济', '民生'];

// 第五点禁止关键词：标题含这些的预筛排除（借贷产品不允许给看病/上学/结婚彩礼提供借贷）
const FORBIDDEN_KEYWORDS = ['看病', '治病', '医疗', '住院', '手术', '医药', '医院',
  '上学', '学费', '开学', '开学季', '升学',
  '结婚', '彩礼', '婚嫁', '婚宴', '嫁妆'];

function preFilter(item) {
  const topic = item.topic || '';
  // 第五点禁止关键词（所有渠道）
  const hit = FORBIDDEN_KEYWORDS.find(k => topic.includes(k));
  if (hit) {
    return { pass: false, reason: `含禁止关键词[${hit}]（第五点：看病/上学/结婚彩礼不允许）` };
  }
  // 抖音渠道按 category 预筛（白名单）
  if ((item.platform === 'douyin' || item.platform === 'douyin_creator') && item.category) {
    const inWhitelist = DOUYIN_CATEGORY_WHITELIST.some(c => item.category.includes(c));
    if (!inWhitelist) {
      return { pass: false, reason: `抖音类目[${item.category}]非金融时政类，预筛排除` };
    }
  }
  return { pass: true };
}

// ============ 转折判据：语义锚点 + 跳数 → 植入方式 ============
// 锚点候选池（与飞书「语义锚点」字段的 select 选项严格一致，AI 只能从这里选）
const ANCHOR_POOL = ['钱', '收入', '支出', '借贷', '征信', '被骗'];

// 锚点别名归一（AI 偶尔写成同义词，按最长优先映射回候选池；'钱' 兜底放最后）
const ANCHOR_ALIASES = [
  ['借贷', '借贷'], ['贷款', '借贷'], ['借钱', '借贷'], ['信贷', '借贷'], ['融资', '借贷'],
  ['征信', '征信'], ['信用记录', '征信'], ['信用', '征信'],
  ['被骗', '被骗'], ['受骗', '被骗'], ['诈骗', '被骗'], ['反诈', '被骗'], ['骗子', '被骗'],
  ['收入', '收入'], ['工资', '收入'], ['收益', '收入'], ['利息', '收入'], ['养老金', '收入'], ['补贴', '收入'],
  ['支出', '支出'], ['消费', '支出'], ['花费', '支出'], ['开销', '支出'], ['月供', '支出'], ['还款', '支出'],
  ['钱', '钱'], ['资金', '钱'], ['现金', '钱'], ['资产', '钱']
];

function normalizeAnchor(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '钱';
  if (ANCHOR_POOL.includes(s)) return s;
  for (const [alias, canonical] of ANCHOR_ALIASES) {
    if (s.includes(alias)) return canonical;
  }
  return '钱';
}

// 跳数 → 植入方式（由规则硬判定，覆盖 AI 的自我判断，避免口径漂移）
function placementFromHops(hops) {
  if (hops <= 0) return '直接阐述';
  if (hops === 1) return '隐喻植入';
  return '仅蹭热度';
}

// 热点类型（决定到期复查口径）：时事政策 / 头部达人 / 平台热榜
function classifyHotspotType(item) {
  const p = item.platform || '';
  if (p === 'gov' || p === 'gov_jiedu' || p === 'gov_zhengce') return '时事政策';
  if (p === 'douyin_creator') return '头部达人';
  const s = p + (item.source || '');
  if (s.includes('政策') || s.includes('解读') || s.includes('文件') || s.includes('gov')) return '时事政策';
  if (s.includes('达人') || s.includes('创作者') || s.includes('creator')) return '头部达人';
  return '平台热榜';
}

// 到期复查间隔（天）：热榜短、政策与达人长
const REVIEW_DAYS = { '平台热榜': 3, '时事政策': 7, '头部达人': 7 };

function reviewDate(hotspotType, from) {
  const days = REVIEW_DAYS[hotspotType] || 3;
  const d = new Date(from.getTime() + days * 86400000);
  return d.toISOString().substring(0, 10); // yyyy-MM-dd，飞书 datetime 字段接受
}
// =============================================================

// ============ AI 判断 prompt（度小满时事政策热点 + 植入策略） ============
const JUDGE_SYSTEM = '你是度小满金融信息流的资深选题编辑，只输出 JSON，不输出任何额外说明文字。';

const JUDGE_PROMPT = `# 角色
你是度小满的金融热点选题编辑。你要做四件事：① 判断热点是否符合度小满；② 选出热点与「借钱」共用的语义锚点；③ 数出从热点到「借钱需求」的转折跳数；④ 按跳数给出植入方式与植入策略。

# 第一步：符合度判断（两条硬条件必须同时满足）
1. 领域：必须是金融经济、民生经济相关。排除娱乐、网络游戏及赛事、汽车、美妆、时尚等非金融经济领域。
2. 受众与相关性：必须和普罗大众相关，且和"钱"直接或间接相关——如养老、公积金、社保、国补、投资市场新政策、借贷、利率、税收、消费补贴等与大众息息相关的经济内容。
   - 排除宏大叙事：美国伊朗打仗、日本韩国摩擦等与普通人钱袋子无关的国际政治内容不要。

# 禁止方向（第五点，命中任一即 fit=false，不可植入）
1. 涉及具体个人（明星/网红/企业家本人）或具体公司品牌的热点不要——蹭此类热点会产生舆情。
2. 涉及看病治病、小孩上学、结婚彩礼的相关热点或政策不要——借贷产品不允许给这些需求提供借贷。

只有 fit=true 时才继续做第二至第四步；fit=false 时后面字段一律按"输出格式"里的占位规则填。

# 第二步：选语义锚点（决定转折难度的关键变量）
锚点 = 热点与「借钱」之间共用的那个语义公共项。**必须从下面这个候选池里选一个，不要自造**：
钱 / 收入 / 支出 / 借贷 / 征信 / 被骗

找锚点的方法：先看这个热点里"和钱有关的那一层"，再判断哪一层能最直接地通向「借钱」。
- 贷款贴息类 → 锚点「借贷」（贴息本身就是借钱成本，这条最近）
- 货币/支付/存钱类 → 锚点「钱」（都要用钱、都关心钱怎么用）
- 收入/工资/利息/补贴类 → 锚点「收入」
- 消费/物价/月供类 → 锚点「支出」
- 征信/信用体系类 → 锚点「征信」
- 反诈/骗局/黑产类 → 锚点「被骗」

**同一个热点通常能挂多个锚点，优先选离「借钱」最近的那个。**锚点选得越近，后面要转折的次数就越少。

# 第三步：数转折跳数（口径必须严格遵守，这是判定的核心）
跳数 = 从热点到「借钱需求」之间，**需要显式说出来的转折次数**。三条硬规则：

规则一：**终点是「借钱」，不是品牌名。**
度小满本身就是借钱渠道，所以"借钱 → 度小满"这一段是同义替换，**不计跳**。数到「借钱」就停。
反例（错误算法）：把"借钱渠道 → 度小满"也算一跳，会凭空多出一跳。

规则二：**先定锚点，再数跳数。**
如果数出来 ≥2 跳，不要直接下结论，先回头换一个更近的锚点重新数一遍（见第二步）。很多时候不是热点太远，是锚点选远了。

规则三：**区分「显式跳转」和「隐含前提」。**
- 显式跳转 = 必须由文案说出来、听众需要被带着走的理解步骤 → 计入跳数
- 隐含前提 = 听众默认成立、不必陈述的背景（例如"人都有支出"）→ 不计入跳数，**但也不许真的删掉**：它要在转折句里一笔带过，否则会出现"刚说你有钱、转头让你借钱"的逻辑断裂

判例：
- 贷款贴息 → 借钱：锚点「借贷」，贴息本身就是借钱成本。**0 跳**
- 数字人民币（会给利息）→ 借钱：锚点「钱」，从"国家给你利息"一次转折到"急用钱的周转"。**1 跳**
  隐含前提是"支出"——不单独陈述，用"收入能靠利息慢慢攒，支出等不起"这类从句一笔带过。
- 网络反诈新规 → 借钱：锚点「被骗」，被骗过/怕被骗的人更需要正规借钱渠道。**1 跳**

# 第四步：定植入方式（由跳数决定，不可自行改判）
- 0 跳 → 直接阐述：概念同源，热点本身就是借钱话题，直接讲产品
- 1 跳 → 隐喻植入：标准做法，用一次转折把热点引到借钱
- ≥2 跳 → 仅蹭热度：只借热度做泛内容，**不做产品落点，strategy 必须填空字符串**

# 当前待判断的热点
平台：{platform}
来源：{source}
热点标题：{topic}
热度/热度文本：{heat} {heat_text}
（如为达人视频，创作者：{creator}）

# 输出格式（严格 JSON，不要额外文字）
{
  "fit": true 或 false,
  "reason": "用一两句说明是否满足两条硬条件，引用具体领域和相关性；不符合时说明违反哪条",
  "semantic_anchor": "钱|收入|支出|借贷|征信|被骗 中的一个；fit=false 时填 钱",
  "hop_count": 整数，从热点到「借钱需求」的显式转折次数；fit=false 时填 0,
  "hop_path": "用一个箭头串起显式转折节点，如：数字人民币（利息收入）→ 借钱需求；fit=false 时填空字符串",
  "implicit_premise": "隐含前提节点（不计跳但必须在转折句里一笔带过）；没有则填空字符串",
  "placement": "直接阐述|隐喻植入|仅蹭热度（必须与 hop_count 对应）；fit=false 时填空字符串",
  "strategy": "hop_count 为 0 或 1 时写植入策略（含噱头/角度 + 度小满衔接逻辑，并体现锚点与转折句）；hop_count ≥2 或 fit=false 时必须填空字符串"
}`;

// ============ 标题归一化（去重用） ============
function normalizeTopic(t) {
  return (t || '').replace(/\s+/g, '').trim();
}

// ============ 调用 AI 判断单个热点 ============
async function judgeHotspot(item, debug) {
  const prompt = JUDGE_PROMPT
    .replace('{platform}', item.platform || '')
    .replace('{source}', item.source || '')
    .replace('{topic}', item.topic || '')
    .replace('{heat}', String(item.heat || item.digg_count || ''))
    .replace('{heat_text}', item.heat_text || '')
    .replace('{creator}', item.creator || '');

  const doFetch = () => fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.5
    }),
    signal: AbortSignal.timeout(60000)
  });

  // 失败重试 1 次（限流/网络抖动），间隔 3 秒
  let response;
  try {
    response = await doFetch();
  } catch (e) {
    await new Promise(r => setTimeout(r, 3000));
    response = await doFetch();
  }
  if (!response.ok) {
    await new Promise(r => setTimeout(r, 3000));
    response = await doFetch();
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI 判断失败 (HTTP ${response.status}): ${errText.substring(0, 200)}`);
    }
  }
  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  if (debug) log(`   AI raw: ${content.substring(0, 400)}`);

  // 提取 JSON（容错：可能带 ```json 包裹或前后文字）
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { fit: false, reason: `AI 返回无可解析 JSON: ${content.substring(0, 120)}`, strategy: '' };
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { fit: false, reason: `AI JSON 解析失败: ${e.message}`, strategy: '' };
  }
}

// ============ 生成热点ID（来源_日期_短述） ============
function makeHotId(item) {
  let prefix = PLATFORM_PREFIX[item.platform];
  // platform 缺失时按 source 关键词推断（per_channel_top 精简了 platform 字段）
  if (!prefix) {
    const s = (item.source || '') + (item.platform || '');
    if (s.includes('微博')) prefix = 'weibo';
    else if (s.includes('B站')) prefix = 'bilibili';
    else if (s.includes('抖音')) prefix = 'douyin';
    else if (s.includes('小红书')) prefix = 'xhs';
    else if (s.includes('快手')) prefix = 'kuaishou';
    else if (s.includes('政策') || s.includes('解读') || s.includes('文件')) prefix = 'gov';
    else prefix = 'misc';
  }
  const date = new Date().toISOString().substring(0, 10).replace(/-/g, ''); // YYYYMMDD
  // 短述：热点标题去除非中英文数字字符后取前 12 字
  const short = (item.topic || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').substring(0, 12) || 'hot';
  return `${prefix}_${date}_${short}`;
}

// ============ 生成热点概述（植入策略 + 转折判定依据 + 溯源信息） ============
function makeOverview(item, judge, meta) {
  const parts = [];
  if (judge.strategy) parts.push(judge.strategy);
  else if (meta.placement === '仅蹭热度') {
    parts.push('【仅蹭热度】转折跳数 ≥2，只借热度做泛内容，不做产品落点。');
  }
  parts.push('——转折判定——');
  parts.push(`语义锚点：${meta.anchor} | 转折跳数：${meta.hops} 跳 | 植入方式：${meta.placement}`);
  if (judge.hop_path) parts.push(`转折路径：${judge.hop_path}`);
  if (judge.implicit_premise) parts.push(`隐含前提：${judge.implicit_premise}（不计跳，但需在转折句里一笔带过）`);
  parts.push('——溯源信息——');
  parts.push(`平台：${item.platform || ''} | 来源：${item.source || ''}`);
  if (item.heat) parts.push(`热度值：${item.heat.toLocaleString()}`);
  if (item.heat_text) parts.push(`热度：${item.heat_text}`);
  if (item.digg_count) parts.push(`点赞：${item.digg_count.toLocaleString()}`);
  if (item.creator) parts.push(`达人：${item.creator}`);
  if (item.url) parts.push(`链接：${item.url}`);
  if (item.captured_at) parts.push(`采集时间：${item.captured_at.replace('T', ' ').substring(0, 19)}`);
  return parts.join('\n');
}

// ============ 表级去重键（比采集期 normalizeTopic 更强：去话题标签 + 去标点） ============
// 同一热点在不同轮次/不同渠道抓到时，标题可能带不同话题标签或标点差异，
// 归一化到"纯中文英文数字"后再比对，才认得出是同一条。
function dedupKey(t) {
  return (t || '')
    .replace(/#[^\s#]+/g, '')                    // 去话题标签 #xxx
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')   // 只保留中英文数字
    .toLowerCase();
}

// ============ 读取素材表已有记录（表级去重用） ============
// 注意：lark-cli 的 --limit 在 json 格式下上限为 200（ndjson 为 2000，但记录会落到外部文件），
// 因此这里用 json + limit 200；表内记录超过 200 条时会告警提示去重覆盖不全。
function fetchExistingKeys() {
  try {
    const output = execFileSync(LARK_CLI, [
      'base', '+record-list',
      '--base-token', HOTSPOT_BASE_TOKEN,
      '--table-id', HOTSPOT_TABLE_ID,
      '--field-id', '热点标题',
      '--field-id', '热点ID',
      '--limit', '200',
      '--as', 'user',
      '--format', 'json'
    ], {
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      maxBuffer: 50 * 1024 * 1024
    });
    const resp = JSON.parse(output);
    if (!resp?.ok) throw new Error(resp?.error?.message || 'record-list 返回 ok=false');
    const rows = resp?.data?.data || [];
    if (resp?.data?.has_more) {
      log('   ⚠️ 表内记录已超 200 条上限，本轮去重只覆盖前 200 条');
    }
    const titles = new Set();
    const ids = new Set();
    for (const r of rows) {
      const k = dedupKey(r[0]);
      if (k) titles.add(k);
      const id = String(r[1] || '').trim();
      if (id) ids.add(id);
    }
    log(`   📖 已读表 ${rows.length} 条记录（用于去重比对）`);
    return { titles, ids, count: rows.length };
  } catch (e) {
    log(`   ⚠️ 读取已有记录失败，本轮跳过去重（${e.message.substring(0, 160)}）`);
    return null;
  }
}

// ============ 写入飞书热点素材表（11 字段） ============
function writeToBitable(records, existing) {
  if (!HOTSPOT_BASE_TOKEN || !HOTSPOT_TABLE_ID) {
    log('⚠️ 未配置 HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID，跳过飞书写入');
    return { success: 0, skipped: true };
  }
  if (records.length === 0) {
    log('🔹 无符合的热点可写入');
    return { success: 0 };
  }

  // 表级去重：标题在表中已存在 → 跳过，避免同一热点跨轮次重复入表
  let toCreate = records;
  let dupSkipped = [];
  if (existing && existing.titles.size > 0) {
    toCreate = [];
    for (const r of records) {
      const k = dedupKey(r.topic);
      if (k && existing.titles.has(k)) { dupSkipped.push(r.topic); continue; }
      toCreate.push(r);
    }
    if (dupSkipped.length > 0) {
      log(`🔹 表级去重：${records.length} 条中 ${dupSkipped.length} 条已在表中，跳过`);
      for (const t of dupSkipped) log(`   ⏭️  ${t.substring(0, 52)}`);
    }
    if (toCreate.length === 0) {
      log('🔹 无新热点需要写入');
      return { success: 0, skipped_existing: dupSkipped.length };
    }
  }

  const today = new Date().toISOString().substring(0, 10); // yyyy-MM-dd，飞书 datetime 字段接受
  const createRecords = toCreate.map(r => ({
    '热点ID': r.hot_id,
    '热点标题': r.topic,
    '热点概述': r.overview,
    '热点类型': r.hotspot_type,        // select：时事政策 / 平台热榜 / 头部达人
    '语义锚点': r.anchor,               // select：钱/收入/支出/借贷/征信/被骗
    '转折跳数': r.hops,                 // number
    '植入方式': r.placement,            // select：直接阐述 / 隐喻植入 / 仅蹭热度
    '植入方向': r.strategy,             // 仅蹭热度时为空
    '入库时间': today,                  // datetime，写入当天
    '到期复查日': r.review_date,         // datetime，入库日 +3（热榜）/ +7（政策、达人）
    // 素材评分留空，由 hotspot_refine.js 手动精筛时回填
  }));

  log(`🔹 写入飞书热点素材表（${createRecords.length} 条）...`);
  const payload = JSON.stringify({ create_records: createRecords });
  try {
    const output = execFileSync(LARK_CLI, [
      'base', '+record-batch-create',
      '--base-token', HOTSPOT_BASE_TOKEN,
      '--table-id', HOTSPOT_TABLE_ID,
      '--json', payload,
      '--as', 'user',
      '--format', 'json'
    ], {
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      maxBuffer: 50 * 1024 * 1024
    });
    const resp = JSON.parse(output);
    const count = resp?.data?.record_id_list?.length || 0;
    log(`   ✅ 写入 ${count} 条${dupSkipped.length ? `（另跳过已存在 ${dupSkipped.length} 条）` : ''}`);
    return { success: count, skipped_existing: dupSkipped.length };
  } catch (error) {
    // 失败落盘：入表失败时把待写数据存成文件，直接重放即可，不必再从日志里捞转义 JSON
    let dumpPath = null;
    try {
      dumpPath = path.join(SCRIPT_DIR, `pending_bitable_${Date.now()}.json`);
      fs.writeFileSync(dumpPath, payload, 'utf-8');
      log(`   💾 待入表数据已落盘：${dumpPath}`);
    } catch (e2) {
      log(`   ⚠️ 落盘失败：${e2.message.substring(0, 120)}`);
    }
    log(`   ❌ 写入失败: ${error.message.substring(0, 400)}`);
    return { success: 0, failed: error.message, pending_file: dumpPath };
  }
}

// ============ 运行 hotspot_collect.js 获取采集结果 ============
function runCollect(channels, top) {
  const nodeBin = process.execPath;
  const collectScript = path.join(SCRIPT_DIR, 'hotspot_collect.js');
  const envFile = path.join(SCRIPT_DIR, '..', '.env');
  const args = [collectScript, '--channels', channels, '--top', String(top)];
  if (fs.existsSync(envFile)) args.unshift('--env-file=' + envFile);

  log(`🔹 调用 hotspot_collect.js 采集（渠道：${channels}）...`);
  const r = spawnSync(nodeBin, args, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    log(r.stderr.substring(0, 800));
    throw new Error(`采集脚本退出码 ${r.status}`);
  }
  // stdout 是 JSON
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`采集输出解析失败: ${e.message}; stdout 头: ${r.stdout.substring(0, 200)}`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = {
    input: null,
    channels: 'douyin,xhs,kuaishou,weibo,bilibili,gov,creator',
    top: 20,
    dryRun: false,
    forceWrite: false,
    debug: false
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--channels' && args[i + 1]) opts.channels = args[++i];
    else if (args[i] === '--top' && args[i + 1]) opts.top = Number(args[++i]);
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--force-write') opts.forceWrite = true;
    else if (args[i] === '--debug') opts.debug = true;
  }

  if (!AIHUBMIX_API_KEY) {
    log('❌ 缺少 AIHUBMIX_API_KEY，无法做 AI 判断');
    process.exit(1);
  }

  log('============================================');
  log('🎯 度小满热点筛选 + 入表 启动');
  log(`   ${opts.input ? '输入文件: ' + opts.input : '实时采集: ' + opts.channels} | 每渠道Top ${opts.top} | ${opts.dryRun ? '干跑不入表' : '写飞书表'}`);
  log('============================================\n');

  // Step 1: 获取采集结果
  let collected;
  if (opts.input) {
    log(`🔹 读取采集结果 ${opts.input}`);
    collected = JSON.parse(fs.readFileSync(opts.input, 'utf-8'));
  } else {
    collected = runCollect(opts.channels, opts.top);
  }

  // 汇总所有待判断热点：取每渠道 top N
  const candidates = [];
  for (const [ch, items] of Object.entries(collected.per_channel_top || {})) {
    for (const it of items.slice(0, opts.top)) candidates.push(it);
  }
  // 合并榜也加入
  for (const it of (collected.merged_top || [])) candidates.push(it);

  // 去重：per_channel_top 与 merged_top 会有重叠（同标题重复送 AI），按归一化标题去重
  const seenTopics = new Set();
  const uniqueCandidates = [];
  let dupRemoved = 0;
  for (const it of candidates) {
    const key = normalizeTopic(it.topic);
    if (key && seenTopics.has(key)) { dupRemoved++; continue; }
    if (key) seenTopics.add(key);
    uniqueCandidates.push(it);
  }
  if (dupRemoved > 0) {
    log(`🔹 标题去重：${candidates.length} → ${uniqueCandidates.length} 条（移除重复 ${dupRemoved} 条）`);
  }

  // 预筛：抖音 category 白名单 + 第五点禁止关键词
  const toJudge = [];
  const preSkipped = [];
  for (const it of uniqueCandidates) {
    const r = preFilter(it);
    if (r.pass) toJudge.push(it);
    else preSkipped.push({ topic: it.topic, platform: it.platform, reason: r.reason });
  }
  log(`\n🔹 待判断 ${uniqueCandidates.length} 条 → 预筛后 ${toJudge.length} 条（预筛排除 ${preSkipped.length} 条：抖音非金融时政类 + 第五点禁止关键词）`);

  // Step 2: AI 判断（并发限流，默认 6 路，可用 JUDGE_CONCURRENCY 环境变量调整）
  const CONCURRENCY = Math.max(1, Number(process.env.JUDGE_CONCURRENCY) || 6);
  const judged = new Array(toJudge.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= toJudge.length) break;
      const it = toJudge[i];
      try {
        const j = await judgeHotspot(it, opts.debug);
        process.stderr.write(`   [${i + 1}/${toJudge.length}] ${it.topic?.substring(0, 30)} ... ${j.fit ? '✓符合' : '✗不符'}\n`);
        judged[i] = { item: it, judge: j };
      } catch (e) {
        process.stderr.write(`   [${i + 1}/${toJudge.length}] ${it.topic?.substring(0, 30)} ... ❌ ${e.message.substring(0, 80)}\n`);
        judged[i] = { item: it, judge: { fit: false, reason: e.message, strategy: '' } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toJudge.length) }, worker));

  const fitOnes = judged.filter(x => x.judge.fit);
  log(`\n✅ 符合度小满热点 ${fitOnes.length} / ${judged.length} 条`);

  // Step 3: 归一锚点/跳数、按跳数硬判定植入方式、生成热点ID + 概述 + 到期复查日
  const now = new Date();
  const toWrite = fitOnes.map(x => {
    const anchor = normalizeAnchor(x.judge.semantic_anchor);
    const hops = Math.max(0, Math.round(Number(x.judge.hop_count) || 0));
    const placement = placementFromHops(hops);
    // 植入方式以跳数为准（防 AI 口径漂移）；≥2 跳一律不生成植入策略
    const aiPlacement = String(x.judge.placement || '').trim();
    if (aiPlacement && aiPlacement !== placement) {
      log(`   ⚠️ 植入方式口径修正：AI=${aiPlacement} → 规则=${placement}（跳数 ${hops}）| ${x.item.topic?.substring(0, 24)}`);
    }
    const strategy = placement === '仅蹭热度' ? '' : String(x.judge.strategy || '');
    const hotspotType = classifyHotspotType(x.item);
    const meta = { anchor, hops, placement };
    return {
      hot_id: makeHotId(x.item),
      topic: x.item.topic,
      overview: makeOverview(x.item, x.judge, meta),
      strategy,
      hotspot_type: hotspotType,
      anchor,
      hops,
      placement,
      hop_path: String(x.judge.hop_path || ''),
      review_date: reviewDate(hotspotType, now),
      platform: x.item.platform,
      source: x.item.source,
      url: x.item.url,
      heat: x.item.heat
    };
  });

  // 跳数分布 + 复查到期分布（观察判定口径是否合理）
  const hopDist = {};
  const typeDist = {};
  for (const r of toWrite) {
    hopDist[r.hops] = (hopDist[r.hops] || 0) + 1;
    typeDist[r.hotspot_type] = (typeDist[r.hotspot_type] || 0) + 1;
  }
  log(`\n📊 跳数分布：${Object.entries(hopDist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} 跳 ${v} 条`).join(' | ')}`);
  log(`📊 热点类型：${Object.entries(typeDist).map(([k, v]) => `${k} ${v} 条`).join(' | ')}`);
  const direct = toWrite.filter(r => r.placement === '直接阐述').length;
  const metaphor = toWrite.filter(r => r.placement === '隐喻植入').length;
  const bumpOnly = toWrite.filter(r => r.placement === '仅蹭热度').length;
  log(`📊 植入方式：直接阐述 ${direct} | 隐喻植入 ${metaphor} | 仅蹭热度 ${bumpOnly}`);

  // Step 4: 写飞书（除非 dry-run）。默认先读表做表级去重，避免同一热点跨轮次重复入表
  let writeResult = { success: 0, skipped: true };
  if (!opts.dryRun) {
    if (opts.forceWrite) {
      log('ℹ️ --force-write：跳过表级去重，全量入表');
      writeResult = writeToBitable(toWrite, null);
    } else {
      const existing = fetchExistingKeys();
      writeResult = writeToBitable(toWrite, existing);
    }
  } else {
    log('ℹ️ --dry-run 模式，跳过飞书写入');
  }

  // 输出
  const output = {
    captured_at: collected.captured_at,
    total_candidates: candidates.length,
    total_deduped: dupRemoved,
    total_pre_skipped: preSkipped.length,
    pre_skipped: preSkipped.slice(0, 20),
    total_judged: judged.length,
    total_fit: fitOnes.length,
    hop_distribution: Object.keys(hopDist).sort((a, b) => a - b).map(k => ({ hops: Number(k), count: hopDist[k] })),
    type_distribution: typeDist,
    fit_hotspots: toWrite.map(x => ({
      hot_id: x.hot_id, topic: x.topic, platform: x.platform,
      hotspot_type: x.hotspot_type,
      anchor: x.anchor,
      hops: x.hops,
      placement: x.placement,
      hop_path: x.hop_path,
      review_date: x.review_date,
      strategy: x.strategy.substring(0, 100) + (x.strategy.length > 100 ? '...' : '')
    })),
    not_fit: judged.filter(x => !x.judge.fit).map(x => ({
      topic: x.item.topic, reason: x.judge.reason.substring(0, 80)
    })),
    bitable_write: writeResult,
    dry_run: opts.dryRun
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  log(`\n❌ 热点筛选失败: ${e.message}`);
  process.exit(1);
});
