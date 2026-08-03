/**
 * 抖音视频脚本提取工具
 * 
 * 使用方法：
 *   NODE_USE_ENV_PROXY=1 node video_script.js <视频下载链接>
 * 
 * 示例：
 *   NODE_USE_ENV_PROXY=1 node video_script.js "https://v96-sz-daily-a.douyinvod.com/..."
 * 
 * 说明：
 *   - 直接将视频下载链接发给豆包模型，模型会分析视频内容并转录全部台词
 *   - 如果是剧情视频，会自动标注说话人
 *   - 无需下载视频、无需提取音频、无需安装 FFmpeg
 *   - 如果因网络问题需要下载到本地，用完后会自动删除临时文件
 *   - 需要设置 NODE_USE_ENV_PROXY=1（如果使用代理）
 */

const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const API_KEY = process.env.AIHUBMIX_API_KEY;
const BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1';
const MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro';
// ==============================

const SYSTEM_PROMPT = `你是专业的视频脚本转录助手。请将视频中的所有对话和台词完整转录为文字。

要求：
1. 如果是剧情视频，标注每句话是谁说的（根据画面和语气推断角色，如【男主】【女主】【旁白】或角色名）
2. 如果有内心独白，标注为【人物（内心）】
3. 保留所有口语和语气词，不要遗漏任何内容
4. 按时间顺序输出
5. 如果有画面动作描述需要，可在台词间用（动作描述）补充
6. 输出格式：【人物】台词内容`;

async function extractScript(videoSource) {
  console.log('🎬 正在分析视频并提取脚本...');
  console.log(`   模型: ${MODEL}`);

  // 判断是本地文件还是远程链接
  let videoUrl;
  if (fs.existsSync(videoSource)) {
    // 本地文件 — 转为 base64 data URL 发送
    console.log(`   来源: 本地文件 ${path.basename(videoSource)}`);
    const buffer = fs.readFileSync(videoSource);
    const base64 = buffer.toString('base64');
    videoUrl = `data:video/mp4;base64,${base64}`;
  } else {
    // 远程链接
    console.log(`   来源: 远程链接 ${videoSource.substring(0, 80)}...`);
    videoUrl = videoSource;
  }

  console.log('');

  const startTime = Date.now();

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请转录这个视频中的全部台词内容，标注说话人。完整输出，不要省略。' },
            { type: 'video_url', video_url: { url: videoUrl } }
          ]
        }
      ],
      max_tokens: 8192,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 错误 (HTTP ${response.status}): ${errorText.substring(0, 500)}`);
  }

  const data = await response.json();
  const script = data.choices[0].message.content;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`✅ 转录完成！耗时 ${elapsed}s，消耗 ${data.usage?.total_tokens || '?'} tokens\n`);

  return { script, usage: data.usage, elapsed };
}

// 下载视频到本地临时文件
async function downloadVideo(url, localPath) {
  console.log(`📥 下载视频中...`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buf);
  console.log(`   已下载: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  return localPath;
}

// 删除临时文件
function cleanupFiles(...filePaths) {
  for (const p of filePaths) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`🗑️  已删除临时文件: ${path.basename(p)}`);
    }
  }
}

async function main() {
  const videoUrl = process.argv[2];

  if (!videoUrl) {
    console.error('用法: node video_script.js <视频下载链接>');
    console.error('示例: NODE_USE_ENV_PROXY=1 node video_script.js "https://v96-sz-daily-a.douyinvod.com/..."');
    process.exit(1);
  }

  if (!API_KEY) {
    console.error('❌ 缺少环境变量 AIHUBMIX_API_KEY，请参考 .env.example 配置');
    process.exit(1);
  }

  const tempVideoPath = path.join(process.cwd(), 'video_temp.mp4');
  let script, usage, elapsed;

  try {
    const result = await extractScript(videoUrl);
    script = result.script;
    usage = result.usage;
    elapsed = result.elapsed;
  } catch (error) {
    console.log('⚠️  直接发送链接失败，尝试下载视频后再处理...');
    try {
      await downloadVideo(videoUrl, tempVideoPath);
      // 用本地文件重试（base64 方式发送）
      const result = await extractScript(tempVideoPath);
      script = result.script;
      usage = result.usage;
      elapsed = result.elapsed;
    } catch (err2) {
      cleanupFiles(tempVideoPath);
      console.error('\n❌ 提取失败:', err2.message);
      process.exit(1);
    }
  } finally {
    // 无论成功或失败，都清理临时文件
    cleanupFiles(tempVideoPath);
  }

  console.log('========================================');
  console.log('📝 视频完整脚本');
  console.log('========================================\n');
  console.log(script);
  console.log('\n========================================');
  console.log(`⏱️  耗时: ${elapsed}s | Tokens: ${usage?.total_tokens || '?'} | 模型: ${MODEL}`);
  console.log('========================================\n');

  // Save to file
  const outputPath = path.join(process.cwd(), `script_${Date.now()}.txt`);
  fs.writeFileSync(outputPath, script, 'utf-8');
  console.log(`📁 脚本已保存: ${outputPath}`);
}

main();
