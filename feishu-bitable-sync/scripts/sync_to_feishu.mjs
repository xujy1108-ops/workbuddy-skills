#!/usr/bin/env node
/**
 * 飞书多维表格数据同步脚本 (团队共享版)
 *
 * 用法: node sync_to_feishu.mjs <起始行> <结束行> [--config <配置文件路径>]
 * 例如: node sync_to_feishu.mjs 1 10
 *        node sync_to_feishu.mjs 1 10 --config ~/my_config.json
 *
 * 配置文件说明:
 *   首次使用前，复制 scripts/config.example.json 为 ~/.feishu_sync_config.json
 *   填入自己的 cookie 和表格信息
 *
 * 流程:
 * 1. 从飞书多维表格读取指定行范围的记录
 * 2. 提取每行的【订单ID】作为入参
 * 3. 调用视频号广告数据接口获取数据
 * 4. 将结果更新到飞书多维表格的【播放量】到【组件点击率】字段
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============ 读取配置 ============
function loadConfig() {
    // 支持命令行 --config 参数指定配置文件
    const configIdx = process.argv.indexOf('--config');
    let configPath;
    if (configIdx !== -1 && process.argv[configIdx + 1]) {
        configPath = process.argv[configIdx + 1];
    } else {
        // 默认配置文件路径
        configPath = path.join(os.homedir(), '.feishu_sync_config.json');
    }

    if (!fs.existsSync(configPath)) {
        console.error('❌ 未找到配置文件！');
        console.error(`   预期路径: ${configPath}`);
        console.error('   请复制 scripts/config.example.json 为该路径的文件，并填入你的配置。');
        console.error('   或使用 --config 参数指定其他路径。');
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // 校验必填字段
    const required = ['cookie', 'base_token', 'table_id'];
    for (const field of required) {
        if (!config[field]) {
            console.error(`❌ 配置文件缺少必填字段: ${field}`);
            process.exit(1);
        }
    }

    return config;
}

const CONFIG = loadConfig();
const BASE_TOKEN = CONFIG.base_token;
const TABLE_ID = CONFIG.table_id;
const START_TIME = CONFIG.start_time || '20260717';
const COOKIE = CONFIG.cookie;

// ============ 字段映射 ============
// 脚本返回字段 -> 飞书多维表格字段名
const FIELD_MAP = {
    'bfl':       '播放量',
    'hdsl':      '互动量=点赞+评论+分享',
    'dzl':       '点赞量',
    'pll':       '评论量',
    'fxl':       '分享量',
    'zpb':       '赞评比',
    'wbl':       '完播率',
    'hdl':       '互动率',
    'cpm':       'cpm',
    'cpe':       'CPE',
    'zjcpm':     '组件cpm',
    'zjcpe':     '组件CPE',
    'cvt_show':  '组件曝光量',
    'cvt_click': '组件点击量',
    'cvt_rate':  '组件点击率',
};

// 百分比类型字段 (飞书中 percentage=true 的字段，需要将 "12.34%" 转为 0.1234)
const PERCENTAGE_FIELDS = new Set(['完播率', '互动率', '组件点击率']);

// 记录最后一次错误信息（供主流程判断 cookie 是否过期）
getInfo1.lastError = '';

// ============ 核心函数 ============

/**
 * 获取视频号广告数据
 */
async function getInfo1(taskid) {
    try {
        const currentDate = new Date().toISOString().split('T')[0];
        const endDate = currentDate.split('-')[0] + currentDate.split('-')[1] + currentDate.split('-')[2];

        const response = await fetch(
            `https://huxuan.qq.com/cgi-bin/advertiser/get_finder_ad_metric_v2?aid=${taskid}&need_dynamic_data=true&start_time=${START_TIME}&end_time=${endDate}`,
            {
                headers: {
                    "accept": "application/json, text/plain, */*",
                    "accept-language": "zh-CN,zh;q=0.9",
                    "account_id": CONFIG.account_id || "85142655",
                    "priority": "u=1, i",
                    "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": "\"macOS\"",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                    "cookie": COOKIE,
                },
                body: null,
                method: "GET"
            }
        );

        if (response.status === 401 || response.status === 403) {
            getInfo1.lastError = `Cookie 过期 (HTTP ${response.status})`;
            console.error(`  ❌ Cookie 已过期 (HTTP ${response.status})！请在对话中发送新的 cookie，我会自动更新配置文件。`);
            return null;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        let tag = await response.json();
        tag = tag.data;

        let prepareData = {
            dzl: tag.summary.channels_match_fav_pv + tag.summary.channels_match_heart_pv,
            pll: tag.summary.channels_match_comment_pv,
            fxl: tag.summary.channels_match_share_pv,
            cvt_show: tag.summary.exp_pv,
            cvt_click: tag.summary.clk_pv,
        };
        const totalPay = tag.total_amount / 100 || 0;

        let baseinfo = {
            aid: taskid,
            bfl: tag.summary.channels_match_read_pv,
            hdsl: Number(prepareData.dzl) + Number(prepareData.pll) + Number(prepareData.fxl),
            dzl: prepareData.dzl,
            pll: prepareData.pll,
            fxl: prepareData.fxl,
            zpb: ((prepareData.pll / prepareData.dzl) * 100).toFixed(2) + '%',
            wbl: (Number(tag.summary.channels_video_play_finish_ctr) / 100).toFixed(2) + '%',
            hdl: (Number(tag.summary.interaction_rate) / 100).toFixed(2) + '%',
            cpm: parseFloat((Number(totalPay) / Number(tag.summary.channels_match_read_pv) * 1000).toFixed(2)),
            cpe: parseFloat((Number(totalPay) / (Number(prepareData.dzl) + Number(prepareData.pll) + Number(prepareData.fxl))).toFixed(2)),
            zjcpm: parseFloat((totalPay / (prepareData.cvt_show / 1000)).toFixed(2)),
            zjcpe: parseFloat((totalPay / prepareData.cvt_click).toFixed(2)),
            cvt_show: prepareData.cvt_show,
            cvt_click: prepareData.cvt_click,
            cvt_rate: (prepareData.cvt_click / prepareData.cvt_show * 100).toFixed(2) + '%',
            totalPay,
        };

        return baseinfo;
    } catch (error) {
        getInfo1.lastError = error.message;
        console.error(`  ❌ 获取数据失败 (ID: ${taskid}):`, error.message);
        return null;
    }
}

/**
 * 将脚本返回值转换为飞书多维表格所需的格式
 */
function convertValue(fieldName, value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string' && value.endsWith('%')) {
        if (PERCENTAGE_FIELDS.has(fieldName)) {
            return parseFloat(value.replace('%', '')) / 100;
        }
        return value;
    }
    return value;
}

/**
 * 调用 lark-cli 读取多维表格记录
 */
function readRecords(offset, limit) {
    const result = spawnSync('lark-cli', [
        'base', '+record-list',
        '--base-token', BASE_TOKEN,
        '--table-id', TABLE_ID,
        '--as', 'user',
        '--offset', String(offset),
        '--limit', String(limit),
        '--field-id', '订单ID',
        '--format', 'json',
    ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

    const output = (result.stdout || '') + (result.stderr || '');
    const jsonStart = output.indexOf('{');
    if (jsonStart < 0) {
        throw new Error('无法解析 lark-cli 输出: ' + output);
    }
    const data = JSON.parse(output.substring(jsonStart));
    if (!data.ok) {
        throw new Error('读取记录失败: ' + JSON.stringify(data.error));
    }
    return {
        recordIds: data.data.record_id_list || [],
        orderIds: data.data.data.map(row => row[0]),
    };
}

/**
 * 调用 lark-cli 批量更新记录
 */
function batchUpdateRecords(updateRecords) {
    const jsonStr = JSON.stringify({ update_records: updateRecords });

    const result = spawnSync('lark-cli', [
        'base', '+record-batch-update',
        '--base-token', BASE_TOKEN,
        '--table-id', TABLE_ID,
        '--as', 'user',
        '--json', jsonStr,
    ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

    const output = (result.stdout || '') + (result.stderr || '');
    if (result.status !== 0 && !output.includes('"ok": true')) {
        console.error('  lark-cli 输出:', output);
        throw new Error(`lark-cli 退出码: ${result.status}`);
    }

    const jsonStart = output.indexOf('{');
    if (jsonStart >= 0) {
        return JSON.parse(output.substring(jsonStart));
    }
    return { ok: true, raw: output };
}

// ============ 主流程 ============

async function main() {
    // 解析命令行参数 (跳过 --config 及其值)
    const args = process.argv.slice(2).filter((v, i, arr) => {
        if (v === '--config') return false;
        if (i > 0 && arr[i - 1] === '--config') return false;
        return true;
    });

    if (args.length < 2) {
        console.log('用法: node sync_to_feishu.mjs <起始行> <结束行> [--config <配置文件路径>]');
        console.log('例如: node sync_to_feishu.mjs 1 10');
        process.exit(1);
    }

    const startRow = parseInt(args[0]);
    const endRow = parseInt(args[1]);

    if (isNaN(startRow) || isNaN(endRow) || startRow < 1 || endRow < startRow) {
        console.error('❌ 行号无效: 起始行和结束行必须是正整数，且结束行 >= 起始行');
        process.exit(1);
    }

    console.log(`\n🚀 开始处理: 第 ${startRow} 行 到 第 ${endRow} 行`);
    console.log(`   共 ${endRow - startRow + 1} 行\n`);

    // 1. 读取飞书多维表格记录
    console.log('📋 正在读取飞书多维表格记录...');
    const offset = startRow - 1;
    const limit = endRow - startRow + 1;

    let records;
    try {
        records = readRecords(offset, limit);
    } catch (error) {
        console.error('❌ 读取记录失败:', error.message);
        process.exit(1);
    }

    console.log(`   共读取到 ${records.recordIds.length} 条记录\n`);

    // 2. 逐行处理
    const updateRecords = {};
    let successCount = 0;
    let failCount = 0;
    const failedRows = []; // { row, orderId, reason }
    let cookieExpired = false;

    for (let i = 0; i < records.recordIds.length; i++) {
        const recordId = records.recordIds[i];
        const orderId = records.orderIds[i];
        const rowNum = startRow + i;

        // Cookie 过期则提前终止
        if (cookieExpired) {
            failedRows.push({ row: rowNum, orderId: orderId || '(空)', reason: 'Cookie 过期，未执行' });
            failCount++;
            continue;
        }

        if (!orderId) {
            console.log(`⏭️  第 ${rowNum} 行: 订单ID为空，跳过`);
            failedRows.push({ row: rowNum, orderId: '(空)', reason: '订单ID为空' });
            failCount++;
            continue;
        }

        console.log(`🔄 第 ${rowNum} 行: 正在处理订单ID ${orderId}...`);

        const result = await getInfo1(String(orderId));

        if (!result) {
            // 检查是否 cookie 过期
            const lastErr = getInfo1.lastError || '';
            if (lastErr.includes('401') || lastErr.includes('403') || lastErr.includes('Cookie')) {
                cookieExpired = true;
                failedRows.push({ row: rowNum, orderId: String(orderId), reason: 'Cookie 已过期' });
                console.error(`  🚫 Cookie 已过期！后续行将不再执行。`);
            } else {
                failedRows.push({ row: rowNum, orderId: String(orderId), reason: '获取数据失败: ' + lastErr });
            }
            failCount++;
            continue;
        }

        // 映射到飞书字段
        const fields = {};
        for (const [scriptKey, fieldName] of Object.entries(FIELD_MAP)) {
            const value = convertValue(fieldName, result[scriptKey]);
            if (value === null || value === undefined) continue;
            if (typeof value === 'string') {
                fields[fieldName] = value;
            } else if (!isNaN(value)) {
                fields[fieldName] = value;
            }
        }

        if (Object.keys(fields).length === 0) {
            console.log(`  ⚠️  第 ${rowNum} 行: 无有效数据可更新`);
            failedRows.push({ row: rowNum, orderId: String(orderId), reason: '无有效数据' });
            failCount++;
            continue;
        }

        updateRecords[recordId] = fields;
        successCount++;
        console.log(`  ✅ 第 ${rowNum} 行: 播放量=${result.bfl}, 互动量=${result.hdsl}, 点赞=${result.dzl}`);

        // 随机延迟，避免请求过快
        const delay = Math.floor(Math.random() * 1000) + 500;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    // 3. 批量更新到飞书多维表格
    if (Object.keys(updateRecords).length > 0) {
        console.log(`\n📝 正在批量更新 ${Object.keys(updateRecords).length} 条记录到飞书多维表格...`);
        try {
            batchUpdateRecords(updateRecords);
            console.log('✅ 批量更新完成！');

            // 4. 读取更新后的数据验证
            console.log('\n🔍 正在验证更新结果...');
            const firstRecordId = Object.keys(updateRecords)[0];
            const verifyResult = spawnSync('lark-cli', [
                'base', '+record-get',
                '--base-token', BASE_TOKEN,
                '--table-id', TABLE_ID,
                '--as', 'user',
                '--record-id', firstRecordId,
                '--field-id', '播放量',
                '--field-id', '赞评比',
                '--field-id', '完播率',
                '--field-id', '组件点击率',
                '--format', 'json',
            ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
            const verifyOutput = (verifyResult.stdout || '') + (verifyResult.stderr || '');
            const vJsonStart = verifyOutput.indexOf('{');
            if (vJsonStart >= 0) {
                const verifyData = JSON.parse(verifyOutput.substring(vJsonStart));
                if (verifyData.ok && verifyData.data) {
                    const fieldNames = verifyData.data.fields || [];
                    const values = (verifyData.data.data && verifyData.data.data[0]) || [];
                    for (let j = 0; j < fieldNames.length; j++) {
                        console.log(`   验证 - ${fieldNames[j]}: ${values[j]}`);
                    }
                }
            }
        } catch (error) {
            console.error('❌ 批量更新失败:', error.message);
        }
    } else {
        console.log('\n⚠️  没有需要更新的记录');
    }

    // 5. 汇总
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 处理完成:`);
    console.log(`   ✅ 成功: ${successCount} 条`);
    console.log(`   ❌ 失败/跳过: ${failCount} 条`);
    console.log(`   📋 总计: ${records.recordIds.length} 条`);

    // 失败行明细
    if (failedRows.length > 0) {
        console.log(`\n⚠️  以下行处理失败，需要关注:`);
        console.log(`${'─'.repeat(50)}`);
        for (const f of failedRows) {
            console.log(`   第 ${f.row} 行 | 订单ID: ${f.orderId} | 原因: ${f.reason}`);
        }
        console.log(`${'─'.repeat(50)}`);

        // Cookie 过期特别提醒
        if (cookieExpired) {
            console.log(`\n🚫 Cookie 已过期！请重新获取 cookie 并更新 ~/.feishu_sync_config.json`);
            console.log(`   获取方法: 打开 https://huxuan.qq.com → F12 → Network → 复制 cookie`);
        }
    } else {
        console.log(`\n🎉 全部成功！`);
    }
    console.log(`${'='.repeat(50)}\n`);
}

main().catch(err => {
    console.error('运行出错:', err);
    process.exit(1);
});
