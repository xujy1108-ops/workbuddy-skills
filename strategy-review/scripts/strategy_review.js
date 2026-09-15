#!/usr/bin/env node
/**
 * 度小满策略素材自动分析脚本
 * 
 * 流程：头条数据表 → 筛选优秀脚本 → AI分析提取素材 → 写入审核表
 * 
 * 用法：node --env-file=<env_path> strategy_review.js
 * 或：  node strategy_review.js （自动加载默认.env）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==================== 加载 .env ====================
// 依次查找：本目录 → skill根目录 → 同仓库的 duxiaoman-hotspot/.env
const ENV_CANDIDATES = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', 'duxiaoman-hotspot', '.env')
];
for (const envPath of ENV_CANDIDATES) {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
    break;
  }
}

// ==================== 配置 ====================
const BASE_TOKEN = process.env.TOUTIAO_BASE_TOKEN || 'IusNb2cgTafYo4sTVntcHNJHn9f';
const HEAD_TABLE_ID = process.env.TOUTIAO_TABLE_ID || 'tblBEveR1P0gKRyy';
const REVIEW_TABLE_ID = process.env.REVIEW_TABLE_ID || 'tblX7a3YpwLExN7Z';
const AI_API_KEY = process.env.AIHUBMIX_API_KEY;
const AI_BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1';
const AI_MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro';

if (!AI_API_KEY) {
  console.error('错误: AIHUBMIX_API_KEY 未设置，请检查 .env 文件');
  process.exit(1);
}

const STAR_RATIO_THRESHOLD = 2.5; // 星推比阈值

// 保存代理设置，fetch 直连 API，lark-cli 走代理访问飞书
const SAVED_PROXY = {};
['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].forEach(k => {
  if (process.env[k]) SAVED_PROXY[k] = process.env[k];
});
// 删除代理，让 Node.js fetch 直连
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

// ==================== 工具函数 ====================

/**
 * 调用 lark-cli 命令（恢复代理），返回 stdout 文本
 */
function larkCliRaw(args) {
  const cmd = `lark-cli ${args} --as user 2>/dev/null`;
  return execSync(cmd, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...SAVED_PROXY } // 恢复代理给 lark-cli
  });
}

/**
 * 调用 lark-cli 命令，返回解析后的 JSON（用于非 record-list 命令）
 */
function larkCli(args) {
  const raw = larkCliRaw(args);
  const lines = raw.split('\n').filter(l => !l.startsWith('[lark-cli]'));
  return JSON.parse(lines.join('\n').trim());
}

/**
 * 用 NDJSON 模式拉取记录，返回记录数组
 */
function fetchRecords(baseToken, tableId, fieldIds) {
  const tmpDir = process.env.TMPDIR || '/tmp';
  const outputFile = `strategy_review_${Date.now()}.ndjson`;
  const fieldArgs = fieldIds.map(f => `--field-id ${f}`).join(' ');
  const cmd = `base +record-list --base-token ${baseToken} --table-id ${tableId} ${fieldArgs} --format ndjson --output ${outputFile}`;
  
  const raw = larkCliRaw(cmd);
  const manifest = JSON.parse(raw);
  const recordFile = manifest.record_file;
  
  if (!recordFile || !fs.existsSync(recordFile)) {
    throw new Error(`NDJSON record file not found: ${recordFile}`);
  }
  
  const records = [];
  const data = fs.readFileSync(recordFile, 'utf8');
  for (const line of data.split('\n')) {
    if (line.trim()) {
      records.push(JSON.parse(line));
    }
  }
  
  // 清理临时文件
  try { fs.unlinkSync(recordFile); } catch(e) {}
  try { fs.unlinkSync(outputFile); } catch(e) {}
  const manifestFile = recordFile.replace('.ndjson', '.manifest.json');
  try { fs.unlinkSync(manifestFile); } catch(e) {}
  
  return records;
}

/**
 * 解析星推比文本为数字
 */
function parseStarRatio(val) {
  if (!val) return 0;
  const num = parseFloat(String(val).replace(/[^\d.]/g, ''));
  return isNaN(num) ? 0 : num;
}

/**
 * 检查转化是否达标
 */
function isConversionQualified(val) {
  if (!val) return false;
  if (Array.isArray(val)) return val.includes('是');
  return String(val) === '是';
}

/**
 * 计算评分等级
 */
function calcGrade(starRatio, conversionOk) {
  if (starRatio > STAR_RATIO_THRESHOLD && conversionOk) return 'S';
  if (conversionOk) return 'A';
  if (starRatio > STAR_RATIO_THRESHOLD) return 'A';
  return null; // 不满足入池标准
}

/**
 * 判断热点/非热点
 */
function classifyTopic(topic) {
  if (topic && topic.includes('热点')) return '热点';
  return '非热点';
}

/**
 * 清理脚本文案中的HTML标签
 */
function cleanScript(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// ==================== AI 分析 ====================

/**
 * 调用 AIHubMix API 分析脚本，提取4类策略素材
 */
async function analyzeScript(scriptText, topic) {
  const prompt = `你是一个度小满短视频脚本策略分析师。以下是一条投放效果优秀的度小满脚本文案，请从中提取可复用的策略素材。

脚本主题：${topic}
脚本文案：
${scriptText}

请分析这条脚本，从以下4个维度提取可复用的策略素材：

1. 钩子：这条脚本的开头用了什么方式吸引观众？是什么打法（反常识观点/人设预期挑战/群体对比反差/极端冲突事件/偏见正名/权威事件开场/事件悬念开场/利益相关开场）？给出可复用的台词公式。
2. 承接：这条脚本如何把内容兑现成与30-50岁受众相关的具体内容？是什么打法（信息差填补/真实经历展开/痛点场景共情/政策翻译/事件关联/缺口补充）？给出可复用的模板。
3. 转折：这条脚本如何从内容自然衔接到产品？是什么打法（痛点求解/标准筛选/质疑反转/叙事延伸/认知翻转/天然关联/政策响应/缺口补充）？给出可复用的转折句式。
4. 角色定位：度小满在这条脚本中扮演什么角色（痛点解药/过来人工具/应急安全垫/被验证的靠谱/拒绝话术武器/优等生/体面方案/合规标杆/国家队合作伙伴/缺口补充工具/政策响应者/普通人低息入口）？给出角色名称和典型话术。

请严格以JSON格式输出，不要输出其他内容：
{
  "钩子": {"打法": "打法名称", "台词公式": "可复用的公式，用【】标注变量"},
  "承接": {"打法": "打法名称", "模板": "可复用的模板描述"},
  "转折": {"打法": "打法名称", "句式": "可复用的转折句式"},
  "角色定位": {"角色": "角色名称", "典型话术": "典型的话术示例"}
}`;

  // 用 curl 调用 AI API（Node.js fetch 有代理兼容性问题）
  const requestBody = JSON.stringify({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: '你是一个短视频脚本策略分析师，擅长从优秀脚本中提取可复用的策略素材。输出必须是纯JSON，不要有其他文字。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3
  });
  
  // 写入临时文件避免命令行长度限制
  const tmpBody = `/tmp/ai_request_${Date.now()}.json`;
  fs.writeFileSync(tmpBody, requestBody);
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cmd = `curl -s --max-time 120 ${AI_BASE_URL}/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer ${AI_API_KEY}" -d @${tmpBody}`;
      const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 130000 });
      
      const data = JSON.parse(raw);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      
      const content = data.choices[0].message.content;
      fs.unlinkSync(tmpBody);
      
      try {
        return JSON.parse(content);
      } catch (e) {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('AI返回内容无法解析为JSON: ' + content.substring(0, 200));
      }
    } catch (e) {
      if (attempt < 3) {
        console.log(`\n    重试 ${attempt + 1}/3...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } else {
        try { fs.unlinkSync(tmpBody); } catch(_) {}
        throw e;
      }
    }
  }
}

// ==================== 主流程 ====================

async function main() {
  console.log('=== 度小满策略素材自动分析 ===\n');

  // Step 1: 拉取头条数据表记录
  console.log('Step 1: 拉取头条数据表记录...');
  const fieldIds = ['fld4T4Tixc', 'fld4ugCkol', 'flddXORPIT', 'fldAGQ24hv', 'fld5mFP10m'];
  const allRecords = fetchRecords(BASE_TOKEN, HEAD_TABLE_ID, fieldIds);
  console.log(`  共 ${allRecords.length} 条记录\n`);

  // Step 2: 筛选优秀脚本
  console.log('Step 2: 筛选优秀脚本...');
  const candidates = [];
  for (const rec of allRecords) {
    const starRatio = parseStarRatio(rec['星推比']);
    const conversionOk = isConversionQualified(rec['转化是否达标']);
    const grade = calcGrade(starRatio, conversionOk);
    
    if (!grade) continue; // 不满足入池标准
    
    const topic = rec['脚本主题'] || '';
    const script = cleanScript(rec['脚本文案'] || '');
    
    if (!script || script.length < 30) continue; // 脚本太短跳过
    
    candidates.push({
      record_id: rec._record_id || '',
      topic,
      script,
      starRatio,
      conversionOk,
      grade,
      target: classifyTopic(topic),
      creator: rec['达人名称'] || ''
    });
  }
  
  console.log(`  符合入池标准: ${candidates.length} 条`);

  // Step 2.5: 去重——跳过审核表中已存在的源脚本，避免重复写入
  console.log('Step 2.5: 检查审核表已有记录（去重）...');
  try {
    const existing = fetchRecords(BASE_TOKEN, REVIEW_TABLE_ID, ['源脚本ID']);
    const existingIds = new Set(existing.map(r => r['源脚本ID']).filter(Boolean));
    const before = candidates.length;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].record_id && existingIds.has(candidates[i].record_id)) {
        candidates.splice(i, 1);
      }
    }
    console.log(`  已在审核表: ${before - candidates.length} 条，本次新增: ${candidates.length} 条\n`);
  } catch (e) {
    console.log(`  ⚠ 去重检查失败（继续执行，可能重复写入）: ${e.message}\n`);
  }

  console.log(`  S级: ${candidates.filter(c => c.grade === 'S').length} 条`);
  console.log(`  A级: ${candidates.filter(c => c.grade === 'A').length} 条\n`);

  // 测试模式：只分析第1条
  if (process.env.TEST_MODE === '1') {
    console.log('  [测试模式] 只分析第1条\n');
    candidates.length = 1;
  }

  if (candidates.length === 0) {
    console.log('没有符合标准的脚本，退出。');
    return;
  }

  // Step 3: AI 分析每条脚本
  console.log('Step 3: AI分析提取策略素材...');
  const analyzed = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] ${c.topic} (${c.grade}) ...`);
    
    try {
      const analysis = await analyzeScript(c.script, c.topic);
      c.analysis = analysis;
      analyzed.push(c);
      console.log(' ✓');
    } catch (e) {
      console.log(` ✗ AI分析失败: ${e.message}`);
      // 失败的也写入审核表，但AI建议字段留空
      c.analysis = null;
      analyzed.push(c);
    }
    
    // 限制并发，避免API过载
    if (i < candidates.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`  分析完成: ${analyzed.length} 条\n`);

  // Step 4: 写入审核表
  console.log('Step 4: 写入策略素材审核表...');
  
  const batchSize = 20; // 单批最多200条，保守用20
  for (let i = 0; i < analyzed.length; i += batchSize) {
    const batch = analyzed.slice(i, i + batchSize);
    const records = batch.map(c => {
      const a = c.analysis || {};
      return {
        '脚本主题': c.topic,
        '源脚本ID': c.record_id,
        '脚本文案': c.script.substring(0, 10000), // 飞书文本字段有长度限制
        'AI建议-钩子': a.钩子 ? `${a.钩子.打法 || ''}：${a.钩子.台词公式 || ''}` : '',
        'AI建议-承接': a.承接 ? `${a.承接.打法 || ''}：${a.承接.模板 || ''}` : '',
        'AI建议-转折': a.转折 ? `${a.转折.打法 || ''}：${a.转折.句式 || ''}` : '',
        'AI建议-角色定位': a.角色定位 ? `${a.角色定位.角色 || ''}：${a.角色定位.典型话术 || ''}` : '',
        '评分等级': [c.grade],
        '入库目标': [c.target],
        '审核状态': ['待审核']
      };
    });
    
    const json = JSON.stringify({ create_records: records });
    // 写入临时文件避免命令行长度限制
    const tmpFile = `/tmp/review_batch_${i}.json`;
    fs.writeFileSync(tmpFile, json);
    
    try {
      const result = larkCli(`base +record-batch-create --base-token ${BASE_TOKEN} --table-id ${REVIEW_TABLE_ID} --json @${tmpFile}`);
      const count = result.data?.record_id_list?.length || 0;
      console.log(`  批次 ${Math.floor(i / batchSize) + 1}: 写入 ${count} 条`);
    } catch (e) {
      console.log(`  批次 ${Math.floor(i / batchSize) + 1}: 写入失败 - ${e.message}`);
    }
    
    fs.unlinkSync(tmpFile);
  }

  console.log(`\n=== 完成！共写入 ${analyzed.length} 条候选素材到审核表 ===`);
  console.log(`\n下一步：在飞书多维表格中审核候选素材，审核通过后运行 sync_to_strategy.js 追加到策略库文档`);
}

main().catch(e => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
