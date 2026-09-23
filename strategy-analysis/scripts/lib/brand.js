'use strict';

/**
 * strategy-analysis 品牌配置加载
 *
 * 品牌选择：--brand 参数 > env WORKFLOW_BRAND > 默认 duxiaoman
 * .env 查找顺序（先找到先用，逐级合并、已存在的进程变量优先）：
 *   1. <skill>/scripts/.env
 *   2. <skill>/.env
 *   3. ../hotspot/.env（同仓库姐妹 skill 的共享凭证）
 *
 * config/<brand>/config.json 必填字段：
 *   brand / brandName / strategyTable.baseToken / strategyTable.tableId
 * 含 TODO_ 占位值的配置会在启动时报错（骨架配置误跑直接拦截）。
 */

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..', '..');

function resolveBrand() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--brand');
  return (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--'))
    ? argv[idx + 1]
    : (process.env.WORKFLOW_BRAND || 'duxiaoman');
}

/** 解析 KEY=VALUE 行（支持引号包裹值；忽略注释与空行） */
function parseEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** 加载 env：分级查找合并；进程已有变量优先（外部显式设置不被文件覆盖） */
function loadEnv(brand) {
  const candidates = [
    path.join(SKILL_ROOT, 'scripts', '.env'),
    path.join(SKILL_ROOT, '.env'),
    path.join(SKILL_ROOT, '..', 'hotspot', '.env')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const vars = parseEnvFile(file);
      for (const [k, v] of Object.entries(vars)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch (error) {
      process.stderr.write(`⚠️ 读取 ${file} 失败（忽略）: ${error.message}\n`);
    }
  }
}

/** 校验配置完整性：必填字段缺失或含 TODO_ 占位即报错退出 */
function validateConfig(cfg, configFile) {
  const problems = [];
  const required = ['brand', 'brandName'];
  for (const key of required) {
    if (!cfg[key]) problems.push(`缺少必填字段 ${key}`);
  }
  const st = cfg.strategyTable || {};
  for (const key of ['baseToken', 'tableId']) {
    if (!st[key]) problems.push(`缺少必填字段 strategyTable.${key}`);
  }
  const flat = JSON.stringify(cfg);
  const todoHits = flat.match(/TODO_[A-Z0-9_]+/g);
  if (todoHits) problems.push(`配置含未填占位: ${[...new Set(todoHits)].join('、')}`);
  if (problems.length > 0) {
    process.stderr.write(`❌ 品牌配置不完整: ${configFile}\n` +
      problems.map(p => `   - ${p}`).join('\n') + '\n');
    process.exit(1);
  }
}

function loadBrandConfig(brand) {
  const configFile = path.join(SKILL_ROOT, 'config', brand, 'config.json');
  if (!fs.existsSync(configFile)) {
    let available = [];
    try {
      available = fs.readdirSync(path.join(SKILL_ROOT, 'config'))
        .filter(f => !f.startsWith('.') && fs.statSync(path.join(SKILL_ROOT, 'config', f)).isDirectory());
    } catch { /* config 目录不存在 */ }
    process.stderr.write(`❌ 品牌配置不存在: ${configFile}\n   可用品牌: ${available.join(', ') || '（无）'}\n`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  validateConfig(cfg, configFile);
  return cfg;
}

module.exports = { SKILL_ROOT, resolveBrand, loadEnv, loadBrandConfig };
