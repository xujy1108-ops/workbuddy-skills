#!/usr/bin/env node

/**
 * 度小满创意分析 - 抖音工作流主脚本
 *
 * 使用方法：
 *   node run_workflow.js [--keywords "kw1,kw2"] [--existing-ids "id1,id2"] [--skip-bitable]
 *
 * 默认行为（一条命令跑完）：
 *   1. 自动查询飞书多维表格已有素材 ID（去重）
 *   2. 生成关键词 → 搜索抖音 → 提取脚本 → 分析创意
 *   3. 自动将结果写入飞书多维表格
 *   4. 如果 API 余额不足，自动给飞书发消息通知
 *
 * 参数：
 *   --keywords "kw1,kw2"     使用自定义搜索关键词（跳过 AI 生成）
 *   --existing-ids "id1,id2" 手动传入已有素材 ID（跳过自动查询）
 *   --skip-bitable           跳过飞书多维表格读写（仅跑分析，不写入）
 *
 * 环境变量：
 *   AIHUBMIX_API_KEY   - AIHubMix API 密钥
 *   AIHUBMIX_BASE_URL  - AIHubMix API 地址（默认 https://api.inferera.com/v1）
 *   TIKHUB_TOKEN       - TikHub API 令牌
 *   DEEPSEEK_MODEL     - DeepSeek 模型名（默认 deepseek-v4-pro）
 *   DOUBAO_MODEL       - 豆包模型名（默认 doubao-seed-2-1-pro）
 *
 * 输出：JSON 格式结果到 stdout，进度日志输出到 stderr
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ============ 配置 ============
const AIHUBMIX_API_KEY = process.env.AIHUBMIX_API_KEY;
const AIHUBMIX_BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1';
const TIKHUB_TOKEN = process.env.TIKHUB_TOKEN;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro';

const MAX_DURATION_MS = 300000; // 5 分钟
const MIN_DIGG_COUNT = 2000; // 最低点赞数
const FORBIDDEN_KEYWORDS = ['催收', '医疗', '看病', '住院', '手术', '上学', '学费', '开学'];

// 飞书多维表格配置
const BITABLE_BASE_TOKEN = process.env.BITABLE_BASE_TOKEN;
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID;
const LARK_CLI = 'lark-cli';
// ==============================

// ============ 提示词 ============

const KEYWORD_PROMPT = `你是抖音内容素材策划专家，熟悉抖音平台的内容生态、用户情绪和话题传播逻辑。请围绕"资金周转困难"这个核心场景，生成2个抖音搜索关键词。

场景说明：资金周转困难是一个广泛的生活议题，涵盖所有与"缺钱、借钱、用钱、搞钱"相关的真实处境和情绪。以下为参考场景类型，可根据抖音实际内容生态自行补充其他借钱相关场景：

- 熟人借贷纠纷：被朋友/亲戚开口借钱、借了要不回来、借钱伤感情、不好意思拒绝
- 做生意资金周转：创业资金链断裂、进货缺钱、年底结账收不回款、周转不开
- 逆袭翻盘故事：讲述自己以前有多难、怎么从负债中爬起来、穷日子怎么熬过来的
- 借钱被坑经历：被熟人骗钱、担保踩坑、高利贷陷阱、网贷越借越多
- 银行贷款困境：普通人为什么银行借不出来、征信花了借不到钱、贷款被拒
- 突发用钱压力：家人生病急需用钱、意外支出、房贷车贷断供
- 搞钱奋斗类：普通人怎么搞钱、副业赚钱、省钱过紧日子

要求如下：

话题原生性：关键词必须来自真实用户在抖音上自发讨论的内容方向，不能带有任何品牌卖点、产品功能或推广意图，要像普通用户会搜索的词一样自然。

关键词形式：必须是长尾搜索短语（5-15个字），直接粘贴到抖音搜索框即可使用，不要过于宽泛（如"缺钱"）或过于简短。

场景多样性：2个关键词必须覆盖不同的场景类型，不要只盯同一个方向，这样素材覆盖面更广。以上场景列表仅为参考，你应根据借钱议题的实际讨论热度，选择最容易产出优质素材的方向，也可以补充列表之外的场景。

内容多样性：2个关键词需要覆盖不同类型的内容形态，例如心理分析类、情绪记录类、真实案例分享类、人性讨论类、经验干货类等，不能全是同一类型。

禁止预设案例：只输出关键词本身，不要预设或编造具体案例，让下一个agent自己去抖音搜索发现和筛选真实素材。

输出格式：严格按以下JSON格式输出，不要增加任何额外字段、注释或说明文字：

{
  "keywords": [
    { "id": 1, "keyword": "完整的长尾搜索关键词" },
    { "id": 2, "keyword": "完整的长尾搜索关键词" }
  ]
}`;

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

const ANALYSIS_PROMPT = `# 角色
你是一位资深短视频编导，擅长拆解爆款素材的叙事逻辑，并为品牌广告提供可落地的植入策略。

# 任务
分析用户提供的脚本素材，完成五项输出，直接输出JSON。

# 输出格式
{
  "内容方向": "用一句大白话总结整个脚本的叙事逻辑和核心主张，让观众一听就懂",
  "素材逻辑分析": "从叙事视角、双方行为画像、核心结论三个维度综合分析，一段话写清楚，直接给结论",
  "对度小满的借鉴": "从情绪借势、反向论证、核心策略三个维度综合分析，一段话写清楚核心策略",
  "植入修改建议": "包含植入锚点、修改后话术（用引号标出）、植入逻辑三个要素，一段话写清楚",
  "适配达人": {
    "表现形式": "口播/剧情/AI生成/其他",
    "语速与风格": "语速快慢+说话风格，如：快、犀利",
    "口吻": "老登说教/犀利点评/真挚分享等",
    "推荐达人类型": "基于以上三点推导，2-3个类型，如：财经、职场、母婴亲子"
  }
}

# 适配达人分析要求
- 表现形式：如输入中已提供「视频表现特征」，直接引用；否则从脚本结构推断（单人长段=口播，多人对话=剧情）。提示中列举的类型仅为参考，可根据实际情况自行补充其他类型
- 语速与风格：如输入中已提供「视频表现特征」，直接引用；否则从脚本语言密度和标点推断。提示中列举的档位和风格仅为参考，可根据实际情况自行补充其他描述
- 口吻：从脚本内容的说话态度和立场判断，提示中列举的类型仅为参考，可根据实际情况自行补充其他口吻描述
- 推荐达人类型：综合表现形式、语速风格、口吻三个维度，推导什么类型的达人适合演绎这类脚本

# 约束条件
- 内容方向，总字数在30字以内
- 适配达人的推荐达人类型控制在20字以内，其余3个子项各15字以内
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
  "内容方向": "不想既丢钱又丢朋友，就记住：没做好送钱的准备，一分都别借。",
  "素材逻辑分析": "被借钱者受害者视角，借钱方占便宜、试探底线、施压人情，被借方羞耻绑架、承担风险、人财两空。核心结论：借钱＝拿钱买仇人，赠予心态才可例外。",
  "对度小满的借鉴": "借势熟人借贷伤感情高风险的情绪，反向论证正规平台是正向替代方案。核心策略：品牌接住观众'不伤感情+不求人'的需求，成为两难后的最优解。",
  "植入修改建议": "在'找银行借钱要付利息'处接入'找银行借钱要付利息，但银行还不一定借给你；找度小满，明码标价，利息清楚，到账快，不欠人情不伤感情。那你说，你为啥还要找朋友开口？'核心逻辑：把'向朋友借'的熟人借贷痛点转化为'用正规平台'的解决方案。",
  "适配达人": {
    "表现形式": "口播",
    "语速与风格": "中速、犀利、利落",
    "口吻": "犀利点评",
    "推荐达人类型": "财经、职场、情感观点"
  }
}`;

// ==============================

function log(msg) {
  process.stderr.write(msg + '\n');
}

// Step 1: 生成搜索关键词
async function generateKeywords() {
  log('🔹 Step 1: 生成搜索关键词...');

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
        { role: 'user', content: KEYWORD_PROMPT }
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
  const keywords = parsed.keywords.map(k => k.keyword);

  log(`   生成了 ${keywords.length} 个关键词: ${keywords.join(', ')}`);
  return keywords;
}

// Step 2: 搜索抖音视频
async function searchDouyin(keyword) {
  log(`🔹 Step 2: 搜索抖音关键词 "${keyword}"...`);

  const response = await fetch('https://api.tikhub.io/api/v1/douyin/search/fetch_video_search_v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TIKHUB_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      keyword,
      cursor: 0,
      sort_type: '1',
      publish_time: '0',
      filter_duration: '0',
      content_type: '0',
      search_id: '',
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
  } else if (Array.isArray(result)) {
    items = result;
  }

  // 标准化每条记录为 aweme_info 对象
  const awemeList = items.map(item => {
    if (item.aweme_info) return item.aweme_info;
    if (item.aweme_id) return item;
    return null;
  }).filter(Boolean);

  log(`   搜索到 ${awemeList.length} 条视频`);
  return awemeList;
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
      model: DOUBAO_MODEL,
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
        { role: 'system', content: ANALYSIS_PROMPT },
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

// 检查脚本是否包含禁止内容
function containsForbiddenContent(script) {
  return FORBIDDEN_KEYWORDS.some(keyword => script.includes(keyword));
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
    const ids = [];

    for (const record of records) {
      const fields = record.fields || {};
      const val = fields['素材id'];
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
    log(`   ⚠️ 查询已有素材 ID 失败（将跳过去重）: ${error.message.substring(0, 200)}`);
    return [];
  }
}

// 格式化「适配达人」分析结果为飞书表格可写入的多行文本
function formatAdaptation(adaptation) {
  if (!adaptation) return '';
  if (typeof adaptation === 'string') return adaptation;
  if (typeof adaptation === 'object') {
    const parts = [];
    if (adaptation['表现形式']) parts.push(`表现形式：${adaptation['表现形式']}`);
    if (adaptation['语速与风格']) parts.push(`语速与风格：${adaptation['语速与风格']}`);
    if (adaptation['口吻']) parts.push(`口吻：${adaptation['口吻']}`);
    if (adaptation['推荐达人类型']) parts.push(`推荐达人类型：${adaptation['推荐达人类型']}`);
    return parts.join('\n');
  }
  return '';
}

// Step 3 自动化：构建 payload 并写入多维表格
function writeToBitable(results) {
  if (results.length === 0) {
    log('🔹 Step 5: 无需写入（0 条结果）');
    return { success: 0, failed: 0, errors: [] };
  }

  log(`🔹 Step 5: 写入飞书多维表格（${results.length} 条）...`);

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
    const created = resp?.data?.records || resp?.data?.items || [];
    const count = Array.isArray(created) ? created.length : (resp?.data?.record_count || results.length);
    log(`   ✅ 成功写入 ${count} 条记录`);
    return { success: count, failed: 0, errors: [] };
  } catch (error) {
    log(`   ❌ 写入飞书多维表格失败: ${error.message.substring(0, 500)}`);
    return { success: 0, failed: results.length, errors: [error.message] };
  }
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keywords' && args[i + 1]) {
      customKeywords = args[i + 1].split(',').map(k => k.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--existing-ids' && args[i + 1]) {
      existingIds = args[i + 1].split(',').map(id => id.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--skip-bitable') {
      skipBitable = true;
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

  // Step 1: 查询已有素材 ID（如果未手动传入）
  if (existingIds.length === 0 && !skipBitable) {
    existingIds = fetchExistingIds();
  } else if (existingIds.length > 0) {
    log(`🔹 Step 1: 使用传入的 ${existingIds.length} 个已有素材 ID`);
  }

  // Step 1: 生成关键词（或使用自定义关键词）
  let keywords;
  if (customKeywords && customKeywords.length > 0) {
    keywords = customKeywords;
    log(`🔹 Step 1: 使用自定义关键词: ${keywords.join(', ')}`);
  } else {
    keywords = await generateKeywords();
  }
  log('');

  // Step 2: 搜索抖音
  const allAweme = [];
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
  const skipped = [];
  const candidates = [];

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

    // 时长过滤
    if (duration && Number(duration) > MAX_DURATION_MS) {
      skipped.push({ aweme_id: awemeId, reason: 'duration_exceeded', duration: Number(duration) });
      continue;
    }

    // 点赞数过滤
    const diggCount = aweme.statistics?.digg_count || 0;
    if (diggCount < MIN_DIGG_COUNT) {
      skipped.push({ aweme_id: awemeId, reason: 'low_digg_count', digg_count: diggCount });
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

  // Step 4: 提取脚本 + 分析（并行执行）
  const CONCURRENCY = parseInt(process.env.WORKFLOW_CONCURRENCY || '3', 10);
  log(`🔹 Step 4: 提取视频脚本并分析（并行，并发 ${CONCURRENCY}）...\n`);

  // 共享状态：一旦检测到余额不足，后续未开始的任务直接跳过
  const state = { quotaExhausted: false };

  // 为每个候选构建处理函数（返回结构化结果，不抛异常）
  const taskFns = candidates.map((candidate, i) => {
    return async () => {
      // 余额已耗尽，跳过
      if (state.quotaExhausted) {
        log(`   [${i + 1}/${candidates.length}] ⏭️  跳过 ${candidate.aweme_id}（API 余额不足，未开始）`);
        return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'quota_exhausted' };
      }

      log(`   [${i + 1}/${candidates.length}] 处理: ${candidate.aweme_id} — ${candidate.desc.substring(0, 50)}`);

      try {
        // 提取脚本 + 视频表现特征
        const { script, meta } = await extractVideoScript(candidate.download_url);
        log(`   [${candidate.aweme_id}] 脚本长度: ${script.length} 字`);

        // 检查全程未开口说话
        if (isNoSpeechScript(script)) {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 全程未开口说话`);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'no_speech' };
        }

        // 检查禁止内容
        if (containsForbiddenContent(script)) {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 包含禁止内容`);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'forbidden_content' };
        }

        // 分析创意（传入视频表现特征）
        const analysis = await analyzeCreative(candidate.desc, script, meta);
        log(`   [${candidate.aweme_id}] ✅ 分析完成`);

        return {
          status: 'success',
          aweme_id: candidate.aweme_id,
          desc: candidate.desc,
          video_url: `https://www.douyin.com/video/${candidate.aweme_id}`,
          script,
          analysis,
          keyword: candidate.keyword
        };
      } catch (error) {
        // 余额不足 — 设置标志，剩余任务将跳过
        if (isQuotaExhaustedError(error)) {
          state.quotaExhausted = true;
          log(`   [${candidate.aweme_id}] 💰 API 余额不足！剩余任务将跳过`);
          return { status: 'quota_exhausted', aweme_id: candidate.aweme_id, desc: candidate.desc, error: error.message };
        }
        log(`   [${candidate.aweme_id}] ❌ 处理失败: ${error.message.substring(0, 200)}`);
        return { status: 'failed', aweme_id: candidate.aweme_id, desc: candidate.desc, error: error.message };
      }
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
        keyword: r.keyword
      });
    } else if (r.status === 'skipped') {
      skipped.push({ aweme_id: r.aweme_id, reason: r.reason });
    } else if (r.status === 'quota_exhausted') {
      skipped.push({ aweme_id: r.aweme_id, reason: 'quota_exhausted' });
    } else if (r.status === 'failed') {
      failedItems.push({ aweme_id: r.aweme_id, error: r.error });
    }
  }

  // Step 5: 自动写入飞书多维表格
  let bitableResult = { success: 0, failed: 0, errors: [] };
  if (!skipBitable) {
    bitableResult = writeToBitable(results);
  } else {
    log('🔹 Step 5: 跳过飞书写入（--skip-bitable）');
  }

  // 每次运行结束都发送飞书通知
  sendFeishuNotification(
    {
      total_success: results.length,
      total_skipped: skipped.length,
      total_failed: failedItems.length,
      bitable_success: bitableResult.success,
      keywords: keywords
    },
    state.quotaExhausted
  );

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
