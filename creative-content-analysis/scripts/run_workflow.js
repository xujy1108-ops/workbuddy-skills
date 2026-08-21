#!/usr/bin/env node

/**
 * 度小满创意分析 - 抖音工作流主脚本
 *
 * 使用方法：
 *   node run_workflow.js [--keywords "kw1,kw2"] [--existing-ids "id1,id2"] [--skip-bitable] [--resume]
 *
 * 默认行为（一条命令跑完）：
 *   1. 自动查询飞书多维表格已有素材 ID（去重）
 *   2. 生成关键词 → 搜索抖音 → 提取脚本 → 分析创意
 *   3. 自动将结果写入飞书多维表格
 *   4. 如果 API 余额不足，自动给飞书发消息通知
 *
 * 断点续跑：
 *   如果运行被沙箱中断（Exit 137），可加 --resume 重新运行，
 *   脚本会从 checkpoint 恢复候选列表，跳过已处理的视频，继续处理剩余的。
 *
 * 参数：
 *   --keywords "kw1,kw2"     使用自定义搜索关键词（跳过 AI 生成）
 *   --existing-ids "id1,id2" 手动传入已有素材 ID（跳过自动查询）
 *   --skip-bitable           跳过飞书多维表格读写（仅跑分析，不写入）
 *   --resume                 从 checkpoint 恢复，跳过搜索直接处理剩余视频
 *
 * 环境变量：
 *   AIHUBMIX_API_KEY   - AIHubMix API 密钥
 *   AIHUBMIX_BASE_URL  - AIHubMix API 地址（默认 https://api.inferera.com/v1）
 *   TIKHUB_TOKEN       - TikHub API 令牌
 *   DEEPSEEK_MODEL     - DeepSeek 模型名（默认 deepseek-v4-pro）
 *   DOUBAO_MODEL       - 豆包模型名（默认 doubao-seed-2-1-pro）
 *
 * 输出：JSON 格式结果到 stdout，进度日志输出到 stderr
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ============ Checkpoint 断点续跑 ============
const CHECKPOINT_DIR = path.join(os.tmpdir(), 'duxiaoman-workflow');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'checkpoint.json');

function saveCheckpoint(keywords, candidates) {
  if (!fs.existsSync(CHECKPOINT_DIR)) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }
  const data = {
    savedAt: new Date().toISOString(),
    keywords,
    candidates,
    processed: [] // 已处理的 aweme_id 列表
  };
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  log(`   💾 Checkpoint 已保存（${candidates.length} 条候选）`);
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return null;
  }
  const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf-8');
  return JSON.parse(raw);
}

function markProcessed(awemeId) {
  const cp = loadCheckpoint();
  if (!cp) return;
  if (!cp.processed.includes(awemeId)) {
    cp.processed.push(awemeId);
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
  }
}

function clearCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    log(`   🧹 Checkpoint 已清理`);
  }
}

// ============ 近期关键词记忆（避免重复） ============
const RECENT_KEYWORDS_FILE = path.join(__dirname, '..', '.recent_keywords.json');
const MAX_RECENT_KEYWORDS = 9; // 保留最近3次运行的关键词

function loadRecentKeywords() {
  if (!fs.existsSync(RECENT_KEYWORDS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(RECENT_KEYWORDS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveRecentKeywords(keywords) {
  let recent = loadRecentKeywords();
  recent = [...keywords, ...recent].slice(0, MAX_RECENT_KEYWORDS);
  fs.writeFileSync(RECENT_KEYWORDS_FILE, JSON.stringify(recent, null, 2));
  log(`   💾 近期关键词已记录（共 ${recent.length} 个）`);
}

// ============ 配置 ============
const AIHUBMIX_API_KEY = process.env.AIHUBMIX_API_KEY;
const AIHUBMIX_BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://api.inferera.com/v1';
const TIKHUB_TOKEN = process.env.TIKHUB_TOKEN;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro';

const MIN_DIGG_COUNT = 2000; // 最低点赞数
const MAX_VIDEO_SIZE_MB = 50; // 豆包 API 视频文件大小限制
const FORBIDDEN_KEYWORDS = ['催收', '医疗', '看病', '住院', '手术', '上学', '学费', '开学', '助学贷款', '助学',
  '结婚', '彩礼',
  // 公检法/政府人群
  '民警', '警察', '公安', '法院', '法官', '检察', '检察院', '公检法', '派出所', '执法', '立案', '起诉', '诉讼', '强制执行', '失信名单', '支付令', '缺席判决',
  // 房贷断供类（大量政策/法律分析内容）
  '法拍', '法拍房', '信用破产', '个人破产'];

// 标题级禁止关键词：导师说教/成功学/负债翻身类 + 公检法/政府人群 + 突发用钱非经营类，在过滤阶段直接跳过
const TITLE_FORBIDDEN_KEYWORDS = [
  '负债翻身', '怎么翻身', '逆天改命', '翻身秘籍', '成功学',
  '教你翻身', '负债逆袭', '以贷养贷', '保你逆天', '教你赚钱',
  '带你赚钱', '带你翻身', '逆袭翻身',
  // 公检法/政府人群
  '民警', '警察', '公安', '法院', '法官', '检察', '公检法', '派出所',
  '普法', '法律科普', '维权干货', '报警', '报案', '诉讼', '起诉', '立案',
  '强制执行', '失信名单', '限制高消费', '支付令',
  // 房贷断供类（政策/法律分析为主，偏离借钱核心）
  '断供', '弃房', '法拍房',
  // 突发用钱非经营类（看病/上学/结婚彩礼/助学贷款等，不纳入素材范围）
  '结婚', '彩礼', '助学贷款', '助学'];

// 飞书多维表格配置
const BITABLE_BASE_TOKEN = process.env.BITABLE_BASE_TOKEN;
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID;
const LARK_CLI = 'lark-cli';
// ==============================

// ============ 提示词 ============

const KEYWORD_PROMPT = `你是抖音内容素材策划专家，熟悉抖音平台的内容生态、用户情绪和话题传播逻辑。请围绕"资金周转困难"这个核心场景，生成3个抖音搜索关键词。

场景方向按重要性分为三个层级，请严格按比例选取：

【重点方向】（每次必须从中选2个，覆盖不同方向）
1. 熟人借贷纠纷：被朋友/亲戚开口借钱、借了要不回来、借钱伤感情、不好意思拒绝
2. 做生意资金周转：创业资金链断裂、进货缺钱、年底结账收不回款、周转不开
3. 如何拒绝借钱：不想借钱给别人、怎么体面拒绝、拒绝借钱的理由、怎么说不伤感情
4. 借钱遇到的困难：借钱时遇到的尴尬/困难/门槛、开口借钱难以启齿、借钱被拒的经历

【一般方向】（每次从中选1个，与重点方向不重复）
1. 因为什么原因要借钱：什么情况下需要借钱、借钱的理由和动机
2. 借钱被坑经历：被熟人骗钱、担保踩坑、高利贷陷阱、网贷越借越多
3. 银行贷款困境：普通人为什么银行借不出来、征信花了借不到钱、贷款被拒
4. 突发用钱压力（仅限经营/投资类场景：日常经营周转、购置设备、扩大经营、创业启动、装修、购买大件。禁止看病、上学、结婚彩礼等方向）

【非重点方向】（偶尔出现，每3次运行最多替换1次一般方向的位置，不要每次都出现）
1. 过来人东山再起：只选曾经因为借钱/负债陷入困境、后来已经还清债务并走出来的人，回顾分享当时借钱那段经历中的真实感受和教训。关键词必须聚焦"借钱/还债"本身（如"借的钱终于还清了""还清了所有借款"），不要用"负债还清了重新开始""走出低谷""改变磁场"这类泛化词——它们搜出的内容多为个人成长/心态/旅居类，与借钱毫无关系。
2. 搞钱奋斗类：普通人怎么搞钱、副业赚钱、省钱过紧日子

【AI自主衍生方向】（不要只困在上述列表里，主动从抖音内容生态中衍生新方向。以下为启发维度，可以替换一般方向的位置）
- 不同人群的借钱处境（年轻人第一笔贷款、中年人养家压力、老年人被骗借钱、大学生生活费不够）
- 不同关系中的金钱摩擦（夫妻因钱吵架、兄弟姐妹分家产、合伙人翻脸、房东租客纠纷）
- 不同心理状态的缺钱体验（不敢看手机余额、超市结账时算计、不敢接电话怕催款、朋友圈看别人消费的自卑）
- 社会现象与钱的交织（彩礼压力、房子月供、农村留守家庭经济困境、打工人月底吃土）
- 你观察到的抖音上其他真实存在且高讨论度的"钱"相关话题

选取规则：
- 3个关键词 = 2个重点方向 + 1个一般方向
- 第3个关键词可以来自一般方向、非重点方向、或AI自主衍生方向，三者轮换出现，保持多样性
- 3个关键词必须覆盖不同的场景类型，不可重复同一方向
- 避免与近期已使用的关键词重复或高度相似（近期已用关键词列表见下方），尽量从不同角度切入同一方向
- 如果选"过来人"方向，关键词必须聚焦借钱/还债本身（如"借的钱终于还清了""还清了所有借款"），不要用"负债还清了重新开始""走出低谷""改变磁场"等泛化词。

要求如下：

话题原生性：关键词必须来自真实用户在抖音上自发讨论的内容方向，不能带有任何品牌卖点、产品功能或推广意图，要像普通用户会搜索的词一样自然。

关键词形式：以3-8个字的通用搜索词为主，适当泛化以提高搜索量和结果质量。避免过于具体的长尾短语（如"借钱给亲戚要不回来怎么办"太长太窄），优先选择搜索量更高的短语（如"生意周转不开"、"怎么拒绝借钱"）。不要过于宽泛（如单个字"钱"），也不要超过10个字。

内容聚焦性：关键词必须围绕"借钱、缺钱、资金周转"本身展开，借钱/缺钱是视频的核心议题而非引子。禁止生成"借钱见人心""借钱看清一个人""借钱试人品""借钱考验感情"这类把借钱当由头去讨论人心、人品、善良、信任的泛化话题——它们搜索量虽大，但结果严重偏离资金周转核心，产出的素材大多与借钱无关。

内容多样性：3个关键词需要覆盖不同类型的内容形态，例如心理分析类、情绪记录类、真实案例分享类、人性讨论类、经验干货类等，不能全是同一类型。

禁止预设案例：只输出关键词本身，不要预设或编造具体案例，让下一个agent自己去抖音搜索发现和筛选真实素材。

禁止方向：不要生成「当下负债怎么翻身」「负债几十万怎么办」「以贷养贷」等引导负债人群继续借贷的关键词。过来人故事必须是已经走出困境的回顾视角，不是当下还在困境中找出路的求助视角。不要生成与公检法、法律科普、维权诉讼相关的关键词（如"怎么起诉老赖""报警立案"等），我们不需要政府/执法人员视角的内容。不要生成看病、上学、助学贷款、结婚彩礼等方向的突发用钱关键词。此外，以下关键词虽表面聚焦借钱，但抖音搜索结果几乎全部是法律科普/催收/维权干货类内容，会被内容过滤规则100%拦截，禁止生成：\n- "朋友借钱不还" / "借钱不还怎么办" / "老赖" / "欠钱不还" — 结果大量是民警普法、法律维权干货\n- "网贷逾期" / "网贷不还" / "网贷催收" — 结果大量涉及催收话题\n- "借钱见人心" / "借钱看清一个人" / "借钱试人品" — 结果是讨论人心/人品，偏离资金周转核心\n- "过来人负债经历" / "负债经历分享" — 太模糊，搜出来大量还在还债路上挣扎的人，不是已经成功翻身的人，对素材策划没有参考价值\n- "房贷断供" / "断供的后果" / "弃房断供" — 结果大量是政策分析、法拍房、信用破产等法律/金融科普内容，偏离个人借钱/资金周转核心\n- "借给亲戚的钱要不回来" / "年底结账收不回款" / "借钱容易要钱难" / "怎么讨债" / "怎么要回钱" / "收不回款" / "讨债" — 这类"讨债/要钱/收不回"方向的关键词，抖音搜索结果几乎全是法律维权、法院强制执行、民警调解类内容，会被内容过滤规则100%拦截，禁止生成。如果要聚焦"借钱伤感情"方向，应从"借钱时的尴尬/为难/伤感情"角度切入，而不是从"要不回来/讨债"角度\n- "中年人养家缺钱压力" / "中年人压力" / "人到中年不容易" — 过于泛化，搜出的内容多为情感抒发/歌改类视频，偏离借钱核心议题，禁止生成这类泛化情感方向\n应当生成聚焦借钱本身带来的情感、生活压力、人际关系变化的关键词，例如个人经历分享、真实故事记录、生活困境感悟等方向。

__RECENT_KEYWORDS__

输出格式：严格按以下JSON格式输出，不要增加任何额外字段、注释或说明文字：

{
  "keywords": [
    { "id": 1, "keyword": "完整的长尾搜索关键词" },
    { "id": 2, "keyword": "完整的长尾搜索关键词" },
    { "id": 3, "keyword": "完整的长尾搜索关键词" }
  ]
}`;

const VIDEO_SCRIPT_PROMPT = `你是专业的视频脚本转录助手。请将视频中的所有对话和台词完整转录为文字。

要求：
1. 如果是剧情视频，标注每句话是谁说的（根据画面和语气推断角色，如【男主】【女主】【旁白】或角色名）
2. 如果有内心独白，标注为【人物（内心）】
3. 保留所有口语和语气词，不要遗漏任何内容
4. 按时间顺序输出
5. 如果有画面动作描述需要，可在台词间用（动作描述）补充
6. 输出格式：【人物】台词内容

转录完成后，在最后一行输出以下分隔符和JSON元信息（用于后续达人匹配分析）：
---META---
{"表现形式": "口播/剧情/AI生成/其他", "语速": "快/中/慢", "说话风格": "亲切/激情/稳重/幽默/利落/温柔等"}

说明：
- 表现形式：以下为参考类型，可根据视频实际情况自行补充其他类型（如情景演绎、街头采访、教程演示等）
- 语速：以下为参考档位，可根据实际听感自行补充其他描述
- 说话风格：以下为参考类型，可根据实际听感自行补充其他风格描述，可多选，用逗号分隔`;

const ANALYSIS_PROMPT = `# 角色
你是一位资深短视频编导，擅长拆解爆款素材的叙事逻辑，并为品牌广告提供可落地的植入策略。

# 任务
分析用户提供的脚本素材，完成六项输出，直接输出JSON。

# 输出格式
{
  "内容相关性": "强相关/弱相关/不相关",
  "内容方向": "用一句大白话总结整个脚本的叙事逻辑和核心主张，让观众一听就懂",
  "素材逻辑分析": "从叙事视角、双方行为画像、核心结论三个维度综合分析，一段话写清楚，直接给结论",
  "对度小满的借鉴": "从情绪借势、反向论证、核心策略三个维度综合分析，一段话写清楚核心策略",
  "植入修改建议": "包含植入锚点、修改后话术（用引号标出）、植入逻辑三个要素，一段话写清楚",
  "适配达人": {
    "达人类型": "一级分类-二级分类，按达人类型分类标准判断，如：剧情-剧情搞笑",
    "表现形式": "口播/剧情/AI生成/其他",
    "语速与风格": "语速快慢+说话风格，如：快、犀利",
    "口吻": "老登说教/犀利点评/真挚分享等",
    "推荐达人类型": "基于以上三点推导，2-3个类型，如：财经、职场、母婴亲子"
  }
}

# 内容相关性判断标准
判断脚本内容是否真正围绕"借钱、缺钱、资金周转、债务"等核心议题展开：
- 强相关：脚本核心主题就是借钱/缺钱/还钱/债务/资金周转，借钱是推动剧情或论述的主线
- 弱相关：脚本提到了借钱，但只是作为众多情节之一，主线是其他主题（如正能量、心灵鸡汤、搞笑段子等）。或者：如果是"过来人"类内容，但当事人还在还债路上挣扎、尚未成功翻身，也算弱相关——我们需要的是已经走出来的成功者视角
- 不相关：脚本与借钱/资金周转完全无关

# 达人类型分类标准（用于输出「达人类型」字段）
根据脚本文案对照以下标准判断素材适配的达人类型，输出格式为「一级分类-二级分类」。

## 标准类型（全部类型，只能从中选择）
- 财经-泛财经：商业故事、个人财富、消费决策、搞钱思路、时政要闻等一切与金钱/财富/商业相关的点评输出观点，不含投资
- 财经-高价值：主讲投资（股票/债券/基金/贵金属/房产等金融投资），垂直赛道，政策分析、市场洞察
- 财经-小微企业主：本人是老板/合伙人，创业日常vlog、产业点评、创业吐槽
- 财经-常规：真实借贷故事分享（借贷用途非小微企业方向），自己或别人的经历都算
- 财经-鸡汤：情感共鸣切入、无故事讲述、金句为主，大概描述借贷场景（人情债、借钱难等），讲述整体观点
- 三农-三农美食：围绕指定食材展开剧情演绎+爽感做饭，人物出镜口播，农村/城乡结合部场景
- 三农-三农建造：建房/家具/生活用具等手工建造记录，人物出镜口播
- 剧情-常规剧情：1分钟以上、多人（非一人分饰多角）多场景演出，有完整叙事结构（人物关系、核心冲突、起承转合），环环相扣
- 剧情-剧情搞笑：相比常规剧情逻辑可不严谨、可不到1分钟，无脑耍丑肢体搞笑为主，可有万万没想到式转折

判断规则：必须且只能从上述 9 个标准类型中选择，以脚本文案的内容形态（叙事结构、表现形式、主题方向）为准判断，不是判断视频作者本人是什么达人。即使素材与所有标准类型的匹配度都不高，也必须选择范围最接近的那一个，禁止自创类型、禁止输出标准列表之外的类型。

# 适配达人分析要求
- 达人类型：严格按「达人类型分类标准」判断，只能从 9 个标准类型中选范围最接近的一个，输出「一级分类-二级分类」格式，禁止自创类型
- 表现形式：如输入中已提供「视频表现特征」，直接引用；否则从脚本结构推断（单人长段=口播，多人对话=剧情）。提示中列举的类型仅为参考，可根据实际情况自行补充其他类型
- 语速与风格：如输入中已提供「视频表现特征」，直接引用；否则从脚本语言密度和标点推断。提示中列举的档位和风格仅为参考，可根据实际情况自行补充其他描述
- 口吻：从脚本内容的说话态度和立场判断，提示中列举的类型仅为参考，可根据实际情况自行补充其他口吻描述
- 推荐达人类型：综合表现形式、语速风格、口吻三个维度，推导什么类型的达人适合演绎这类脚本（自由描述，不受达人类型分类标准约束）

# 约束条件
- 内容方向，总字数在30字以内
- 适配达人的达人类型严格按「一级分类-二级分类」格式输出且只选一个，推荐达人类型控制在20字以内，其余3个子项各15字以内
- 植入话术单独不计入总字数，素材逻辑分析、对度小满的借鉴、植入修改建议三项总字数控制在100字以内
- 不要分点罗列，每项一段话连贯输出
- 语言精炼直接，不给铺垫过程
- 植入顺着原素材情绪走，不自夸不生硬

# 品牌名称
品牌名称：度小满
品牌卖点：新人首借年华利率4.9%，借一万一年利息约271元；不用不收费
目标人群：24-50岁的新锐白领、中产阶级，资深中产等方向的男性

# 输出示例
{
  "内容相关性": "强相关",
  "内容方向": "不想既丢钱又丢朋友，就记住：没做好送钱的准备，一分都别借。",
  "素材逻辑分析": "被借钱者受害者视角，借钱方占便宜、试探底线、施压人情，被借方羞耻绑架、承担风险、人财两空。核心结论：借钱＝拿钱买仇人，赠予心态才可例外。",
  "对度小满的借鉴": "借势熟人借贷伤感情高风险的情绪，反向论证正规平台是正向替代方案。核心策略：品牌接住观众'不伤感情+不求人'的需求，成为两难后的最优解。",
  "植入修改建议": "在'找银行借钱要付利息'处接入'找银行借钱要付利息，但银行还不一定借给你；找度小满，明码标价，利息清楚，到账快，不欠人情不伤感情。那你说，你为啥还要找朋友开口？'核心逻辑：把'向朋友借'的熟人借贷痛点转化为'用正规平台'的解决方案。",
  "适配达人": {
    "达人类型": "口播-观点输出",
    "表现形式": "口播",
    "语速与风格": "中速、犀利、利落",
    "口吻": "犀利点评",
    "推荐达人类型": "财经、职场、情感观点"
  }
}`;

// ==============================

function log(msg) {
  process.stderr.write(msg + '\n');
}

// Step 1: 生成搜索关键词
async function generateKeywords() {
  log('🔹 Step 1: 生成搜索关键词...');

  // 加载近期关键词，避免重复
  const recentKeywords = loadRecentKeywords();
  let prompt = KEYWORD_PROMPT;
  if (recentKeywords.length > 0) {
    prompt = prompt.replace('__RECENT_KEYWORDS__', `\n近期已使用的关键词（请勿重复或生成高度相似的词）：\n${recentKeywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}\n`);
  } else {
    prompt = prompt.replace('__RECENT_KEYWORDS__', '');
  }

  const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: '你是一个抖音内容策划专家，只输出JSON，不输出任何其他内容。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2048,
      temperature: 0.7
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`关键词生成失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // 提取 JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`关键词生成返回格式异常: ${content.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const keywords = parsed.keywords.map(k => k.keyword);

  log(`   生成了 ${keywords.length} 个关键词: ${keywords.join(', ')}`);

  // 保存到近期关键词列表
  saveRecentKeywords(keywords);

  return keywords;
}

// Step 2: 搜索抖音视频
async function searchDouyin(keyword) {
  log(`🔹 Step 2: 搜索抖音关键词 "${keyword}"...`);

  const response = await fetch('https://api.tikhub.io/api/v1/douyin/search/fetch_video_search_v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TIKHUB_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      keyword,
      cursor: 0,
      sort_type: '1',
      publish_time: '0',
      filter_duration: '0',
      content_type: '0',
      search_id: '',
      backtrace: ''
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`抖音搜索失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();

  // 解析搜索结果，兼容多种 TikHub 响应结构
  let items = [];
  if (result.data) {
    if (Array.isArray(result.data)) {
      items = result.data;
    } else if (result.data.business_data && Array.isArray(result.data.business_data)) {
      // TikHub v2: data.business_data[].data.aweme_info
      items = result.data.business_data.map(bd => bd.data).filter(Boolean);
    } else if (result.data.data && Array.isArray(result.data.data)) {
      items = result.data.data;
    } else if (result.data.aweme_info) {
      items = [result.data];
    }
  } else if (Array.isArray(result)) {
    items = result;
  }

  // 标准化每条记录为 aweme_info 对象
  const awemeList = items.map(item => {
    if (item.aweme_info) return item.aweme_info;
    if (item.aweme_id) return item;
    return null;
  }).filter(Boolean);

  log(`   搜索到 ${awemeList.length} 条视频`);
  return awemeList;
}

// Step 3: 提取视频脚本（同时获取视频表现特征元信息）
async function extractVideoScript(videoUrl) {
  const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model: DOUBAO_MODEL,
      messages: [
        { role: 'system', content: VIDEO_SCRIPT_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请转录这个视频中的全部台词内容，标注说话人。完整输出，不要省略。转录完成后输出视频表现特征元信息。' },
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
    throw new Error(`视频脚本提取失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // 解析 ---META--- 分隔符，分离脚本和元信息
  const metaSeparator = '---META---';
  const metaIdx = content.lastIndexOf(metaSeparator);
  let script = content;
  let meta = {};

  if (metaIdx !== -1) {
    script = content.substring(0, metaIdx).trim();
    const metaJsonStr = content.substring(metaIdx + metaSeparator.length).trim();
    try {
      const parsed = JSON.parse(metaJsonStr);
      meta = {
        表现形式: parsed.表现形式 || '',
        语速: parsed.语速 || '',
        说话风格: parsed.说话风格 || ''
      };
    } catch (e) {
      log(`   ⚠️ 视频元信息JSON解析失败，仅使用脚本`);
    }
  }

  return { script, meta };
}

// Step 4: 分析创意价值
async function analyzeCreative(title, script, meta) {
  let metaSection = '';
  if (meta && meta.表现形式) {
    metaSection = '\n\n# 视频表现特征（由视频模型观察得出，分析「适配达人」时请参考）\n'
      + `- 表现形式：${meta.表现形式}\n`
      + `- 语速：${meta.语速}\n`
      + `- 说话风格：${meta.说话风格}`;
  }

  const userInput = `# 输入

脚本标题：${title}
脚本内容：
${script}${metaSection}`;

  const response = await fetch(`${AIHUBMIX_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AIHUBMIX_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: userInput }
      ],
      max_tokens: 4096,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`创意分析失败 (HTTP ${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // 提取 JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log(`   ⚠️ 分析返回格式异常，使用原始文本`);
    return { 内容方向: content.substring(0, 50), 素材逻辑分析: '', 对度小满的借鉴: '', 植入修改建议: '' };
  }

  return JSON.parse(jsonMatch[0]);
}

// 从视频对象中提取下载 URL
function getDownloadUrl(aweme) {
  const video = aweme.video || {};
  const playAddr = video.play_addr_265 || video.play_addr || {};
  const urlList = playAddr.url_list || [];

  // 优先选择 api.amemv.com 域名
  const amemvUrl = urlList.find(url => url.includes('api.amemv.com'));
  if (amemvUrl) return amemvUrl;

  // 回退到第一个可用 URL
  return urlList[0] || null;
}

// 检查脚本是否包含禁止内容
function containsForbiddenContent(script) {
  return FORBIDDEN_KEYWORDS.some(keyword => script.includes(keyword));
}

// 检查视频标题/描述是否包含导师说教/成功学类禁止内容
function containsForbiddenTitle(desc) {
  return TITLE_FORBIDDEN_KEYWORDS.some(keyword => desc.includes(keyword));
}

// 检查是否全程未开口说话（无台词/无对话）
function isNoSpeechScript(script) {
  const trimmed = script.trim();
  if (!trimmed || trimmed.length < 5) return true;

  // 常见的"无台词"描述
  const noSpeechKeywords = [
    '无台词', '没有说话', '无对话', '无旁白', '全程没有', '未说话',
    '没有开口', '没有台词', '没有任何对话', '没有对白', '无对白',
    '纯音乐', '只有音乐', '没有声音', '静音', '无声音',
    '视频中没有任何', '视频没有说话', '该视频没有'
  ];
  if (noSpeechKeywords.some(kw => trimmed.includes(kw))) return true;

  // 如果内容全是括号内的动作描述，没有【人物】格式的台词
  const dialogueLines = trimmed.split('\n').filter(line => {
    const t = line.trim();
    return t && !t.startsWith('（') && !t.startsWith('(') && t.includes('】');
  });
  if (dialogueLines.length === 0) return true;

  return false;
}

// 检测 API 余额不足错误
function isQuotaExhaustedError(error) {
  const msg = (error.message || '').toLowerCase();
  return msg.includes('http 402') ||
         msg.includes('payment required') ||
         msg.includes('quota') ||
         msg.includes('insufficient') ||
         msg.includes('余额不足') ||
         msg.includes('额度不足') ||
         msg.includes('exceeded your current quota') ||
         msg.includes('billing') ||
         msg.includes('no enough') ||
         msg.includes('账户余额');
}

// 并发执行控制器：用 Promise.all 并行跑，但限制同时运行的数量
async function runWithConcurrency(taskFns, concurrency) {
  const results = new Array(taskFns.length);
  let index = 0;

  async function worker() {
    while (index < taskFns.length) {
      const current = index++;
      try {
        results[current] = await taskFns[current]();
      } catch (error) {
        results[current] = { status: 'failed', error: error.message };
      }
    }
  }

  const workers = Array(Math.min(concurrency, taskFns.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

// ============ 飞书多维表格自动化 ============

// 获取今天的日期字符串 yyyy/MM/dd
function getTodayDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// 调用 lark-cli 的封装
function runLarkCli(args) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
  };
  return execFileSync(LARK_CLI, args, {
    encoding: 'utf-8',
    timeout: 60000,
    env,
    maxBuffer: 10 * 1024 * 1024 // 10MB
  });
}

// Step 1 自动化：从多维表格查询已有素材 ID
function fetchExistingIds() {
  log('🔹 Step 1: 查询飞书多维表格已有素材 ID...');
  try {
    const output = runLarkCli([
      'base', '+record-list',
      '--base-token', BITABLE_BASE_TOKEN,
      '--table-id', BITABLE_TABLE_ID,
      '--field-id', '素材id',
      '--limit', '200',
      '--as', 'user',
      '--format', 'json'
    ]);

    const data = JSON.parse(output);
    const records = data?.data?.data || data?.data || [];
    const fieldNames = data?.data?.fields || [];
    const idFieldIdx = fieldNames.indexOf('素材id');
    const ids = [];

    for (const record of records) {
      // lark-cli 返回的记录可能是数组格式（配合 fieldNames）或对象格式（带 fields）
      let val;
      if (Array.isArray(record) && idFieldIdx >= 0) {
        val = record[idFieldIdx];
      } else if (record.fields) {
        val = record.fields['素材id'];
      } else {
        val = record['素材id'];
      }

      if (val && typeof val === 'string') {
        ids.push(val);
      } else if (Array.isArray(val)) {
        // 飞书文本字段可能返回 [{ text: "xxx" }]
        const text = val.map(v => v.text || '').join('');
        if (text) ids.push(text);
      }
    }

    log(`   已有素材 ID: ${ids.length} 条`);
    return ids;
  } catch (error) {
    log(`   ⚠️ 查询已有素材 ID 失败（将跳过去重）: ${error.message.substring(0, 200)}`);
    return [];
  }
}

// 格式化「适配达人」分析结果为飞书表格可写入的多行文本
function formatAdaptation(adaptation) {
  if (!adaptation) return '';
  if (typeof adaptation === 'string') return adaptation;
  if (typeof adaptation === 'object') {
    const parts = [];
    if (adaptation['达人类型']) parts.push(`达人类型：${adaptation['达人类型']}`);
    if (adaptation['表现形式']) parts.push(`表现形式：${adaptation['表现形式']}`);
    if (adaptation['语速与风格']) parts.push(`语速与风格：${adaptation['语速与风格']}`);
    if (adaptation['口吻']) parts.push(`口吻：${adaptation['口吻']}`);
    if (adaptation['推荐达人类型']) parts.push(`推荐达人类型：${adaptation['推荐达人类型']}`);
    return parts.join('\n');
  }
  return '';
}

// Step 3 自动化：构建 payload 并写入多维表格
function writeToBitable(results) {
  if (results.length === 0) {
    log('🔹 Step 5: 无需写入（0 条结果）');
    return { success: 0, failed: 0, errors: [] };
  }

  log(`📝 写入飞书多维表格（${results.length} 条）...`);

  const todayStr = getTodayDateStr();
  const createRecords = results.map(r => {
    const analysis = r.analysis || {};
    const borrowInsight = analysis['对度小满的借鉴'] || '';
    const implantSuggestion = analysis['植入修改建议'] || '';
    const adInsight = [borrowInsight, implantSuggestion].filter(Boolean).join('\n\n');

    return {
      '素材id': `dy_${r.aweme_id}`,
      '素材渠道': '抖音',
      '关键词': r.keyword || '',
      '素材链接': r.video_url,
      '素材脚本文案': r.script,
      '内容方向': analysis['内容方向'] || '',
      '内容分析': analysis['素材逻辑分析'] || '',
      '广告可借鉴点': adInsight,
      '适配达人': formatAdaptation(analysis['适配达人']),
      '更新时间': todayStr
    };
  });

  const payload = { create_records: createRecords };
  const payloadJson = JSON.stringify(payload);

  try {
    const output = execFileSync(LARK_CLI, [
      'base', '+record-batch-create',
      '--base-token', BITABLE_BASE_TOKEN,
      '--table-id', BITABLE_TABLE_ID,
      '--json', payloadJson,
      '--as', 'user',
      '--format', 'json'
    ], {
      encoding: 'utf-8',
      timeout: 60000,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1'
      },
      maxBuffer: 50 * 1024 * 1024
    });

    const resp = JSON.parse(output);
    const recordIds = resp?.data?.record_id_list || [];
    const count = recordIds.length;
    log(`   ✅ 成功写入 ${count} 条记录`);
    return { success: count, failed: 0, errors: [] };
  } catch (error) {
    log(`   ❌ 写入飞书多维表格失败: ${error.message.substring(0, 500)}`);
    return { success: 0, failed: results.length, errors: [error.message] };
  }
}

// 发送飞书通知（每次运行结束都发，含成功/失败/放弃统计）
function sendFeishuNotification(summary, quotaExhausted) {
  log('🔹 发送飞书结果通知...');

  try {
    // 从 auth status 获取当前用户 open_id
    const authOutput = runLarkCli(['auth', 'status']);
    const authData = JSON.parse(authOutput);
    const myOpenId = authData?.identities?.user?.openId || '';

    if (!myOpenId) {
      log('   ⚠️ 无法获取当前用户 open_id，跳过飞书通知');
      return;
    }

    const lines = [
      '📊 度小满创意分析 - 执行结果通知',
      ''
    ];

    if (summary.keywords && summary.keywords.length > 0) {
      lines.push(`🔑 搜索关键词：${summary.keywords.join('、')}`);
      lines.push('');
    }

    lines.push('📈 执行结果：');
    lines.push(`- ✅ 成功处理：${summary.total_success} 条`);
    lines.push(`- ⏭️ 被放弃：${summary.total_skipped} 条`);
    lines.push(`- ❌ 执行失败：${summary.total_failed} 条`);

    if (summary.bitable_success !== undefined) {
      lines.push(`- 📝 飞书写入：${summary.bitable_success} 条`);
    }

    if (quotaExhausted) {
      lines.push('');
      lines.push('⚠️ AIHubMix API 余额不足，工作流已提前终止！');
      lines.push('已成功处理的素材已写入飞书多维表格，请及时充值后重新运行。');
    } else {
      lines.push('');
      lines.push('✅ 工作流已正常完成。');
    }

    const msgText = lines.join('\n');
    const content = JSON.stringify({ text: msgText });
    runLarkCli([
      'im', '+messages-send',
      '--user-id', myOpenId,
      '--msg-type', 'text',
      '--content', content,
      '--as', 'user',
      '--format', 'json'
    ]);

    log('   ✅ 飞书通知已发送');
  } catch (error) {
    log(`   ⚠️ 飞书通知发送失败: ${error.message.substring(0, 200)}`);
  }
}

// 主流程
async function main() {
  // 解析参数
  const args = process.argv.slice(2);
  let customKeywords = null;
  let existingIds = [];
  let skipBitable = false;
  let isResume = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keywords' && args[i + 1]) {
      customKeywords = args[i + 1].split(',').map(k => k.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--existing-ids' && args[i + 1]) {
      existingIds = args[i + 1].split(',').map(id => id.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--skip-bitable') {
      skipBitable = true;
    } else if (args[i] === '--resume') {
      isResume = true;
    }
  }

  log('============================================');
  log('🎬 度小满创意分析 - 抖音工作流启动');
  log('============================================\n');

  // 检查必需的环境变量
  const required = { AIHUBMIX_API_KEY, TIKHUB_TOKEN };
  if (!skipBitable) {
    required.BITABLE_BASE_TOKEN = BITABLE_BASE_TOKEN;
    required.BITABLE_TABLE_ID = BITABLE_TABLE_ID;
  }
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    log(`❌ 缺少必需的环境变量: ${missing.join(', ')}`);
    log('   请参考 .env.example 配置环境变量后重试');
    process.exit(1);
  }

  // Step 1: 查询已有素材 ID（如果未手动传入）
  if (existingIds.length === 0 && !skipBitable) {
    existingIds = fetchExistingIds();
  } else if (existingIds.length > 0) {
    log(`🔹 Step 1: 使用传入的 ${existingIds.length} 个已有素材 ID`);
  }

  // ========== Resume 模式：从 checkpoint 恢复 ==========
  let keywords;
  let candidates = [];
  let allAweme = [];
  const skipped = [];

  if (isResume) {
    const cp = loadCheckpoint();
    if (!cp) {
      log('❌ 没有 checkpoint 文件，无法 --resume。请先正常运行一次。');
      process.exit(1);
    }
    keywords = cp.keywords;
    candidates = cp.candidates.filter(c => !cp.processed.includes(c.aweme_id));
    // 也跳过已写入飞书的（双重保险）
    candidates = candidates.filter(c => !existingIds.includes(`dy_${c.aweme_id}`));
    log(`🔹 Resume 模式：从 checkpoint 恢复`);
    log(`   关键词：${keywords.join('、')}`);
    log(`   原始候选：${cp.candidates.length} 条，已处理：${cp.processed.length} 条，剩余：${candidates.length} 条\n`);

    if (candidates.length === 0) {
      log('✅ 所有候选已处理完毕，清理 checkpoint。');
      clearCheckpoint();
      return;
    }
  } else {
    // ========== 正常模式：生成关键词 → 搜索 → 过滤 ==========
    // Step 1: 生成关键词（或使用自定义关键词）
    if (customKeywords && customKeywords.length > 0) {
      keywords = customKeywords;
      log(`🔹 Step 1: 使用自定义关键词: ${keywords.join(', ')}`);
    } else {
      keywords = await generateKeywords();
    }
    log('');

    // Step 2: 搜索抖音
    for (const keyword of keywords) {
      const results = await searchDouyin(keyword);
      // 每条视频标注它来自哪个搜索关键词
      for (const aweme of results) {
        allAweme.push({ aweme, keyword });
      }
    }
    log(`   共搜索到 ${allAweme.length} 条视频\n`);

    // Step 3: 过滤和去重
    log('🔹 Step 3: 过滤和去重...');

    for (const { aweme, keyword } of allAweme) {
      const awemeId = aweme.aweme_id;
      const duration = aweme.video?.duration;
      const materialId = `dy_${awemeId}`;

      // 去重
      if (existingIds.includes(materialId)) {
        skipped.push({ aweme_id: awemeId, reason: 'duplicate' });
        continue;
      }

      // 同一个 aweme_id 重复
      if (candidates.find(c => c.aweme_id === awemeId)) {
        skipped.push({ aweme_id: awemeId, reason: 'duplicate_in_batch' });
        continue;
      }

      // 视频文件大小过滤（豆包 API 限制 50MB）
      const videoSize = aweme.video?.data_size || 0;
      if (videoSize && videoSize > MAX_VIDEO_SIZE_MB * 1024 * 1024) {
        skipped.push({ aweme_id: awemeId, reason: 'video_too_large', size_mb: Math.round(videoSize / 1024 / 1024) });
        continue;
      }

      // 点赞数过滤
      const diggCount = aweme.statistics?.digg_count || 0;
      if (diggCount < MIN_DIGG_COUNT) {
        skipped.push({ aweme_id: awemeId, reason: 'low_digg_count', digg_count: diggCount });
        continue;
      }

      // 标题级过滤：导师说教/成功学/负债翻身类内容
      const descText = aweme.desc || '';
      if (containsForbiddenTitle(descText)) {
        skipped.push({ aweme_id: awemeId, reason: 'forbidden_title', desc: descText.substring(0, 50) });
        continue;
      }

      // 获取下载 URL
      const downloadUrl = getDownloadUrl(aweme);
      if (!downloadUrl) {
        skipped.push({ aweme_id: awemeId, reason: 'no_download_url' });
        continue;
      }

      candidates.push({
        aweme_id: awemeId,
        desc: aweme.desc || '',
        download_url: downloadUrl,
        duration: duration,
        keyword: keyword
      });
    }

    log(`   通过过滤: ${candidates.length} 条`);
    log(`   已跳过: ${skipped.length} 条`);
    skipped.forEach(s => log(`     - ${s.aweme_id}: ${s.reason}`));
    log('');

    // 保存 checkpoint（防中断丢失）
    if (candidates.length > 0) {
      saveCheckpoint(keywords, candidates);
    }
  }

  // Step 4: 提取脚本 + 分析（并行执行）
  const CONCURRENCY = parseInt(process.env.WORKFLOW_CONCURRENCY || '3', 10);
  log(`🔹 Step 4: 提取视频脚本并分析（并行，并发 ${CONCURRENCY}）...\n`);

  // 共享状态：一旦检测到余额不足，后续未开始的任务直接跳过
  const state = { quotaExhausted: false };

  // 为每个候选构建处理函数（返回结构化结果，不抛异常）
  const taskFns = candidates.map((candidate, i) => {
    return async () => {
      // 余额已耗尽，跳过
      if (state.quotaExhausted) {
        log(`   [${i + 1}/${candidates.length}] ⏭️  跳过 ${candidate.aweme_id}（API 余额不足，未开始）`);
        return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'quota_exhausted' };
      }

      log(`   [${i + 1}/${candidates.length}] 处理: ${candidate.aweme_id} — ${candidate.desc.substring(0, 50)}`);

      try {
        // 提取脚本 + 视频表现特征
        const { script, meta } = await extractVideoScript(candidate.download_url);
        log(`   [${candidate.aweme_id}] 脚本长度: ${script.length} 字`);

        // 检查全程未开口说话
        if (isNoSpeechScript(script)) {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 全程未开口说话`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'no_speech' };
        }

        // 检查禁止内容
        if (containsForbiddenContent(script)) {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 包含禁止内容`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'forbidden_content' };
        }

        // 分析创意（传入视频表现特征）
        const analysis = await analyzeCreative(candidate.desc, script, meta);

        // 检查内容相关性
        if (analysis.内容相关性 && analysis.内容相关性 !== '强相关') {
          log(`   [${candidate.aweme_id}] ⏭️  跳过: 内容${analysis.内容相关性}，与借钱/资金周转主题关联度不足`);
          markProcessed(candidate.aweme_id);
          return { status: 'skipped', aweme_id: candidate.aweme_id, desc: candidate.desc, reason: 'low_relevance', relevance: analysis.内容相关性 };
        }

        log(`   [${candidate.aweme_id}] ✅ 分析完成`);

        const result = {
          aweme_id: candidate.aweme_id,
          desc: candidate.desc,
          video_url: `https://www.douyin.com/video/${candidate.aweme_id}`,
          script,
          analysis,
          keyword: candidate.keyword
        };

        // 即时写入飞书（不等全部完成，防中途中断丢失数据）
        let bitableWritten = false;
        if (!skipBitable) {
          const single = writeToBitable([result]);
          bitableWritten = single.success > 0;
        }

        markProcessed(candidate.aweme_id);
        return { status: 'success', ...result, bitableWritten };
      } catch (error) {
        // 余额不足 — 设置标志，剩余任务将跳过
        if (isQuotaExhaustedError(error)) {
          state.quotaExhausted = true;
          log(`   [${candidate.aweme_id}] 💰 API 余额不足！剩余任务将跳过`);
          return { status: 'quota_exhausted', aweme_id: candidate.aweme_id, desc: candidate.desc, error: error.message };
        }
        log(`   [${candidate.aweme_id}] ❌ 处理失败: ${error.message.substring(0, 200)}`);
        markProcessed(candidate.aweme_id);
        return { status: 'failed', aweme_id: candidate.aweme_id, desc: candidate.desc, error: error.message };
      }
    };
  });

  // 并行执行所有任务
  const taskResults = await runWithConcurrency(taskFns, CONCURRENCY);

  // 分类汇总
  const results = [];
  const failedItems = [];

  for (const r of taskResults) {
    if (r.status === 'success') {
      results.push({
        aweme_id: r.aweme_id,
        desc: r.desc,
        video_url: r.video_url,
        script: r.script,
        analysis: r.analysis,
        keyword: r.keyword,
        bitableWritten: r.bitableWritten
      });
    } else if (r.status === 'skipped') {
      skipped.push({ aweme_id: r.aweme_id, reason: r.reason });
    } else if (r.status === 'quota_exhausted') {
      skipped.push({ aweme_id: r.aweme_id, reason: 'quota_exhausted' });
    } else if (r.status === 'failed') {
      failedItems.push({ aweme_id: r.aweme_id, error: r.error });
    }
  }

  // Step 5: 飞书写入已在每条分析完成后即时执行，此处仅统计
  let bitableResult = { success: 0, failed: 0, errors: [] };
  if (skipBitable) {
    log('🔹 Step 5: 跳过飞书写入（--skip-bitable）');
  } else {
    bitableResult.success = results.filter(r => r.bitableWritten).length;
    bitableResult.failed = results.filter(r => !r.bitableWritten).length;
    log(`🔹 Step 5: 飞书写入统计 — 成功 ${bitableResult.success} 条，失败 ${bitableResult.failed} 条`);
  }

  // 每次运行结束都发送飞书通知
  sendFeishuNotification(
    {
      total_success: results.length,
      total_skipped: skipped.length,
      total_failed: failedItems.length,
      bitable_success: bitableResult.success,
      keywords: keywords
    },
    state.quotaExhausted
  );

  // 全部处理完成，清理 checkpoint
  if (!state.quotaExhausted) {
    clearCheckpoint();
  }

  // 输出结果
  log('============================================');
  log(`✅ 工作流完成！`);
  log(`   成功: ${results.length} 条`);
  log(`   被放弃: ${skipped.length} 条`);
  log(`   执行失败: ${failedItems.length} 条`);
  if (bitableResult.success > 0) {
    log(`   飞书写入: ${bitableResult.success} 条`);
  }
  if (bitableResult.failed > 0) {
    log(`   飞书写入失败: ${bitableResult.failed} 条`);
  }
  if (state.quotaExhausted) {
    log(`   ⚠️  API 余额不足，工作流已提前终止！`);
  }
  log('============================================\n');

  const output = {
    keywords: keywords,
    results: results,
    skipped: skipped,
    failed: failedItems,
    quota_exhausted: state.quotaExhausted,
    bitable_write: bitableResult,
    summary: {
      total_searched: allAweme.length,
      total_filtered: candidates.length,
      total_success: results.length,
      total_skipped: skipped.length,
      total_failed: failedItems.length,
      bitable_success: bitableResult.success,
      bitable_failed: bitableResult.failed
    }
  };

  // JSON 输出到 stdout
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  log(`\n❌ 工作流失败: ${error.message}`);
  process.exit(1);
});
