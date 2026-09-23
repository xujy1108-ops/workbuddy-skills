#!/usr/bin/env node

'use strict';

/**
 * strategy-analysis —— 内容策略表唯一读写入口（CLI）
 *
 * 子命令：
 *   node sync.js list --brand <brand>
 *     读策略表全量行（recordId/方向/等级/定义/植入策略/素材链接ids/适合达人）。
 *     读取失败自动退 config.<brand>.fallback.strategies 静态快照（fallbackUsed=true）。
 *     stdout 输出 JSON：{ ok, brand, label, excludeL1, total, fallbackUsed, rows }
 *
 *   node sync.js sync --brand <brand> --input <items.json> [--dry-run]
 *     内容策略沉淀：按「内容方向一|内容方向二」聚合素材 → 与表内已有方向合并：
 *       - 已有方向：AI 查重（打法概括+推理链口径，见《内容策略表字段填写指南》3.4）
 *         · duplicate → 仅并入素材链接ids
 *         · new → 追加【素材补充 <id>】块（同时并入素材链接ids）
 *         · 合并适合达人（宽/窄类型粒度规则，幂等）
 *       - 新方向：新建策略行（等级取 config.levelForNewStrategy，默认 X），正向案例=script
 *       - 落表前自动扩充「内容方向一/二」select 选项（飞书不会自动建选项）
 *     查重 AI 失败时全部视为"仅并入素材链接ids"（策略文本不动，宁可少存不堆重复）。
 *     --dry-run 只读+查重，不写表，输出 wouldCreate/wouldUpdate 预览。
 *     stdout 输出 JSON：{ ok, created, updated, appended, mergedOnly, items, skipped, ... }
 *
 *   node sync.js regen --brand <brand> [--record-id <recXXX>] [--dry-run]
 *     按正向案例重写「植入策略」：逐行取正向案例脚本原文 → AI 按《内容策略表字段
 *     填写指南》标准生成植入策略（打法概括 + 取材于真实脚本的推理链示例）→ 回写。
 *     正向案例为空的行自动跳过（不臆造）。--record-id 只处理指定行。
 *     stdout 输出 JSON：{ ok, processed, skipped, dryRun, results:[{recordId,l1,l2,placement}] }
 *
 * 输入文件 schema（sync 用）：
 *   { "items": [ { "id": "dy_xxx（评论洞察）", "script": "脚本原文",
 *       "source": "material|comment_insight",
 *       "strategy": { "内容方向一": "...", "内容方向二": "...",
 *                     "方向定义": "...（= 二级方向定义，写入「内容二方向定义」列）",
 *                     "一级方向定义": "...（仅新建一级方向时才需要；已有的一级自动继承，无需传）",
 *                     "植入策略": "...", "适合达人": "..." } } ] }
 *
 * 定义两列（2026-09-21 起）：
 *   「内容一方向定义」= 一级方向定义，同一级下各行必须逐字一致（程序新建二级时自动继承同级的）；
 *   「内容二方向定义」= 二级方向定义，每行各写自己的，用于同级之间互相区分。
 *
 * 日志一律走 stderr，stdout 只输出结果 JSON（供调用方 execSync 解析）。
 */

const fs = require('fs');
const path = require('path');

const brand = require('./lib/brand');
const { runLarkCli, cellText, normalizeDirectionValue } = require('./lib/lark');

// 策略表字段名（两品牌表结构一致；如未来某品牌字段改名，可在 config.fields 覆盖）
const F = {
  dir1: '内容方向一',
  dir2: '内容方向二',
  level: '策略等级',
  definition: '内容一方向定义',      // 一级方向定义（同一级下各行应完全一致）
  l2Definition: '内容二方向定义',    // 二级方向定义（每行各写自己的）
  placement: '植入策略',
  materialIds: '素材链接ids',
  suited: '适合达人',
  positiveCase: '正向案例'
};

function log(msg) {
  process.stderr.write(msg + '\n');
}

// ============ 读表 ============

/** 读策略表原始行 → 归一化 rows（list/sync 共用；sync 必须传 fresh 即每次现读） */
function fetchTableRows(cfg) {
  const st = cfg.strategyTable;
  const fields = { ...F, ...(cfg.fields || {}) };
  const output = runLarkCli([
    'base', '+record-list',
    '--base-token', st.baseToken,
    '--table-id', st.tableId,
    '--limit', String(cfg.rowLimit || 200),
    '--format', 'json'
  ]);
  const data = JSON.parse(output)?.data || {};
  const fieldNames = data.fields || [];
  const rawRows = data.data || [];
  const recordIds = data.record_id_list || [];
  const idx = {};
  Object.values(fields).forEach(name => { idx[name] = fieldNames.indexOf(name); });
  const at = (row, name) => (idx[name] >= 0 ? cellText(row[idx[name]]) : '');

  return rawRows.map((row, i) => ({
    recordId: recordIds[i] || null,
    l1: normalizeDirectionValue(at(row, fields.dir1)),
    l2: normalizeDirectionValue(at(row, fields.dir2)),
    level: at(row, fields.level),
    definition: at(row, fields.definition),
    l2Definition: at(row, fields.l2Definition),
    placement: at(row, fields.placement),
    materialIds: at(row, fields.materialIds),
    suited: at(row, fields.suited),
    positiveCase: at(row, fields.positiveCase)
  }));
}

/** rows → Map「l1|l2」→ {recordId, placement, materialIds, suited}（跳过缺方向的行） */
function buildRecordsMap(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.l1 || !r.l2) continue;
    map.set(`${r.l1}|${r.l2}`, {
      recordId: r.recordId,
      placement: r.placement,
      materialIds: r.materialIds,
      suited: r.suited
    });
  }
  return map;
}

// ============ 子命令：list ============

function cmdList(cfg) {
  const st = cfg.strategyTable;
  try {
    const rows = fetchTableRows(cfg);
    log(`📋 ${st.label || cfg.brandName + '策略表'}：${rows.length} 行`);
    process.stdout.write(JSON.stringify({
      ok: true,
      brand: cfg.brand,
      brandName: cfg.brandName,
      label: st.label || '',
      excludeL1: st.excludeL1 || [],
      total: rows.length,
      fallbackUsed: false,
      rows
    }, null, 2) + '\n');
  } catch (error) {
    const fallback = (cfg.fallback && cfg.fallback.strategies) || [];
    log(`⚠️ 策略表读取失败，使用静态快照兜底（${fallback.length} 行）: ${error.message.substring(0, 200)}`);
    process.stdout.write(JSON.stringify({
      ok: true,
      brand: cfg.brand,
      brandName: cfg.brandName,
      label: st.label || '',
      excludeL1: st.excludeL1 || [],
      total: fallback.length,
      fallbackUsed: true,
      error: error.message.substring(0, 300),
      rows: fallback.map(s => ({
        recordId: null,
        l1: normalizeDirectionValue(s.l1),
        l2: normalizeDirectionValue(s.l2),
        level: s.level || '',
        definition: s.definition || '',
        l2Definition: s.l2Definition || '',
        placement: '',
        materialIds: '',
        suited: ''
      }))
    }, null, 2) + '\n');
  }
}

// ============ AI 查重 ============

/** 查重：新素材植入策略 vs 已有策略是否同一套打法逻辑（指南 3.4 口径）。
 *  返回 per-item ['duplicate'|'new']；失败返回 null（调用方全部仅并入素材ids）。 */
async function dedupeStrategies(cfg, existingStrategyText, items) {
  const ai = cfg.ai || {};
  const model = process.env.DEEPSEEK_MODEL || process.env.DOUBAO_MODEL || ai.defaultModel || 'doubao-seed-2-1-pro';
  try {
    const verdicts = new Array(items.length).fill('new');
    const listText = items.map((r, i) => `【素材${i + 1} ${r.id}】${r.strategy['植入策略']}`).join('\n\n');
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

    const baseUrl = (process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AIHUBMIX_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是一个内容策略分析专家，只输出JSON，不输出任何其他内容。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: ai.maxTokens || 512,
        temperature: ai.temperature ?? 0.1
      }),
      signal: AbortSignal.timeout((ai.timeoutSec || 60) * 1000)
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
    // 返回 null（区别于全 new）：调用方只并入素材链接ids、不动策略文本，
    // 避免 API 故障时把重复补充段粘进策略（粘进去后不会自动清理）
    log(`⚠️ 策略查重失败（本轮仅并入素材链接ids，策略文本不更新，下轮重试）: ${error.message.substring(0, 150)}`);
    return null;
  }
}

// ============ 适合达人合并 ============

/** 「达人类型：」行的分隔符：表内主流用中文分号「；」，历史行也有「、」「，」。
 *  必须兼容全部四种，否则「财经-小微企业主；财经-泛财经」会被当成单个 token
 *  整体塞入，导致重复（2026-09-18 修复）。输出统一用「；」。 */
const SUITED_SEP = /[、，,；;]/;
const SUITED_JOIN = '；';

/** token 归一化：仅用于**比对判重**，不改变写回原文。
 *  剥离「（依据素材实测视频分析）」这类括号说明后缀 —— 否则行上写
 *  「财经-泛财经（依据素材实测视频分析）」、新素材写「财经-泛财经」时会被判为
 *  两个不同 token，导致重复（2026-09-18 修复）。 */
const canon = t => String(t || '').replace(/[（(][^）)]*[）)]/g, '').trim();

/** 合并「适合达人」：新素材里行上未覆盖的达人类型并入「达人类型：」行（幂等）。
 *  粒度规则（2026-09-09 约定）：整个一级类型适用只写一级；仅限某二级才写「一级-二级」。
 *  宽(一级)覆盖窄(一级-二级)；行上有窄、新素材判宽 → 窄收敛为宽。
 *  比对统一走 canon()（剥括号后缀）与 SUITED_SEP（兼容、，,；;），写回原文保留原样。 */
function mergeSuitedInfluencers(existing, items) {
  const existingText = (existing || '').trim();
  const lines = existingText ? existingText.split('\n') : [];
  const ti = lines.findIndex(l => /^达人类型[:：]/.test(l.trim()));
  let tokens = [];
  if (ti >= 0) {
    tokens = lines[ti].replace(/^达人类型[:：]\s*/, '').split(SUITED_SEP).map(s => s.trim()).filter(Boolean);
  }
  const isNarrow = t => canon(t).includes('-');
  const primaryOf = t => canon(t).split('-')[0];
  const tokenCanon = tokens.map(canon);
  const adds = [];
  const addCanon = [];
  const replaceMap = {};
  for (const r of items) {
    const suited = r.strategy?.['适合达人'] || '';
    const m = suited.match(/达人类型[:：]\s*([^\n]+)/);
    if (!m) continue;
    for (const seg of m[1].split(SUITED_SEP)) {
      const t = seg.trim();
      if (!t) continue;
      const ct = canon(t);
      if (!ct) continue;
      if (isNarrow(t)) {
        if (tokenCanon.includes(ct) || tokenCanon.includes(primaryOf(t))) continue;
        if (!addCanon.includes(ct)) { adds.push(t); addCanon.push(ct); }
      } else {
        if (tokenCanon.includes(ct)) continue;
        const narrower = tokens.filter(tok => canon(tok).startsWith(ct + '-'));
        if (narrower.length > 0) {
          narrower.forEach(tok => { replaceMap[tok] = t; });
        } else if (!addCanon.includes(ct)) {
          adds.push(t); addCanon.push(ct);
        }
      }
    }
  }
  if (adds.length === 0 && Object.keys(replaceMap).length === 0) return existingText;
  if (lines.length === 0) {
    const first = items.find(r => r.strategy?.['适合达人']);
    return first ? first.strategy['适合达人'] : existingText;
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
  const typeLine = '达人类型：' + finalTokens.join(SUITED_JOIN);
  const otherLines = lines.filter(l => !/^达人类型[:：]/.test(l.trim()));
  return [typeLine, ...otherLines].join('\n');
}

// ============ select 选项扩充 ============

/** 确保 select 字段包含给定选项（飞书不会自动创建不存在的选项）。返回实际新增列表。 */
function ensureSelectOptions(cfg, fieldName, values) {
  const needed = [...new Set(values.map(v => normalizeDirectionValue(v)).filter(Boolean))];
  if (needed.length === 0) return [];

  // field-update 是全量 PUT，必须先读后改
  const resp = JSON.parse(runLarkCli([
    'base', '+field-get',
    '--base-token', cfg.strategyTable.baseToken,
    '--table-id', cfg.strategyTable.tableId,
    '--field-id', fieldName,
    '--format', 'json'
  ]));
  const field = resp?.data?.field;
  if (!field || field.type !== 'select') throw new Error(`字段 ${fieldName} 不存在或不是单选类型`);

  const existingNames = new Set((field.options || []).map(o => o.name));
  const toAdd = needed.filter(v => !existingNames.has(v));
  if (toAdd.length === 0) return [];

  const updated = {
    name: field.name,
    type: field.type,
    multiple: field.multiple === true,
    options: [...(field.options || []), ...toAdd.map(name => ({ name }))]
  };
  const updateResp = JSON.parse(runLarkCli([
    'base', '+field-update',
    '--base-token', cfg.strategyTable.baseToken,
    '--table-id', cfg.strategyTable.tableId,
    '--field-id', field.id,
    '--json', JSON.stringify(updated),
    '--yes',
    '--format', 'json'
  ]));
  if (!updateResp?.ok) throw new Error(`更新字段 ${fieldName} 失败: ${JSON.stringify(updateResp).substring(0, 200)}`);
  log(`🆕 策略表字段「${fieldName}」新增选项: ${toAdd.join('、')}`);
  return toAdd;
}

// ============ 子命令：sync ============

async function cmdSync(cfg, input, { dryRun = false } = {}) {
  const fields = { ...F, ...(cfg.fields || {}) };
  const items = (input.items || []).map(it => {
    const s = it.strategy || {};
    // 归一化方向值（与读表侧同一规则，防止 select 选项分裂）
    s['内容方向一'] = normalizeDirectionValue(s['内容方向一']);
    s['内容方向二'] = normalizeDirectionValue(s['内容方向二']);
    return { id: it.id || '', script: it.script || '', source: it.source || 'material', strategy: s };
  }).filter(it => it.strategy['内容方向一'] && it.strategy['内容方向二']);

  const skippedItems = (input.items || []).length - items.length;
  if (skippedItems > 0) log(`⚠️ ${skippedItems} 条素材缺内容方向，跳过沉淀`);
  if (items.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, created: 0, updated: 0, appended: 0, mergedOnly: 0, items: 0, skipped: skippedItems, dryRun }) + '\n');
    return;
  }

  // 写表路径强制实时读，绝不能用旧快照做合并写入
  let existing;
  const l1DefMap = new Map(); // 一级方向 → 一级定义（取已有行里的第一个非空值，新建二级时继承）
  try {
    const rawRows = fetchTableRows(cfg);
    existing = buildRecordsMap(rawRows);
    for (const r of rawRows) {
      if (r.l1 && r.definition && !l1DefMap.has(r.l1)) l1DefMap.set(r.l1, r.definition);
    }
  } catch (error) {
    log(`❌ 读取策略表失败，跳过同步: ${error.message.substring(0, 200)}`);
    process.stdout.write(JSON.stringify({ ok: false, error: 'read_failed', detail: error.message.substring(0, 300), created: 0, updated: 0, appended: 0, mergedOnly: 0, items: items.length, skipped: items.length + skippedItems, dryRun }) + '\n');
    return;
  }
  log(`📋 策略表现有 ${existing.size} 个方向组合${dryRun ? '（dry-run：只读+查重，不写表）' : ''}`);

  // 按方向组合聚合
  const grouped = new Map();
  for (const r of items) {
    const key = `${r.strategy['内容方向一']}|${r.strategy['内容方向二']}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  const createRecords = [];
  const updateRecords = {};
  let created = 0, updated = 0, appended = 0, mergedOnly = 0;

  for (const [key, group] of grouped) {
    const [dir1, dir2] = key.split('|');
    const exist = existing.get(key);

    if (exist && exist.recordId) {
      // 已有方向：先查重——策略逻辑重复的只并入素材链接ids，有实质差异的才追加【素材补充】
      const verdicts = await dedupeStrategies(cfg, exist.placement, group);
      const dedupeOk = verdicts !== null;
      const dupCount = dedupeOk ? verdicts.filter(v => v === 'duplicate').length : group.length;
      const newItems = dedupeOk ? group.filter((_, i) => verdicts[i] === 'new') : [];
      appended += newItems.length;
      mergedOnly += dedupeOk ? dupCount : group.length;

      const mergedIds = [...new Set([
        ...(exist.materialIds ? exist.materialIds.split('、') : []),
        ...group.map(r => r.id)
      ])].join('、');
      const updateFields = { [fields.materialIds]: mergedIds };
      if (newItems.length > 0) {
        const supplements = newItems.map(r => `【素材补充 ${r.id}】${r.strategy['植入策略']}`).join('\n\n');
        updateFields[fields.placement] = `${exist.placement}\n\n${supplements}`;
      }
      const mergedSuited = mergeSuitedInfluencers(exist.suited, group);
      if (mergedSuited && mergedSuited !== (exist.suited || '')) {
        updateFields[fields.suited] = mergedSuited;
      }
      updateRecords[exist.recordId] = updateFields;
      updated += 1;
      log(dedupeOk
        ? `🔄 已有方向「${dir1}-${dir2}」：${group.length} 条中 ${dupCount} 条重复（仅并入素材ids）、${newItems.length} 条新打法（追加素材补充）`
        : `🔄 已有方向「${dir1}-${dir2}」：查重失败，${group.length} 条全部仅并入素材ids（策略文本未动）`);
    } else {
      // 新方向：新建策略行（等级取 config，默认 X = 创意洞察未经业务验证）
      const first = group[0];
      let placement = first.strategy['植入策略'];
      if (group.length > 1) {
        const verdicts = await dedupeStrategies(cfg, placement, group.slice(1));
        const dedupeOk = verdicts !== null;
        const newItems = dedupeOk ? group.slice(1).filter((_, i) => verdicts[i] === 'new') : [];
        appended += newItems.length;
        mergedOnly += dedupeOk ? (group.length - 1 - newItems.length) : (group.length - 1);
        if (newItems.length > 0) {
          placement += '\n\n' + newItems.map(r => `【素材补充 ${r.id}】${r.strategy['植入策略']}`).join('\n\n');
        }
        const dupCount = dedupeOk ? group.length - 1 - newItems.length : group.length - 1;
        log(dedupeOk
          ? `↳ 新方向查重：${dupCount} 条重复（仅并入素材ids）、${newItems.length} 条追加补充`
          : `↳ 新方向查重失败：${group.length - 1} 条全部仅并入素材ids（策略文本未动）`);
      }
      const l1Def = l1DefMap.get(dir1) || first.strategy['一级方向定义'] || '';
      createRecords.push({
        [fields.dir1]: [dir1],
        [fields.dir2]: [dir2],
        // 一级定义：优先继承该一级已有行的定义（保证同级逐字一致）；全新一级才用 AI 给的「一级方向定义」
        [fields.definition]: l1Def,
        // 二级定义：本行的方向定义
        [fields.l2Definition]: first.strategy['方向定义'] || '',
        [fields.placement]: placement,
        [fields.level]: [cfg.levelForNewStrategy || 'X'],
        [fields.suited]: first.strategy['适合达人'] || '',
        [fields.materialIds]: group.map(r => r.id).join('、'),
        [fields.positiveCase]: first.script || ''
      });
      created += 1;
      log(`➕ 新方向「${dir1}-${dir2}」：新建策略行（等级 ${cfg.levelForNewStrategy || 'X'}）`);
      if (!l1Def) log(`   ⚠️ 一级「${dir1}」无一级定义（表里既没有、AI 也没给），「内容一方向定义」留空，需人工补写`);
    }
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify({
      ok: true, dryRun: true,
      created, updated, appended, mergedOnly,
      items: items.length, skipped: skippedItems,
      wouldCreate: createRecords,
      wouldUpdate: updateRecords
    }, null, 2) + '\n');
    return;
  }

  let skipped = 0;
  try {
    if (createRecords.length > 0) {
      // 新方向落表前先扩 select 选项；失败则放弃新建（不产生脏选项）
      try {
        ensureSelectOptions(cfg, fields.dir1, createRecords.map(r => r[fields.dir1][0]));
        ensureSelectOptions(cfg, fields.dir2, createRecords.map(r => r[fields.dir2][0]));
      } catch (error) {
        log(`❌ 策略表选项扩充失败，跳过 ${createRecords.length} 条新方向写入: ${error.message.substring(0, 200)}`);
        skipped += createRecords.length;
        createRecords.length = 0;
      }
    }
    if (createRecords.length > 0) {
      const resp = JSON.parse(runLarkCli([
        'base', '+record-batch-create',
        '--base-token', cfg.strategyTable.baseToken,
        '--table-id', cfg.strategyTable.tableId,
        '--json', JSON.stringify({ create_records: createRecords }),
        '--format', 'json'
      ]));
      if (!resp?.ok) throw new Error(JSON.stringify(resp).substring(0, 300));
    }
    if (Object.keys(updateRecords).length > 0) {
      const resp = JSON.parse(runLarkCli([
        'base', '+record-batch-update',
        '--base-token', cfg.strategyTable.baseToken,
        '--table-id', cfg.strategyTable.tableId,
        '--json', JSON.stringify({ update_records: updateRecords }),
        '--format', 'json'
      ]));
      if (!resp?.ok) throw new Error(JSON.stringify(resp).substring(0, 300));
    }
    log(`✅ 内容策略同步完成：新建 ${created} 行，更新 ${updated} 行${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`);
    process.stdout.write(JSON.stringify({ ok: true, dryRun: false, created, updated, appended, mergedOnly, items: items.length, skipped }) + '\n');
  } catch (error) {
    log(`❌ 策略表写入失败: ${error.message.substring(0, 300)}`);
    process.stdout.write(JSON.stringify({ ok: false, error: 'write_failed', detail: error.message.substring(0, 300), created: 0, updated: 0, appended: 0, mergedOnly: 0, items: items.length, skipped: items.length }) + '\n');
  }
}

// ============ 子命令：regen（按正向案例重写植入策略） ============

/** AI 依据正向案例脚本原文生成植入策略（指南口径：打法概括 + 取材真实脚本的推理链示例） */
async function generatePlacement(cfg, row) {
  const ai = cfg.ai || {};
  const model = process.env.DEEPSEEK_MODEL || process.env.DOUBAO_MODEL || ai.defaultModel || 'doubao-seed-2-1-pro';
  const baseUrl = (process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1').replace(/\/$/, '');
  const prompt = `你在维护一张短视频内容策略表。下面是一个内容方向的定义和它的正向案例脚本原文（该方向下已验证效果不错的真实视频脚本）。请**只依据脚本原文**产出这个方向的「植入策略」。

# 内容方向
一级：${row.l1} / 二级：${row.l2}
一级方向定义：${row.definition || '（无）'}
二级方向定义：${row.l2Definition || '（无）'}

# 正向案例脚本原文
${row.positiveCase}

# 植入策略字段标准（必须严格遵守）
1. 第一行：打法概括——用一句话（「打法「……」」句式）概括这类脚本用什么叙事手法把观众带入、在什么时机转折到产品。
2. **打法概括只写叙事逻辑，禁止混入表现形式**：对话体/双人问答/单人咆哮/自述体/剧情演绎等属「拍摄方式」维度（与达人风格、内容方向是独立维度），写进打法会把方向锁死在某种拍摄方式上、口播达人无法复用。叙事逻辑层才能复用（如"认知翻转开场"而非"夫妻对话制造翻转"、"连续反问解谜"而非"双人问答拆解"）。
3. 之后 1-2 个示例：每个示例对应脚本里一段**真实存在的**完整走法，写清三层推理链——① 内容层用什么话术/场景/情绪抓住观众 → ② 转折点在哪、靠什么支点（提问/事件/情绪顶点）过渡 → ③ 产品以什么身份承接、点了哪些卖点。示例必须引用或紧贴脚本原话，**禁止虚构脚本里没有的情节**。
4. 示例末尾可用「注：」单独说明该正向案例的表现形式（如对话体的独特优势），并注明表现形式可替换、不影响叙事逻辑复用——表现形式细节只放这里，不进打法概括。
5. 不写空话套话（如"自然过渡""巧妙植入"这类不落地的表述）；每个示例都要能让没看过视频的人照着复刻。
6. 多个正向案例（【正向案例1】【正向案例2】分隔）时，每个案例提炼一个示例。
7. 不要输出方向定义，不要评价脚本好坏，只写植入策略本身。

只输出JSON：{"植入策略": "生成的完整文本"}，文本内用 \\n 分行。`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是短视频内容策略分析师，擅长从真实脚本中提炼可复用的植入打法。只输出JSON，不输出任何其他内容。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: ai.temperature ?? 0.2
    }),
    // 长文本生成为主，60s 档位必然不够；取 config 与 300s 的较大值
    signal: AbortSignal.timeout(Math.max((ai.timeoutSec || 60), 300) * 1000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
  const text = String(parsed['植入策略'] || '').trim();
  if (!text) throw new Error('AI 返回空植入策略');
  return text;
}

async function cmdRegen(cfg, { recordId = null, dryRun = false } = {}) {
  const fields = { ...F, ...(cfg.fields || {}) };
  let rows;
  try {
    rows = fetchTableRows(cfg);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'read_failed', detail: error.message.substring(0, 300), processed: 0, skipped: 0 }) + '\n');
    return;
  }

  // 过滤：有正向案例才处理（正向案例空 → 不臆造，跳过）
  let targets = rows.filter(r => r.recordId && r.positiveCase);
  if (recordId) targets = targets.filter(r => r.recordId === recordId);
  const skipped = rows.filter(r => r.recordId && !r.positiveCase).length
    + (recordId && !targets.length ? 1 : 0);
  log(`📋 策略表 ${rows.length} 行，其中 ${targets.length} 行有正向案例待重写${recordId ? `（限定 ${recordId}）` : ''}，${skipped} 行无正向案例跳过`);
  if (targets.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, processed: 0, skipped, dryRun, results: [] }) + '\n');
    return;
  }

  const results = [];
  let failed = 0;
  for (const row of targets) {
    const label = `${row.l1}-${row.l2}`;
    try {
      const placement = await generatePlacement(cfg, row);
      results.push({ recordId: row.recordId, l1: row.l1, l2: row.l2, placement });
      log(`✅ ${label}：植入策略已生成（${placement.length} 字）`);
    } catch (error) {
      failed += 1;
      log(`❌ ${label}：生成失败 ${error.message.substring(0, 150)}`);
    }
  }

  if (dryRun || results.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, processed: results.length, failed, skipped, dryRun, results }) + '\n');
    return;
  }

  try {
    const updateRecords = {};
    for (const r of results) updateRecords[r.recordId] = { [fields.placement]: r.placement };
    const resp = JSON.parse(runLarkCli([
      'base', '+record-batch-update',
      '--base-token', cfg.strategyTable.baseToken,
      '--table-id', cfg.strategyTable.tableId,
      '--json', JSON.stringify({ update_records: updateRecords }),
      '--format', 'json'
    ]));
    if (!resp?.ok) throw new Error(JSON.stringify(resp).substring(0, 300));
    log(`✅ 植入策略回写完成：${results.length} 行${failed > 0 ? `（${failed} 行生成失败未动）` : ''}`);
    process.stdout.write(JSON.stringify({ ok: true, processed: results.length, failed, skipped, dryRun, results }) + '\n');
  } catch (error) {
    log(`❌ 回写失败: ${error.message.substring(0, 300)}`);
    process.stdout.write(JSON.stringify({ ok: false, error: 'write_failed', detail: error.message.substring(0, 300), processed: 0, failed, skipped, results }) + '\n');
  }
}

// ============ 入口 ============

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!['list', 'sync', 'regen'].includes(sub)) {
    process.stderr.write('用法: node sync.js <list|sync|regen> [--brand <brand>] [--input <file>] [--record-id <id>] [--dry-run]\n');
    process.exit(2);
  }
  const brandName = brand.resolveBrand();
  brand.loadEnv(brandName);
  const cfg = brand.loadBrandConfig(brandName);

  if (sub === 'list') {
    cmdList(cfg);
    return;
  }
  if (sub === 'regen') {
    const ri = argv.indexOf('--record-id');
    await cmdRegen(cfg, {
      recordId: ri >= 0 ? argv[ri + 1] : null,
      dryRun: argv.includes('--dry-run')
    });
    return;
  }
  const idx = argv.indexOf('--input');
  const inputFile = idx >= 0 ? argv[idx + 1] : null;
  if (!inputFile || !fs.existsSync(inputFile)) {
    process.stderr.write(`❌ sync 需要 --input <file>（存在且可读）: ${inputFile}\n`);
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  await cmdSync(cfg, input, { dryRun: argv.includes('--dry-run') });
}

main().catch(error => {
  process.stderr.write(`❌ 未捕获异常: ${error.stack || error.message}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: 'uncaught', detail: String(error.message).substring(0, 300) }) + '\n');
  process.exit(1);
});
