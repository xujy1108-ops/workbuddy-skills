#!/usr/bin/env node

/**
 * 度小满热点筛选 + 入表脚本（hotspot_filter.js）
 *
 * 流程：采集热点（复用 hotspot_collect.js）→ AI 判断是否符合度小满时事政策热点
 *       → 对符合的热点生成植入策略 → 按素材表 7 字段写入飞书多维表格
 *
 * 判断标准（度小满需求文档第二部分）：
 *   1. 和金融经济、民生经济相关；排除娱乐/网络游戏&赛事/汽车/美妆/时尚等非金融经济领域
 *   2. 和普罗大众相关且和钱直接/间接相关（养老/公积金/社保/国补/投资新政策等）；
 *      排除美国伊朗打仗、日韩摩擦等与普通人无关的宏大叙事
 *
 * 使用方法：
 *   node hotspot_filter.js [--input <collect.json>] [--channels ...] [--top 20] [--dry-run] [--debug]
 *
 * 参数：
 *   --input <file>   直接读取 hotspot_collect.js 已生成的 JSON 结果（跳过采集）
 *   --channels       采集渠道（仅未指定 --input 时生效），默认 douyin,xhs,kuaishou,weibo,bilibili,gov,creator
 *   --top N          每渠道取前 N 条送 AI 判断（默认 20）
 *   --dry-run        只判断不入表（用于观察 AI 判断结果）
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

// ============ AI 判断 prompt（度小满时事政策热点 + 植入策略） ============
const JUDGE_SYSTEM = '你是度小满金融信息流的资深选题编辑，只输出 JSON，不输出任何额外说明文字。';

const JUDGE_PROMPT = `# 角色
你是度小满的金融热点选题编辑，负责判断互联网热点是否适合做"度小满"品牌内容植入，并为符合的热点设计植入策略。

# 判断标准（必须同时满足两条硬条件）
1. 领域：必须是金融经济、民生经济相关。排除娱乐、网络游戏及赛事、汽车、美妆、时尚等非金融经济领域。
2. 受众与相关性：必须和普罗大众相关，且和"钱"直接或间接相关——如养老、公积金、社保、国补、投资市场新政策、借贷、利率、税收、消费补贴等与大众息息相关的经济内容。
   - 排除宏大叙事：美国伊朗打仗、日本韩国摩擦等与普通人钱袋子无关的国际政治内容不要。

# 禁止方向（第五点，命中任一即 fit=false，不可植入）
1. 涉及具体个人（明星/网红/企业家本人）或具体公司品牌的热点不要——蹭此类热点会产生舆情。
2. 涉及看病治病、小孩上学、结婚彩礼的相关热点或政策不要——借贷产品不允许给这些需求提供借贷。

# 推理路径示例（符合时应这样思考植入策略）
示例一：
- 热点：国家推行数字人民币升级2.0版本
- 判断：金融经济相关（钱币使用方式）+ 普罗大众相关（每个人都要用）+ 和钱直接相关 ✓ 符合
- 植入策略：数字人民币存放在这里的钱会给利息，可用"国家发钱了"的噱头吸引关注（无政策风险，国家确给利息）；让大家关注利息进账的同时，也别忽略怎么借钱才更重要，不知道怎么选就选度小满——相比数字人民币利息，借钱踩坑影响更大。

示例二：
- 热点：国家8月1号正式推行个人借贷出示综合融资成本明示表
- 判断：借贷新规，金融经济相关 + 普罗大众都可能借贷 + 和钱直接相关 ✓ 符合
- 植入策略：借贷新规关乎每个人经济生活，以前借钱被砍头息、隐形收费坑，新规让全部成本摊在阳光下；度小满响应新规，一直做合规借贷业务，以后可安全使用度小满解决周转问题。

示例三：
- 热点：国家1月29号正式推行急难事项小额快救政策
- 判断：小额快救属民生经济 + 救助金和钱相关 + 普罗大众相关 ✓ 符合
- 植入策略：国家给救助金但有上限（不高于当地一个月低保标准），若有更大困难需要大额支出，可选度小满作为临时周转。

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
  "strategy": "若 fit=true，按上面示例风格写出植入策略思考（含噱头/角度 + 度小满衔接逻辑）；若 fit=false，填空字符串"
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

// ============ 生成热点概述（含溯源信息） ============
function makeOverview(item, judge) {
  const parts = [];
  if (judge.strategy) parts.push(judge.strategy);
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

// ============ 写入飞书热点素材表（7 字段） ============
function writeToBitable(records) {
  if (!HOTSPOT_BASE_TOKEN || !HOTSPOT_TABLE_ID) {
    log('⚠️ 未配置 HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID，跳过飞书写入');
    return { success: 0, skipped: true };
  }
  if (records.length === 0) {
    log('🔹 无符合的热点可写入');
    return { success: 0 };
  }

  const today = new Date().toISOString().substring(0, 10); // yyyy-MM-dd，飞书 datetime 字段接受
  const createRecords = records.map(r => ({
    '热点ID': r.hot_id,
    '热点标题': r.topic,
    '热点概述': r.overview,
    '热点类型': '时事政策',          // select 字段，符合的统一填
    '植入方向': r.strategy,
    '入库时间': today,                // datetime，写入当天
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
    log(`   ✅ 写入 ${count} 条`);
    return { success: count };
  } catch (error) {
    log(`   ❌ 写入失败: ${error.message.substring(0, 400)}`);
    return { success: 0, failed: error.message };
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
    debug: false
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--channels' && args[i + 1]) opts.channels = args[++i];
    else if (args[i] === '--top' && args[i + 1]) opts.top = Number(args[++i]);
    else if (args[i] === '--dry-run') opts.dryRun = true;
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

  // Step 3: 生成热点ID + 概述，准备入表
  const toWrite = fitOnes.map(x => ({
    hot_id: makeHotId(x.item),
    topic: x.item.topic,
    overview: makeOverview(x.item, x.judge),
    strategy: x.judge.strategy,
    platform: x.item.platform,
    source: x.item.source,
    url: x.item.url,
    heat: x.item.heat
  }));

  // Step 4: 写飞书（除非 dry-run）
  let writeResult = { success: 0, skipped: true };
  if (!opts.dryRun) {
    writeResult = writeToBitable(toWrite);
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
    fit_hotspots: toWrite.map(x => ({
      hot_id: x.hot_id, topic: x.topic, platform: x.platform,
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
