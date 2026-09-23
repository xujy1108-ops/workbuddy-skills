'use strict';

/**
 * lark-cli 封装 + 飞书单元格工具函数
 * 与 creative-content-analysis 的 runLarkCli/cellText/normalizeDirectionValue 保持行为一致。
 */

const { execFileSync } = require('child_process');

const LARK_CLI = 'lark-cli';

/** 调用 lark-cli（统一 --as user），返回 stdout 文本；失败抛错由调用方决定降级 */
function runLarkCli(args, { timeoutMs = 120000 } = {}) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
  };
  return execFileSync(LARK_CLI, [...args, '--as', 'user'], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env,
    maxBuffer: 50 * 1024 * 1024
  });
}

/** 解析飞书单元格（文本字段可能是 string 或 [{text}] 数组） */
function cellText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map(v => (typeof v === 'string' ? v : v.text || '')).join('').trim();
  return String(val);
}

/**
 * 方向值归一化（脏数据兜底）：内容方向一/二若带首尾换行、多余空白，
 * 写入飞书 select 字段时无法与已有选项精确匹配（飞书按全字符串匹配，不做 trim），
 * 会把同一方向分裂成「干净选项」与「带空白选项」两份。读/写两侧统一归一化。
 */
function normalizeDirectionValue(val) {
  if (val == null) return '';
  const raw = Array.isArray(val) ? (val.length > 0 ? val[0] : '') : val;
  return String(raw).replace(/\s+/g, ' ').trim();
}

module.exports = { LARK_CLI, runLarkCli, cellText, normalizeDirectionValue };
