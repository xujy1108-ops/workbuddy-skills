#!/usr/bin/env node
/**
 * lark-cli 封装（通用模块）
 *
 * 关键技术点（历史踩坑，勿改）：
 *   1. 代理分治：本机系统代理会让 Node 原生请求连不上 AIHubMix，AI 调用需剥代理走 curl；
 *      而 lark-cli 访问飞书必须走代理 —— 因此调用 lark-cli 时把代理注入子进程 env。
 *   2. NDJSON 拉数：`+record-list --format json` 对大数据不稳，统一用
 *      `--format ndjson --output <file>`，stdout 返回 manifest（含 record_file 路径）再读文件。
 *   3. 字段名解析：先用 +field-list 建「字段名 → field_id」映射，避免在代码里硬编码 field_id。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 保存代理设置后从进程环境中剥离，供 AI 调用（curl）直连
// 惰性初始化：必须在 brand.loadEnv() 之后再剥离，否则 .env 里配的代理会被漏掉
let SAVED_PROXY = null;
function initProxy() {
  if (SAVED_PROXY) return SAVED_PROXY;
  SAVED_PROXY = {};
  ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].forEach(k => {
    if (process.env[k]) SAVED_PROXY[k] = process.env[k];
  });
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  return SAVED_PROXY;
}

/** 调用 lark-cli（恢复代理），返回 stdout 文本；所有命令统一 --as user */
function larkCliRaw(args) {
  initProxy(); // 兜底：任何取数路径都保证代理已按需恢复
  return execSync(`lark-cli ${args} --as user 2>/dev/null`, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...SAVED_PROXY } // 恢复代理给 lark-cli
  });
}

/** 调用 lark-cli，返回解析后的 JSON */
function larkCli(args) {
  const raw = larkCliRaw(args);
  const lines = raw.split('\n').filter(l => !l.startsWith('[lark-cli]'));
  return JSON.parse(lines.join('\n').trim());
}

/** 拉取字段名 → field_id 映射 */
function getFieldMap(baseToken, tableId) {
  const res = larkCli(`base +field-list --base-token ${baseToken} --table-id ${tableId}`);
  const fields = res.data?.fields || res.data?.items || [];
  const map = {};
  for (const f of fields) {
    const name = f.name || f.field_name;
    const id = f.id || f.field_id;
    if (name && id) map[name] = id;
  }
  return map;
}

/**
 * 用 NDJSON 模式拉取记录（按字段名）
 * @param {string} baseToken
 * @param {string} tableId
 * @param {string[]} fieldNames 字段名数组；为空则拉全字段
 * @param {object} [opts] { filterJson, outputPrefix }
 * @returns {object[]} 记录数组
 */
function fetchRecords(baseToken, tableId, fieldNames, opts = {}) {
  const { filterJson, outputPrefix = 'fetch' } = opts;
  const outputFile = `${outputPrefix}_${Date.now()}.ndjson`;

  let fieldArgs = '';
  if (fieldNames && fieldNames.length > 0) {
    const fieldMap = getFieldMap(baseToken, tableId);
    const missing = fieldNames.filter(n => !fieldMap[n]);
    if (missing.length > 0) {
      throw new Error(`表中缺少字段: ${missing.join(', ')}（表 ${tableId}）`);
    }
    fieldArgs = fieldNames.map(n => `--field-id ${fieldMap[n]}`).join(' ');
  }

  const filterArgs = filterJson ? `--filter-json '${filterJson}'` : '';
  const cmd = `base +record-list --base-token ${baseToken} --table-id ${tableId} ${fieldArgs} ${filterArgs} --format ndjson --output ${outputFile}`;

  const raw = larkCliRaw(cmd);
  const manifest = JSON.parse(raw.split('\n').filter(l => !l.startsWith('[lark-cli]')).join('\n').trim());
  const recordFile = manifest.record_file;

  if (!recordFile || !fs.existsSync(recordFile)) {
    throw new Error(`NDJSON record file not found: ${recordFile}`);
  }

  const records = [];
  for (const line of fs.readFileSync(recordFile, 'utf8').split('\n')) {
    if (line.trim()) records.push(JSON.parse(line));
  }

  // 统一记录主键：lark-cli NDJSON 里是 `record_id`（历史代码误用 `_record_id` 导致去重恒失效）
  for (const r of records) {
    if (!r._record_id && r.record_id) r._record_id = r.record_id;
  }

  cleanup([recordFile, outputFile, recordFile.replace('.ndjson', '.manifest.json')]);
  return records;
}

/** 用临时文件批量写入/更新记录（避免命令行长度限制） */
function batchWrite(argsBuilder, payload, tmpFile) {
  fs.writeFileSync(tmpFile, JSON.stringify(payload));
  try {
    const result = larkCli(`${argsBuilder} --json @${tmpFile}`);
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function cleanup(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

/** 临时目录（优先 /tmp） */
function tmpPath(name) {
  const dir = process.env.TMPDIR ? path.join(process.env.TMPDIR, '') : '/tmp/';
  return path.join(dir.replace(/\/$/, ''), name);
}

module.exports = {
  initProxy,
  larkCliRaw,
  larkCli,
  getFieldMap,
  fetchRecords,
  batchWrite,
  cleanup,
  tmpPath
};
