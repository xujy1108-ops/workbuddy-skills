#!/usr/bin/env node
/**
 * 度小满策略素材同步到策略库脚本
 * 
 * 从审核表中读取审核状态为"已通过"的记录，
 * 按入库目标（热点/非热点）追加到对应的策略库飞书文档。
 * 
 * 用法：node --env-file=<env_path> sync_to_strategy.js
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
const REVIEW_TABLE_ID = process.env.REVIEW_TABLE_ID || 'tblX7a3YpwLExN7Z';

// 策略库文档 token
const STRATEGY_LIB = {
  '非热点': 'BBx1dVk5aoNIn6xgON2cppNKnkb',
  '热点': 'SHdXdI0KQoJbfwxNq4mcePL5nxb'
};

// 保存代理设置，lark-cli 走代理访问飞书
const SAVED_PROXY = {};
['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].forEach(k => {
  if (process.env[k]) SAVED_PROXY[k] = process.env[k];
});
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

// ==================== 工具函数 ====================

function larkCliRaw(args) {
  return execSync(`lark-cli ${args} --as user 2>/dev/null`, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...SAVED_PROXY }
  });
}

function larkCli(args) {
  const raw = larkCliRaw(args);
  const lines = raw.split('\n').filter(l => !l.startsWith('[lark-cli]'));
  return JSON.parse(lines.join('\n').trim());
}

function fetchRecords(baseToken, tableId, fieldIds) {
  const outputFile = `sync_review_${Date.now()}.ndjson`;
  const fieldArgs = fieldIds.map(f => `--field-id ${f}`).join(' ');
  const cmd = `base +record-list --base-token ${baseToken} --table-id ${tableId} ${fieldArgs} --format ndjson --output ${outputFile}`;
  
  const raw = larkCliRaw(cmd);
  const manifest = JSON.parse(raw);
  const recordFile = manifest.record_file;
  
  if (!recordFile || !fs.existsSync(recordFile)) {
    throw new Error(`NDJSON file not found: ${recordFile}`);
  }
  
  const records = [];
  const data = fs.readFileSync(recordFile, 'utf8');
  for (const line of data.split('\n')) {
    if (line.trim()) records.push(JSON.parse(line));
  }
  
  // 清理
  try { fs.unlinkSync(recordFile); } catch(e) {}
  try { fs.unlinkSync(outputFile); } catch(e) {}
  
  return records;
}

// ==================== 主流程 ====================

async function main() {
  console.log('=== 策略素材同步到策略库 ===\n');

  // Step 1: 拉取审核表中已通过的记录
  console.log('Step 1: 拉取审核表中已通过的记录...');
  
  // 先获取字段列表确认 field_id
  const fieldList = larkCli(`base +field-list --base-token ${BASE_TOKEN} --table-id ${REVIEW_TABLE_ID}`);
  const fields = fieldList.data?.fields || [];
  const fieldMap = {};
  for (const f of fields) {
    fieldMap[f.name] = f.id;
  }
  
  const neededFields = ['脚本主题', 'AI建议-钩子', 'AI建议-承接', 'AI建议-转折', 'AI建议-角色定位', '评分等级', '入库目标', '审核状态'];
  const fieldIds = neededFields.map(name => fieldMap[name]).filter(Boolean);
  
  // 用 filter 筛选审核状态=已通过
  const filterJson = JSON.stringify({
    logic: 'and',
    conditions: [['审核状态', 'intersects', ['已通过']]]
  });
  
  const outputFile = `sync_approved_${Date.now()}.ndjson`;
  const fieldArgs = fieldIds.map(f => `--field-id ${f}`).join(' ');
  
  try {
    const raw = larkCliRaw(`base +record-list --base-token ${BASE_TOKEN} --table-id ${REVIEW_TABLE_ID} ${fieldArgs} --filter-json '${filterJson}' --format ndjson --output ${outputFile}`);
    const manifest = JSON.parse(raw);
    const recordFile = manifest.record_file;
    
    if (!recordFile || !fs.existsSync(recordFile)) {
      console.log('  没有找到已通过的记录');
      return;
    }
    
    const approved = [];
    const data = fs.readFileSync(recordFile, 'utf8');
    for (const line of data.split('\n')) {
      if (line.trim()) approved.push(JSON.parse(line));
    }
    
    try { fs.unlinkSync(recordFile); } catch(e) {}
    try { fs.unlinkSync(outputFile); } catch(e) {}
    
    console.log(`  已通过记录: ${approved.length} 条\n`);
    
    if (approved.length === 0) {
      console.log('没有需要同步的记录。');
      console.log('请在审核表中将审核状态改为"已通过"后再运行。');
      return;
    }

    // Step 2: 按入库目标分组（保留 record_id 用于状态回写）
    const groups = { '非热点': [], '热点': [] };
    for (const rec of approved) {
      const target = rec['入库目标'];
      if (Array.isArray(target) && target.length > 0) {
        const t = target[0];
        if (groups[t]) groups[t].push(rec);
      }
    }
    
    console.log(`  非热点: ${groups['非热点'].length} 条`);
    console.log(`  热点: ${groups['热点'].length} 条\n`);

    // Step 3: 追加到策略库文档
    for (const [target, records] of Object.entries(groups)) {
      if (records.length === 0) continue;
      
      const docToken = STRATEGY_LIB[target];
      if (!docToken) {
        console.log(`  未知入库目标: ${target}，跳过`);
        continue;
      }
      
      console.log(`Step 2: 追加到策略库（${target}）...`);
      console.log(`  文档: https://kwza968lz1u.feishu.cn/docx/${docToken}`);
      
      // 构造追加内容
      let content = '\n\n---\n\n## 待补充素材（' + new Date().toLocaleDateString('zh-CN') + ' 审核）\n\n';
      
      for (const rec of records) {
        const topic = rec['脚本主题'] || '';
        const grade = Array.isArray(rec['评分等级']) ? rec['评分等级'][0] : '';
        const hook = rec['AI建议-钩子'] || '';
        const chengJie = rec['AI建议-承接'] || '';
        const transition = rec['AI建议-转折'] || '';
        const role = rec['AI建议-角色定位'] || '';
        
        content += `### ${topic}（${grade}级）\n\n`;
        if (hook) content += `**钩子**：${hook}\n\n`;
        if (chengJie) content += `**承接**：${chengJie}\n\n`;
        if (transition) content += `**转折**：${transition}\n\n`;
        if (role) content += `**角色定位**：${role}\n\n`;
        content += '\n';
      }
      
      // 写入临时文件
      const tmpFile = `/tmp/sync_content_${target}.md`;
      fs.writeFileSync(tmpFile, content);
      
      // 用 lark-cli docs +update append 追加到文档末尾
      let appendOk = false;
      try {
        const result = larkCli(`docs +update --doc ${docToken} --command append --doc-format markdown --content @${tmpFile}`);
        console.log(`  ✓ 追加成功`);
        appendOk = true;
      } catch (e) {
        console.log(`  ✗ 追加失败: ${e.message}`);
      }
      
      fs.unlinkSync(tmpFile);

      // 追加成功后，把审核状态回写为"已入库"，避免重复同步
      if (appendOk) {
        const recordIds = records.map(r => r._record_id).filter(Boolean);
        for (let i = 0; i < recordIds.length; i += 100) {
          const chunk = recordIds.slice(i, i + 100);
          const updateMap = {};
          for (const rid of chunk) updateMap[rid] = { '审核状态': ['已入库'] };
          const tmpUpdate = `/tmp/review_status_update_${target}_${i}.json`;
          fs.writeFileSync(tmpUpdate, JSON.stringify({ update_records: updateMap }));
          try {
            larkCli(`base +record-batch-update --base-token ${BASE_TOKEN} --table-id ${REVIEW_TABLE_ID} --json @${tmpUpdate}`);
            console.log(`  ✓ 状态已回写为"已入库"（${chunk.length} 条）`);
          } catch (e) {
            console.log(`  ⚠ 状态回写失败（不影响文档追加，但重跑会重复同步）: ${e.message}`);
          }
          fs.unlinkSync(tmpUpdate);
        }
      }
    }
    
    console.log(`\n=== 完成！同步了 ${approved.length} 条素材到策略库 ===`);
    console.log('\n注意：追加的素材在策略库文档末尾的"待补充素材"区域，');
    console.log('需要人工整理到对应的方法库分类下。');
    
  } catch (e) {
    console.error('运行失败:', e.message);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
