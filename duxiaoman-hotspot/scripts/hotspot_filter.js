#!/usr/bin/env node

/**
 * 热点筛选 + 入表脚本（hotspot_filter.js）
 *
 * 流程：采集热点（复用 hotspot_collect.js）→ AI 判断是否符合本品牌时事政策热点
 *       → 选语义锚点 + 数转折跳数 → 定植入方式 + 生成植入策略
 *       → 按素材表 11 字段写入飞书多维表格
 *
 * 品牌配置化（2026-09-17）：
 *   品牌私有内容（飞书表、预筛词表、锚点池、复查间隔、AI prompt、judge system）全部在
 *   config/<brand>/ 下，本文件零品牌硬编码。品牌选择：--brand > env WORKFLOW_BRAND > duxiaoman。
 *
 * 判断标准（品牌 prompt 模板 config/<brand>/prompts/judge.md 定义）：
 *   领域（金融经济/民生经济）+ 相关性（和钱相关、非宏大叙事）+ 受众重合（围观人群可能有周转需求）
 *   禁止方向：涉具体人/公司品牌（舆情）、看病上学彩礼、涉军红线
 *
 * 转折判据：
 *   锚点 = 热点与「借钱」共用的语义公共项，候选池闭口（config: strategy.anchorPool）
 *   跳数 = 从热点到「借钱需求」的显式转折次数，**不算到品牌名**（品牌＝借钱渠道，同义替换不计跳）
 *   植入方式由跳数硬判定（config: strategy.placementByHops），不采信 AI 自我判断
 *
 * 到期复查（汰换=状态复查而非删除，间隔见 config: strategy.reviewDays）：
 *   时事政策 +7 天（查有无新进展：细则/执行日，有则续期）
 *   头部达人 +7 天（查是否仍在讲同一话题）
 *   平台热榜 +3 天（冷却淘汰，到期直接下线）
 *
 * 表级去重（2026-09-16 新增）：
 *   入表前先读素材表已有「热点标题」，按归一化标题（去话题标签与标点）比对，
 *   已存在则跳过——修复"每轮全量重写入表导致同题重复"的问题。
 *   需要强制全量写入时加 --force-write。
 *
 * 二次复核（2026-09-16 新增）：
 *   首轮 fit=true 的再判一遍，两次一致才入库，复核轮结果为权威；JUDGE_RECHECK=0 关闭。
 *
 * 使用方法：
 *   node hotspot_filter.js [--brand <品牌>] [--input <collect.json>] [--channels ...] [--top 20] [--dry-run] [--force-write] [--debug]
 *
 * 参数：
 *   --brand <name>   品牌配置（默认 duxiaoman，可用 config/ 下任意品牌目录名）
 *   --input <file>   直接读取 hotspot_collect.js 已生成的 JSON 结果（跳过采集）
 *   --channels       采集渠道（仅未指定 --input 时生效），默认 douyin,xhs,kuaishou,weibo,bilibili,gov,creator
 *   --top N          每渠道取前 N 条送 AI 判断（默认 20）
 *   --dry-run        只判断不入表（用于观察 AI 判断结果）
 *   --force-write    跳过表级去重，全部入表（默认跳过表中已存在同标题的热点）
 *   --debug          输出 AI 原始返回片段
 *
 * 环境变量：
 *   AIHUBMIX_API_KEY / AIHUBMIX_BASE_URL / DEEPSEEK_MODEL
 *   HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID  （可选，覆盖品牌配置里的飞书热点素材表；--dry-run 时可不配）
 *   TIKHUB_TOKEN / TIKHUB_BASE_URL         （仅采集时需要）
 *   WORKFLOW_BRAND                         （品牌，被 --brand 覆盖）
 *
 * 输出：JSON 到 stdout（含 fit/strategy/write 结果），进度日志到 stderr
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const brandConfig = require('./brand_config');

// ============ 配置 ============
// 品牌私有内容全部来自 config/<brand>/（见 brand_config.js），本文件不写死任何品牌内容
const CFG = brandConfig.load();
const BRAND = CFG.brand;
const BRAND_NAME = CFG.brandName;
const AIHUBMIX_API_KEY = process.env.AIHUBMIX_API_KEY;
const AIHUBMIX_BASE_URL = (process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1').replace(/\/+$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const HOTSPOT_BASE_TOKEN = CFG.table.baseToken;
const HOTSPOT_TABLE_ID = CFG.table.tableId;
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

// ============ 预筛规则（A 方案 + 第五点禁止，词表来自品牌配置） ============
// 抖音 category 白名单：只送这些类目给 AI（跳过娱乐/游戏/汽车/美食/旅行/体育/站内玩法/话题互动）
const DOUYIN_CATEGORY_WHITELIST = CFG.filters.douyinCategoryWhitelist;

// 第五点禁止关键词（分组，标题命中即预筛排除；含各品牌自有红线，如涉军）
const FORBIDDEN_GROUPS = CFG.filters.forbiddenGroups;

function preFilter(item) {
  const topic = item.topic || '';
  // 第五点禁止关键词（所有渠道，分组匹配）
  for (const g of FORBIDDEN_GROUPS) {
    const hit = g.words.find(k => topic.includes(k));
    if (hit) return { pass: false, reason: `含禁止关键词[${hit}]（第五点：${g.reason}）` };
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
// 锚点候选池（与品牌飞书「语义锚点」字段的 select 选项严格一致，AI 只能从这里选）
const ANCHOR_POOL = CFG.strategy.anchorPool;

// 锚点别名归一（AI 偶尔写成同义词，按最长优先映射回候选池；兜底项放最后）
const ANCHOR_ALIASES = CFG.strategy.anchorAliases;
const ANCHOR_FALLBACK = CFG.strategy.anchorFallback;

function normalizeAnchor(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return ANCHOR_FALLBACK;
  if (ANCHOR_POOL.includes(s)) return s;
  for (const [alias, canonical] of ANCHOR_ALIASES) {
    if (s.includes(alias)) return canonical;
  }
  return ANCHOR_FALLBACK;
}

// 跳数 → 植入方式（由规则硬判定，覆盖 AI 的自我判断，避免口径漂移）
function placementFromHops(hops) {
  if (hops <= 0) return CFG.strategy.placementByHops['0'];
  if (hops === 1) return CFG.strategy.placementByHops['1'];
  return CFG.strategy.placementByHops['2+'];
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

// 到期复查间隔（天，来自品牌配置）：热榜短、政策与达人长
const REVIEW_DAYS = CFG.strategy.reviewDays;
const REVIEW_DAYS_DEFAULT = CFG.strategy.reviewDaysDefault;

function reviewDate(hotspotType, from) {
  const days = REVIEW_DAYS[hotspotType] || REVIEW_DAYS_DEFAULT;
  const d = new Date(from.getTime() + days * 86400000);
  return d.toISOString().substring(0, 10); // yyyy-MM-dd，飞书 datetime 字段接受
}
// =============================================================

// ============ AI 判断 prompt（品牌模板：config/<brand>/prompts/judge.md） ============
const JUDGE_SYSTEM = CFG.judgeSystem;

const JUDGE_PROMPT = brandConfig.loadPrompt('judge', [
  '{platform}', '{source}', '{topic}', '{heat}', '{heat_text}', '{creator}'
]);

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
  const args = [collectScript, '--channels', channels, '--top', String(top), '--brand', BRAND];
  if (fs.existsSync(envFile)) args.unshift('--env-file=' + envFile);

  log(`🔹 调用 hotspot_collect.js 采集（渠道：${channels}｜品牌：${BRAND}）...`);
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
  log(`🎯 ${BRAND_NAME}热点筛选 + 入表 启动（品牌配置：${BRAND}）`);
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

  // Step 2.5: 二次复核（首轮 fit=true 的再判一遍，两次一致才入库；设 JUDGE_RECHECK=0 可关闭）
  const fitOnesFirst = judged.filter(x => x.judge.fit);
  let fitOnes = fitOnesFirst;
  const recheckInfo = { enabled: false, rechecked: 0, overturned: 0 };
  if (fitOnesFirst.length > 0 && (process.env.JUDGE_RECHECK ?? '1') !== '0') {
    recheckInfo.enabled = true;
    log(`\n🔍 二次复核 ${fitOnesFirst.length} 条（两次一致才入库）...`);
    const rechecked = new Array(fitOnesFirst.length);
    let rcursor = 0;
    const rworker = async () => {
      while (true) {
        const i = rcursor++;
        if (i >= fitOnesFirst.length) break;
        const x = fitOnesFirst[i];
        try {
          const j2 = await judgeHotspot(x.item, opts.debug);
          rechecked[i] = j2;
          process.stderr.write(`   [${i + 1}/${fitOnesFirst.length}] ${x.item.topic?.substring(0, 30)} ... ${j2.fit ? '✓一致' : '✗翻案'}\n`);
        } catch (e) {
          rechecked[i] = x.judge; // 复核调用失败时保守保留首轮结果
          process.stderr.write(`   [${i + 1}/${fitOnesFirst.length}] ${x.item.topic?.substring(0, 30)} ... ⚠️复核失败，保留首轮\n`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fitOnesFirst.length) }, rworker));
    fitOnes = fitOnesFirst.filter((x, i) => rechecked[i].fit);
    recheckInfo.rechecked = fitOnesFirst.length;
    recheckInfo.overturned = fitOnesFirst.length - fitOnes.length;
    // 复核通过的，锚点/跳数/策略以复核轮结果为准
    for (let i = 0; i < fitOnesFirst.length; i++) {
      if (rechecked[i].fit) fitOnesFirst[i].judge = rechecked[i];
    }
    if (recheckInfo.overturned > 0) log(`   复核翻案 ${recheckInfo.overturned} 条，不入库`);
  }

  log(`\n✅ 符合${BRAND_NAME}热点 ${fitOnes.length} / ${judged.length} 条${recheckInfo.enabled ? `（复核后，翻案 ${recheckInfo.overturned} 条）` : ''}`);

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
    recheck: recheckInfo,
    dry_run: opts.dryRun
  };
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch(e => {
    log(`\n❌ 热点筛选失败: ${e.message}`);
    process.exit(1);
  });
}
module.exports = { judgeHotspot, preFilter };
