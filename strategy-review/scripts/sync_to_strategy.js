#!/usr/bin/env node
/**
 * 策略素材同步到策略库脚本（多品牌配置化）
 *
 * 从审核表中读取审核状态为「已通过」的记录，按入库目标追加到对应的策略库飞书文档，
 * 追加成功后把审核状态回写为「已入库」（幂等：重跑不会重复追加）。
 *
 * 品牌私有内容（审核表、策略库文档 token、状态枚举、章节模板）外置在 config/<brand>/。
 *
 * 用法：
 *   node sync_to_strategy.js [--brand duxiaoman]
 *
 * 参数：
 *   --brand <name>   品牌配置目录名（config/<name>/，默认 duxiaoman；env WORKFLOW_BRAND 可兜底）
 */

const fs = require('fs');

const brand = require('./lib/brand');
const lark = require('./lib/lark');

// ==================== 品牌配置 ====================
const BRAND = brand.resolveBrand();
brand.loadEnv(BRAND);
lark.initProxy(); // 必须在 loadEnv 之后：剥离代理，lark-cli 子进程会自动恢复代理
const CFG = brand.loadBrandConfig(BRAND);

const REV = CFG.tables.review;
const LIB = CFG.strategyLib;

const REV_BASE_TOKEN = (REV.envOverride?.baseToken && process.env[REV.envOverride.baseToken]) || REV.baseToken;
const REV_TABLE_ID = (REV.envOverride?.tableId && process.env[REV.envOverride.tableId]) || REV.tableId;

const STATUS = REV.status || {};
const STATUS_APPROVED = STATUS.approved || '已通过';
const STATUS_SYNCED = STATUS.synced || '已入库';
const STATUS_FIELD = REV.fieldNames.status;
const TARGET_FIELD = REV.fieldNames.target;

// 章节模板（品牌配置化：config/<brand>/prompts/sync_section.md）
const SECTION_TEMPLATE = brand.loadPromptFile(BRAND, LIB.sectionTemplate || 'sync_section.md');

// ==================== 主流程 ====================

/** 按入库目标取策略库文档 token；未启用分线时用 docs.default */
function resolveDocToken(target) {
  const docs = LIB.docs || {};
  return docs[target] || docs.default || null;
}

/** 渲染单条素材的 markdown 块 */
function renderRecord(rec) {
  const fn = REV.fieldNames;
  const topic = rec[fn.topic] || '';
  const gradeRaw = rec[fn.grade];
  const grade = Array.isArray(gradeRaw) ? gradeRaw[0] : (gradeRaw || '');

  let block = `### ${topic}（${grade}级）\n\n`;
  for (const item of LIB.recordFields || []) {
    const val = rec[fn[item.field]];
    if (val) block += `**${item.label}**：${val}\n\n`;
  }
  return block;
}

async function main() {
  console.log(`=== ${CFG.syncTitle || CFG.brandName + '策略素材同步到策略库'} ===`);
  console.log(`品牌: ${BRAND}（${CFG.brandName}）\n`);

  // Step 1: 拉取审核表中已通过的记录
  console.log(`Step 1: 拉取${REV.label || '审核表'}中已通过的记录...`);

  const neededFieldNames = [
    REV.fieldNames.topic, REV.fieldNames.grade, REV.fieldNames.target, REV.fieldNames.status,
    ...(LIB.recordFields || []).map(item => REV.fieldNames[item.field])
  ].filter(Boolean);

  const filterJson = JSON.stringify({
    logic: 'and',
    conditions: [[STATUS_FIELD, 'intersects', [STATUS_APPROVED]]]
  });

  let approved;
  try {
    approved = lark.fetchRecords(REV_BASE_TOKEN, REV_TABLE_ID, neededFieldNames, {
      filterJson,
      outputPrefix: 'sync_approved'
    });
  } catch (e) {
    console.error('运行失败:', e.message);
    process.exit(1);
  }

  console.log(`  已通过记录: ${approved.length} 条\n`);

  if (approved.length === 0) {
    console.log('没有需要同步的记录。');
    console.log('请在审核表中将审核状态改为「' + STATUS_APPROVED + '」后再运行。');
    return;
  }

  // Step 2: 按入库目标分组（保留 record_id 用于状态回写）
  const groups = {};
  for (const rec of approved) {
    const raw = rec[TARGET_FIELD];
    const target = Array.isArray(raw) && raw.length > 0 ? raw[0] : (CFG.topicSplit?.default || 'default');
    (groups[target] = groups[target] || []).push(rec);
  }

  for (const [target, records] of Object.entries(groups)) {
    console.log(`  ${target}: ${records.length} 条`);
  }
  console.log('');

  // Step 3: 追加到策略库文档
  for (const [target, records] of Object.entries(groups)) {
    if (records.length === 0) continue;

    const docToken = resolveDocToken(target);
    if (!docToken) {
      console.log(`  ⚠ 未配置入库目标「${target}」对应的策略库文档，跳过 ${records.length} 条`);
      continue;
    }

    console.log(`Step 2: 追加到${LIB.label || '策略库'}（${target}）...`);
    console.log(`  文档: ${LIB.baseUrl || ''}${docToken}`);

    const recordsMd = records.map(renderRecord).join('\n');
    const content = brand.renderTemplate(SECTION_TEMPLATE, {
      BRAND: CFG.brandName,
      DATE: new Date().toLocaleDateString('zh-CN'),
      SECTION_TITLE: '待补充素材',
      RECORDS: recordsMd
    });

    const tmpFile = lark.tmpPath(`sync_content_${target}_${Date.now()}.md`);
    fs.writeFileSync(tmpFile, content);

    if (dryRun) {
      console.log(`  [DRY_RUN] 跳过文档追加与状态回写，待追加内容预览：\n${'-'.repeat(40)}`);
      console.log(content.substring(0, 3000));
      console.log('-'.repeat(40));
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      continue;
    }

    let appendOk = false;
    try {
      lark.larkCli(`docs +update --doc ${docToken} --command append --doc-format markdown --content @${tmpFile}`);
      console.log('  ✓ 追加成功');
      appendOk = true;
    } catch (e) {
      console.log(`  ✗ 追加失败: ${e.message}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    // 追加成功后，把审核状态回写为「已入库」，避免重复同步
    if (appendOk) {
      const recordIds = records.map(r => r._record_id).filter(Boolean);
      for (let i = 0; i < recordIds.length; i += 100) {
        const chunk = recordIds.slice(i, i + 100);
        const updateMap = {};
        for (const rid of chunk) updateMap[rid] = { [STATUS_FIELD]: [STATUS_SYNCED] };
        const tmpUpdate = lark.tmpPath(`review_status_update_${target}_${i}.json`);
        try {
          lark.batchWrite(
            `base +record-batch-update --base-token ${REV_BASE_TOKEN} --table-id ${REV_TABLE_ID}`,
            { update_records: updateMap },
            tmpUpdate
          );
          console.log(`  ✓ 状态已回写为「${STATUS_SYNCED}」（${chunk.length} 条）`);
        } catch (e) {
          console.log(`  ⚠ 状态回写失败（不影响文档追加，但重跑会重复同步）: ${e.message}`);
          try { fs.unlinkSync(tmpUpdate); } catch (_) {}
        }
      }
    }
  }

  console.log(`\n=== 完成！同步了 ${approved.length} 条素材到策略库 ===`);
  console.log('\n注意：追加的素材在策略库文档末尾的「待补充素材」区域，');
  console.log('需要人工整理到对应的方法库分类下。');
}

main().catch(e => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
