#!/usr/bin/env node
/**
 * 策略素材自动分析脚本（多品牌配置化）
 *
 * 流程：数据源表 → 筛选优秀脚本 → AI分析提取素材 → 写入审核表
 *
 * 品牌私有内容（品牌名、飞书表、筛选阈值、分级规则、AI prompt 模板）
 * 全部外置在 config/<brand>/，代码只保留通用流程逻辑。
 *
 * 用法：
 *   node strategy_review.js [--brand duxiaoman]
 *
 * 参数：
 *   --brand <name>   品牌配置目录名（config/<name>/，默认 duxiaoman；env WORKFLOW_BRAND 可兜底）
 *
 * 环境变量：
 *   AIHUBMIX_API_KEY   AIHubMix 网关 key（必需）
 *   AIHUBMIX_BASE_URL  默认 https://api.inferera.com/v1
 *   DOUBAO_MODEL       默认 doubao-seed-2-1-pro
 *   TEST_MODE=1        只分析第 1 条（调试用）
 *   TOUTIAO_BASE_TOKEN / TOUTIAO_TABLE_ID / REVIEW_TABLE_ID  覆盖品牌配置中的表（可选）
 */

const fs = require('fs');
const { execSync } = require('child_process');

const brand = require('./lib/brand');
const lark = require('./lib/lark');

// ==================== 品牌配置 ====================
const BRAND = brand.resolveBrand();
brand.loadEnv(BRAND);
lark.initProxy(); // 必须在 loadEnv 之后：剥离代理让 AI 调用直连，lark-cli 子进程会自动恢复代理
const CFG = brand.loadBrandConfig(BRAND);

const SRC = CFG.tables.source;
const REV = CFG.tables.review;
const F = CFG.filters;
const G = CFG.grading;
const AI = CFG.ai;

// 表 token 支持 env 覆盖（保留历史变量名兼容）
const SRC_BASE_TOKEN = (SRC.envOverride?.baseToken && process.env[SRC.envOverride.baseToken]) || SRC.baseToken;
const SRC_TABLE_ID = (SRC.envOverride?.tableId && process.env[SRC.envOverride.tableId]) || SRC.tableId;
const REV_BASE_TOKEN = (REV.envOverride?.baseToken && process.env[REV.envOverride.baseToken]) || REV.baseToken;
const REV_TABLE_ID = (REV.envOverride?.tableId && process.env[REV.envOverride.tableId]) || REV.tableId;

const AI_API_KEY = process.env.AIHUBMIX_API_KEY;
const AI_BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1';
const AI_MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro';

if (!AI_API_KEY) {
  console.error('错误: AIHUBMIX_API_KEY 未设置，请检查 .env 文件');
  process.exit(1);
}

// AI prompt 模板（品牌配置化：config/<brand>/prompts/review.md）
const REVIEW_PROMPT_TEMPLATE = brand.loadPromptFile(BRAND, AI.promptTemplate || 'review.md');

// ==================== 工具函数 ====================

/** 解析星推比文本为数字 */
function parseStarRatio(val) {
  if (!val) return 0;
  const num = parseFloat(String(val).replace(/[^\d.]/g, ''));
  return isNaN(num) ? 0 : num;
}

/** 检查转化是否达标（枚举值来自品牌配置） */
function isConversionQualified(val) {
  if (!val) return false;
  const values = F.conversionQualifiedValues || ['是'];
  if (Array.isArray(val)) return val.some(v => values.includes(v));
  return values.includes(String(val));
}

/** 计算评分等级（分级规则来自品牌配置；返回 null 表示不入池） */
function calcGrade(starRatio, conversionOk) {
  const starOk = starRatio > (F.starRatioThreshold ?? 2.5);
  if (starOk && conversionOk) return G.both ?? null;
  if (conversionOk) return G.conversionOnly ?? null;
  if (starOk) return G.starRatioOnly ?? null;
  return null;
}

/** 判断入库目标（分线规则来自品牌配置；未启用分线时返回 default） */
function classifyTopic(topic) {
  const ts = CFG.topicSplit || {};
  if (!ts.enabled) return ts.default || 'default';
  for (const rule of ts.rules || []) {
    if (topic && topic.includes(rule.keyword)) return rule.target;
  }
  return ts.default || 'default';
}

/** 清理脚本文案中的 HTML 标签 */
function cleanScript(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// ==================== AI 分析 ====================

/**
 * 调用 AIHubMix API 分析脚本，提取 4 类策略素材
 * 注：用 curl 而非 Node fetch —— 本机环境下 Node fetch 有代理兼容性问题
 */
async function analyzeScript(scriptText, topic) {
  const prompt = brand.renderTemplate(REVIEW_PROMPT_TEMPLATE, {
    BRAND: CFG.brandName,
    AUDIENCE: CFG.audience || '',
    TOPIC: topic,
    SCRIPT: scriptText
  });

  const requestBody = JSON.stringify({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: '你是一个短视频脚本策略分析师，擅长从优秀脚本中提取可复用的策略素材。输出必须是纯JSON，不要有其他文字。' },
      { role: 'user', content: prompt }
    ],
    temperature: AI.temperature ?? 0.3
  });

  const tmpBody = lark.tmpPath(`ai_request_${Date.now()}.json`);
  fs.writeFileSync(tmpBody, requestBody);

  const maxRetries = AI.maxRetries || 3;
  const timeout = (AI.requestTimeoutSec || 120) * 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const cmd = `curl -s --max-time ${AI.requestTimeoutSec || 120} ${AI_BASE_URL}/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer ${AI_API_KEY}" -d @${tmpBody}`;
      const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: timeout + 10000 });

      const data = JSON.parse(raw);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      const content = data.choices[0].message.content;
      try { fs.unlinkSync(tmpBody); } catch (_) {}

      try {
        return JSON.parse(content);
      } catch (e) {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('AI返回内容无法解析为JSON: ' + content.substring(0, 200));
      }
    } catch (e) {
      if (attempt < maxRetries) {
        console.log(`\n    重试 ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, (AI.retryDelayMs || 2000) * attempt));
      } else {
        try { fs.unlinkSync(tmpBody); } catch (_) {}
        throw e;
      }
    }
  }
}

// ==================== 主流程 ====================

async function main() {
  console.log(`=== ${CFG.reviewTitle || CFG.brandName + '策略素材自动分析'} ===`);
  console.log(`品牌: ${BRAND}（${CFG.brandName}）\n`);

  // Step 1: 拉取数据源表记录
  console.log(`Step 1: 拉取${SRC.label || '数据源表'}记录...`);
  const srcFieldNames = Object.values(SRC.fieldNames);
  const allRecords = lark.fetchRecords(SRC_BASE_TOKEN, SRC_TABLE_ID, srcFieldNames, { outputPrefix: 'strategy_review' });
  console.log(`  共 ${allRecords.length} 条记录\n`);

  const fn = SRC.fieldNames;

  // Step 2: 筛选优秀脚本
  console.log('Step 2: 筛选优秀脚本...');
  const candidates = [];
  for (const rec of allRecords) {
    const starRatio = parseStarRatio(rec[fn.starRatio]);
    const conversionOk = isConversionQualified(rec[fn.conversionQualified]);
    const grade = calcGrade(starRatio, conversionOk);

    if (!grade) continue; // 不满足入池标准

    const topic = rec[fn.topic] || '';
    const script = cleanScript(rec[fn.script] || '');

    if (!script || script.length < (F.minScriptLength ?? 30)) continue; // 脚本太短跳过

    candidates.push({
      record_id: rec._record_id || '',
      topic,
      script,
      starRatio,
      conversionOk,
      grade,
      target: classifyTopic(topic),
      creator: rec[fn.creator] || ''
    });
  }

  console.log(`  符合入池标准: ${candidates.length} 条`);

  // Step 2.5: 去重——跳过审核表中已存在的源脚本，避免重复写入
  console.log('Step 2.5: 检查审核表已有记录（去重）...');
  try {
    const existing = lark.fetchRecords(REV_BASE_TOKEN, REV_TABLE_ID, [REV.fieldNames.scriptId], { outputPrefix: 'review_existing' });
    const existingIds = new Set(existing.map(r => r[REV.fieldNames.scriptId]).filter(Boolean));
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

  console.log(`  ${G.both}级: ${candidates.filter(c => c.grade === G.both).length} 条`);
  console.log(`  ${G.conversionOnly}级: ${candidates.filter(c => c.grade === G.conversionOnly).length} 条\n`);

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
      c.analysis = await analyzeScript(c.script, c.topic);
      analyzed.push(c);
      console.log(' ✓');
    } catch (e) {
      console.log(` ✗ AI分析失败: ${e.message}`);
      // 失败的也写入审核表，但AI建议字段留空
      c.analysis = null;
      analyzed.push(c);
    }

    // 限制并发，避免 API 过载
    if (i < candidates.length - 1 && AI.betweenRecordsDelayMs) {
      await new Promise(r => setTimeout(r, AI.betweenRecordsDelayMs));
    }
  }
  console.log(`  分析完成: ${analyzed.length} 条\n`);

  // Step 4: 写入审核表
  console.log(`Step 4: 写入${REV.label || '审核表'}...`);

  const rfn = REV.fieldNames;
  const statusPending = REV.status?.pending || '待审核';
  const batchSize = AI.batchSize || 20;
  const dryRun = process.env.DRY_RUN === '1';

  for (let i = 0; i < analyzed.length; i += batchSize) {
    const batch = analyzed.slice(i, i + batchSize);
    const records = batch.map(c => {
      const a = c.analysis || {};
      return {
        [rfn.topic]: c.topic,
        [rfn.scriptId]: c.record_id,
        [rfn.script]: c.script.substring(0, F.scriptMaxLength || 10000),
        [rfn.hook]: a.钩子 ? `${a.钩子.打法 || ''}：${a.钩子.台词公式 || ''}` : '',
        [rfn.inherit]: a.承接 ? `${a.承接.打法 || ''}：${a.承接.模板 || ''}` : '',
        [rfn.transition]: a.转折 ? `${a.转折.打法 || ''}：${a.转折.句式 || ''}` : '',
        [rfn.role]: a.角色定位 ? `${a.角色定位.角色 || ''}：${a.角色定位.典型话术 || ''}` : '',
        [rfn.grade]: [c.grade],
        [rfn.target]: [c.target],
        [rfn.status]: [statusPending]
      };
    });

    if (dryRun) {
      console.log(`  [DRY_RUN] 批次 ${Math.floor(i / batchSize) + 1}: 跳过写入，payload 预览：`);
      console.log(JSON.stringify({ create_records: records }, null, 2).substring(0, 3000));
      continue;
    }

    const tmpFile = lark.tmpPath(`review_batch_${i}.json`);
    try {
      const result = lark.batchWrite(
        `base +record-batch-create --base-token ${REV_BASE_TOKEN} --table-id ${REV_TABLE_ID}`,
        { create_records: records },
        tmpFile
      );
      const count = result.data?.record_id_list?.length || 0;
      console.log(`  批次 ${Math.floor(i / batchSize) + 1}: 写入 ${count} 条`);
    } catch (e) {
      console.log(`  批次 ${Math.floor(i / batchSize) + 1}: 写入失败 - ${e.message}`);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  console.log(`\n=== 完成！共写入 ${analyzed.length} 条候选素材到审核表 ===`);
  console.log(`\n下一步：在飞书多维表格中审核候选素材，审核通过后运行 sync_to_strategy.js 追加到策略库文档`);
}

main().catch(e => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
