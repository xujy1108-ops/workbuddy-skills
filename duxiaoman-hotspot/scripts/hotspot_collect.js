#!/usr/bin/env node

/**
 * 全网热点聚合采集脚本
 *
 * 多路采集，统一模型，飞书闭环：
 *   1. 内容平台热榜：抖音实时/飙升热点 + 小红书热门 + 快手热榜 + 微博热搜 + B站热门（TikHub API）
 *   2. 政策热点：中国政府网 gov.cn 政策解读（官方 JSON 接口，零成本）
 *   3. 头部达人导向：抖音头部达人近 N 天视频，按点赞数排序（TikHub API）
 *
 * 使用方法：
 *   node hotspot_collect.js [--channels douyin,xhs,kuaishou,weibo,bilibili,gov,creator] [--top 10] [--days 3] [--creators ./hotspot_creators.json] [--write-bitable] [--notify] [--debug]
 *
 * 参数：
 *   --channels      采集渠道，逗号分隔：douyin,xhs,kuaishou,weibo,bilibili,gov,creator（默认全开）
 *   --top N         每个渠道取前 N 条（默认 10）
 *   --days N        达人视频时间窗口（天，默认 3）
 *   --creators      达人清单 JSON 文件路径（默认 ./hotspot_creators.json）
 *   --write-bitable 写入飞书多维表格（需环境变量 HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID）
 *   --notify        发送飞书 IM 通知（Top 5 热点摘要）
 *   --debug         输出原始响应片段，便于排查字段结构
 *
 * 环境变量：
 *   TIKHUB_TOKEN        - TikHub API 令牌
 *   TIKHUB_BASE_URL     - TikHub API 地址（大陆用户建议 https://api.tikhub.dev，默认 https://api.tikhub.io）
 *   HOTSPOT_BASE_TOKEN  - 热点表多维表格 Base token（--write-bitable 时必填）
 *   HOTSPOT_TABLE_ID    - 热点表 table id（--write-bitable 时必填）
 *
 * 输出：JSON 到 stdout，进度日志到 stderr
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ============ 配置 ============
const TIKHUB_TOKEN = process.env.TIKHUB_TOKEN;
const TIKHUB_BASE_URL = (process.env.TIKHUB_BASE_URL || 'https://api.tikhub.io').replace(/\/+$/, '');
const HOTSPOT_BASE_TOKEN = process.env.HOTSPOT_BASE_TOKEN;
const HOTSPOT_TABLE_ID = process.env.HOTSPOT_TABLE_ID;
const LARK_CLI = 'lark-cli';

// 政策热点源（gov.cn 官方 JSON 接口；国务院文件 + 要闻已按需求移除）
const GOV_SOURCES = [
  {
    key: 'gov_jiedu',
    label: '政策解读',
    url: 'https://www.gov.cn/zhengce/jiedu/ZCJD_QZ.json'
  }
];
// ==============================

function log(msg) {
  process.stderr.write(msg + '\n');
}

// ============ 基础请求 ============

// TikHub GET 请求（统一封装）
async function tikhubGet(apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${TIKHUB_BASE_URL}${apiPath}${qs ? '?' + qs : ''}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${TIKHUB_TOKEN}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`TikHub 请求失败 (HTTP ${response.status}): ${url}`);
  }
  return response.json();
}

// 通用 GET 请求（gov.cn 等无需认证源）
async function plainGet(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`GET 失败 (HTTP ${response.status}): ${url}`);
  }
  return response.json();
}

// ============ 一、抖音热点采集 ============
async function collectDouyin(debug) {
  log('🔹 [抖音] 抓取实时热点 + 飙升榜...');
  const raw = await tikhubGet('/api/v1/douyin/index/fetch_current_hot_topic');
  if (debug) log(`   raw: ${JSON.stringify(raw).substring(0, 400)}`);

  // 结构：data.current[]（实时热点）+ data.rocketing[]（飙升热点）
  // 字段：rank / topic_name / topic_index（热度指数）/ rank_flag（变化）/ category
  const d = raw.data || {};
  const current = Array.isArray(d.current) ? d.current : [];
  const rocketing = Array.isArray(d.rocketing) ? d.rocketing : [];

  if (current.length + rocketing.length === 0) {
    log('   ⚠️ 抖音热点无数据，跳过');
    return [];
  }
  log(`   实时热点 ${current.length} 条，飙升热点 ${rocketing.length} 条`);

  const mapItem = (it, i, label) => ({
    platform: 'douyin',
    source: label,
    topic: it.topic_name || '',
    rank: Number(it.rank) || i + 1,
    heat: Number(String(it.topic_index || '').replace(/[^0-9]/g, '')) || 0,
    hot_word_type: it.category || '',
    rank_flag: it.rank_flag || '',  // 1=上升 -1=下降 0=持平
    url: `https://www.douyin.com/search/${encodeURIComponent(it.topic_name || '')}`,
    captured_at: new Date().toISOString()
  });

  return [
    ...current.map((it, i) => mapItem(it, i, '抖音实时热点')),
    ...rocketing.map((it, i) => mapItem(it, i, '抖音飙升热点'))
  ].filter(x => x.topic);
}

// ============ 二、小红书热点采集 ============
async function collectXhs(debug) {
  log('🔹 [小红书] 抓取热门灵感榜...');
  // fetch_trending 接口当前 404，改用创作者热门灵感流（App V2）
  // 结构：data.data.items[]，字段 title / score（数值热度）/ score_text（"2444万人在看"）/ type
  const raw = await tikhubGet('/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed');
  if (debug) log(`   raw: ${JSON.stringify(raw).substring(0, 400)}`);

  let items = [];
  const d = raw.data;
  if (d && d.data && Array.isArray(d.data.items)) items = d.data.items;
  else if (d && Array.isArray(d.items)) items = d.items;
  else if (Array.isArray(d)) items = d;

  if (items.length === 0) {
    log('   ⚠️ 小红书热点无数据，跳过');
    return [];
  }
  log(`   热门灵感 ${items.length} 条`);

  return items.map((it, i) => ({
    platform: 'xiaohongshu',
    source: '小红书热门',
    topic: it.title || '',
    rank: i + 1,
    heat: Number(it.score) || 0,
    heat_text: it.score_text || '',   // "2444万人在看"
    hot_type: it.type || '',           // Hot / New 等
    url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(it.title || '')}`,
    captured_at: new Date().toISOString()
  })).filter(x => x.topic);
}

// ============ 三、快手热点采集 ============
async function collectKuaishou(debug) {
  log('🔹 [快手] 抓取热榜...');
  const raw = await tikhubGet('/api/v1/kuaishou/web/fetch_kuaishou_hot_list_v2');
  if (debug) log(`   raw: ${JSON.stringify(raw).substring(0, 400)}`);

  // 结构：data.topHots[]（置顶）+ data.hots[]（热榜 50 条）
  // 字段：keyword / hotValue / hotWordType
  const d = raw.data || {};
  const topHots = Array.isArray(d.topHots) ? d.topHots : [];
  const hots = Array.isArray(d.hots) ? d.hots : [];

  if (topHots.length + hots.length === 0) {
    log('   ⚠️ 快手热榜无数据，跳过');
    return [];
  }
  log(`   热榜 ${hots.length} 条（含置顶 ${topHots.length} 条）`);

  const mapItem = (it, i, label) => ({
    platform: 'kuaishou',
    source: label,
    topic: it.keyword || '',
    rank: i + 1,
    heat: Number(it.hotValue) || 0,
    url: `https://www.kuaishou.com/search/video?searchWord=${encodeURIComponent(it.keyword || '')}`,
    captured_at: new Date().toISOString()
  });

  return [
    ...topHots.map((it, i) => mapItem(it, i, '快手热榜置顶')),
    ...hots.map((it, i) => mapItem(it, i, '快手热榜'))
  ].filter(x => x.topic);
}

// ============ 四、微博热搜采集 ============
async function collectWeibo(debug) {
  log('🔹 [微博] 抓取热搜榜...');
  const raw = await tikhubGet('/api/v1/weibo/app/fetch_hot_search');
  if (debug) log(`   raw: ${JSON.stringify(raw).substring(0, 400)}`);

  // TikHub 微博热搜返回的是页面级嵌套结构：
  // data.items[].items[].data.desc（热搜词）+ data.desc_extr（热度值）
  // 数组顺序即排名；有些 item 是分隔说明（无 items 数组）
  let entries = [];
  const d = raw.data;
  if (d && Array.isArray(d.items)) {
    for (const block of d.items) {
      if (Array.isArray(block.items)) {
        for (const inner of block.items) {
          if (inner && inner.data) entries.push(inner.data);
        }
      }
    }
  } else if (Array.isArray(d)) {
    entries = d;
  }

  if (entries.length === 0) {
    log('   ⚠️ 微博热搜无数据，跳过');
    return [];
  }

  return entries.map((it, i) => {
    // scheme 是 sinaweibo:// 协议，不可直接点击 → 转成网页版搜索链接
    const rawScheme = it.scheme || '';
    const scheme = rawScheme.startsWith('sinaweibo://')
      ? `https://s.weibo.com/weibo?q=${encodeURIComponent(it.desc || '')}`
      : rawScheme;
    return {
      platform: 'weibo',
      source: '微博热搜',
      topic: it.desc || it.word || it.keyword || it.title || '',
      rank: i + 1,
      // desc_extr 形如 "1095823" 或 "剧集 502705"，提取数字
      heat: Number(String(it.desc_extr || '').replace(/[^0-9]/g, '')) || 0,
      label: it.label || '',
      url: scheme || `https://s.weibo.com/weibo?q=${encodeURIComponent(it.desc || '')}`,
      captured_at: new Date().toISOString()
    };
  }).filter(x => x.topic);
}

// ============ 五、B站热门采集 ============
async function collectBilibili(debug) {
  log('🔹 [B站] 抓取综合热门...');
  const raw = await tikhubGet('/api/v1/bilibili/web/fetch_com_popular');
  if (debug) log(`   raw: ${JSON.stringify(raw).substring(0, 400)}`);

  // 结构：data.data.list[]
  let items = [];
  const d = raw.data;
  if (d && d.data && Array.isArray(d.data.list)) items = d.data.list;
  else if (Array.isArray(d)) items = d;

  if (items.length === 0) {
    log('   ⚠️ B站热门无数据，跳过');
    return [];
  }

  return items.map((it, i) => {
    const stat = it.stat || {};
    const owner = it.owner || {};
    return {
      platform: 'bilibili',
      source: 'B站热门',
      topic: it.title || '',
      rank: i + 1,
      heat: Number(stat.view || it.view || 0),
      digg_count: Number(stat.like || it.like || 0),
      danmaku: Number(stat.danmaku || it.danmaku || 0),
      creator: owner.name || '',
      bvid: it.bvid || '',
      url: it.short_link_v2 || `https://www.bilibili.com/video/${it.bvid || ''}`,
      captured_at: new Date().toISOString()
    };
  }).filter(x => x.topic);
}

// ============ 六、政策热点采集（gov.cn JSON 接口） ============
async function collectGov(debug) {
  const results = [];
  for (const src of GOV_SOURCES) {
    log(`🔹 [政策] 抓取 ${src.label}...`);
    try {
      const data = await plainGet(src.url);
      const arr = Array.isArray(data) ? data : (data.data && Array.isArray(data.data) ? data.data : []);
      if (arr.length === 0) {
        log(`   ⚠️ ${src.label} 无数据`);
        continue;
      }
      log(`   ${src.label} 共 ${arr.length} 条`);
      if (debug) log(`   sample: ${JSON.stringify(arr[0])}`);

      // 日期新鲜度 → 热度分：今天=1.0，每早一天 -0.02，最低 0.2
      const today = new Date();
      for (const it of arr) {
        const pubDate = new Date(it.DOCRELPUBTIME || it.PUBTIME || it.DOC_PUB_TIME || Date.now());
        const daysAgo = Math.max(0, Math.floor((today - pubDate) / 86400000));
        const freshness = Math.max(0.2, 1 - daysAgo * 0.02);
        results.push({
          platform: src.key,
          source: src.label,
          topic: (it.TITLE || '').replace(/^【[^】]*】/, '').trim(),
          rank: 0,
          heat: 0,
          heat_score: freshness,
          url: it.URL || '',
          pub_date: (it.DOCRELPUBTIME || it.PUBTIME || '').substring(0, 10),
          captured_at: new Date().toISOString()
        });
      }
    } catch (e) {
      log(`   ❌ ${src.label} 抓取失败: ${e.message.substring(0, 150)}`);
    }
  }
  // 按日期倒序，取每个源最新
  return results.filter(x => x.topic);
}

// ============ 七、头部达人视频采集 ============
async function collectCreators(creatorsFile, days, debug) {
  const filePath = path.resolve(creatorsFile);
  if (!fs.existsSync(filePath)) {
    log(`ℹ️ 达人清单不存在（${filePath}），跳过达人渠道`);
    return [];
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    log(`❌ 达人清单解析失败: ${e.message.substring(0, 150)}`);
    return [];
  }
  const creators = config.creators || [];
  if (creators.length === 0) {
    log('ℹ️ 达人清单为空，跳过达人渠道');
    return [];
  }

  const since = Date.now() - days * 86400000;
  const results = [];

  for (const c of creators) {
    log(`🔹 [达人] ${c.name || c.url} ...`);
    try {
      // Step 1: 主页链接 → sec_user_id
      let secUserId = c.sec_user_id;
      if (!secUserId && c.url) {
        const parsed = await tikhubGet('/api/v1/douyin/web/get_sec_user_id', { url: c.url });
        secUserId = parsed?.data?.sec_user_id || parsed?.data || (typeof parsed?.data === 'string' ? parsed.data : null);
        if (debug) log(`   sec_user_id: ${secUserId}`);
      }
      if (!secUserId) {
        log(`   ⚠️ 无法解析 ${c.name} 的 sec_user_id，跳过`);
        continue;
      }

      // Step 2: 拉取用户作品列表（翻页直到覆盖时间窗口）
      let cursor = 0;
      let videos = [];
      for (let page = 0; page < 5; page++) {
        const resp = await tikhubGet('/api/v1/douyin/app/v3/fetch_user_post_videos', {
          sec_user_id: secUserId,
          max_cursor: cursor,
          count: 20
        });
        if (debug && page === 0) log(`   raw: ${JSON.stringify(resp).substring(0, 400)}`);

        let awemes = [];
        const d = resp.data;
        if (Array.isArray(d)) awemes = d;
        else if (d && Array.isArray(d.aweme_list)) awemes = d.aweme_list;
        else if (d && Array.isArray(d.videos)) awemes = d.videos;

        if (awemes.length === 0) break;
        videos = videos.concat(awemes);
        cursor = d?.max_cursor || d?.has_more_cursor || 0;
        if (!d?.has_more) break;
      }

      // Step 3: 过滤近 N 天 + 按点赞排序
      const recent = videos
        .filter(v => (v.create_time || 0) * 1000 >= since)
        .map(v => ({
          platform: 'douyin_creator',
          source: '达人视频',
          creator: c.name || '',
          topic: v.desc || '',
          aweme_id: v.aweme_id || '',
          digg_count: Number(v.statistics?.digg_count || 0),
          comment_count: Number(v.statistics?.comment_count || 0),
          share_count: Number(v.statistics?.share_count || 0),
          create_time: v.create_time ? new Date(v.create_time * 1000).toISOString().substring(0, 10) : '',
          url: v.aweme_id ? `https://www.douyin.com/video/${v.aweme_id}` : '',
          captured_at: new Date().toISOString()
        }))
        .sort((a, b) => b.digg_count - a.digg_count);

      log(`   ${c.name}: 拉取 ${videos.length} 条，近 ${days} 天 ${recent.length} 条，最高赞 ${recent[0]?.digg_count || 0}`);
      results.push(...recent);
    } catch (e) {
      log(`   ❌ ${c.name} 抓取失败: ${e.message.substring(0, 150)}`);
    }
  }
  return results;
}

// ============ 统一模型：归一化（原地修改，保证引用一致） ============
function normalize(items) {
  // 有真实 heat 的渠道做 min-max 归一化
  const withHeat = items.filter(x => x.heat > 0);
  const heatVals = withHeat.map(x => x.heat);
  const min = heatVals.length ? Math.min(...heatVals) : 0;
  const max = heatVals.length ? Math.max(...heatVals) : 0;
  const range = max - min || 1;

  // 达人渠道：按 digg_count 归一化
  const creators = items.filter(x => x.digg_count > 0);
  const diggVals = creators.map(x => x.digg_count);
  const dMin = diggVals.length ? Math.min(...diggVals) : 0;
  const dMax = diggVals.length ? Math.max(...diggVals) : 0;
  const dRange = dMax - dMin || 1;

  for (const x of items) {
    let score = x.heat_score;
    if (x.heat > 0) score = (x.heat - min) / range;
    else if (x.digg_count > 0) score = (x.digg_count - dMin) / dRange;
    else if (score === undefined || score === null) score = 0;
    x.heat_score = Math.round(score * 100) / 100;
  }
  return items;
}

// ============ 关键词提取（简单版：从标题抽名词性短语） ============
function extractKeywords(topic) {
  if (!topic) return [];
  // 去书名号、引号内的核心词优先
  const bracket = topic.match(/[《》“”「」『』"']([^《》“”「」『』"']{2,12})/g);
  if (bracket) {
    return bracket.map(s => s.replace(/[《》“”「」『』"']/g, '')).slice(0, 3);
  }
  // 按常见分隔符拆
  const parts = topic.split(/[，。；、：:·\s|/]/).filter(p => p.length >= 2);
  return parts.slice(0, 3);
}

// ============ 跨源合并（简单标题相似度去重） ============
function mergeAcrossSources(items, topN) {
  const merged = [];
  for (const it of items) {
    const norm = it.topic.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    let target = null;
    for (const m of merged) {
      const mNorm = m.topic.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
      if (!norm || !mNorm) continue;
      const shorter = Math.min(norm.length, mNorm.length);
      if (shorter < 4) continue;
      let overlap = 0;
      for (let i = 0; i < Math.min(norm.length, mNorm.length); i++) {
        if (norm[i] === mNorm[i]) overlap++;
      }
      if (overlap / shorter >= 0.75) { target = m; break; }
    }
    if (target) {
      // 合并：热度相加、来源并列
      target.heat_score = Math.min(1, target.heat_score + it.heat_score * 0.3);
      if (!target.sources) target.sources = [target.source];
      if (!target.sources.includes(it.source)) target.sources.push(it.source);
      target.source = target.sources.join('+');
    } else {
      merged.push({ ...it, sources: [it.source] });
    }
  }
  // 统一排序取 Top N
  return merged
    .sort((a, b) => b.heat_score - a.heat_score)
    .slice(0, topN);
}

// ============ 飞书 Bitable 写入 ============
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
    maxBuffer: 10 * 1024 * 1024
  });
}

function writeToBitable(items) {
  if (!HOTSPOT_BASE_TOKEN || !HOTSPOT_TABLE_ID) {
    log('⚠️ 未配置 HOTSPOT_BASE_TOKEN / HOTSPOT_TABLE_ID，跳过飞书写入');
    return { success: 0, skipped: true };
  }
  if (items.length === 0) {
    log('🔹 无热点数据可写入');
    return { success: 0 };
  }

  const today = new Date().toISOString().substring(0, 10);
  const createRecords = items.map(it => ({
    '日期': today,
    '热点标题': it.topic,
    '来源': it.source,
    '平台': it.platform,
    '热度分': it.heat_score,
    '原始热度': it.heat || '',
    '点赞数': it.digg_count || '',
    '达人': it.creator || '',
    '链接': it.url,
    '发布时间': it.pub_date || it.create_time || '',
    '关键词': (extractKeywords(it.topic) || []).join('、'),
    '抓取时间': it.captured_at ? it.captured_at.replace('T', ' ').substring(0, 19) : ''
  }));

  log(`🔹 写入飞书多维表格（${createRecords.length} 条）...`);
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
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
      },
      maxBuffer: 50 * 1024 * 1024
    });
    const resp = JSON.parse(output);
    const count = resp?.data?.record_id_list?.length || 0;
    log(`   ✅ 写入 ${count} 条`);
    return { success: count };
  } catch (error) {
    log(`   ❌ 写入失败: ${error.message.substring(0, 500)}`);
    return { success: 0, failed: error.message };
  }
}

// ============ 飞书 IM 通知 ============
function sendNotify(topItems) {
  try {
    const authOutput = runLarkCli(['auth', 'status']);
    const authData = JSON.parse(authOutput);
    const myOpenId = authData?.identities?.user?.openId || '';
    if (!myOpenId) {
      log('   ⚠️ 无法获取当前用户 open_id，跳过通知');
      return;
    }

    const lines = ['🔥 全网热点聚合 - Top 5', ''];
    topItems.forEach((it, i) => {
      lines.push(`${i + 1}. [${it.source}] ${it.topic}`);
      if (it.creator) lines.push(`   达人: ${it.creator}`);
      if (it.digg_count) lines.push(`   点赞: ${it.digg_count.toLocaleString()}`);
      else if (it.heat) lines.push(`   热度: ${it.heat.toLocaleString()}`);
      if (it.url) lines.push(`   ${it.url}`);
      lines.push('');
    });

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
    log(`   ⚠️ 飞书通知失败: ${error.message.substring(0, 200)}`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = {
    channels: 'douyin,xhs,kuaishou,weibo,bilibili,gov,creator',
    top: 10,
    days: 3,
    creators: './hotspot_creators.json',
    writeBitable: false,
    notify: false,
    debug: false
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channels' && args[i + 1]) { opts.channels = args[++i]; }
    else if (args[i] === '--top' && args[i + 1]) { opts.top = Number(args[++i]); }
    else if (args[i] === '--days' && args[i + 1]) { opts.days = Number(args[++i]); }
    else if (args[i] === '--creators' && args[i + 1]) { opts.creators = args[++i]; }
    else if (args[i] === '--write-bitable') { opts.writeBitable = true; }
    else if (args[i] === '--notify') { opts.notify = true; }
    else if (args[i] === '--debug') { opts.debug = true; }
  }
  const channels = opts.channels.split(',').map(s => s.trim()).filter(Boolean);

  log('============================================');
  log('🔥 全网热点聚合采集启动');
  log(`   渠道: ${channels.join(', ')} | Top: ${opts.top} | 达人窗口: ${opts.days}天`);
  log('============================================\n');

  if (channels.some(c => ['douyin', 'xhs', 'kuaishou', 'weibo', 'bilibili', 'creator'].includes(c)) && !TIKHUB_TOKEN) {
    log('❌ 缺少 TIKHUB_TOKEN，无法采集抖音/小红书/快手/微博/B站/达人渠道');
    process.exit(1);
  }

  const all = [];
  const perChannel = {};

  if (channels.includes('douyin')) {
    const items = await collectDouyin(opts.debug);
    perChannel.douyin = items;
    all.push(...items);
  }
  if (channels.includes('xhs')) {
    const items = await collectXhs(opts.debug);
    perChannel.xhs = items;
    all.push(...items);
  }
  if (channels.includes('kuaishou')) {
    const items = await collectKuaishou(opts.debug);
    perChannel.kuaishou = items;
    all.push(...items);
  }
  if (channels.includes('weibo')) {
    const items = await collectWeibo(opts.debug);
    perChannel.weibo = items;
    all.push(...items);
  }
  if (channels.includes('bilibili')) {
    const items = await collectBilibili(opts.debug);
    perChannel.bilibili = items;
    all.push(...items);
  }
  if (channels.includes('gov')) {
    const items = await collectGov(opts.debug);
    perChannel.gov = items;
    all.push(...items);
  }
  if (channels.includes('creator')) {
    const items = await collectCreators(opts.creators, opts.days, opts.debug);
    perChannel.creator = items;
    all.push(...items);
  }

  // 归一化 + 排序
  const normalized = normalize(all);
  const sorted = normalized.sort((a, b) => b.heat_score - a.heat_score);

  // 每渠道 Top N
  const perChannelTop = {};
  for (const [ch, items] of Object.entries(perChannel)) {
    perChannelTop[ch] = [...items].sort((a, b) => b.heat_score - a.heat_score).slice(0, opts.top);
  }

  // 跨源合并 Top N
  const mergedTop = mergeAcrossSources(sorted, opts.top);

  // 输出摘要
  log('\n============================================');
  log('📊 各渠道 Top 5 摘要');
  log('============================================');
  const summary = {};
  for (const [ch, items] of Object.entries(perChannelTop)) {
    const chName = { douyin: '抖音热点', xhs: '小红书热门', kuaishou: '快手热榜', weibo: '微博热搜', bilibili: 'B站热门', gov: '政策热点', creator: '达人视频' }[ch] || ch;
    log(`\n【${chName}】共 ${items.length} 条`);
    items.slice(0, 5).forEach((it, i) => {
      const score = normalized.find(n => n === it)?.heat_score;
      const heat = it.digg_count ? `赞${it.digg_count}` : (it.heat ? `热度${it.heat}` : '');
      log(`  ${i + 1}. ${it.topic}${heat ? ` (${heat})` : ''} score=${score}`);
    });
    summary[ch] = items.slice(0, 5).map(it => ({ topic: it.topic, source: it.source, heat: it.heat, digg_count: it.digg_count, url: it.url }));
  }

  log('\n============================================');
  log('🏆 跨源合并 Top 5（全网热点）');
  log('============================================');
  mergedTop.slice(0, 5).forEach((it, i) => {
    log(`  ${i + 1}. [${it.source}] ${it.topic} score=${it.heat_score}`);
  });

  // 飞书闭环
  if (opts.writeBitable) {
    writeToBitable(sorted.slice(0, opts.top * 3));
  }
  if (opts.notify) {
    sendNotify(mergedTop.slice(0, 5));
  }

  // 结构化输出
  const output = {
    captured_at: new Date().toISOString(),
    per_channel_top: summary,
    merged_top: mergedTop.map(it => ({
      topic: it.topic,
      source: it.source,
      platform: it.platform,
      heat_score: it.heat_score,
      heat: it.heat,
      digg_count: it.digg_count,
      creator: it.creator,
      url: it.url,
      keywords: extractKeywords(it.topic)
    })),
    total_collected: all.length
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  log(`\n❌ 热点采集失败: ${e.message}`);
  process.exit(1);
});
