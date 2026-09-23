#!/usr/bin/env node

/**
 * 品牌配置加载器（brand_config.js）
 *
 * 唯一入口：所有品牌私有内容（飞书表、预筛词表、锚点池、定级阈值、AI prompt、达人清单）
 * 都放在 config/<brand>/ 下，脚本代码零品牌硬编码。
 *
 * 品牌选择链：--brand <name>  >  环境变量 WORKFLOW_BRAND  >  'duxiaoman'
 *
 * 失败即报错（fail-fast，不留半可用状态）：
 *   - 配置目录/文件不存在、JSON 非法
 *   - 缺必填字段（brand / brandName / tables.hotspot / filters / strategy / refine / judgeSystem）
 *   - 配置或 prompt 里仍残留 `TODO_` 占位值 → 启动即列出待填字段并退出
 *   - prompt 模板缺失或为空、缺运行时占位符
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_BRAND = 'duxiaoman';
const SKILL_ROOT = path.join(__dirname, '..');
const CONFIG_ROOT = path.join(SKILL_ROOT, 'config');

// ============ 品牌解析 ============
function resolveBrand(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--brand' && argv[i + 1]) return argv[i + 1];
  }
  return process.env.WORKFLOW_BRAND || DEFAULT_BRAND;
}

function availableBrands() {
  if (!fs.existsSync(CONFIG_ROOT)) return [];
  return fs.readdirSync(CONFIG_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fs.existsSync(path.join(CONFIG_ROOT, name, 'config.json')))
    .sort();
}

// ============ TODO_ 占位值扫描（递归，返回字段路径） ============
function scanTodo(node, prefix, hits) {
  if (typeof node === 'string') {
    if (node.includes('TODO_')) hits.push(prefix);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanTodo(v, `${prefix}[${i}]`, hits));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '_note' || k === '_comment') continue;  // 说明性文本允许出现 TODO_ 字样
      scanTodo(v, prefix ? `${prefix}.${k}` : k, hits);
    }
  }
}

// ============ 必填字段校验 ============
function assertConfig(cfg, brand) {
  const missing = [];
  const require = (cond, label) => { if (!cond) missing.push(label); };

  require(cfg.brand, 'brand');
  require(cfg.brandName, 'brandName');
  require(cfg.tables && cfg.tables.hotspot, 'tables.hotspot');
  require(cfg.tables?.hotspot?.baseToken || process.env.HOTSPOT_BASE_TOKEN, 'tables.hotspot.baseToken（或环境变量 HOTSPOT_BASE_TOKEN）');
  require(cfg.tables?.hotspot?.tableId || process.env.HOTSPOT_TABLE_ID, 'tables.hotspot.tableId（或环境变量 HOTSPOT_TABLE_ID）');

  require(Array.isArray(cfg.filters?.douyinCategoryWhitelist), 'filters.douyinCategoryWhitelist');
  require(Array.isArray(cfg.filters?.forbiddenGroups) && cfg.filters.forbiddenGroups.length > 0, 'filters.forbiddenGroups');
  for (const [i, g] of (cfg.filters?.forbiddenGroups || []).entries()) {
    require(Array.isArray(g.words) && g.words.length > 0, `filters.forbiddenGroups[${i}].words`);
    require(g.reason, `filters.forbiddenGroups[${i}].reason`);
  }

  require(Array.isArray(cfg.strategy?.anchorPool) && cfg.strategy.anchorPool.length > 0, 'strategy.anchorPool');
  require(Array.isArray(cfg.strategy?.anchorAliases), 'strategy.anchorAliases');
  require(cfg.strategy?.anchorFallback, 'strategy.anchorFallback');
  require(cfg.strategy?.placementByHops?.['0'] && cfg.strategy?.placementByHops?.['1'] && cfg.strategy?.placementByHops?.['2+'], 'strategy.placementByHops（需 0 / 1 / "2+" 三档）');
  require(cfg.strategy?.reviewDays && Object.keys(cfg.strategy.reviewDays).length > 0, 'strategy.reviewDays');

  for (const k of ['EXCELLENT', 'GOOD', 'NORMAL']) {
    require(typeof cfg.refine?.gradeThresholds?.[k] === 'number', `refine.gradeThresholds.${k}`);
  }
  for (const k of ['EXCELLENT', 'GOOD', 'NORMAL', 'BELOW']) {
    require(cfg.refine?.gradeLabels?.[k], `refine.gradeLabels.${k}`);
  }
  require(typeof cfg.refine?.daysRecent === 'number', 'refine.daysRecent');
  require(typeof cfg.refine?.minDigg === 'number', 'refine.minDigg');
  require(typeof cfg.refine?.topN === 'number', 'refine.topN');

  require(cfg.judgeSystem, 'judgeSystem');

  if (missing.length > 0) {
    throw new Error(
      `品牌配置 [${brand}] 缺必填字段（${missing.length} 项）：\n` +
      missing.map(m => `   · ${m}`).join('\n') +
      `\n   配置文件：${path.join(CONFIG_ROOT, brand, 'config.json')}`
    );
  }
}

// ============ 加载 + 缓存 ============
let _cache = null;

function load(brand = resolveBrand()) {
  if (_cache && _cache.brand === brand) return _cache;

  const dir = path.join(CONFIG_ROOT, brand);
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(dir)) {
    throw new Error(`未找到品牌配置目录：${dir}\n   可用品牌：${availableBrands().join(', ') || '（无）'}`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`未找到品牌配置文件：${file}\n   可用品牌：${availableBrands().join(', ') || '（无）'}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`品牌配置 JSON 解析失败（${file}）：${e.message}`);
  }

  const todoHits = [];
  scanTodo(cfg, '', todoHits);
  if (todoHits.length > 0) {
    throw new Error(
      `品牌 [${brand}] 配置尚未补齐（含 ${todoHits.length} 处 TODO_ 占位值）：\n` +
      todoHits.map(p => `   · ${p}`).join('\n') +
      `\n   请填写后重试：${file}`
    );
  }

  assertConfig(cfg, brand);

  // 飞书表：环境变量可覆盖配置（方便临时指向测试表）
  const table = {
    baseToken: process.env.HOTSPOT_BASE_TOKEN || cfg.tables.hotspot.baseToken,
    tableId: process.env.HOTSPOT_TABLE_ID || cfg.tables.hotspot.tableId,
    baseUrl: cfg.tables.hotspot.baseUrl || ''
  };

  _cache = {
    brand,
    brandName: cfg.brandName,
    dir,
    configDir: dir,
    configPath: file,
    table,
    filters: cfg.filters,
    strategy: cfg.strategy,
    refine: cfg.refine,
    judgeSystem: cfg.judgeSystem,
    // 达人清单默认落在品牌配置目录下（品牌私有），--creators 可覆盖
    creatorsFile: path.join(dir, 'hotspot_creators.json')
  };
  return _cache;
}

// ============ prompt 模板加载（含占位符校验） ============
function loadPrompt(name, requiredPlaceholders = []) {
  const c = load();
  const file = path.join(c.dir, 'prompts', `${name}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`品牌 [${c.brand}] 缺 prompt 模板：${file}`);
  }
  const tpl = fs.readFileSync(file, 'utf-8');
  if (!tpl.trim()) {
    throw new Error(`品牌 [${c.brand}] prompt 模板为空：${file}`);
  }
  // 模板本身不允许是纯注释/纯 TODO_ 说明（未补齐的骨架会在这里被拦下）
  const body = tpl.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
  if (body.length === 0) {
    throw new Error(`品牌 [${c.brand}] prompt 模板 ${name}.md 只有注释、没有实际内容：${file}`);
  }
  const todoHits = [];
  scanTodo(tpl, '', todoHits);
  if (todoHits.length > 0) {
    throw new Error(`品牌 [${c.brand}] prompt 模板 ${name}.md 尚未补齐（含 ${todoHits.length} 处 TODO_ 占位值）：${file}`);
  }
  const missing = requiredPlaceholders.filter(p => !tpl.includes(p));
  if (missing.length > 0) {
    throw new Error(`品牌 [${c.brand}] prompt 模板 ${name}.md 缺运行时占位符：${missing.join(', ')}（${file}）`);
  }
  return tpl;
}

module.exports = {
  DEFAULT_BRAND,
  CONFIG_ROOT,
  SKILL_ROOT,
  resolveBrand,
  availableBrands,
  load,
  loadPrompt,
  get brand() { return load().brand; },
  get brandName() { return load().brandName; }
};
