#!/usr/bin/env node

/**
 * 度小满热点手动精筛脚本（hotspot_refine.js）
 *
 * 对已入飞书热点素材表的热点做"优秀度检验"并回填素材评分：
 *   1. 读取素材表第 N 行的热点标题
 *   2. 抖音搜索该热点（仅视频，按点赞排序）
 *   3. 取前 20 条，统计其中"近 7 天发布 且 点赞 > 1 万"的数量
 *   4. 定级：≥10 优秀 / 5-9 良好 / 3-5 一般 / <3 劣质
 *   5. 回填该行的"素材评分"字段
 *
 * 使用方法：
 *   node hotspot_refine.js --row 23            # 精筛第 23 行
 *   node hotspot_refine.js --record-id recXXX  # 直接指定记录 ID
 *   node hotspot_refine.js --row 23 --dry-run  # 只检验不入表
 *
 * 参数：
 *   --row N          精筛素材表第 N 行（1-based，默认视图顺序）
 *   --record-id ID   直接指定记录 ID（优先于 --row）
 *   --dry-run        只检验并打印结果，不回填评分
 *   --debug          输出抖音搜索原始结构片段
 *
 * 环境变量：
 *   TIKHUB_TOKEN / TIKHUB_BASE_URL     抖音搜索
 *   HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID  飞书热点素材表读写
 *
 * 输出：JSON 到 stdout，进度日志到 stderr
 */

const { execFileSync } = require('child_process');

// ============ 配置 ============
const TIKHUB_TOKEN = process.env.TIKHUB_TOKEN;
const TIKHUB_BASE_URL = (process.env.TIKHUB_BASE_URL || 'https://api.tikhub.io').replace(/\/+$/, '');
const HOTSPOT_BASE_TOKEN = process.env.HOTSPOT_BASE_TOKEN;
const HOTSPOT_TABLE_ID = process.env.HOTSPOT_TABLE_ID;
const LARK_CLI = 'lark-cli';

// 检验阈值（度小满需求文档第三部分）
const GRADE_THRESHOLDS = {
  EXCELLENT: 10,  // >=10 优秀
  GOOD: 5,        // 5-9 良好
  NORMAL: 3       // 3-5 一般（含5）；<3 劣质
};
const DAYS_RECENT = 7;     // 近7天
const MIN_DIGG = 10000;    // 点赞>1万
const TOP_N = 20;          // 看前20条
// ==============================

function log(msg) {
  process.stderr.write(msg + '\n');
}

function runLarkCli(args) {
  return execFileSync(LARK_CLI, args, {
    encoding: 'utf-8',
    timeout: 60000,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    maxBuffer: 20 * 1024 * 1024
  });
}

// ============ 读取字段 ID→名称映射 ============
function getFieldMap() {
  const out = runLarkCli([
    'base', '+field-list',
    '--base-token', HOTSPOT_BASE_TOKEN,
    '--table-id', HOTSPOT_TABLE_ID,
    '--as', 'user',
    '--format', 'json'
  ]);
  const d = JSON.parse(out);
  const fields = d?.data?.fields || [];
  const map = {};
  for (const f of fields) map[f.id] = f.name;
  return map;
}

// ============ 读取素材表记录（record-list 返回矩阵格式，需重组为对象） ============
function listRecords() {
  const fieldMap = getFieldMap(); // field_id -> name
  const all = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const args = [
      'base', '+record-list',
      '--base-token', HOTSPOT_BASE_TOKEN,
      '--table-id', HOTSPOT_TABLE_ID,
      '--page-size', '200',
      '--as', 'user',
      '--format', 'json'
    ];
    if (token) args.push('--page-token', token);
    const out = runLarkCli(args);
    const d = JSON.parse(out);
    const dataObj = d?.data || {};
    const fieldIds = dataObj.field_id_list || [];
    const recordIds = dataObj.record_id_list || [];
    const rows = dataObj.data || []; // 行值数组
    for (let i = 0; i < rows.length; i++) {
      const vals = rows[i] || [];
      const fields = {};
      for (let j = 0; j < fieldIds.length; j++) {
        const fname = fieldMap[fieldIds[j]] || fieldIds[j];
        fields[fname] = vals[j];
      }
      all.push({ record_id: recordIds[i] || '', fields });
    }
    token = dataObj.page_token || dataObj.next_page_token || '';
    if (!dataObj.has_more || !token) break;
  }
  return all;
}

function getRecordByRow(rowNum) {
  const records = listRecords();
  if (rowNum < 1 || rowNum > records.length) {
    throw new Error(`行号超出范围：第 ${rowNum} 行，表中共 ${records.length} 条`);
  }
  return records[rowNum - 1];
}

// 从记录里提取热点标题（字段名"热点标题"，可能是 [{text:..}] 或字符串）
function extractTitle(record) {
  const f = record.fields?.['热点标题'];
  if (!f) return '';
  if (Array.isArray(f)) return f.map(x => x.text || x).join('');
  if (typeof f === 'string') return f;
  return String(f);
}

// ============ 抖音搜索（按点赞排序，取前 20 条） ============
async function searchDouyin(keyword, debug) {
  const all = [];
  let cursor = 0;
  for (let page = 0; page < 3 && all.length < TOP_N; page++) {
    const body = {
      keyword,
      cursor,
      sort_type: '1',        // 按点赞排序
      publish_time: '0',
      filter_duration: '0',
      content_type: '0',
      search_id: '',
      backtrace: ''
    };
    const resp = await fetch(`${TIKHUB_BASE_URL}/api/v1/douyin/search/fetch_video_search_v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TIKHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`抖音搜索失败 (HTTP ${resp.status}): ${t.substring(0, 200)}`);
    }
    const result = await resp.json();
    if (debug && page === 0) log(`   首页结构: ${JSON.stringify(result).substring(0, 300)}`);

    // 兼容多种 TikHub 返回结构
    let items = [];
    const d = result.data;
    if (Array.isArray(d)) items = d;
    else if (d && Array.isArray(d.business_data)) items = d.business_data.map(b => b.data).filter(Boolean);
    else if (d && Array.isArray(d.data)) items = d.data;
    else if (d && d.aweme_info) items = [d];

    const awemes = items.map(i => i.aweme_info || i).filter(Boolean);
    all.push(...awemes);
    cursor = d?.cursor || d?.has_more_cursor || 0;
    if (!d?.has_more) break;
  }
  return all.slice(0, TOP_N);
}

// ============ 统计近7天+点赞>1万的数量 ============
function countQualified(videos) {
  const since = Date.now() - DAYS_RECENT * 86400000;
  let count = 0;
  const detail = [];
  for (const v of videos) {
    const ct = Number(v.create_time) || 0;
    const digg = Number(v.statistics?.digg_count || v.digg_count || 0);
    const recent = ct * 1000 >= since;
    const hot = digg > MIN_DIGG;
    if (recent && hot) count++;
    detail.push({
      title: (v.desc || v.aweme_id || '').substring(0, 30),
      create_time: ct ? new Date(ct * 1000).toISOString().substring(0, 10) : '',
      digg_count: digg,
      qualified: recent && hot
    });
  }
  return { count, detail };
}

// ============ 定级 ============
function grade(count) {
  if (count >= GRADE_THRESHOLDS.EXCELLENT) return '优秀';
  if (count >= GRADE_THRESHOLDS.GOOD) return '良好';
  if (count >= GRADE_THRESHOLDS.NORMAL) return '一般';
  return '劣质';
}

// ============ 回填素材评分 ============
function updateScore(recordId, score) {
  // batch-update 格式：record_id_list + patch（patch 为字段名→值的对象）
  const payload = JSON.stringify({
    record_id_list: [recordId],
    patch: { '素材评分': score }
  });
  try {
    const out = runLarkCli([
      'base', '+record-batch-update',
      '--base-token', HOTSPOT_BASE_TOKEN,
      '--table-id', HOTSPOT_TABLE_ID,
      '--json', payload,
      '--as', 'user',
      '--format', 'json'
    ]);
    log(`   ✅ 已回填素材评分：${score}`);
    return { success: true };
  } catch (e) {
    log(`   ❌ 回填失败: ${e.message.substring(0, 400)}`);
    return { success: false, error: e.message };
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { row: null, recordId: null, dryRun: false, debug: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--row' && args[i + 1]) opts.row = Number(args[++i]);
    else if (args[i] === '--record-id' && args[i + 1]) opts.recordId = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--debug') opts.debug = true;
  }

  if (!opts.row && !opts.recordId) {
    log('❌ 请指定 --row N 或 --record-id ID');
    process.exit(1);
  }
  if (!TIKHUB_TOKEN) {
    log('❌ 缺少 TIKHUB_TOKEN，无法做抖音搜索检验');
    process.exit(1);
  }
  if (!HOTSPOT_BASE_TOKEN || !HOTSPOT_TABLE_ID) {
    log('❌ 缺少 HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID，无法读取素材表');
    process.exit(1);
  }

  log('============================================');
  log('🔬 度小满热点精筛（优秀度检验）');
  log('============================================\n');

  // Step 1: 读取热点
  let record;
  if (opts.recordId) {
    const all = listRecords();
    record = all.find(r => r.record_id === opts.recordId);
    if (!record) throw new Error(`未找到记录 ID: ${opts.recordId}`);
  } else {
    log(`🔹 读取素材表第 ${opts.row} 行...`);
    record = getRecordByRow(opts.row);
  }
  const title = extractTitle(record);
  if (!title) throw new Error('该记录无"热点标题"字段值');
  log(`   热点：${title}`);
  log(`   record_id: ${record.record_id}\n`);

  // Step 2: 抖音搜索（按点赞排序，取前20）
  log(`🔹 抖音搜索 "${title}"（按点赞排序，取前 ${TOP_N} 条）...`);
  const videos = await searchDouyin(title, opts.debug);
  log(`   搜到 ${videos.length} 条\n`);

  if (videos.length === 0) {
    log('⚠️ 未搜到视频，评为"劣质"');
    const result = { title, total: 0, qualified: 0, grade: '劣质', videos: [] };
    if (!opts.dryRun) updateScore(record.record_id, '劣质');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Step 3: 统计近7天+点赞>1万
  const { count, detail } = countQualified(videos);
  const g = grade(count);
  log(`📊 前 ${videos.length} 条中，近 ${DAYS_RECENT} 天且点赞 > ${MIN_DIGG.toLocaleString()} 的：${count} 条`);
  log(`   定级：${g}\n`);

  // Step 4: 回填评分
  let updateResult = { success: false, skipped: true };
  if (!opts.dryRun) {
    updateResult = updateScore(record.record_id, g);
  } else {
    log('ℹ️ --dry-run 模式，跳过回填');
  }

  // 输出
  console.log(JSON.stringify({
    row: opts.row,
    record_id: record.record_id,
    title,
    total_searched: videos.length,
    qualified_count: count,
    grade: g,
    threshold: `近${DAYS_RECENT}天 + 点赞>${MIN_DIGG} 在前${TOP_N}条中的数量`,
    videos: detail,
    bitable_update: updateResult,
    dry_run: opts.dryRun
  }, null, 2));
}

main().catch(e => {
  log(`\n❌ 精筛失败: ${e.message}`);
  process.exit(1);
});
