#!/usr/bin/env node
/**
 * 品牌配置加载器（通用模块，不含任何品牌私有内容）
 *
 * 品牌私有内容（品牌名、飞书表、筛选阈值、分级规则、策略库文档、prompt 模板）
 * 全部外置在 config/<brand>/ 目录，代码只保留通用流程逻辑。
 *
 * 品牌选择优先级：--brand 参数 > env WORKFLOW_BRAND > DEFAULT_BRAND
 *
 * 目录约定：
 *   config/<brand>/config.json          品牌配置
 *   config/<brand>/prompts/<name>.md    品牌 prompt / 文本模板（__PLACEHOLDER__ 占位）
 *   config/<brand>/.env                 品牌私有环境变量（可选，优先级最高）
 */

const fs = require('fs');
const path = require('path');

const SKILL_ROOT = path.join(__dirname, '..', '..');
const CONFIG_ROOT = path.join(SKILL_ROOT, 'config');
const DEFAULT_BRAND = 'duxiaoman';

// ==================== .env 加载 ====================
// 按优先级依次查找并合并（先命中者优先，不覆盖已存在的进程环境变量）
// 注意：本模块被 require 时即执行，保证后续脚本读到的 process.env 已就绪
function loadEnv(brand) {
  const candidates = [
    brand ? path.join(CONFIG_ROOT, brand, '.env') : null,
    path.join(SKILL_ROOT, 'scripts', '.env'),
    path.join(SKILL_ROOT, '.env'),
    path.join(SKILL_ROOT, '..', '.env'),
    path.join(SKILL_ROOT, '..', 'hotspot', '.env') // 历史共用 env 兜底
  ].filter(Boolean);

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  }
}

// ==================== 品牌选择 ====================
function resolveBrand(argv) {
  const args = argv || process.argv.slice(2);
  const idx = args.indexOf('--brand');
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return process.env.WORKFLOW_BRAND || DEFAULT_BRAND;
}

function listBrands() {
  try {
    return fs.readdirSync(CONFIG_ROOT)
      .filter(f => !f.startsWith('.') && fs.statSync(path.join(CONFIG_ROOT, f)).isDirectory());
  } catch (_) {
    return [];
  }
}

// ==================== 配置加载 ====================
const REQUIRED_KEYS = ['brandName', 'tables', 'filters', 'grading', 'topicSplit', 'strategyLib', 'ai'];

function loadBrandConfig(brand) {
  const configFile = path.join(CONFIG_ROOT, brand, 'config.json');
  if (!fs.existsSync(configFile)) {
    process.stderr.write(`❌ 品牌配置不存在: ${configFile}\n`);
    const available = listBrands();
    process.stderr.write(`   可用品牌: ${available.join(', ') || '（config 目录为空）'}\n`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch (error) {
    process.stderr.write(`❌ 品牌配置解析失败（${configFile}）: ${error.message}\n`);
    process.exit(1);
  }

  const missing = REQUIRED_KEYS.filter(k => cfg[k] === undefined);
  if (missing.length > 0) {
    process.stderr.write(`❌ 品牌配置缺少必填字段: ${missing.join(', ')}（文件: ${configFile}）\n`);
    process.exit(1);
  }

  const todos = collectTodos(cfg);
  if (todos.length > 0) {
    process.stderr.write(`❌ 品牌「${brand}」配置尚未补齐，以下字段仍是 TODO 占位：\n`);
    todos.forEach(t => process.stderr.write(`   - ${t}\n`));
    process.stderr.write(`   请补齐 ${configFile} 后重试（可参考 config/duxiaoman/config.json）。\n`);
    process.exit(1);
  }

  return cfg;
}

/** 递归收集形如 "TODO_xxx" 的占位值，用于阻止骨架配置被误跑 */
function collectTodos(obj, prefix = '') {
  const hits = [];
  const walk = (node, p) => {
    if (typeof node === 'string') {
      if (/^TODO/.test(node.trim())) hits.push(`${p} = "${node}"`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('_')) continue; // `_TODO` 注释键跳过
        walk(v, p ? `${p}.${k}` : k);
      }
    }
  };
  walk(obj, prefix);
  return hits;
}

// ==================== prompt / 文本模板 ====================
function loadPromptFile(brand, name) {
  const file = path.join(CONFIG_ROOT, brand, 'prompts', name);
  if (!fs.existsSync(file)) {
    process.stderr.write(`❌ 品牌模板不存在: ${file}\n`);
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf-8');
}

/** 渲染 __PLACEHOLDER__ 占位符；未提供值的占位符原样保留（便于排错） */
function renderTemplate(tpl, vars) {
  return tpl.replace(/__([A-Z0-9_]+)__/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

module.exports = {
  SKILL_ROOT,
  CONFIG_ROOT,
  DEFAULT_BRAND,
  loadEnv,
  resolveBrand,
  listBrands,
  loadBrandConfig,
  loadPromptFile,
  renderTemplate
};
