#!/usr/bin/env node

/**
 * 度小满创意分析 - 抖音工作流主脚本
 *
 * 使用方法：
 *   node run_workflow.js [--keywords "kw1,kw2"] [--existing-ids "id1,id2"] [--skip-bitable] [--resume]
 *
 * 默认行为（一条命令跑完）：
 *   1. 自动查询飞书多维表格已有素材 ID（去重）
 *   2. 生成 4 个搜索关键词（策略直搜1 + 策略衍生1 + 开放探索2；探索素材接入飞书热点素材表。
 *      连续 2 轮零新策略产出时自动进入加强模式：直搜1 + 探索3，策略衍生通道暂停——反内循环）
 *      → 搜索抖音 → 提取脚本 → 分析创意
 *   3. 自动将结果写入飞书多维表格
 *   4. 如果 API 余额不足，自动给飞书发消息通知
 *
 * 断点续跑：
 *   如果运行被沙箱中断（Exit 137），可加 --resume 重新运行，
 *   脚本会从 checkpoint 恢复候选列表，跳过已处理的视频，继续处理剩余的。
 *
 * 参数：
 *   --keywords "kw1,kw2"     使用自定义搜索关键词（跳过 AI 生成）
 *   --existing-ids "id1,id2" 手动传入已有素材 ID（跳过自动查询）
 *   --skip-bitable           跳过飞书多维表格读写（仅跑分析，不写入）
 *   --resume                 从 checkpoint 恢复，跳过搜索直接处理剩余视频
 *
 * 环境变量：
 *   AIHUBMIX_API_KEY   - AIHubMix API 密钥
 *   AIHUBMIX_BASE_URL  - AIHubMix API 地址（默认 https://api.inferera.com/v1）
 *   TIKHUB_TOKEN       - TikHub API 令牌
 *   DEEPSEEK_MODEL     - DeepSeek 模型名（默认 deepseek-v4-pro）
 *   TRANSCRIBE_MODEL   - 视频转录模型（默认 qwen3-vl-plus；兼容旧变量名 DOUBAO_MODEL）
 *   SEARCH_PAGES       - 每个关键词搜索翻页数（默认 1，即每个词 10 条；2026-09-08 应用户要求由 2 调为 1 控制单次处理量）
 *   WORKFLOW_CONCURRENCY - 并行处理并发数（默认 3）
 *
 * 输出：JSON 格式结果到 stdout，进度日志输出到 stderr
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ============ Checkpoint 断点续跑 ============
const CHECKPOINT_DIR = path.join(os.tmpdir(), 'duxiaoman-workflow');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'checkpoint.json');

function saveCheckpoint(keywords, candidates, keywordDirs) {
  if (!fs.existsSync(CHECKPOINT_DIR)) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }
  const data = {
    savedAt: new Date().toISOString(),
    keywords,
    keywordDirs: keywordDirs || keywords.map(k => ({ keyword: k, direction: '' })),
    candidates,
    processed: [] // 已处理的 aweme_id 列表
  };
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  log(`   💾 Checkpoint 已保存（${candidates.length} 条候选）`);
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return null;
  }
  const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf-8');
  return JSON.parse(raw);
}

function markProcessed(awemeId) {
  const cp = loadCheckpoint();
  if (!cp) return;
  if (!cp.processed.includes(awemeId)) {
    cp.processed.push(awemeId);
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
  }
}

function clearCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    log(`   🧹 Checkpoint 已清理`);
  }
}

// ============ 近期关键词记忆（避免重复） ============
const RECENT_KEYWORDS_FILE = path.join(__dirname, '..', '.recent_keywords.json');
const MAX_RECENT_KEYWORDS = 15; // 保留最近5次运行的关键词（2026-09-15 由 9 扩容，防模板词轮出记忆后复发）

function loadRecentKeywords() {
  if (!fs.existsSync(RECENT_KEYWORDS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(RECENT_KEYWORDS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveRecentKeywords(keywords) {
  let recent = loadRecentKeywords();
  recent = [...keywords, ...recent].slice(0, MAX_RECENT_KEYWORDS);
  fs.writeFileSync(RECENT_KEYWORDS_FILE, JSON.stringify(recent, null, 2));
  log(`   💾 近期关键词已记录（共 ${recent.length} 个）`);
}

// ============ 关键词命中率统计与方向休眠 ============
// 记录每个关键词的搜索数/通过数/成功数，用于：
// 1. 命中率反馈：连续多次零产出的关键词注入 prompt，禁止 AI 再生成同类词
// 2. 方向休眠：某方向累计多个关键词且总产出为 0，该方向临时休眠轮换
const KEYWORD_STATS_FILE = path.join(__dirname, '..', '.keyword_stats.json');
const MAX_STATS_KEYWORDS = 40; // 只保留最近 40 个关键词的统计
const ZERO_STREAK_THRESHOLD = 2; // 连续 N 次零产出进入低效名单
const DORMANT_DIR_MIN_KEYWORDS = 2; // 方向累计 N 个关键词且零产出才休眠

function loadKeywordStats() {
  if (!fs.existsSync(KEYWORD_STATS_FILE)) {
    return { runs: 0, keywords: {} };
  }
  try {
    const raw = fs.readFileSync(KEYWORD_STATS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { runs: parsed.runs || 0, keywords: parsed.keywords || {}, live_counts: parsed.live_counts || null };
  } catch {
    return { runs: 0, keywords: {} };
  }
}

function saveKeywordStats(stats) {
  fs.writeFileSync(KEYWORD_STATS_FILE, JSON.stringify(stats, null, 2));
}

// 构建注入关键词生成 prompt 的命中率反馈文本
function buildHitRateFeedback() {
  const stats = loadKeywordStats();
  if (!stats.runs || Object.keys(stats.keywords).length === 0) return '';

  // 连续多次零产出的关键词（低效关键词黑名单）
  const zeroKeywords = Object.entries(stats.keywords)
    .filter(([, v]) => (v.zero_streak || 0) >= ZERO_STREAK_THRESHOLD)
    .map(([k, v]) => `${k}（连续${v.zero_streak}次零产出）`);

  // 方向级聚合：累计关键词数 >= 2 且总成功数为 0 的方向 → 休眠
  const dirAgg = {};
  for (const [, v] of Object.entries(stats.keywords)) {
    const d = v.direction || '';
    if (!d) continue;
    if (!dirAgg[d]) dirAgg[d] = { keywords: 0, success: 0 };
    dirAgg[d].keywords += 1;
    dirAgg[d].success += v.total_success || 0;
  }
  const dormantDirs = Object.entries(dirAgg)
    .filter(([, v]) => v.keywords >= DORMANT_DIR_MIN_KEYWORDS && v.success === 0)
    .map(([d]) => d);

  // 来源级聚合：某来源累计关键词数 >= 2 且总成功数为 0 → 来源休眠提示
  const srcAgg = {};
  for (const [, v] of Object.entries(stats.keywords)) {
    const s = v.source || '';
    if (!s) continue;
    if (!srcAgg[s]) srcAgg[s] = { keywords: 0, success: 0 };
    srcAgg[s].keywords += 1;
    srcAgg[s].success += v.total_success || 0;
  }
  const dormantSources = Object.entries(srcAgg)
    .filter(([, v]) => v.keywords >= DORMANT_DIR_MIN_KEYWORDS && v.success === 0)
    .map(([s]) => s);

  const sourceNames = {
    strategy_direct: '策略直搜', strategy_derive: '策略衍生',
    explore_suggest: '搜索联想词', explore_comments: '高赞评论', explore_ai: 'AI衍生'
  };

  const lines = [];
  if (zeroKeywords.length > 0) {
    lines.push(`以下关键词近期连续多次搜索零产出（经真实搜索验证低效），禁止再生成相同或高度相似的词：\n${zeroKeywords.map(k => `- ${k}`).join('\n')}`);
  }
  if (dormantDirs.length > 0) {
    lines.push(`以下方向已用多个关键词验证均为零产出，当前处于休眠期，本次请暂停选择这些方向（包括其衍生变体），改选其他方向：${dormantDirs.join('、')}`);
  }
  if (dormantSources.length > 0) {
    const named = dormantSources.map(s => sourceNames[s] || s).join('、');
    lines.push(`以下关键词来源已连续多轮零产出（休眠中），本次生成时请降低对这些来源的依赖，将配额让给其他来源：${named}`);
  }
  return lines.length > 0 ? `\n${lines.join('\n\n')}\n` : '';
}

// 运行结束时更新关键词统计
// keywordDirs: [{keyword, direction, source}]，counts: { [keyword]: {searched, filtered, success} }
function updateKeywordStats(keywordDirs, counts) {
  const stats = loadKeywordStats();
  stats.runs = (stats.runs || 0) + 1;
  stats.keywords = stats.keywords || {};

  for (const { keyword, direction, source } of keywordDirs) {
    const c = counts[keyword] || { searched: 0, filtered: 0, success: 0 };
    const prev = stats.keywords[keyword] || {
      direction: direction || '', source: source || '', runs: 0,
      total_searched: 0, total_filtered: 0, total_success: 0, zero_streak: 0
    };
    prev.direction = direction || prev.direction;
    prev.source = source || prev.source;
    prev.runs += 1;
    prev.total_searched = (prev.total_searched || 0) + c.searched;
    prev.total_filtered = (prev.total_filtered || 0) + c.filtered;
    prev.total_success = (prev.total_success || 0) + c.success;
    prev.zero_streak = c.success === 0 ? (prev.zero_streak || 0) + 1 : 0;
    prev.last_run = new Date().toISOString();
    stats.keywords[keyword] = prev;
  }

  // 防膨胀：按 last_run 排序只保留最近 MAX_STATS_KEYWORDS 个
  const entries = Object.entries(stats.keywords);
  if (entries.length > MAX_STATS_KEYWORDS) {
    entries.sort((a, b) => String(a[1].last_run || '').localeCompare(String(b[1].last_run || '')));
    stats.keywords = Object.fromEntries(entries.slice(-MAX_STATS_KEYWORDS));
  }

  // 正常跑完：清除中断容错快照（本轮 totals 已完整落盘）
  delete stats.live_counts;
  saveKeywordStats(stats);
  log(`   💾 关键词命中率统计已更新（第 ${stats.runs} 次运行）`);
}

// ============ 关键词硬查重（生成后程序化校验，prompt 软约束之外的第二道防线） ============
// 背景：2026-09-15 发现两个重复模式——
// 1) 模型会无视 prompt 的"请勿重复"（当天把 5 小时前用过的原词一字不差重新生成）；
// 2) 策略衍生的示例句式被克隆（货车司机/小超市/花店/奶茶店老板缺现金吗，4 轮同一模板）。
// 因此生成后必须程序化查重：完全相同 / 包含关系 / 最长公共子串 ≥4 字（同模板、同词族）均拒绝。
const DEDUP_MIN_COMMON = 4;

function normalizeKeyword(kw) {
  return String(kw || '').toLowerCase().replace(/[\s，。！？、,.!?:：;；'"“”‘’]/g, '');
}

function longestCommonSubstring(a, b) {
  let best = '';
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (a[i] !== b[j]) continue;
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) len++;
      if (len > best.length) best = a.substring(i, i + len);
    }
  }
  return best;
}

// 返回 null 表示通过，否则返回冲突原因文本
function checkKeywordDup(keyword, existingWords) {
  const norm = normalizeKeyword(keyword);
  if (!norm) return '空关键词';
  for (const w of existingWords) {
    const wn = normalizeKeyword(w);
    if (!wn) continue;
    if (wn === norm) return `与已用词完全相同：${w}`;
    if ((norm.includes(wn) && wn.length >= DEDUP_MIN_COMMON) ||
        (wn.includes(norm) && norm.length >= DEDUP_MIN_COMMON)) {
      return `是已用词「${w}」的同族变体`;
    }
    const lcs = longestCommonSubstring(norm, wn);
    if (lcs.length >= DEDUP_MIN_COMMON) {
      return `与已用词「${w}」共享句式片段「${lcs}」（同模板/同词族）`;
    }
  }
  return null;
}

// 查重池 = 近期关键词 + 零产出黑名单
function buildDedupPool() {
  const recent = loadRecentKeywords();
  const stats = loadKeywordStats();
  const blacklist = Object.entries(stats.keywords || {})
    .filter(([, v]) => (v.zero_streak || 0) >= ZERO_STREAK_THRESHOLD)
    .map(([k]) => k);
  return [...new Set([...recent, ...blacklist])];
}

// ============ 中断容错：live_counts（运行中逐条落盘，中断后下次运行恢复） ============
// 背景：2026-09-15 前台运行两次被中断，stats 只在跑完才写，中断即丢——
// 导致被中断 run 用过的关键词既没进零产出黑名单、成功率也没记录（explore 种子词选择失真）。
function flushLiveCounts(updates) {
  const stats = loadKeywordStats();
  stats.live_counts = stats.live_counts || {};
  for (const [kw, fields] of Object.entries(updates)) {
    stats.live_counts[kw] = { ...(stats.live_counts[kw] || {}), ...fields };
  }
  saveKeywordStats(stats);
}

function recoverLiveCounts() {
  const stats = loadKeywordStats();
  const live = stats.live_counts;
  if (!live || Object.keys(live).length === 0) return;
  stats.keywords = stats.keywords || {};
  for (const [kw, c] of Object.entries(live)) {
    const prev = stats.keywords[kw] || {
      direction: c.direction || '', source: c.source || '', runs: 0,
      total_searched: 0, total_filtered: 0, total_success: 0, zero_streak: 0
    };
    prev.total_searched = (prev.total_searched || 0) + (c.searched || 0);
    prev.total_filtered = (prev.total_filtered || 0) + (c.filtered || 0);
    prev.total_success = (prev.total_success || 0) + (c.success || 0);
    if ((c.success || 0) > 0) prev.zero_streak = 0;
    prev.last_run = c.last_run || new Date().toISOString();
    stats.keywords[kw] = prev;
  }
  delete stats.live_counts;
  saveKeywordStats(stats);
  log(`   ♻️ 已恢复上次中断运行的关键词统计：${Object.keys(live).join('、')}`);
}

// ============ 策略库生长统计（反内循环预警，2026-09-15） ============
// 每轮运行结束记录：新建方向数（created）/ 追加新打法数（appended）/ 仅并入素材数（mergedOnly）。
// 「新策略」= created + appended。本轮有策略产出但新策略为 0 → 记一轮旱灾（drought）；
// 连续 STRATEGY_DROUGHT_BOOST_THRESHOLD 轮旱灾 → 下轮关键词生成进入加强模式
// （explore 2→3、策略衍生暂停），并在飞书通知中预警。
const STRATEGY_GROWTH_FILE = path.join(__dirname, '..', '.strategy_growth.json');
const STRATEGY_DROUGHT_BOOST_THRESHOLD = 2;
const STRATEGY_GROWTH_HISTORY = 20;

function loadStrategyGrowth() {
  try {
    if (fs.existsSync(STRATEGY_GROWTH_FILE)) {
      const g = JSON.parse(fs.readFileSync(STRATEGY_GROWTH_FILE, 'utf-8'));
      if (typeof g.droughtStreak === 'number') return g;
    }
  } catch { /* 损坏则重置 */ }
  return { droughtStreak: 0, history: [] };
}

function updateStrategyGrowth(strategyResult, itemCount) {
  const growth = loadStrategyGrowth();
  const newStrategy = (strategyResult.created || 0) + (strategyResult.appended || 0);
  // 本轮有策略产出但全部只是并入素材链接ids → 记一轮旱灾；本轮无策略产出（0 条素材）不计入
  const isDroughtRound = itemCount > 0 && newStrategy === 0;
  growth.droughtStreak = isDroughtRound ? growth.droughtStreak + 1 : 0;
  growth.history = [...(growth.history || []), {
    date: new Date().toISOString(),
    created: strategyResult.created || 0,
    appended: strategyResult.appended || 0,
    mergedOnly: strategyResult.mergedOnly || 0,
    droughtStreak: growth.droughtStreak
  }].slice(-STRATEGY_GROWTH_HISTORY);
  growth.lastRun = new Date().toISOString();
  fs.writeFileSync(STRATEGY_GROWTH_FILE, JSON.stringify(growth, null, 2));
  log(`   💾 策略库生长统计已更新（零新策略连续 ${growth.droughtStreak} 轮${growth.droughtStreak >= STRATEGY_DROUGHT_BOOST_THRESHOLD ? '，下轮进入加强探索模式' : ''}）`);
  return growth;
}

// ============ 内容策略文档（关键词来源1/2：策略直搜 + 策略衍生） ============
// 运行时动态拉取内容策略文档，解析 S/A 级策略方向注入 prompt。
// 缓存 24h；拉取失败用过期缓存；缓存也没有用内置兜底清单。
// 这样以后只需要在文档里加新方向，搜索策略自动跟上，代码不用改。
const STRATEGY_DOC_URL = 'https://kwza968lz1u.feishu.cn/docx/WmZfdDUZKod80NxCKULccMM4n9d';
const STRATEGY_CACHE_FILE = path.join(__dirname, '..', '.strategy_cache.json');
const STRATEGY_CACHE_TTL = 24 * 60 * 60 * 1000;
// 整类排除：接广告后的回应内容，不是可搜的素材场景
const STRATEGY_EXCLUDE_L1 = ['回应解释'];

// 内置兜底策略清单（文档拉取失败时使用，与策略文档保持同步）
const FALLBACK_STRATEGIES = [
  { l1: '蹭热点', l2: '时政新闻', level: 'S', definition: '国家发布最新的政策新闻，先吸睛再衔接到借钱话题' },
  { l1: '揭秘自己', l2: '生意赚多少钱', level: 'S', definition: '聚焦表面光鲜、实则重资产/高现金流压力的特定人群，揭秘真实收入与资产结构，打破高收入=高存款的刻板印象' },
  { l1: '揭秘自己', l2: '炒股是否财富自由', level: 'A', definition: '揭秘炒股博主的真实财务状况，打破暴富滤镜' },
  { l1: '借钱高性价比', l2: '借便宜的钱', level: 'S', definition: '向普通人揭秘低利率时代借到便宜的钱就是优势的财富真相，破除借钱羞耻' },
  { l1: '借钱高性价比', l2: '利息计算', level: 'A', definition: '揭秘网贷真实利率的计算陷阱（等额本息/IRR），打破利息认知盲区' },
  { l1: '有钱人借钱', l2: '对比富人', level: 'S', definition: '对比富人借钱让钱流动与普通人死存钱的思维差异，打破借钱羞耻' },
  { l1: '网贷测评', l2: '反向测评', level: 'S', definition: '以较真打假的反向测评视角，替粉丝找茬挑刺，亲自实测拆解网贷文案' },
  { l1: '鸡汤', l2: '中年人借网贷不是堕落', level: 'S', definition: '共情中年人上有老下有小的生存重压，为中年人借网贷正名' },
  { l1: '鸡汤', l2: '求人不如靠自己', level: 'S', definition: '揭露借钱伤感情、求人看脸色的残酷社交真相' },
  { l1: '鸡汤', l2: '我为你们感到着急', level: 'S', definition: '以知心人身份共情粉丝缺钱时翻通讯录不敢打电话的卑微与窘境' },
  { l1: '避坑', l2: '不要贪便宜', level: 'S', definition: '盘点普通人极易中招的钱财陷阱，以人间清醒视角硬核科普避坑指南' },
  { l1: '拒绝借钱', l2: '如何有效拒绝借钱', level: 'A', definition: '解决借钱抹不开面子又伤人情、最后人财两空的问题' }
];

// 解析策略文档 markdown 中的表格（处理 rowspan 合并单元格）
function parseStrategyTable(markdown) {
  const tableStart = markdown.indexOf('<table>');
  const tableEnd = markdown.indexOf('</table>');
  if (tableStart === -1 || tableEnd === -1) return [];
  const table = markdown.substring(tableStart, tableEnd);
  const rows = table.match(/<tr>[\s\S]*?<\/tr>/g) || [];

  const cellText = (cell) => cell
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();

  const COLS = 7; // 内容方向一/二、定义、植入策略、策略等级、适合达人、正向案例
  const spanLeft = new Array(COLS).fill(0);
  const lastVal = new Array(COLS).fill('');
  const out = [];

  for (const row of rows) {
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (cells.length === 0) continue;
    const values = new Array(COLS).fill('');
    let ci = 0;
    for (let col = 0; col < COLS && ci < cells.length; col++) {
      if (spanLeft[col] > 0) {
        spanLeft[col] -= 1;
        values[col] = lastVal[col];
        continue;
      }
      const cell = cells[ci++];
      const rowspanMatch = cell.match(/rowspan="(\d+)"/);
      if (rowspanMatch) spanLeft[col] = parseInt(rowspanMatch[1], 10) - 1;
      values[col] = cellText(cell);
      lastVal[col] = values[col];
    }
    out.push(values);
  }

  // 列索引：0内容方向一 1内容方向二 2定义 3植入策略 4策略等级 5适合达人 6正向案例
  return out
    .filter(v => v[0] && v[1] && v[0] !== '内容方向一')
    .filter(v => !STRATEGY_EXCLUDE_L1.includes(v[0]))
    .filter(v => v[4] === 'S' || v[4] === 'A')
    .map(v => ({ l1: v[0], l2: v[1], definition: v[2].substring(0, 120), level: v[4] }));
}

function fetchStrategyDoc() {
  // 1. 新鲜缓存直接用（24h 内）
  if (fs.existsSync(STRATEGY_CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(STRATEGY_CACHE_FILE, 'utf-8'));
      if (cache.fetchedAt
        && (Date.now() - new Date(cache.fetchedAt).getTime()) < STRATEGY_CACHE_TTL
        && (cache.strategies || []).length > 0) {
        log(`   ♻️ 使用策略文档缓存（${cache.strategies.length} 个 S/A 级策略方向，24h 内）`);
        return cache.strategies;
      }
    } catch { /* 缓存损坏，继续拉取 */ }
  }

  // 2. 拉取文档
  try {
    const output = runLarkCli([
      'docs', '+fetch',
      '--doc', STRATEGY_DOC_URL,
      '--doc-format', 'markdown',
      '--as', 'user',
      '--format', 'json'
    ]);
    const data = JSON.parse(output);
    const content = data?.data?.document?.content || '';
    const strategies = parseStrategyTable(content);
    if (strategies.length > 0) {
      fs.writeFileSync(STRATEGY_CACHE_FILE, JSON.stringify({
        fetchedAt: new Date().toISOString(),
        source: STRATEGY_DOC_URL,
        strategies
      }, null, 2));
      log(`   📋 策略文档拉取成功：${strategies.length} 个 S/A 级策略方向（已缓存 24h）`);
      return strategies;
    }
    throw new Error('解析到 0 个策略');
  } catch (error) {
    // 3. 过期缓存兜底
    if (fs.existsSync(STRATEGY_CACHE_FILE)) {
      try {
        const cache = JSON.parse(fs.readFileSync(STRATEGY_CACHE_FILE, 'utf-8'));
        if ((cache.strategies || []).length > 0) {
          log(`   ⚠️ 策略文档拉取失败（${error.message.substring(0, 100)}），使用过期缓存`);
          return cache.strategies;
        }
      } catch { /* fallthrough */ }
    }
    // 4. 内置清单兜底
    log(`   ⚠️ 策略文档拉取失败，使用内置兜底清单（${FALLBACK_STRATEGIES.length} 个）`);
    return FALLBACK_STRATEGIES;
  }
}

// ============ 开放探索来源（来源3）：飞书热点素材表 + AI 自由衍生 ============
// 2026-09-15 反内循环改造：探索素材接入热点素材表（duxiaoman-hotspot 抓取沉淀的近期热点），
// 为关键词生成注入策略文档之外的外部信号，打断"关键词←策略文档→验证老策略"的闭环。
// 热点表读取失败 / 无新鲜热点时降级为 AI 自由衍生（旧行为）。
const HOTSPOT_BASE_TOKEN = process.env.HOTSPOT_BASE_TOKEN || 'STMrbQgqma35dksI3WsclJlNnlc';
const HOTSPOT_TABLE_ID = process.env.HOTSPOT_TABLE_ID || 'tblDpxkM7psozqeO';
const HOTSPOT_MAX_AGE_DAYS = 7;   // 只取入库 7 天内的热点（过老的热点已过传播窗口）
const HOTSPOT_MAX_COUNT = 8;      // 每轮最多注入 8 条热点，防止 prompt 过长

// 视频高赞评论（按点赞排序）
async function fetchVideoComments(awemeId, count = 20) {
  const response = await fetch(`https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_comments?aweme_id=${awemeId}&cursor=0&count=${count}`, {
    headers: { 'Authorization': `Bearer ${TIKHUB_TOKEN}` },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`评论接口失败 (HTTP ${response.status})`);
  const result = await response.json();
  const comments = result.data?.comments || [];
  return comments
    .map(c => ({ text: (c.text || c.content || '').trim(), digg: c.digg_count || 0 }))
    .filter(c => c.text.length >= 5)
    .sort((a, b) => b.digg - a.digg);
}

// 拉取热点素材表中的新鲜热点（入库 ≤ 7 天且未过到期复查日）
function fetchRecentHotspots() {
  const output = runLarkCli([
    'base', '+record-list',
    '--base-token', HOTSPOT_BASE_TOKEN,
    '--table-id', HOTSPOT_TABLE_ID,
    '--limit', '50',
    '--as', 'user',
    '--format', 'json'
  ]);
  const data = JSON.parse(output)?.data || {};
  const fieldNames = data.fields || [];
  const rows = data.data || [];
  const idx = {};
  ['热点标题', '热点概述', '热点类型', '入库时间', '到期复查日'].forEach(name => {
    idx[name] = fieldNames.indexOf(name);
  });
  const cell = (row, name) => {
    const v = idx[name] >= 0 ? row[idx[name]] : null;
    if (Array.isArray(v)) return v.filter(Boolean).join('、');
    return cellText(v);
  };
  const now = Date.now();
  const cutoff = now - HOTSPOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return rows
    .map(row => ({
      title: cell(row, '热点标题'),
      summary: cell(row, '热点概述').split('\n')[0], // 概述首段（去掉溯源信息尾巴）
      type: cell(row, '热点类型'),
      storedAt: Date.parse(cell(row, '入库时间')) || 0,
      reviewAt: Date.parse(cell(row, '到期复查日')) || 0
    }))
    .filter(h => h.title && h.storedAt >= cutoff && (!h.reviewAt || h.reviewAt >= now))
    .sort((a, b) => b.storedAt - a.storedAt)
    .slice(0, HOTSPOT_MAX_COUNT);
}

// 构建开放探索素材：优先注入热点素材表新鲜热点；失败/为空降级 AI 自由衍生
function buildExploreMaterial() {
  try {
    const hotspots = fetchRecentHotspots();
    if (hotspots.length === 0) {
      log('   热点素材表无 7 天内新鲜热点，探索来源降级为 AI 自由衍生');
      return { type: 'explore_ai', text: '' };
    }
    const lines = hotspots.map((h, i) =>
      `${i + 1}. [${h.type || '热点'}] ${h.title}——${(h.summary || '').substring(0, 120)}`
    );
    const text = `# 开放探索素材：近期热点素材表（来自热点抓取流程，${hotspots.length} 条新鲜热点）
优先从下列热点中找与借钱/缺钱/资金周转有真实关联的角度，把热点话题翻译成普通用户会搜的搜索词——注意不是搜热点事件本身，而是搜热点牵出的用钱场景或人群处境（热点概述里已包含植入思路可参考）。每个热点最多衍生 1 个搜索词，多个探索词必须来自不同热点或不同角度：
${lines.join('\n')}`;
    log(`   热点素材表注入 ${hotspots.length} 条新鲜热点作为探索素材`);
    return { type: 'explore_hotspot', text };
  } catch (error) {
    log(`   ⚠️ 热点素材表读取失败（${error.message.substring(0, 120)}），探索来源降级为 AI 自由衍生`);
    return { type: 'explore_ai', text: '' };
  }
}

// ============ 配置 ============
const AIHUBMIX_API_KEY = process.env.AIHUBMIX_API_KEY;
const AIHUBMIX_BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1';
const TIKHUB_TOKEN = process.env.TIKHUB_TOKEN;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
// 转录模型：2026-09-08 A/B 实测后由 doubao-seed-2-1-pro 切换为 qwen3-vl-plus（成本 ¥0.60→¥0.20/条，说话人归属准确性不降）
// 兼容旧变量名 DOUBAO_MODEL；视频输入必须用直链（aweme_info 里的 play_addr），抖音页面 URL 已不稳定
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || process.env.DOUBAO_MODEL || 'qwen3-vl-plus';

const MIN_DIGG_COUNT = 2000; // 最低点赞数
const MAX_VIDEO_SIZE_MB = 50; // 豆包 API 视频文件大小限制
// 高赞评论分析触发阈值：本轮新入库视频点赞 > 该值时，并行抓取高赞评论做创意策略分析
const COMMENT_ANALYSIS_DIGG_THRESHOLD = parseInt(process.env.COMMENT_ANALYSIS_DIGG_THRESHOLD || '30000', 10);
const FORBIDDEN_KEYWORDS = ['催收', '医疗', '看病', '住院', '手术', '上学', '学费', '开学', '助学贷款', '助学',
  '结婚', '彩礼',
  // 公检法/政府人群
  '民警', '警察', '公安', '法院', '法官', '检察', '检察院', '公检法', '派出所', '执法', '立案', '起诉', '诉讼', '强制执行', '失信名单', '支付令', '缺席判决',
  // 房贷断供类（大量政策/法律分析内容）
  '法拍', '法拍房', '信用破产', '个人破产'];

// 标题级禁止关键词：导师说教/成功学/负债翻身类 + 公检法/政府人群 + 突发用钱非经营类，在过滤阶段直接跳过
const TITLE_FORBIDDEN_KEYWORDS = [
  '负债翻身', '怎么翻身', '逆天改命', '翻身秘籍', '成功学',
  '教你翻身', '负债逆袭', '以贷养贷', '保你逆天', '教你赚钱',
  '带你赚钱', '带你翻身', '逆袭翻身',
  // 公检法/政府人群
  '民警', '警察', '公安', '法院', '法官', '检察', '公检法', '派出所',
  '普法', '法律科普', '维权干货', '报警', '报案', '诉讼', '起诉', '立案',
  '强制执行', '失信名单', '限制高消费', '支付令',
  // 房贷断供类（政策/法律分析为主，偏离借钱核心）
  '断供', '弃房', '法拍房',
  // 突发用钱非经营类（看病/上学/结婚彩礼/助学贷款等，不纳入素材范围）
  '结婚', '彩礼', '助学贷款', '助学'];

// 飞书多维表格配置
const BITABLE_BASE_TOKEN = process.env.BITABLE_BASE_TOKEN;
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID;
// 内容策略表（度小满-网络创意策略）：素材创意同步沉淀为内容策略行
const STRATEGY_BASE_TOKEN = process.env.STRATEGY_BASE_TOKEN || 'EPYhbxo9TaUclysWuM0cgjkdnFf';
const STRATEGY_TABLE_ID = process.env.STRATEGY_TABLE_ID || 'tblSZ8LbahG9GnCH';
const LARK_CLI = 'lark-cli';
// ==============================

// ============ 提示词 ============

// 关键词生成 prompt（2026-09-15 反内循环改造：固定 3 词改为动态配额）
// 常规模式：直搜1 + 衍生1 + 探索2 = 4 词；加强模式（连续 2 轮零新策略）：直搜1 + 探索3 = 4 词（衍生暂停）
function buildKeywordPrompt(directQuota, deriveQuota, exploreQuota) {
  const total = directQuota + deriveQuota + exploreQuota;
  const sources = [];
  if (directQuota > 0) {
    sources.push(`【来源：策略直搜】${directQuota} 个（source 填 strategy_direct）
从下方内容策略清单中选策略方向，把它"翻译"成普通用户真实会搜的词。不是照抄策略名，而是想：对这个话题感兴趣的真实用户，会在抖音搜什么。
例：策略「揭秘自己-生意赚多少钱」→ 搜词"开店一年赚多少"；策略「借钱高性价比-利息计算」→ 搜词"网贷利息怎么算"；策略「拒绝借钱-如何有效拒绝借钱」→ 搜词"如何拒绝借钱"。`);
  }
  if (deriveQuota > 0) {
    sources.push(`【来源：策略衍生】${deriveQuota} 个（source 填 strategy_derive）
从策略清单中选另一个策略（必须与策略直搜不同的策略方向，且不得选择下方"近期已使用的方向"里出现过的策略），先抽象出该策略的核心钩子公式，再实例化成全新搜索词。
公式示例（仅示范"如何从策略抽象公式"，禁止套用句式模板）：「揭秘自己」的核心公式 = 高收入表象 vs 现金流紧张的反差；「网贷测评」的核心公式 = 较真打假替粉丝实测。生成时必须基于策略自身逻辑构造全新表达——同一句式骨架仅替换职业/人群/平台名也算重复（如近期已用过"花店老板缺现金吗"，就禁止再生成"XX老板缺现金吗"）。`);
  }
  if (exploreQuota > 0) {
    sources.push(`【来源：开放探索】${exploreQuota} 个（source 填 explore）
按下方"开放探索素材"的指示执行；若素材为空，则 AI 自主衍生与借钱/缺钱/用钱相关的新方向（可从这些维度切入：不同人群的借钱处境、不同关系的金钱摩擦、不同心理状态的缺钱体验、社会现象与钱的交织），不要困在策略清单里。多个探索词之间必须覆盖互不相同的新方向，来自不同热点或不同角度。`);
  }

  const exampleItems = [];
  let eid = 1;
  if (directQuota > 0) exampleItems.push(`    { "id": ${eid++}, "keyword": "搜索关键词", "source": "strategy_direct", "direction": "所属方向" }`);
  if (deriveQuota > 0) exampleItems.push(`    { "id": ${eid++}, "keyword": "搜索关键词", "source": "strategy_derive", "direction": "所属方向" }`);
  for (let i = 0; i < exploreQuota; i++) {
    exampleItems.push(`    { "id": ${eid++}, "keyword": "搜索关键词", "source": "explore", "direction": "所属方向" }`);
  }

  return `你是抖音内容素材策划专家，熟悉抖音平台的内容生态、用户情绪和话题传播逻辑。请围绕"资金周转困难"这个核心场景，生成 ${total} 个抖音搜索关键词，按下列来源分配：

${sources.join('\n\n')}

内容策略清单（来自内容策略文档，S=已验证成功 / A=可继续尝试）：
__STRATEGY_LIST__

__EXPLORE_MATERIAL__

选取规则：
- 关键词严格按上述来源配额分配
- 策略直搜和策略衍生（如启用）必须选择不同的策略方向，不可重复同一策略
- ${total} 个关键词覆盖互不相同的场景方向，不可重复同一方向
- 开放探索不得选取与近期已用词同词族的联想词（共享核心短语的变体均算重复，如近期已用过"借钱伤感情"，则"借钱伤感情XX"类联想词全部禁选）
- 避免与近期已使用的关键词重复或高度相似

通用要求：

话题原生性：关键词必须来自真实用户在抖音上自发讨论的内容方向，不能带有任何品牌卖点、产品功能或推广意图，要像普通用户会搜索的词一样自然。

关键词形式：以2-8个字的搜索词为主，优先选择高搜索量的短词；策略直搜类允许最长10字的自然短语（如"开店一年真的能赚多少"）。不要过于宽泛（如单个字"钱"）。

内容聚焦性：关键词必须围绕"借钱、缺钱、资金周转、收入真相、用钱痛点"本身展开，借钱/缺钱是内容的核心议题而非引子。禁止生成"借钱见人心""借钱看清一个人""借钱试人品""借钱考验感情"这类把借钱当由头去讨论人心、人品、善良、信任的泛化话题——它们搜索量虽大，但结果严重偏离资金周转核心。

禁止方向：不要生成「当下负债怎么翻身」「负债几十万怎么办」「以贷养贷」等引导负债人群继续借贷的关键词。不要生成与公检法、法律科普、维权诉讼相关的关键词（如"怎么起诉老赖""报警立案"）。不要生成看病、上学、助学贷款、结婚彩礼等方向的突发用钱关键词。此外，以下方向搜索结果几乎全是法律科普/催收/维权干货类内容，会被内容过滤规则100%拦截，禁止生成："朋友借钱不还"/"借钱不还怎么办"/"老赖"/"欠钱不还"/"网贷逾期"/"网贷催收"/"讨债"/"怎么要回钱"/"收不回款"/"房贷断供"/"法拍房"；"中年人压力"等泛化情感方向也禁止。

__RECENT_KEYWORDS__

__HIT_RATE_FEEDBACK__

输出格式：严格按以下JSON格式输出，不要增加任何额外字段、注释或说明文字。source 必须是 strategy_direct / strategy_derive / explore 三者之一；direction 填写该关键词所属的场景方向（用简短方向名，如：揭秘自己-生意赚多少钱、策略衍生-反差职业收入、热点素材-公共数据开放）：

{
  "keywords": [
${exampleItems.join(',\n')}
  ]
}`;
}

const VIDEO_SCRIPT_PROMPT = `你是专业的视频脚本转录助手。请将视频中的所有对话和台词完整转录为文字。

要求：
1. 如果是剧情视频，标注每句话是谁说的（根据画面和语气推断角色，如【男主】【女主】【旁白】或角色名）
2. 如果有内心独白，标注为【人物（内心）】
3. 保留所有口语和语气词，不要遗漏任何内容
4. 按时间顺序输出
5. 如果有画面动作描述需要，可在台词间用（动作描述）补充
6. 输出格式：【人物】台词内容

转录完成后，在最后一行输出以下分隔符和JSON元信息（用于后续达人匹配分析）：
---META---
{"表现形式": "口播/剧情/AI生成/其他", "语速": "快/中/慢", "说话风格": "亲切/激情/稳重/幽默/利落/温柔等"}

说明：
- 表现形式：以下为参考类型，可根据视频实际情况自行补充其他类型（如情景演绎、街头采访、教程演示等）
- 语速：以下为参考档位，可根据实际听感自行补充其他描述
- 说话风格：以下为参考类型，可根据实际听感自行补充其他风格描述，可多选，用逗号分隔`;

// ============ 方向枚举动态化（2026-09-15 反内循环改造） ============
// 背景：分析 prompt 里硬编码的方向枚举 + "优先复用/不要标新立异"强偏置，
// 导致新素材被硬塞进老方向组合，策略表几乎不可能长出新行。
// 改造：运行时从策略表拉取现有方向组合及素材数注入 prompt；
// 饱和方向（素材数 ≥ SATURATED_DIR_MATERIALS）注入"切入角度实质不同时优先新建二级方向"指令。
// 策略表读取失败时用内置兜底枚举（即原硬编码清单）。
const SATURATED_DIR_MATERIALS = 5;
let _directionSnapshot = null; // 进程级缓存（策略表只在本轮 Step 6 末尾写入，运行期间不变）

function getDirectionSnapshot() {
  if (_directionSnapshot) return _directionSnapshot;
  try {
    const existing = fetchStrategyRecords();
    const groups = new Map(); // dir1 -> Map(dir2 -> 素材数)
    for (const [key, val] of existing) {
      const [dir1, dir2] = key.split('|');
      const count = (val.素材链接ids || '').split('、').filter(Boolean).length;
      if (!dir1 || !dir2) continue;
      if (!groups.has(dir1)) groups.set(dir1, new Map());
      groups.get(dir1).set(dir2, count);
    }
    _directionSnapshot = { groups, total: existing.size };
    log(`   📋 方向枚举动态拉取：策略表 ${existing.size} 个方向组合已注入分析 prompt`);
  } catch (error) {
    log(`   ⚠️ 策略表方向拉取失败，方向枚举使用内置兜底: ${error.message.substring(0, 120)}`);
    _directionSnapshot = null;
  }
  return _directionSnapshot;
}

// 内置兜底枚举（策略表读取失败时用，与策略表初始方向保持一致）
const FALLBACK_DIRECTION_ENUMS = `## 内容方向一（一级方向，优先从以下枚举中选，不满足时可新建）
- 蹭热点：借时政/政策新闻的注意力，先吸睛再承接
- 揭秘自己：博主自曝真实收入与资产结构，打破刻板印象
- 借钱高性价比：揭秘「借到便宜的钱就是优势」的财富真相
- 利息计算：硬核数学计算拆解利率陷阱，建立专业信任
- 有钱人借钱：对比富人/普通人的资金思维差异
- 网贷测评：较真打假视角反向实测，欲扬先抑
- 回应解释：承接上期广告话题，回应质疑或做常规科普
- 鸡汤：共情中年人处境，先理解再劝告
- 避坑：守财导师视角，盘点钱财陷阱
- 拒绝借钱：解决「抹不开面子又伤人情」的社交痛点

## 内容方向二（二级方向，优先选所属一级方向下的枚举，不满足时可新建）
蹭热点：时政新闻｜揭秘自己：生意赚多少钱、炒股是否财富自由｜借钱高性价比：借便宜的钱｜利息计算：详细计算｜有钱人借钱：对比富人｜网贷测评：反向测评｜回应解释：回怼回应、常规回应｜鸡汤：中年人借网贷不是堕落、求人不如靠自己、我为你们感到着急｜避坑：不要贪便宜｜拒绝借钱：如何有效拒绝借钱`;

function buildDirectionEnumSection() {
  const snap = getDirectionSnapshot();
  if (!snap) return FALLBACK_DIRECTION_ENUMS;
  const lines = [];
  const saturated = [];
  for (const [dir1, subs] of snap.groups) {
    lines.push(`- ${dir1}：${[...subs.entries()].map(([d2, n]) => `${d2}（${n}条素材）`).join('、')}`);
    for (const [d2, n] of subs) {
      if (n >= SATURATED_DIR_MATERIALS) saturated.push(`${dir1}-${d2}`);
    }
  }
  let text = `## 内容方向一/二（下方为策略表现有方向组合，括号内为已沉淀素材数，共 ${snap.total} 个组合）
${lines.join('\n')}
方向选取原则：优先复用现有方向；新建判断标准见下方判断规则。`;
  if (saturated.length > 0) {
    text += `

**饱和方向预警**：以下方向已充分覆盖（素材数 ≥ ${SATURATED_DIR_MATERIALS}）：${saturated.join('、')}。当素材的核心叙事切入角度与这些饱和方向的既定内涵实质不同（不同人群、不同情绪入口、不同论证路径）时，优先新建二级方向（挂靠已有或新一级方向），不要挤进饱和方向；只有方向内核真正相同时才复用，并在「方向定义」中说明具体角度。`;
  }
  return text;
}

function buildAnalysisPrompt() {
  return ANALYSIS_PROMPT.replace('__DIRECTION_ENUMS__', buildDirectionEnumSection());
}

function buildCommentAnalysisPrompt() {
  return COMMENT_ANALYSIS_PROMPT.replace('__DIRECTION_ENUMS__', buildDirectionEnumSection());
}

const ANALYSIS_PROMPT = `# 角色
你是一位资深短视频编导，擅长拆解爆款素材的叙事逻辑，并为品牌广告提供可落地的植入策略。

# 任务
分析用户提供的脚本素材，完成七项输出（六项素材分析 + 一项内容策略分析），直接输出JSON。

# 输出格式
{
  "内容相关性": "强相关/弱相关/不相关",
  "时效性": "长青 / 时效话题-未过气 / 时效话题-已过气",
  "内容方向": "用一句大白话总结整个脚本的叙事逻辑和核心主张，让观众一听就懂",
  "场景": ["对镜口播"],
  "素材逻辑分析": "从叙事视角、双方行为画像、核心结论三个维度综合分析，一段话写清楚，直接给结论",
  "对度小满的借鉴": "从情绪借势、反向论证、核心策略三个维度综合分析，一段话写清楚核心策略",
  "植入修改建议": "包含植入锚点、修改后话术（用引号标出）、植入逻辑三个要素，一段话写清楚",
  "适配达人": {
    "达人类型": "按达人类型分类标准判断，粒度规则：整个一级类型都适合就只写一级分类（如「财经」=财经下所有二级类型都适合）；仅当适配范围限定在某一二级类型时才写「一级-二级」（如：剧情-剧情搞笑）",
    "表现形式": "口播/剧情/AI生成/其他",
    "语速与风格": "语速快慢+说话风格，如：快、犀利",
    "口吻": "老登说教/犀利点评/真挚分享等",
    "推荐达人类型": "基于以上三点推导，2-3个类型，如：财经、职场、母婴亲子"
  },
  "内容策略": {
    "内容方向一": "一级方向，优先从下方内容策略分析标准给出的枚举中选；确实不满足时新建（命名简短，与现有枚举风格一致）",
    "内容方向二": "二级方向，优先从所属一级方向下属的二级枚举中选；确实不满足时新建（命名具体，能独立区分一批素材）",
    "方向定义": "1-3句：目标人群+核心叙事+内容落点，讲清这个素材体现的方向边界",
    "植入策略": "一句话打法概括+具体示例（讲清从内容到产品的完整推理链），沿用本素材实际的植入方式",
    "适合达人": "达人类型（粒度同适配达人.达人类型：整个一级都适合只写一级，如「财经」；仅限某二级才写「一级-二级」），可附简要风格说明"
  }
}

# 内容相关性判断标准
判断脚本内容是否真正围绕"借钱、缺钱、资金周转、债务、真实收入"等核心议题展开：
- 强相关：脚本核心主题是借钱/缺钱/还钱/债务/资金周转；或者脚本核心是"揭秘真实收入与现金流压力"（如生意人揭秘年收入、打破高收入=高存款的刻板印象、收入构成与垫资压力），且借钱/周转是内容主线之一；或者是网贷平台实测/利息计算类内容
- 弱相关：脚本提到了借钱或收入，但只是作为众多情节之一，主线是其他主题（如正能量、心灵鸡汤、搞笑段子等）。或者：如果是"过来人"类内容，但当事人还在还债路上挣扎、尚未成功翻身，也算弱相关——我们需要的是已经走出来的成功者视角
- 不相关：脚本与借钱/资金周转/收入真相完全无关

# 时效性判断标准
判断素材是"永远不过期的人性/财务话题"还是"依赖特定时间窗口的时效内容"——这不是看发布时间，而是看内容内核：
- **长青**：内容核心是人性、人情世故、普遍财务困境——不论什么时候拍都有共鸣，老视频反而沉淀好。典型：借钱伤感情、求人不如靠自己、有钱人借钱vs普通人死存钱、中年人借网贷不是堕落、不要给别人借钱、熟人借钱风险、借钱看清人心、守财避坑等。这类素材发布时间不参与判断，越老越好
- **时效话题-已过气**：内容依赖某个特定时间窗口的平台功能/政策细则/阶段性热点/具体事件，发布时是热点，现在已经没人关注。典型：抖音小店先采后付（已过电商红利期）、某个具体平台的具体活动（活动已结束）、某条已落地的阶段性政策（后续已有更新）、某个具体人物的具体风波（热度已退）。判断关键：如果把素材里的"时间锚点"换成今天，观众还会关心吗？不会 → 已过气
- **时效话题-未过气**：时效内容但当前仍处传播窗口内（如本季度的金融新规、本月的热点事件），仍有讨论价值

# 场景判断标准（用于输出「场景」字段）
判断这条素材的画面/情节发生在哪里——供后续按达人拍摄能力匹配素材（能拍剧情的、只能对镜口播的、能出户外的）。
- 只能从以下枚举中选，可多选（一条素材跨多个场景时全部列出）：
  **对镜口播**（全片为博主/讲师/女主等对镜讲述，无场景情节）、**酒席饭桌**、**居家室内**、**职场办公**、**户外街头**、**店铺商户**、**车内出行**、**线上通话**（电话/微信对话推进）、**工地工厂**、**其他**
- 判定依据是脚本里的场景动作与地点线索（如"酒席上""从单元门走出""在办公室""在电话里"），不是内容主题；不要输出"借钱""职场故事"这类主题词
- 纯对镜讲述、无任何场景情节的，必须选「对镜口播」，不要归入「其他」；确实无法判断具体场所、又不是纯口播的，才选「其他」
- 场景是"物理/情境发生地"，不要编造脚本中没出现的地点

# 达人类型分类标准（用于输出「达人类型」字段）
根据脚本文案对照以下标准判断素材适配的达人类型。输出粒度规则：**如果素材内容适配整个一级类型（该一级下所有二级都适合），只输出一级分类（如「财经」）；仅当适配范围确实限定在某一二级类型时才输出「一级-二级」（如只适配剧情-剧情搞笑、不适配剧情-常规剧情）**。

## 标准类型（全部类型，只能从中选择）
- 财经-泛财经：商业故事、个人财富、消费决策、搞钱思路、时政要闻等一切与金钱/财富/商业相关的点评输出观点，不含投资
- 财经-高价值：主讲投资（股票/债券/基金/贵金属/房产等金融投资），垂直赛道，政策分析、市场洞察
- 财经-小微企业主：本人是老板/合伙人，创业日常vlog、产业点评、创业吐槽
- 财经-常规：真实借贷故事分享（借贷用途非小微企业方向），自己或别人的经历都算
- 财经-鸡汤：情感共鸣切入、无故事讲述、金句为主，大概描述借贷场景（人情债、借钱难等），讲述整体观点
- 三农-三农美食：围绕指定食材展开剧情演绎+爽感做饭，人物出镜口播，农村/城乡结合部场景
- 三农-三农建造：建房/家具/生活用具等手工建造记录，人物出镜口播
- 剧情-常规剧情：1分钟以上、多人（非一人分饰多角）多场景演出，有完整叙事结构（人物关系、核心冲突、起承转合），环环相扣
- 剧情-剧情搞笑：相比常规剧情逻辑可不严谨、可不到1分钟，无脑耍丑肢体搞笑为主，可有万万没想到式转折

判断规则：必须且只能从上述 9 个标准类型（或其一级分类）中选择，以脚本文案的内容形态（叙事结构、表现形式、主题方向）为准判断，不是判断视频作者本人是什么达人。先判断适配粒度：内容适配整个一级类型下所有二级 → 只输出一级分类（如「财经」）；内容只适配其中某一个二级 → 输出「一级-二级」。即使素材与所有标准类型的匹配度都不高，也必须选择范围最接近的那一个，禁止自创类型、禁止输出标准列表之外的类型。

# 适配达人分析要求
- 达人类型：严格按「达人类型分类标准」判断，从 9 个标准类型中选范围最接近的；整个一级类型都适合时输出一级分类（如「财经」），仅限某一二级适合时才输出「一级-二级」，禁止自创类型
- 表现形式：如输入中已提供「视频表现特征」，直接引用；否则从脚本结构推断（单人长段=口播，多人对话=剧情）。提示中列举的类型仅为参考，可根据实际情况自行补充其他类型
- 语速与风格：如输入中已提供「视频表现特征」，直接引用；否则从脚本语言密度和标点推断。提示中列举的档位和风格仅为参考，可根据实际情况自行补充其他描述
- 口吻：从脚本内容的说话态度和立场判断，提示中列举的类型仅为参考，可根据实际情况自行补充其他口吻描述
- 推荐达人类型：综合表现形式、语速风格、口吻三个维度，推导什么类型的达人适合演绎这类脚本（自由描述，不受达人类型分类标准约束）

# 内容策略分析标准（用于输出「内容策略」字段）
把这条素材沉淀为一条内容策略：回答「这条内容走什么叙事方向、产品怎么植入、找什么达人拍」。

__DIRECTION_ENUMS__

## 判断规则
1. 优先复用已有方向：内容方向一和内容方向二先对照上述方向判断，能贴合就选最贴切的那个（内容方向二必须在所选一级方向下属的二级方向中选；切入角度不完全贴合时选语义最接近的，并在「方向定义」中说明具体角度）
2. 新建判断标准：仅当素材的核心叙事在所有对应层级方向中都找不到容身之处（强行套用会让方向失真、误导后续策略沉淀）时才新建。新建一级方向：命名简短（2-6字，与现有方向风格一致），并在「方向定义」开头注明【新建方向】+一句话说明为什么已有方向都不适用；新建二级方向：必须挂靠一个一级方向（优先已有一级），命名要具体到能独立区分一批素材，同样在「方向定义」开头注明【新建方向】+理由。素材的切入角度（人群、情绪入口、论证路径）与现有方向实质不同时，应倾向新建而不是硬套；只是措辞和锚点不同但方向内核相同的，才复用并在定义中说明角度
3. 方向定义：1-3句，覆盖目标人群（给谁看）、核心叙事（讲什么故事/打破什么认知）、内容落点（最终引向什么）；只讲内容是什么，不要把植入逻辑写进定义
4. 植入策略：一句话打法概括 + 具体示例，示例要展现完整的「内容→痛点→产品」推理链（参考本素材实际的植入方式或植入修改建议）；只写打法不给示例视为不合格
5. 适合达人：按「达人类型分类标准」输出，粒度同「适配达人.达人类型」——整个一级类型都适合只写一级类型（如「财经」），仅限某二级适合才写「一级-二级」；可附 20 字以内的风格说明（如年龄段/职业身份/讲话风格）
6. 策略等级由程序自动填写（新沉淀的策略初始为 X=创意洞察未验证），无需输出

# 约束条件
- 场景只能从枚举中选（可多选，禁止自创场景名）；纯对镜讲述选「对镜口播」
- 内容方向，总字数在30字以内
- 适配达人的达人类型选范围最接近的一个（整个一级类型适合输出一级分类如「财经」，仅限某二级适合才输出「一级-二级」），推荐达人类型控制在20字以内，其余3个子项各15字以内
- 植入话术单独不计入总字数，素材逻辑分析、对度小满的借鉴、植入修改建议三项总字数控制在100字以内
- 不要分点罗列，每项一段话连贯输出
- 语言精炼直接，不给铺垫过程
- 植入顺着原素材情绪走，不自夸不生硬

# 品牌名称
品牌名称：度小满
品牌卖点：新人首借年华利率4.9%，借一万一年利息约271元；不用不收费
目标人群：24-50岁的新锐白领、中产阶级，资深中产等方向的男性

# 输出示例
{
  "内容相关性": "强相关",
  "内容方向": "不想既丢钱又丢朋友，就记住：没做好送钱的准备，一分都别借。",
  "场景": ["对镜口播"],
  "素材逻辑分析": "被借钱者受害者视角，借钱方占便宜、试探底线、施压人情，被借方羞耻绑架、承担风险、人财两空。核心结论：借钱＝拿钱买仇人，赠予心态才可例外。",
  "对度小满的借鉴": "借势熟人借贷伤感情高风险的情绪，反向论证正规平台是正向替代方案。核心策略：品牌接住观众'不伤感情+不求人'的需求，成为两难后的最优解。",
  "植入修改建议": "在'找银行借钱要付利息'处接入'找银行借钱要付利息，但银行还不一定借给你；找度小满，明码标价，利息清楚，到账快，不欠人情不伤感情。那你说，你为啥还要找朋友开口？'核心逻辑：把'向朋友借'的熟人借贷痛点转化为'用正规平台'的解决方案。",
  "适配达人": {
    "达人类型": "口播-观点输出",
    "表现形式": "口播",
    "语速与风格": "中速、犀利、利落",
    "口吻": "犀利点评",
    "推荐达人类型": "财经、职场、情感观点"
  },
  "内容策略": {
    "内容方向一": "拒绝借钱",
    "内容方向二": "如何有效拒绝借钱",
    "方向定义": "给被熟人开口借钱、抹不开面子又怕伤感情的普通人看；核心叙事是拒绝借钱的实操方法与人情边界；落点是把「借出去是仇人」的恐惧转化为守住钱包的行动指南。",
    "植入策略": "打法：先立「借钱=买仇人」的恐惧共识，再衔接到正规平台的替代方案。示例——在「没做好送钱的准备，一分都别借」处接入「真要帮，也要帮得明明白白：自己周转不开时，找度小满，新人首借年化4.9%，不欠人情。把借出去的钱收回来，比什么都强」。推理链：拒绝借钱的痛点→拒绝不了时的兜底→正规平台补位。",
    "适合达人": "财经-鸡汤，30-50岁、有生活阅历、讲话接地气的口播博主"
  }
}`;

// ==============================

function log(msg) {
  process.stderr.write(msg + '\n');
}

// Step 1: 生成搜索关键词（返回 [{keyword, direction, source}]）
async function generateKeywords(existingIds) {
  // 反内循环配额（2026-09-15）：常规 直搜1+衍生1+探索2；连续零新策略 → 加强 直搜1+探索3（衍生暂停）
  const growth = loadStrategyGrowth();
  const boost = (growth.droughtStreak || 0) >= STRATEGY_DROUGHT_BOOST_THRESHOLD;
  const directQuota = 1;
  const deriveQuota = boost ? 0 : 1;
  const exploreQuota = boost ? 3 : 2;
  const totalQuota = directQuota + deriveQuota + exploreQuota;
  log(`🔹 Step 1: 生成搜索关键词（${boost ? `加强探索模式：直搜${directQuota} + 探索${exploreQuota}，策略衍生暂停` : `直搜${directQuota} + 衍生${deriveQuota} + 探索${exploreQuota}`}）${boost ? `——已连续 ${growth.droughtStreak} 轮零新策略，自动提升探索配额` : ''}`);

  // 来源1/2：拉取内容策略清单（24h 缓存 + 兜底）
  const strategies = fetchStrategyDoc();
  const strategyListText = strategies
    .map(s => `- ${s.l1}-${s.l2}（${s.level}级）：${s.definition}`)
    .join('\n');

  // 来源3：构建开放探索素材（热点素材表新鲜热点优先，失败降级 AI 自由衍生）
  const explore = await buildExploreMaterial(existingIds || []);
  const exploreLabel = explore.type === 'explore_hotspot' ? '热点素材表' :
    explore.type === 'explore_suggest' ? '搜索联想词' :
      explore.type === 'explore_comments' ? '高赞评论' : 'AI 自由衍生';
  log(`   开放探索素材来源：${exploreLabel}（配额 ${exploreQuota} 个）`);

  let prompt = buildKeywordPrompt(directQuota, deriveQuota, exploreQuota)
    .replace('__STRATEGY_LIST__', strategyListText)
    .replace('__EXPLORE_MATERIAL__', explore.text || '（无开放探索素材，开放探索来源请由 AI 自主衍生新方向）');

  // 近期关键词 + 近期方向（软约束注入 prompt；方向级避开用于阻断"反差职业收入"类反复衍生）
  const recentKeywords = loadRecentKeywords();
  const statsNow = loadKeywordStats();
  const recentDirs = [...new Set(recentKeywords
    .map(k => (statsNow.keywords[k] || {}).direction)
    .filter(Boolean))];
  let recentBlock = '';
  if (recentKeywords.length > 0) {
    recentBlock += `\n近期已使用的关键词（请勿重复或生成高度相似的词）：\n${recentKeywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}\n`;
  }
  if (recentDirs.length > 0) {
    recentBlock += `\n近期已使用的方向（来源2策略衍生、来源3开放探索必须避开这些方向，改选清单里的其他策略）：${recentDirs.join('、')}\n`;
  }
  prompt = prompt.replace('__RECENT_KEYWORDS__', recentBlock);

  // 注入命中率反馈（低效关键词黑名单 + 休眠方向 + 休眠来源）
  prompt = prompt.replace('__HIT_RATE_FEEDBACK__', buildHitRateFeedback());

  const callKeywordLLM = async (promptText) => {
    const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: '你是一个抖音内容策划专家，只输出JSON，不输出任何其他内容。' },
          { role: 'user', content: promptText }
        ],
        max_tokens: 2048,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`关键词生成失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    // 提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`关键词生成返回格式异常: ${content.substring(0, 200)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.keywords.map(k => {
      // source 归一化：explore 统一为 AI 自由衍生（explore_ai）
      let source = k.source || '';
      if (source === 'explore' || !source) source = explore.type;
      return { keyword: k.keyword, direction: k.direction || '', source };
    });
  };

  // 硬查重（程序化第二道防线）：命中重复则带原因重试，最多 3 轮
  const MAX_GEN_ATTEMPTS = 3;
  const dedupPool = buildDedupPool();
  let keywordDirs = [];
  let lastRejections = [];
  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    const attemptPrompt = lastRejections.length > 0
      ? `${prompt}\n\n【上一轮生成结果已被程序查重拒绝，本次必须全部规避】\n${lastRejections.map(r => `- ${r}`).join('\n')}\n请重新生成 ${totalQuota} 个与近期已用词及以上冲突词都不重复、不相似、不同句式模板的关键词（保持原来源配额）。`
      : prompt;
    const rawDirs = await callKeywordLLM(attemptPrompt);

    // 逐词校验（查重池 = 近期词 + 黑名单 + 本轮已通过的词）
    const accepted = [];
    const problems = [];
    for (const k of rawDirs) {
      const conflict = checkKeywordDup(k.keyword, [...dedupPool, ...accepted.map(a => a.keyword)]);
      if (conflict) problems.push(`「${k.keyword}」：${conflict}`);
      else accepted.push(k);
    }
    log(`   查重第${attempt}轮：${rawDirs.length} 个候选，${accepted.length} 个通过${problems.length ? '；拒绝 → ' + problems.join('；') : ''}`);

    keywordDirs = accepted;
    if (accepted.length === rawDirs.length && rawDirs.length > 0) break;
    lastRejections = problems;
  }

  if (keywordDirs.length === 0) {
    throw new Error(`关键词生成失败：连续 ${MAX_GEN_ATTEMPTS} 轮生成的关键词全部与近期已用词重复/高度相似`);
  }
  if (keywordDirs.length < totalQuota) {
    log(`   ⚠️ 查重后仅保留 ${keywordDirs.length} 个关键词（预期 ${totalQuota}，部分候选与近期词重复被拒）`);
  }

  log(`   最终采用 ${keywordDirs.length} 个关键词:`);
  keywordDirs.forEach(k => log(`     - [${k.source}] ${k.keyword}（${k.direction}）`));

  // 保存到近期关键词列表
  saveRecentKeywords(keywordDirs.map(k => k.keyword));

  return keywordDirs;
}

// Step 2: 搜索抖音视频（按 cursor 翻页，默认 2 页，扩大候选池）
const SEARCH_PAGES = parseInt(process.env.SEARCH_PAGES || '1', 10);

async function searchDouyinPage(keyword, cursor, searchId) {
  const response = await fetch('https://api.tikhub.io/api/v1/douyin/search/fetch_video_search_v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TIKHUB_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      keyword,
      cursor,
      sort_type: '1',
      publish_time: '0',
      filter_duration: '0',
      content_type: '0',
      search_id: searchId || '',
      backtrace: ''
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`抖音搜索失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();

  // 解析搜索结果，兼容多种 TikHub 响应结构
  let items = [];
  let nextCursor = null;
  let hasMore = false;
  let nextSearchId = '';
  if (result.data) {
    if (Array.isArray(result.data)) {
      items = result.data;
    } else if (result.data.business_data && Array.isArray(result.data.business_data)) {
      // TikHub v2: data.business_data[].data.aweme_info
      items = result.data.business_data.map(bd => bd.data).filter(Boolean);
    } else if (result.data.data && Array.isArray(result.data.data)) {
      items = result.data.data;
    } else if (result.data.aweme_info) {
      items = [result.data];
    }
    if (!Array.isArray(result.data)) {
      // 翻页信息在 data.business_config 里（has_more + next_page.cursor/search_id）
      const bc = result.data.business_config || {};
      const np = bc.next_page || {};
      hasMore = Boolean(bc.has_more);
      nextCursor = (np.cursor !== undefined && np.cursor !== null) ? np.cursor : null;
      nextSearchId = np.search_id || '';
      // 兜底：business_config 里没有时读顶层字段
      if (nextCursor === null && result.data.cursor !== undefined && result.data.cursor !== null) {
        nextCursor = result.data.cursor;
        hasMore = hasMore || Boolean(result.data.has_more);
      }
    }
  } else if (Array.isArray(result)) {
    items = result;
  }

  // 标准化每条记录为 aweme_info 对象
  const awemeList = items.map(item => {
    if (item.aweme_info) return item.aweme_info;
    if (item.aweme_id) return item;
    return null;
  }).filter(Boolean);

  return { awemeList, nextCursor, hasMore, nextSearchId };
}

async function searchDouyin(keyword) {
  log(`🔹 Step 2: 搜索抖音关键词 "${keyword}"（最多 ${SEARCH_PAGES} 页）...`);

  let all = [];
  let cursor = 0;
  let searchId = '';
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const { awemeList, nextCursor, hasMore, nextSearchId } = await searchDouyinPage(keyword, cursor, searchId);
    all.push(...awemeList);
    log(`   第 ${page} 页: ${awemeList.length} 条`);

    if (!hasMore) break;
    // 响应未返回 cursor 时按每页 10 条递增兜底
    cursor = (nextCursor !== null && nextCursor !== undefined) ? nextCursor : cursor + 10;
    searchId = nextSearchId;
  }

  // 按 aweme_id 去重（不同页可能返回重复视频）
  const seen = new Set();
  all = all.filter(a => {
    if (!a.aweme_id || seen.has(a.aweme_id)) return false;
    seen.add(a.aweme_id);
    return true;
  });

  log(`   搜索到 ${all.length} 条视频（去重后）`);
  return all;
}

// Step 3: 提取视频脚本（同时获取视频表现特征元信息）
async function extractVideoScript(videoUrl) {
  const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model: TRANSCRIBE_MODEL,
      messages: [
        { role: 'system', content: VIDEO_SCRIPT_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请转录这个视频中的全部台词内容，标注说话人。完整输出，不要省略。转录完成后输出视频表现特征元信息。' },
            { type: 'video_url', video_url: { url: videoUrl } }
          ]
        }
      ],
      max_tokens: 8192,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`视频脚本提取失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // 解析 ---META--- 分隔符，分离脚本和元信息
  const metaSeparator = '---META---';
  const metaIdx = content.lastIndexOf(metaSeparator);
  let script = content;
  let meta = {};

  if (metaIdx !== -1) {
    script = content.substring(0, metaIdx).trim();
    const metaJsonStr = content.substring(metaIdx + metaSeparator.length).trim();
    try {
      const parsed = JSON.parse(metaJsonStr);
      meta = {
        表现形式: parsed.表现形式 || '',
        语速: parsed.语速 || '',
        说话风格: parsed.说话风格 || ''
      };
    } catch (e) {
      log(`   ⚠️ 视频元信息JSON解析失败，仅使用脚本`);
    }
  }

  return { script, meta };
}

// Step 4: 分析创意价值
async function analyzeCreative(title, script, meta) {
  let metaSection = '';
  if (meta && meta.表现形式) {
    metaSection = '\n\n# 视频表现特征（由视频模型观察得出，分析「适配达人」时请参考）\n'
      + `- 表现形式：${meta.表现形式}\n`
      + `- 语速：${meta.语速}\n`
      + `- 说话风格：${meta.说话风格}`;
  }

  const userInput = `# 输入

脚本标题：${title}
脚本内容：
${script}${metaSection}`;

  const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: buildAnalysisPrompt() },
        { role: 'user', content: userInput }
      ],
      max_tokens: 4096,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`创意分析失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // 提取 JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log(`   ⚠️ 分析返回格式异常，使用原始文本`);
    return { 内容方向: content.substring(0, 50), 素材逻辑分析: '', 对度小满的借鉴: '', 植入修改建议: '' };
  }

  return JSON.parse(jsonMatch[0]);
}

// ============ 高赞评论创意策略分析（独立第二条线） ============
// 触发：本轮新入库视频点赞 > COMMENT_ANALYSIS_DIGG_THRESHOLD（默认3万）时并行触发
// 逻辑：抓高赞评论 → 过滤（无效/禁止方向/去重）→ 相关性判断 → 强相关才分析
// 产出：与脚本分析同结构（内容方向一/二 + 植入策略 + 适合达人等），来源标记 comment_insight
// 沉淀：现有策略表，与脚本来源的策略按方向聚合

const COMMENT_ANALYSIS_PROMPT = `# 角色
你是一位资深短视频编导，擅长从用户评论区的真实情绪和讨论中提炼创意方向，为品牌广告提供可落地的植入策略。

# 任务
分析用户提供的高赞评论列表（来自一条资金周转/借钱主题的爆款视频），提炼用户真实痛点与情绪共鸣，输出创意策略分析，直接输出JSON。输出结构与脚本创意分析完全一致。

# 输出格式
{
  "内容相关性": "强相关/弱相关/不相关",
  "时效性": "长青 / 时效话题-未过气 / 时效话题-已过气",
  "内容方向": "用一句大白话总结评论区反映的核心情绪和讨论主张",
  "素材逻辑分析": "从评论的主要情绪、典型讨论路径、核心共鸣点三个维度综合分析，一段话写清楚，直接给结论",
  "对度小满的借鉴": "从评论暴露的真实痛点出发，反向论证度小满如何承接这些痛点，核心策略一段话写清楚",
  "植入修改建议": "基于评论洞察设计的创意方向（不是修改某条具体话术，而是给出可落地的创意切入点），一段话写清楚",
  "适配达人": {
    "达人类型": "按达人类型分类标准判断，粒度规则：整个一级类型都适合就只写一级分类（如「财经」）；仅限某二级适合才写「一级-二级」（如剧情-剧情搞笑）",
    "表现形式": "口播/剧情/AI生成/其他",
    "语速与风格": "语速快慢+说话风格",
    "口吻": "老登说教/犀利点评/真挚分享等",
    "推荐达人类型": "基于以上三点推导，2-3个类型"
  },
  "内容策略": {
    "内容方向一": "一级方向，优先从枚举中选；确实不满足时新建（注明【新建方向】+理由）",
    "内容方向二": "二级方向，优先选所属一级方向下属的枚举；确实不满足时新建",
    "方向定义": "1-3句：目标人群+核心叙事+内容落点",
    "植入策略": "一句话打法概括+具体示例（讲清从评论痛点到产品的完整推理链）",
    "适合达人": "达人类型（粒度同适配达人.达人类型：整个一级都适合只写一级，如「财经」；仅限某二级才写「一级-二级」），可附简要风格说明"
  }
}

# 内容相关性判断标准
- 强相关：评论区核心讨论围绕借钱/缺钱/还钱/债务/资金周转/借钱伤感情等核心议题，有真实用户情绪共鸣
- 弱相关：评论里提到借钱或收入，但只是零星提及，主线是其他主题
- 不相关：评论区与借钱/资金周转/收入真相完全无关

# 时效性判断标准
- 长青：评论反映的人性、人情世故、普遍财务困境——不论何时都有共鸣
- 时效话题-已过气：评论围绕的平台功能/阶段性热点/具体事件已经过气
- 时效话题-未过气：时效内容但仍在传播窗口内

# 达人类型分类标准（与脚本分析一致，从 9 个标准类型中选范围最接近的一个）
- 财经-泛财经 / 财经-高价值 / 财经-小微企业主 / 财经-常规 / 财经-鸡汤 / 三农-三农美食 / 三农-三农建造 / 剧情-常规剧情 / 剧情-剧情搞笑
- 输出粒度：整个一级类型都适合就只输出一级分类（如「财经」）；仅限某二级适合才输出「一级-二级」

# 内容策略分析标准（与脚本分析一致）
__DIRECTION_ENUMS__
内容方向二优先选所属一级方向下属的现有方向，不满足时新建并注明【新建方向】+理由；素材切入角度与饱和方向实质不同时优先新建二级方向
植入策略：一句话打法概括 + 具体示例，示例展现完整的「评论痛点→产品」推理链

# 约束条件
- 适配达人的达人类型选范围最接近的一个（整个一级类型适合输出一级分类如「财经」，仅限某二级适合才输出「一级-二级」）
- 不要分点罗列，每项一段话连贯输出
- 语言精炼直接，不给铺垫过程

# 品牌名称
品牌名称：度小满
品牌卖点：新人首借年华利率4.9%，借一万一年利息约271元；不用不收费
目标人群：24-50岁的新锐白领、中产阶级，资深中产等方向的男性
`;

async function analyzeCommentsInsight(videoDesc, comments, videoMeta) {
  // 1. 过滤：去掉空评论、纯表情、过短（<4字）、命中禁止方向的评论
  const forbiddenPatterns = [/催收/, /上门催/, /起诉/, /立案/, /律师函/, /支付令/, /看病/, /治病/, /学费/, /彩礼/, /结婚/, /房贷断供/, /法拍/];
  const cleaned = comments
    .map(c => (c.text || '').trim())
    .filter(t => t.length >= 4)
    .filter(t => !forbiddenPatterns.some(p => p.test(t)));
  // 去重
  const seen = new Set();
  const unique = cleaned.filter(t => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  if (unique.length < 5) {
    return null; // 有效评论不足5条，不足以做策略分析
  }

  const topComments = unique.slice(0, 20).map((t, i) => `${i + 1}. ${t}`).join('\n');
  let metaSection = '';
  if (videoMeta && videoMeta.表现形式) {
    metaSection = `\n# 视频表现特征（原视频）\n- 表现形式：${videoMeta.表现形式}\n- 语速：${videoMeta.语速}\n- 说话风格：${videoMeta.说话风格}`;
  }

  const userInput = `# 输入
视频标题：${videoDesc}
该视频的高赞评论列表（真实用户情绪与讨论）：
${topComments}${metaSection}`;

  try {
    const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: buildCommentAnalysisPrompt() },
          { role: 'user', content: userInput }
        ],
        max_tokens: 4096,
        temperature: 0.3
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`   ⚠️ 评论洞察分析失败 (HTTP ${response.status}): ${errorText.substring(0, 150)}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log(`   ⚠️ 评论洞察分析返回格式异常`);
      return null;
    }

    const analysis = JSON.parse(jsonMatch[0]);

    // 相关性判断：弱相关/不相关 → 不入库
    if (analysis.内容相关性 && analysis.内容相关性 !== '强相关') {
      log(`   ⏭️  评论洞察内容${analysis.内容相关性}，跳过`);
      return null;
    }
    // 时效性判断：已过气 → 不入库
    if (analysis.时效性 === '时效话题-已过气') {
      log(`   ⏭️  评论洞察时效话题已过气，跳过`);
      return null;
    }

    return analysis;
  } catch (error) {
    log(`   ⚠️ 评论洞察分析异常: ${error.message.substring(0, 150)}`);
    return null;
  }
}

// 从视频对象中提取下载 URL
function getDownloadUrl(aweme) {
  const video = aweme.video || {};
  const playAddr = video.play_addr_265 || video.play_addr || {};
  const urlList = playAddr.url_list || [];

  // 优先选择 api.amemv.com 域名
  const amemvUrl = urlList.find(url => url.includes('api.amemv.com'));
  if (amemvUrl) return amemvUrl;

  // 回退到第一个可用 URL
  return urlList[0] || null;
}

// 处理候选前实时刷新视频直链（抖音 CDN 签名链接有时效，checkpoint 里的旧链会过期导致模型下载失败）
async function refreshPlayUrl(awemeId) {
  const resp = await fetch(`https://api.tikhub.io/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`, {
    headers: { 'Authorization': `Bearer ${TIKHUB_TOKEN}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) throw new Error(`TikHub fetch_one_video HTTP ${resp.status}`);
  const d = await resp.json();
  const aweme = d?.data?.aweme_detail || d?.data || {};
  const br = aweme?.video?.bit_rate || [];
  const url = (br[Math.min(1, br.length - 1)]?.play_addr?.url_list || [])[0]
    || (aweme?.video?.play_addr?.url_list || [])[0];
  if (!url) throw new Error('no play url in response');
  return url;
}

// 检查脚本是否包含禁止内容
function containsForbiddenContent(script) {
  return FORBIDDEN_KEYWORDS.some(keyword => script.includes(keyword));
}

// 检查视频标题/描述是否包含导师说教/成功学类禁止内容
function containsForbiddenTitle(desc) {
  return TITLE_FORBIDDEN_KEYWORDS.some(keyword => desc.includes(keyword));
}

// 检查是否全程未开口说话（无台词/无对话）
function isNoSpeechScript(script) {
  const trimmed = script.trim();
  if (!trimmed || trimmed.length < 5) return true;

  // 常见的"无台词"描述
  const noSpeechKeywords = [
    '无台词', '没有说话', '无对话', '无旁白', '全程没有', '未说话',
    '没有开口', '没有台词', '没有任何对话', '没有对白', '无对白',
    '纯音乐', '只有音乐', '没有声音', '静音', '无声音',
    '视频中没有任何', '视频没有说话', '该视频没有'
  ];
  if (noSpeechKeywords.some(kw => trimmed.includes(kw))) return true;

  // 如果内容全是括号内的动作描述，没有【人物】格式的台词
  const dialogueLines = trimmed.split('\n').filter(line => {
    const t = line.trim();
    return t && !t.startsWith('（') && !t.startsWith('(') && t.includes('】');
  });
  if (dialogueLines.length === 0) return true;

  return false;
}

// 检测 API 余额不足错误
function isQuotaExhaustedError(error) {
  const msg = (error.message || '').toLowerCase();
  return msg.includes('http 402') ||
         msg.includes('payment required') ||
         msg.includes('quota') ||
         msg.includes('insufficient') ||
         msg.includes('余额不足') ||
         msg.includes('额度不足') ||
         msg.includes('exceeded your current quota') ||
         msg.includes('billing') ||
         msg.includes('no enough') ||
         msg.includes('账户余额');
}

// 并发执行控制器：用 Promise.all 并行跑，但限制同时运行的数量
async function runWithConcurrency(taskFns, concurrency) {
  const results = new Array(taskFns.length);
  let index = 0;

  async function worker() {
    while (index < taskFns.length) {
      const current = index++;
      try {
        results[current] = await taskFns[current]();
      } catch (error) {
        results[current] = { status: 'failed', error: error.message };
      }
    }
  }

  const workers = Array(Math.min(concurrency, taskFns.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

// ============ 飞书多维表格自动化 ============

// 获取今天的日期字符串 yyyy/MM/dd
function getTodayDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// 调用 lark-cli 的封装
function runLarkCli(args) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
  };
  return execFileSync(LARK_CLI, args, {
    encoding: 'utf-8',
    timeout: 60000,
    env,
    maxBuffer: 10 * 1024 * 1024 // 10MB
  });
}

// Step 0: 飞书预检 —— 在任何付费 API 调用（LLM 关键词生成 / TikHub 搜索 / 转录）之前，
// 先确认 lark-cli 鉴权正常、素材库和策略表都可访问。任何一个探针失败立即中止，
// 避免「整轮跑完才发现飞书写入全灭、白烧 API 资源」的事故重演（2026-09-08 实际发生过）。
function preflightFeishu() {
  log('🔹 Step 0: 飞书预检（lark-cli 鉴权 + 素材库/策略表可达性）...');
  const probes = [
    ['素材库', BITABLE_BASE_TOKEN, BITABLE_TABLE_ID],
    ['策略表', STRATEGY_BASE_TOKEN, STRATEGY_TABLE_ID]
  ];
  for (const [name, baseToken, tableId] of probes) {
    try {
      runLarkCli(['base', '+record-list', '--base-token', baseToken, '--table-id', tableId,
        '--limit', '1', '--as', 'user', '--format', 'json']);
      log(`   ✅ ${name} 可访问`);
    } catch (error) {
      throw new Error(`飞书预检失败（${name} 表不可访问）: ${error.message.substring(0, 200)}`);
    }
  }
}

// Step 1 自动化：从多维表格查询已有素材 ID
function fetchExistingIds() {
  log('🔹 Step 1: 查询飞书多维表格已有素材 ID...');
  try {
    const output = runLarkCli([
      'base', '+record-list',
      '--base-token', BITABLE_BASE_TOKEN,
      '--table-id', BITABLE_TABLE_ID,
      '--field-id', '素材id',
      '--limit', '200',
      '--as', 'user',
      '--format', 'json'
    ]);

    const data = JSON.parse(output);
    const records = data?.data?.data || data?.data || [];
    const fieldNames = data?.data?.fields || [];
    const idFieldIdx = fieldNames.indexOf('素材id');
    const ids = [];

    for (const record of records) {
      // lark-cli 返回的记录可能是数组格式（配合 fieldNames）或对象格式（带 fields）
      let val;
      if (Array.isArray(record) && idFieldIdx >= 0) {
        val = record[idFieldIdx];
      } else if (record.fields) {
        val = record.fields['素材id'];
      } else {
        val = record['素材id'];
      }

      if (val && typeof val === 'string') {
        ids.push(val);
      } else if (Array.isArray(val)) {
        // 飞书文本字段可能返回 [{ text: "xxx" }]
        const text = val.map(v => v.text || '').join('');
        if (text) ids.push(text);
      }
    }

    log(`   已有素材 ID: ${ids.length} 条`);
    return ids;
  } catch (error) {
    // 失败即中止：跳过去重会导致老素材重复入库（2026-09-08 试跑实际发生），且
    // lark-cli/keychain 挂掉时后续飞书写入也必然失败，整轮白跑。中止让问题当场暴露。
    throw new Error(`查询已有素材 ID 失败，中止运行（防重复入库）：${error.message.substring(0, 200)}`);
  }
}

// 格式化「适配达人」分析结果为飞书表格可写入的多行文本
function formatAdaptation(adaptation) {
  if (!adaptation) return '';
  if (typeof adaptation === 'string') return adaptation;
  if (typeof adaptation === 'object') {
    const parts = [];
    if (adaptation['达人类型']) parts.push(`达人类型：${adaptation['达人类型']}`);
    if (adaptation['表现形式']) parts.push(`表现形式：${adaptation['表现形式']}`);
    if (adaptation['语速与风格']) parts.push(`语速与风格：${adaptation['语速与风格']}`);
    if (adaptation['口吻']) parts.push(`口吻：${adaptation['口吻']}`);
    if (adaptation['推荐达人类型']) parts.push(`推荐达人类型：${adaptation['推荐达人类型']}`);
    return parts.join('\n');
  }
  return '';
}

// 素材「场景」枚举（与飞书 tblYEQ0raRDrB4tb「场景」多选字段 fldKapI96Z 严格一致）
const SCENE_OPTIONS = [
  '对镜口播', '酒席饭桌', '居家室内', '职场办公', '户外街头',
  '店铺商户', '车内出行', '线上通话', '工地工厂', '其他'
];

// 归一化「场景」判定结果：只保留合法枚举项（去重、过滤自创值）
function formatScenes(scenes) {
  if (!scenes) return [];
  const arr = Array.isArray(scenes) ? scenes : [scenes];
  const out = [];
  for (const s of arr) {
    const name = String(s || '').trim();
    if (SCENE_OPTIONS.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// Step 3 自动化：构建 payload 并写入多维表格
function writeToBitable(results) {
  if (results.length === 0) {
    log('🔹 Step 5: 无需写入（0 条结果）');
    return { success: 0, failed: 0, errors: [] };
  }

  log(`📝 写入飞书多维表格（${results.length} 条）...`);

  const todayStr = getTodayDateStr();
  const createRecords = results.map(r => {
    const analysis = r.analysis || {};
    const borrowInsight = analysis['对度小满的借鉴'] || '';
    const implantSuggestion = analysis['植入修改建议'] || '';
    const adInsight = [borrowInsight, implantSuggestion].filter(Boolean).join('\n\n');

    return {
      '素材id': `dy_${r.aweme_id}`,
      '素材渠道': '抖音',
      '关键词': r.keyword || '',
      '素材链接': r.video_url,
      '素材脚本文案': r.script,
      '内容方向': analysis['内容方向'] || '',
      '场景': formatScenes(analysis['场景']),
      '内容分析': analysis['素材逻辑分析'] || '',
      '广告可借鉴点': adInsight,
      '适配达人': formatAdaptation(analysis['适配达人']),
      '更新时间': todayStr
    };
  });

  const payload = { create_records: createRecords };
  const payloadJson = JSON.stringify(payload);

  try {
    const output = execFileSync(LARK_CLI, [
      'base', '+record-batch-create',
      '--base-token', BITABLE_BASE_TOKEN,
      '--table-id', BITABLE_TABLE_ID,
      '--json', payloadJson,
      '--as', 'user',
      '--format', 'json'
    ], {
      encoding: 'utf-8',
      timeout: 60000,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
      },
      maxBuffer: 50 * 1024 * 1024
    });

    const resp = JSON.parse(output);
    const recordIds = resp?.data?.record_id_list || [];
    const count = recordIds.length;
    log(`   ✅ 成功写入 ${count} 条记录`);
    return { success: count, failed: 0, errors: [] };
  } catch (error) {
    log(`   ❌ 写入飞书多维表格失败: ${error.message.substring(0, 500)}`);
    return { success: 0, failed: results.length, errors: [error.message] };
  }
}

// ============ 内容策略表同步（度小满-网络创意策略） ============
// 唯一性判断标准：内容方向一|内容方向二 组合。同方向多条素材 →
// 补充完善该方向的植入策略 + 素材id 追加进「素材链接ids」（用、分隔）；新方向 → 新建策略行（等级 X）

// 解析飞书单元格（文本字段可能是 string 或 [{text}] 数组）
function cellText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map(v => (typeof v === 'string' ? v : v.text || '')).join('').trim();
  return String(val);
}

// 读取策略表现有记录，返回 Map「方向一|方向二」-> { recordId, 植入策略, 素材链接ids }
function fetchStrategyRecords() {
  const output = runLarkCli([
    'base', '+record-list',
    '--base-token', STRATEGY_BASE_TOKEN,
    '--table-id', STRATEGY_TABLE_ID,
    '--limit', '200',
    '--as', 'user',
    '--format', 'json'
  ]);
  const data = JSON.parse(output)?.data || {};
  const fieldNames = data.fields || [];
  const rows = data.data || [];
  const recordIds = data.record_id_list || [];
  const idx = {};
  ['内容方向一', '内容方向二', '植入策略', '素材链接ids', '适合达人'].forEach(name => {
    idx[name] = fieldNames.indexOf(name);
  });

  const map = new Map();
  rows.forEach((row, i) => {
    const dir1 = cellText(idx['内容方向一'] >= 0 ? row[idx['内容方向一']] : null);
    const dir2 = cellText(idx['内容方向二'] >= 0 ? row[idx['内容方向二']] : null);
    if (!dir1 || !dir2) return;
    map.set(`${dir1}|${dir2}`, {
      recordId: recordIds[i] || null,
      植入策略: cellText(idx['植入策略'] >= 0 ? row[idx['植入策略']] : null),
      素材链接ids: cellText(idx['素材链接ids'] >= 0 ? row[idx['素材链接ids']] : null),
      适合达人: cellText(idx['适合达人'] >= 0 ? row[idx['适合达人']] : null)
    });
  });
  return map;
}

// 合并「适合达人」：把新素材里行上未覆盖的达人类型并入「达人类型：」行（幂等）
// 粒度规则（2026-09-09 用户约定）：整个一级类型都适用只写一级（如「财经」=财经下所有二级都适合）；仅限某二级才写「一级-二级」
// 覆盖判定：宽(一级)覆盖窄(一级-二级)；窄不覆盖宽——若行上是窄(财经-泛财经)、新素材判定为宽(财经)，需把窄收敛为宽
// 2026-09-09 新增：此前更新已有策略行只写素材链接ids/植入策略，从不看适合达人（行14剧情类素材漏覆盖）
function mergeSuitedInfluencers(existing, items) {
  const existingText = (existing || '').trim();
  const lines = existingText ? existingText.split('\n') : [];
  const ti = lines.findIndex(l => /^达人类型[:：]/.test(l.trim()));
  let tokens = [];
  if (ti >= 0) {
    tokens = lines[ti].replace(/^达人类型[:：]\s*/, '').split(/、|，|,/).map(s => s.trim()).filter(Boolean);
  }
  const isNarrow = t => t.includes('-');
  const primaryOf = t => t.split('-')[0];
  const adds = [];        // 需新增的宽/窄类型（追加行尾）
  const replaceMap = {};  // 窄类型 -> 收敛为的宽类型（原位替换第一个，其余删除）
  for (const r of items) {
    const suited = r.analysis?.内容策略?.['适合达人'] || '';
    const m = suited.match(/达人类型[:：]\s*([^\n]+)/);
    if (!m) continue;
    for (const seg of m[1].split(/、|，|,/)) {
      const t = seg.trim();
      if (!t) continue;
      if (isNarrow(t)) {
        // 窄类型：行上已有同款或其一级（宽覆盖窄）即视为覆盖
        if (tokens.includes(t) || tokens.includes(primaryOf(t))) continue;
        if (!adds.includes(t)) adds.push(t);
      } else {
        // 宽类型：行上已有同款即覆盖；行上有同级的窄类型 → 把窄收敛为宽；否则新增宽
        if (tokens.includes(t)) continue;
        const narrower = tokens.filter(tok => tok.startsWith(t + '-'));
        if (narrower.length > 0) {
          narrower.forEach(tok => { replaceMap[tok] = t; });
        } else if (!adds.includes(t)) {
          adds.push(t);
        }
      }
    }
  }
  if (adds.length === 0 && Object.keys(replaceMap).length === 0) return existingText;
  if (lines.length === 0) {
    // 原字段为空：直接用第一条新素材的完整画像
    const first = items.find(r => r.analysis?.内容策略?.['适合达人']);
    return first ? first.analysis.内容策略['适合达人'] : existingText;
  }
  const keepTokens = [];
  let replaced = false;
  for (const tok of tokens) {
    if (replaceMap[tok]) {
      if (!replaced) { keepTokens.push(replaceMap[tok]); replaced = true; }
      continue;
    }
    keepTokens.push(tok);
  }
  const finalTokens = [...keepTokens, ...adds];
  const typeLine = '达人类型：' + finalTokens.join('、');
  const otherLines = lines.filter(l => !/^达人类型[:：]/.test(l.trim()));
  return [typeLine, ...otherLines].join('\n');
}

// 确保策略表 select 字段包含给定选项（新方向落表的前提：飞书不会自动创建不存在的选项）
// fieldName: 字段名；values: 需要的选项值数组。返回实际新增的选项列表。
function ensureSelectOptions(fieldName, values) {
  const needed = [...new Set(values.filter(v => v && String(v).trim()))];
  if (needed.length === 0) return [];

  // 1) 读全量字段定义（field-update 是全量 PUT，必须先读后改）
  const resp = JSON.parse(runLarkCli([
    'base', '+field-get',
    '--base-token', STRATEGY_BASE_TOKEN,
    '--table-id', STRATEGY_TABLE_ID,
    '--field-id', fieldName,
    '--as', 'user', '--format', 'json'
  ]));
  const field = resp?.data?.field;
  if (!field || field.type !== 'select') throw new Error(`字段 ${fieldName} 不存在或不是单选类型`);

  const existingNames = new Set((field.options || []).map(o => o.name));
  const toAdd = needed.filter(v => !existingNames.has(v));
  if (toAdd.length === 0) return [];

  // 2) 追加新选项（保留已有选项原样），全量 PUT 回去
  const updated = {
    name: field.name,
    type: field.type,
    multiple: field.multiple === true,
    options: [...(field.options || []), ...toAdd.map(name => ({ name }))]
  };
  const updateResp = JSON.parse(runLarkCli([
    'base', '+field-update',
    '--base-token', STRATEGY_BASE_TOKEN,
    '--table-id', STRATEGY_TABLE_ID,
    '--field-id', field.id,
    '--json', JSON.stringify(updated),
    '--yes',
    '--as', 'user', '--format', 'json'
  ]));
  if (!updateResp?.ok) throw new Error(`更新字段 ${fieldName} 失败: ${JSON.stringify(updateResp).substring(0, 200)}`);
  log(`   🆕 策略表字段「${fieldName}」新增选项: ${toAdd.join('、')}`);
  return toAdd;
}

// 新方向创建前，批量确保内容方向一/二的选项存在；失败时抛错由调用方决定降级
function ensureStrategyDirections(createRecords) {
  const dir1s = createRecords.map(r => Array.isArray(r['内容方向一']) ? r['内容方向一'][0] : r['内容方向一']);
  const dir2s = createRecords.map(r => Array.isArray(r['内容方向二']) ? r['内容方向二'][0] : r['内容方向二']);
  ensureSelectOptions('内容方向一', dir1s);
  ensureSelectOptions('内容方向二', dir2s);
}

// 策略查重：判断新素材的植入策略与已有策略是否为同一套打法逻辑
// 返回 per-item verdict 数组 ['duplicate'|'new']；LLM 失败时全部视为 new（回退旧行为，宁可多存不丢失）
async function dedupeStrategies(existingStrategyText, items) {
  try {
    const verdicts = new Array(items.length).fill('new');
    const listText = items.map((r, i) =>
      `【素材${i + 1} dy_${r.aweme_id}】${r.analysis.内容策略['植入策略']}`
    ).join('\n\n');

    const prompt = `你在维护一张内容策略表。某个内容方向下已有一条策略（含打法概括、示例、推理链），现在新收集了一批素材，每条素材也总结了自己的植入策略。

# 已有策略
${existingStrategyText.substring(0, 1500)}

# 新素材的植入策略
${listText}

# 任务
逐条判断每个新素材的植入策略与已有策略是否为**同一个策略**。判定口径按《内容策略表字段填写指南》3.4：植入策略 = 一句话打法概括 + 具体示例（示例的价值在于展现「内容→痛点→产品」的完整推理链）。因此：
- duplicate：打法概括相同，且示例的推理链也相同（例如都是"硬核计算揭露高息→制造恐惧→低息正规平台补位"）——只是措辞、接入锚点位置、具体数字不同。这类变体已由已有策略覆盖，重复罗列没有价值
- new：打法概括不同，或示例展现了实质不同的推理链（不同的情绪入口、不同的论证路径、不同的植入时机，如"先共情再劝告"vs"先恐惧再解救"）——这类值得作为新示例编号补充进已有策略

只输出JSON：{"verdicts": ["duplicate" 或 "new", ...]}，数组长度必须等于素材数量（${items.length}）。`;

    const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: '你是一个内容策略分析专家，只输出JSON，不输出任何其他内容。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 512,
        temperature: 0.1
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    if (Array.isArray(parsed.verdicts)) {
      parsed.verdicts.slice(0, items.length).forEach((v, i) => {
        verdicts[i] = v === 'duplicate' ? 'duplicate' : 'new';
      });
    }
    return verdicts;
  } catch (error) {
    // 查重失败返回 null（区别于查重结果）：调用方只并入素材链接ids、不追加策略文字，
    // 避免回退"全保留"在 API 故障时重新堆叠重复补充段（堆进去后是粘性的，不会自动清理）
    log(`   ⚠️ 策略查重失败（本轮仅并入素材链接ids，策略文本不更新，下轮重试）: ${error.message.substring(0, 150)}`);
    return null;
  }
}

// 将本轮成功素材的「内容策略」同步到策略表（同方向聚合，去重更新）
async function syncStrategyTable(results) {
  // 脚本来源的策略
  const withStrategy = (results || []).filter(r => r.analysis?.内容策略?.['内容方向一'] && r.analysis?.内容策略?.['内容方向二']);
  // 评论洞察来源的策略（独立第二条线，与脚本策略合并聚合到同一张策略表）
  const withCommentInsight = (results || [])
    .filter(r => r.commentInsight && r.commentInsight.内容策略?.['内容方向一'] && r.commentInsight.内容策略?.['内容方向二'])
    .map(r => ({
      aweme_id: r.commentInsight._source_aweme_id || r.aweme_id,
      desc: r.commentInsight._source_desc || r.desc,
      analysis: { 内容策略: r.commentInsight.内容策略 },
      _source: 'comment_insight'
    }));
  const allStrategyItems = [...withStrategy, ...withCommentInsight];
  if (allStrategyItems.length === 0) {
    log('   （本轮无内容策略产出，跳过）');
    return { created: 0, updated: 0, appended: 0, mergedOnly: 0, items: 0, skipped: 0 };
  }
  if (withCommentInsight.length > 0) {
    log(`   其中脚本来源策略 ${withStrategy.length} 条，评论洞察来源策略 ${withCommentInsight.length} 条`);
  }

  let existing;
  try {
    existing = fetchStrategyRecords();
  } catch (error) {
    log(`   ❌ 读取策略表失败，跳过同步: ${error.message.substring(0, 200)}`);
    return { created: 0, updated: 0, appended: 0, mergedOnly: 0, items: allStrategyItems.length, skipped: allStrategyItems.length };
  }
  log(`   策略表现有 ${existing.size} 个方向组合`);

  // 按方向组合聚合本轮素材（脚本来源 + 评论洞察来源合并聚合）
  const grouped = new Map();
  for (const r of allStrategyItems) {
    const s = r.analysis.内容策略;
    const key = `${s['内容方向一']}|${s['内容方向二']}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  const createRecords = [];
  const updateRecords = {};
  let created = 0, updated = 0;
  // 反内循环统计（2026-09-15）：appended = 追加的新打法条数；mergedOnly = 仅并入素材链接ids的条数
  let appended = 0, mergedOnly = 0;

  for (const [key, items] of grouped) {
    const [dir1, dir2] = key.split('|');
    // 评论洞察来源的素材id加来源标记，便于策略表区分
    const newIds = items.map(r => r._source === 'comment_insight'
      ? `dy_${r.aweme_id}（评论洞察）`
      : `dy_${r.aweme_id}`);
    const exist = existing.get(key);

    if (exist && exist.recordId) {
      // 已有方向：先查重——策略逻辑与已有重复的只并入素材链接ids，有实质差异的才追加【素材补充】
      const verdicts = await dedupeStrategies(exist.植入策略, items);
      const dedupeOk = verdicts !== null;
      const dupCount = dedupeOk ? verdicts.filter(v => v === 'duplicate').length : items.length;
      const newItems = dedupeOk ? items.filter((_, i) => verdicts[i] === 'new') : [];
      appended += newItems.length;
      mergedOnly += dedupeOk ? dupCount : items.length;

      const mergedIds = [...new Set([...(exist.素材链接ids ? exist.素材链接ids.split('、') : []), ...newIds])].join('、');
      const updateFields = { '素材链接ids': mergedIds };
      if (newItems.length > 0) {
        const supplements = newItems.map(r => {
          const s = r.analysis.内容策略;
          return `【素材补充 dy_${r.aweme_id}】${s['植入策略']}`;
        }).join('\n\n');
        updateFields['植入策略'] = `${exist.植入策略}\n\n${supplements}`;
      }
      // 合并适合达人：新素材的类型行上有未覆盖达人类型时补充（幂等，无变化则不写）
      const mergedSuited = mergeSuitedInfluencers(exist.适合达人, items);
      if (mergedSuited && mergedSuited !== (exist.适合达人 || '')) {
        updateFields['适合达人'] = mergedSuited;
      }
      updateRecords[exist.recordId] = updateFields;
      updated += 1;
      log(dedupeOk
        ? `   🔄 已有方向「${dir1}-${dir2}」：${items.length} 条中 ${dupCount} 条策略重复（仅并入素材链接ids）、${newItems.length} 条有新打法（追加素材补充），素材链接ids → ${mergedIds}`
        : `   🔄 已有方向「${dir1}-${dir2}」：查重失败，${items.length} 条全部仅并入素材链接ids（策略文本未动），素材链接ids → ${mergedIds}`);
    } else {
      // 新方向：新建策略行，等级 X（创意洞察，未经业务验证）
      // 多条素材时同样查重：以第 1 条为基准，重复的只并入 ids，有差异的追加
      const first = items[0];
      const s = first.analysis.内容策略;
      let 植入策略 = s['植入策略'];
      if (items.length > 1) {
        const verdicts = await dedupeStrategies(植入策略, items.slice(1));
        const dedupeOk = verdicts !== null;
        const newItems = dedupeOk ? items.slice(1).filter((_, i) => verdicts[i] === 'new') : [];
        appended += newItems.length;
        mergedOnly += dedupeOk ? (items.length - 1 - newItems.length) : (items.length - 1);
        if (newItems.length > 0) {
          植入策略 += '\n\n' + newItems.map(r => `【素材补充 dy_${r.aweme_id}】${r.analysis.内容策略['植入策略']}`).join('\n\n');
        }
        const dupCount = dedupeOk ? items.length - 1 - newItems.length : items.length - 1;
        log(dedupeOk
          ? `   ↳ 新方向查重：${dupCount} 条重复（仅并入素材链接ids）、${newItems.length} 条追加补充`
          : `   ↳ 新方向查重失败：${items.length - 1} 条全部仅并入素材链接ids（策略文本未动）`);
      }
      const ids = newIds.join('、');
      createRecords.push({
        '内容方向一': [dir1],
        '内容方向二': [dir2],
        '内容一方向定义': s['方向定义'] || '',
        '植入策略': 植入策略,
        '策略等级': ['X'],
        '适合达人': s['适合达人'] || '',
        '素材链接ids': ids,
        '正向案例': first.script || ''
      });
      created += 1;
      log(`   ➕ 新方向「${dir1}-${dir2}」：新建策略行（等级 X），素材链接ids → ${ids}`);
    }
  }

  let skipped = withStrategy.length;
  try {
    if (createRecords.length > 0) {
      // 飞书 select 不会自动创建不存在的选项，新方向落表前先扩选项
      try {
        ensureStrategyDirections(createRecords);
      } catch (error) {
        log(`   ❌ 策略表选项扩充失败，跳过 ${createRecords.length} 条新方向写入: ${error.message.substring(0, 200)}`);
        skipped += createRecords.length;
        createRecords.length = 0;
      }
    }
    if (createRecords.length > 0) {
      const resp = JSON.parse(runLarkCli([
        'base', '+record-batch-create',
        '--base-token', STRATEGY_BASE_TOKEN,
        '--table-id', STRATEGY_TABLE_ID,
        '--json', JSON.stringify({ create_records: createRecords }),
        '--as', 'user', '--format', 'json'
      ]));
      if (!resp?.ok) throw new Error(JSON.stringify(resp).substring(0, 300));
    }
    if (Object.keys(updateRecords).length > 0) {
      const resp = JSON.parse(runLarkCli([
        'base', '+record-batch-update',
        '--base-token', STRATEGY_BASE_TOKEN,
        '--table-id', STRATEGY_TABLE_ID,
        '--json', JSON.stringify({ update_records: updateRecords }),
        '--as', 'user', '--format', 'json'
      ]));
      if (!resp?.ok) throw new Error(JSON.stringify(resp).substring(0, 300));
    }
    skipped = 0;
    log(`   ✅ 内容策略同步完成：新建 ${created} 行，更新 ${updated} 行`);
  } catch (error) {
    log(`   ❌ 策略表写入失败: ${error.message.substring(0, 300)}`);
    return { created: 0, updated: 0, appended: 0, mergedOnly: 0, items: allStrategyItems.length, skipped };
  }
  return { created, updated, appended, mergedOnly, items: allStrategyItems.length, skipped: 0 };
}

// 发送飞书通知（每次运行结束都发，含成功/失败/放弃统计）
function sendFeishuNotification(summary, quotaExhausted) {
  log('🔹 发送飞书结果通知...');

  try {
    // 从 auth status 获取当前用户 open_id
    const authOutput = runLarkCli(['auth', 'status']);
    const authData = JSON.parse(authOutput);
    const myOpenId = authData?.identities?.user?.openId || '';

    if (!myOpenId) {
      log('   ⚠️ 无法获取当前用户 open_id，跳过飞书通知');
      return;
    }

    const lines = [
      '📊 度小满创意分析 - 执行结果通知',
      ''
    ];

    if (summary.keywords && summary.keywords.length > 0) {
      lines.push(`🔑 搜索关键词：${summary.keywords.join('、')}`);
      lines.push('');
    }

    lines.push('📈 执行结果：');
    lines.push(`- ✅ 成功处理：${summary.total_success} 条`);
    lines.push(`- ⏭️ 被放弃：${summary.total_skipped} 条`);
    lines.push(`- ❌ 执行失败：${summary.total_failed} 条`);

    if (summary.bitable_success !== undefined) {
      lines.push(`- 📝 飞书写入：${summary.bitable_success} 条`);
    }

    if (summary.strategy_created !== undefined) {
      lines.push(`- 🧭 内容策略沉淀：新建 ${summary.strategy_created} 行，更新 ${summary.strategy_updated} 行（追加新打法 ${summary.strategy_appended || 0} 条，仅并入素材 ${summary.strategy_merged_only || 0} 条）`);
    }
    if ((summary.drought_streak || 0) >= 2) {
      lines.push(`- ⚠️ 策略库内循环预警：已连续 ${summary.drought_streak} 轮零新策略产出，下轮探索配额自动提升（探索词 2→3、策略衍生暂停）`);
    }

    if (quotaExhausted) {
      lines.push('');
      lines.push('⚠️ AIHubMix API 余额不足，工作流已提前终止！');
      lines.push('已成功处理的素材已写入飞书多维表格，请及时充值后重新运行。');
    } else {
      lines.push('');
      lines.push('✅ 工作流已正常完成。');
    }

    const msgText = lines.join('\n');
    const content = JSON.stringify({ text: msgText });
    runLarkCli([
      'im', '+messages-send',
      '--user-id', myOpenId,
      '--msg-type', 'text',
      '--content', content,
      '--as', 'user',
      '--format', 'json'
    ]);

    log('   ✅ 飞书通知已发送');
  } catch (error) {
    log(`   ⚠️ 飞书通知发送失败: ${error.message.substring(0, 200)}`);
  }
}

// 主流程
async function main() {
  // 解析参数
  const args = process.argv.slice(2);
  let customKeywords = null;
  let existingIds = [];
  let skipBitable = false;
  let isResume = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keywords' && args[i + 1]) {
      customKeywords = args[i + 1].split(',').map(k => k.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--existing-ids' && args[i + 1]) {
      existingIds = args[i + 1].split(',').map(id => id.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--skip-bitable') {
      skipBitable = true;
    } else if (args[i] === '--resume') {
      isResume = true;
    }
  }

  log('============================================');
  log('🎬 度小满创意分析 - 抖音工作流启动');
  log('============================================\n');

  // 检查必需的环境变量
  const required = { AIHUBMIX_API_KEY, TIKHUB_TOKEN };
  if (!skipBitable) {
    required.BITABLE_BASE_TOKEN = BITABLE_BASE_TOKEN;
    required.BITABLE_TABLE_ID = BITABLE_TABLE_ID;
  }
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    log(`❌ 缺少必需的环境变量: ${missing.join(', ')}`);
    log('   请参考 .env.example 配置环境变量后重试');
    process.exit(1);
  }

  // Step 0: 飞书预检——付费 API（LLM/TikHub）之前先确认飞书可用，失败立即中止
  if (!skipBitable) {
    try {
      preflightFeishu();
    } catch (error) {
      log(`❌ ${error.message}`);
      log('   排查方向：1) run_workflow 必须前台运行，不能丢后台任务（沙箱会拦截 lark-cli keychain 刷新）；2) lark-cli auth status 检查授权是否过期；3) 飞书应用权限/表 id 是否变更');
      process.exit(1);
    }
    log('');
  }

  // Step 1: 查询已有素材 ID（如果未手动传入）
  if (existingIds.length === 0 && !skipBitable) {
    try {
      existingIds = fetchExistingIds();
    } catch (error) {
      log(`❌ ${error.message}`);
      log('   排查方向：1) lark-cli keychain 是否被沙箱拦截（run_workflow 必须前台运行，不能丢后台）；2) 飞书授权是否过期（lark-cli auth status）');
      process.exit(1);
    }
  } else if (existingIds.length > 0) {
    log(`🔹 Step 1: 使用传入的 ${existingIds.length} 个已有素材 ID`);
  }

  // ========== Resume 模式：从 checkpoint 恢复 ==========
  // 先恢复上次中断运行的关键词统计（live_counts → totals），防中断丢黑名单/种子词数据
  recoverLiveCounts();
  let keywords;
  let keywordDirs = [];
  let candidates = [];
  let allAweme = [];
  const skipped = [];

  if (isResume) {
    const cp = loadCheckpoint();
    if (!cp) {
      log('❌ 没有 checkpoint 文件，无法 --resume。请先正常运行一次。');
      process.exit(1);
    }
    keywords = cp.keywords;
    keywordDirs = cp.keywordDirs || keywords.map(k => ({ keyword: k, direction: '' }));
    candidates = cp.candidates.filter(c => !cp.processed.includes(c.aweme_id));
    // 也跳过已写入飞书的（双重保险）
    candidates = candidates.filter(c => !existingIds.includes(`dy_${c.aweme_id}`));
    log(`🔹 Resume 模式：从 checkpoint 恢复`);
    log(`   关键词：${keywords.join('、')}`);
    log(`   原始候选：${cp.candidates.length} 条，已处理：${cp.processed.length} 条，剩余：${candidates.length} 条\n`);

    if (candidates.length === 0) {
      log('✅ 所有候选已处理完毕，清理 checkpoint。');
      clearCheckpoint();
      return;
    }
  } else {
    // ========== 正常模式：生成关键词 → 搜索 → 过滤 ==========
    // Step 1: 生成关键词（或使用自定义关键词）
    if (customKeywords && customKeywords.length > 0) {
      keywords = customKeywords;
      keywordDirs = keywords.map(k => ({ keyword: k, direction: '自定义', source: 'custom' }));
      log(`🔹 Step 1: 使用自定义关键词: ${keywords.join(', ')}`);
    } else {
      keywordDirs = await generateKeywords(existingIds);
      keywords = keywordDirs.map(k => k.keyword);
    }
    log('');

    // Step 2: 搜索抖音
    for (const keyword of keywords) {
      const results = await searchDouyin(keyword);
      // 每条视频标注它来自哪个搜索关键词
      for (const aweme of results) {
        allAweme.push({ aweme, keyword });
      }
    }
    log(`   共搜索到 ${allAweme.length} 条视频\n`);

    // Step 3: 过滤和去重
    log('🔹 Step 3: 过滤和去重...');

    for (const { aweme, keyword } of allAweme) {
      const awemeId = aweme.aweme_id;
      const duration = aweme.video?.duration;
      const materialId = `dy_${awemeId}`;

      // 去重
      if (existingIds.includes(materialId)) {
        skipped.push({ aweme_id: awemeId, reason: 'duplicate' });
        continue;
      }

      // 同一个 aweme_id 重复
      if (candidates.find(c => c.aweme_id === awemeId)) {
        skipped.push({ aweme_id: awemeId, reason: 'duplicate_in_batch' });
        continue;
      }

      // 视频文件大小过滤（豆包 API 限制 50MB）
      const videoSize = aweme.video?.data_size || 0;
      if (videoSize && videoSize > MAX_VIDEO_SIZE_MB * 1024 * 1024) {
        skipped.push({ aweme_id: awemeId, reason: 'video_too_large', size_mb: Math.round(videoSize / 1024 / 1024) });
        continue;
      }

      // 点赞数过滤
      const diggCount = aweme.statistics?.digg_count || 0;
      if (diggCount < MIN_DIGG_COUNT) {
        skipped.push({ aweme_id: awemeId, reason: 'low_digg_count', digg_count: diggCount });
        continue;
      }

      // 标题级过滤：导师说教/成功学/负债翻身类内容
      const descText = aweme.desc || '';
      if (containsForbiddenTitle(descText)) {
        skipped.push({ aweme_id: awemeId, reason: 'forbidden_title', desc: descText.substring(0, 50) });
        continue;
      }

      // 获取下载 URL
      const downloadUrl = getDownloadUrl(aweme);
      if (!downloadUrl) {
        skipped.push({ aweme_id: awemeId, reason: 'no_download_url' });
        continue;
      }

      candidates.push({
        aweme_id: awemeId,
        desc: aweme.desc || '',
        download_url: downloadUrl,
        duration: duration,
        keyword: keyword
      });
    }

    log(`   通过过滤: ${candidates.length} 条`);
    log(`   已跳过: ${skipped.length} 条`);
    skipped.forEach(s => log(`     - ${s.aweme_id}: ${s.reason}`));
    log('');

    // 保存 checkpoint（防中断丢失）
    if (candidates.length > 0) {
      saveCheckpoint(keywords, candidates, keywordDirs);
    }

    // 中断容错：Step 3 完成即落盘 searched/filtered（成功数由 Step 4 逐条追加）
    const liveUpdates = {};
    for (const { keyword, direction, source } of keywordDirs) {
      liveUpdates[keyword] = {
        direction: direction || '', source: source || '',
        searched: allAweme.filter(x => x.keyword === keyword).length,
        filtered: candidates.filter(c => c.keyword === keyword).length,
        last_run: new Date().toISOString()
      };
    }
    flushLiveCounts(liveUpdates);
  }

  // Step 4: 提取脚本 + 分析（并行执行）
  const CONCURRENCY = parseInt(process.env.WORKFLOW_CONCURRENCY || '3', 10);
  log(`🔹 Step 4: 提取视频脚本并分析（并行，并发 ${CONCURRENCY}）...\n`);

  // 共享状态：一旦检测到余额不足，后续未开始的任务直接跳过
  const state = { quotaExhausted: false };

  // 中断容错：成功数逐条落盘（LIVE_SUCCESS 惰性初始化自 live_counts，兼容 --resume 续跑）
  const LIVE_SUCCESS = {};
  const recordLiveSuccess = (keyword) => {
    if (LIVE_SUCCESS[keyword] === undefined) {
      const cur = loadKeywordStats().live_counts || {};
      LIVE_SUCCESS[keyword] = (cur[keyword] && cur[keyword].success) || 0;
    }
    LIVE_SUCCESS[keyword] += 1;
    flushLiveCounts({ [keyword]: { success: LIVE_SUCCESS[keyword], last_run: new Date().toISOString() } });
  };

  // 为每个候选构建处理函数（返回结构化结果，不抛异常）
  const taskFns = candidates.map((candidate, i) => {
    const runTask = async () => {
      // 余额已耗尽，跳过
      if (state.quotaExhausted) {
        log(`   [${i + 1}/${candidates.length}] ⏭️  跳过 ${candidate.aweme_id}（API 余额不足，未开始）`);
        return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'quota_exhausted' };
      }

      log(`   [${i + 1}/${candidates.length}] 处理: ${candidate.aweme_id} — ${candidate.desc.substring(0, 50)}`);

      try {
        // 实时刷新视频直链（旧链接可能已过期），失败则回退到候选里存的链接
        let downloadUrl = candidate.download_url;
        try {
          downloadUrl = await refreshPlayUrl(candidate.aweme_id);
        } catch (e) {
          if (!downloadUrl) throw new Error(`刷新直链失败且无备用链接: ${e.message}`);
          log(`   [${candidate.aweme_id}] ⚠️ 刷新直链失败，使用存的链接重试: ${e.message.substring(0, 100)}`);
        }

        // 提取脚本 + 视频表现特征
        const { script, meta } = await extractVideoScript(downloadUrl);
        log(`   [${candidate.aweme_id}] 脚本长度: ${script.length} 字`);

        // 检查全程未开口说话
        if (isNoSpeechScript(script)) {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 全程未开口说话`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'no_speech' };
        }

        // 检查禁止内容
        if (containsForbiddenContent(script)) {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 包含禁止内容`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'forbidden_content' };
        }

        // 分析创意（传入视频表现特征）
        const analysis = await analyzeCreative(candidate.desc, script, meta);

        // 检查内容相关性
        if (analysis.内容相关性 && analysis.内容相关性 !== '强相关') {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 内容${analysis.内容相关性}，与借钱/资金周转主题关联度不足`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'low_relevance', relevance: analysis.内容相关性 };
        }

        // 检查时效性：依赖特定时间窗口的过气内容（平台功能/阶段性热点/已结束活动）不入库；
        // 长青话题（人情世故/普遍财务困境）不受时间限制，老素材反而沉淀好
        if (analysis.时效性 === '时效话题-已过气') {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 时效话题已过气（如平台功能红利期/阶段性热点已退）`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'stale_topic', timeliness: analysis.时效性 };
        }

        log(`   [${candidate.aweme_id}] ✅ 分析完成`);

        const result = {
          aweme_id: candidate.aweme_id,
          desc: candidate.desc,
          video_url: `https://www.douyin.com/video/${candidate.aweme_id}`,
          script,
          analysis,
          keyword: candidate.keyword
        };

        // 高赞评论创意策略分析（独立第二条线）：点赞 > 阈值时并行触发
        // 评论分析不阻塞主流程入库——先入库脚本来源的结果，评论洞察结果单独收集后统一沉淀到策略表
        const diggCount = candidate.digg_count || candidate.aweme?.statistics?.digg_count || 0;
        let commentInsight = null;
        if (diggCount > COMMENT_ANALYSIS_DIGG_THRESHOLD) {
          log(`   [${candidate.aweme_id}] 💬 点赞 ${diggCount} > ${COMMENT_ANALYSIS_DIGG_THRESHOLD}，触发高赞评论创意策略分析`);
          try {
            const comments = await fetchVideoComments(candidate.aweme_id, 30);
            if (comments.length >= 5) {
              commentInsight = await analyzeCommentsInsight(candidate.desc, comments, meta);
              if (commentInsight) {
                // 给评论洞察的素材id加来源标记，便于策略表区分
                commentInsight._source = 'comment_insight';
                commentInsight._source_aweme_id = candidate.aweme_id;
                commentInsight._source_desc = candidate.desc;
                log(`   [${candidate.aweme_id}] 💬 评论洞察分析完成（方向：${commentInsight.内容策略?.['内容方向一']}/${commentInsight.内容策略?.['内容方向二']}）`);
              }
            } else {
              log(`   [${candidate.aweme_id}] ⚠️ 高赞评论不足5条（${comments.length}），跳过评论洞察分析`);
            }
          } catch (error) {
            log(`   [${candidate.aweme_id}] ⚠️ 评论洞察分析失败（不影响主流程）: ${error.message.substring(0, 150)}`);
          }
        }
        result.commentInsight = commentInsight;

        // 即时写入飞书（不等全部完成，防中途中断丢失数据）
        let bitableWritten = false;
        if (!skipBitable) {
          const single = writeToBitable([result]);
          bitableWritten = single.success > 0;
        }

        markProcessed(candidate.aweme_id);
        return { status: 'success', ...result, bitableWritten };
      } catch (error) {
        // 余额不足 — 设置标志，剩余任务将跳过
        if (isQuotaExhaustedError(error)) {
          state.quotaExhausted = true;
          log(`   [${candidate.aweme_id}] 💰 API 余额不足！剩余任务将跳过`);
          return { status: 'quota_exhausted', aweme_id: candidate.aweme_id, desc: candidate.desc, error: error.message };
        }
        log(`   [${candidate.aweme_id}] ❌ 处理失败: ${error.message.substring(0, 200)}`);
        markProcessed(candidate.aweme_id);
        return { status: 'failed', aweme_id: candidate.aweme_id, desc: candidate.desc, error: error.message };
      }
    };
    // 中断容错包装：每条任务出结果即更新 live_counts
    return async () => {
      const r = await runTask();
      if (r && r.status === 'success' && candidate.keyword) recordLiveSuccess(candidate.keyword);
      return r;
    };
  });

  // 并行执行所有任务
  const taskResults = await runWithConcurrency(taskFns, CONCURRENCY);

  // 分类汇总
  const results = [];
  const failedItems = [];

  for (const r of taskResults) {
    if (r.status === 'success') {
      results.push({
        aweme_id: r.aweme_id,
        desc: r.desc,
        video_url: r.video_url,
        script: r.script,
        analysis: r.analysis,
        keyword: r.keyword,
        bitableWritten: r.bitableWritten
      });
    } else if (r.status === 'skipped') {
      skipped.push({ aweme_id: r.aweme_id, reason: r.reason });
    } else if (r.status === 'quota_exhausted') {
      skipped.push({ aweme_id: r.aweme_id, reason: 'quota_exhausted' });
    } else if (r.status === 'failed') {
      failedItems.push({ aweme_id: r.aweme_id, error: r.error });
    }
  }

  // Step 5: 飞书写入已在每条分析完成后即时执行，此处仅统计
  let bitableResult = { success: 0, failed: 0, errors: [] };
  if (skipBitable) {
    log('🔹 Step 5: 跳过飞书写入（--skip-bitable）');
  } else {
    bitableResult.success = results.filter(r => r.bitableWritten).length;
    bitableResult.failed = results.filter(r => !r.bitableWritten).length;
    log(`🔹 Step 5: 飞书写入统计 — 成功 ${bitableResult.success} 条，失败 ${bitableResult.failed} 条`);
  }

  // 更新关键词命中率统计（余额不足时中途终止，统计会失真，不更新）
  if (!state.quotaExhausted && keywordDirs.length > 0) {
    const counts = {};
    for (const { keyword } of keywordDirs) {
      counts[keyword] = { searched: 0, filtered: 0, success: 0 };
    }
    for (const { keyword } of allAweme) {
      if (counts[keyword]) counts[keyword].searched += 1;
    }
    for (const c of candidates) {
      if (counts[c.keyword]) counts[c.keyword].filtered += 1;
    }
    for (const r of results) {
      if (counts[r.keyword]) counts[r.keyword].success += 1;
    }
    updateKeywordStats(keywordDirs, counts);
  }

  // Step 6: 内容策略沉淀（按内容方向一/二聚合去重，写入策略表）
  log('🔹 Step 6: 内容策略沉淀（度小满-网络创意策略表）...');
  let strategyResult = { created: 0, updated: 0, appended: 0, mergedOnly: 0, items: 0, skipped: 0 };
  try {
    strategyResult = await syncStrategyTable(results);
  } catch (error) {
    log(`   ⚠️ 内容策略同步异常（不影响主流程）: ${error.message.substring(0, 200)}`);
  }

  // 策略库生长统计（反内循环预警）：零新策略连续 N 轮 → 下轮自动提升探索配额
  let growthAfter = null;
  try {
    growthAfter = updateStrategyGrowth(strategyResult, strategyResult.items || 0);
  } catch (error) {
    log(`   ⚠️ 策略库生长统计更新失败（不影响主流程）: ${error.message.substring(0, 150)}`);
  }

  // 每次运行结束都发送飞书通知
  sendFeishuNotification(
    {
      total_success: results.length,
      total_skipped: skipped.length,
      total_failed: failedItems.length,
      bitable_success: bitableResult.success,
      strategy_created: strategyResult.created,
      strategy_updated: strategyResult.updated,
      strategy_appended: strategyResult.appended,
      strategy_merged_only: strategyResult.mergedOnly,
      drought_streak: growthAfter ? growthAfter.droughtStreak : 0,
      keywords: keywords
    },
    state.quotaExhausted
  );

  // 全部处理完成，清理 checkpoint
  if (!state.quotaExhausted) {
    clearCheckpoint();
  }

  // 输出结果
  log('============================================');
  log(`✅ 工作流完成！`);
  log(`   成功: ${results.length} 条`);
  log(`   被放弃: ${skipped.length} 条`);
  log(`   执行失败: ${failedItems.length} 条`);
  if (bitableResult.success > 0) {
    log(`   飞书写入: ${bitableResult.success} 条`);
  }
  if (bitableResult.failed > 0) {
    log(`   飞书写入失败: ${bitableResult.failed} 条`);
  }
  if (state.quotaExhausted) {
    log(`   ⚠️  API 余额不足，工作流已提前终止！`);
  }
  log('============================================\n');

  const output = {
    keywords: keywords,
    results: results,
    skipped: skipped,
    failed: failedItems,
    quota_exhausted: state.quotaExhausted,
    bitable_write: bitableResult,
    summary: {
      total_searched: allAweme.length,
      total_filtered: candidates.length,
      total_success: results.length,
      total_skipped: skipped.length,
      total_failed: failedItems.length,
      bitable_success: bitableResult.success,
      bitable_failed: bitableResult.failed
    }
  };

  // JSON 输出到 stdout
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  log(`\n❌ 工作流失败: ${error.message}`);
  process.exit(1);
});
