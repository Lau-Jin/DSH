/**
 * 自动提炼检索式 —— 把「读工单」和「检索知识库」塌缩成一条命令。
 *
 * 为什么需要它：
 * 检索式必须来自工单正文，所以正常流程是「读工单 → 想检索式 → 检索」。
 * 中间那步要占掉**一整个模型回合**：工单内容得先回到模型，模型才能决定检索词，
 * 然后才能发起检索。两次工具调用之间夹一次推理，往返就慢在这里。
 *
 * 这个模块让脚本自己从工单正文里挑检索式，于是整个流程塌缩成一条命令：
 *   node scripts/triage.mjs <工单号> --auto
 * 模型不必在两次工具调用之间做判断，也就不必多跑一个回合。
 *
 * 边界：自动提炼只是**初稿**。triage 会把「用过的检索式」和「工单事实表」打印在
 * 同一份输出里，所以模型若觉得词不对，补一轮 --query 时**不需要重新读工单**。
 */

/** 出现这些词，多半是问题所在 —— 报错句优先当检索式。 */
const ERROR_HINTS = [
  '错误', '失败', '异常', '报错', '不支持', '不能', '无法', '超时', '重复', '不存在',
  '为空', '不合法', '不正确', '未找到', '无效', '未配置', '不显示', '没有显示', '没反应',
  '同步不了', '同步失败', '缺失', '冲突', '锁定', '拒绝', '中断', '不匹配', '未同步',
  '空指针', '连接失败', '创建失败',
];

/**
 * 校验类报错的特征词。这类报错（"请确认时间格式正确"）是**最有检索价值**的：
 * 它几乎就是知识库文档里的原句。命中它们的短语优先当检索式。
 */
const VALIDATION_HINTS = ['请确认', '请检查', '必须', '应该', '应为', '要求', '格式', '不符合', '不正确'];

/**
 * **高辨识度的报错词**（多字）—— 检索式的主力。
 *
 * 为什么单独列一批：单字词（"异常"、"不能"、"失败"）几乎出现在每篇文档里，
 * 向量检索时等于没加约束；多字词（"空指针"、"连接失败"、"无法读取"）才真正定位得到。
 * 所以优先找含这些词的句子。
 */
const DISTINCTIVE = [
  '空指针', '连接失败', '创建失败', '同步失败', '发布失败', '读取失败', '导入失败', '推送失败',
  '无法读取', '无法连接', '无法创建', '无法获取', '无法发布', '无法同步', '不能增加',
  '不支持', '不存在', '未找到', '格式错误', '格式不正确', '未配置', '不显示', '没有显示',
  '没有数据', '数据为空', '重复', '冲突', '不合法', '无效', '超时', '为空', '锁定',
  '中断', '不匹配', '未同步', '缺失', '读不到', '查不到', '加不上', '点不动',
];

/**
 * 公司自有产品 / 常见模块 —— 命中这些说明要找知识库。
 * 顺序即优先级（先匹配到的先入检索式）。
 */
const MODULES = [
  '统一身份认证', '一平两端', '迎新', '服务中台', '一网通办', '数据中台', '数据同步',
  '运维规范', '资讯配置', '资讯同步', '新闻资讯', '组织机构', '部门管理', '班级管理',
  '学生管理', '用户管理', '同步学生', '同步班级', '同步机构', '工资查询', '高级检索',
  '灾备', '等保', '流程引擎',
];

/** 常见动作词 —— 和产品名拼成「产品 + 动作」的检索式。 */
const ACTIONS = [
  '同步', '配置', '导入', '查询', '新增', '删除', '校验', '推送', '导出', '拉取',
  '批量', '定时', '发布', '失败', '报错', '日志', '权限', '登录',
];

/**
 * 通用词 / 文档标题 —— **不能**当检索式。
 * 这些词在任何一篇文档里都可能出现，向量检索时等于没加约束，
 * 只会把结果稀释掉（实测 "解决方案" 会把命中全带到无关文档）。
 */
const GENERIC = new Set([
  '解决方案', '处理过程', '处理步骤', '操作步骤', '验证结果', '后续建议', '问题描述',
  '问题现象', '原因分析', '根因分析', '处理说明', '操作说明', '注意事项', '总结',
  '解决方案如下', '具体如下', '详见', '如下', '以上', '目前', '现在', '进行', '相关',
]);

/** 去掉噪音：时间戳、线程号、日志级别、纯数字。 */
function scrub(s) {
  return String(s || '')
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d+}(?:\.\d+)?/g, ' ')
    .replace(/\b(?:EDU-)?Thread-\d+\b/gi, ' ')
    .replace(/\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b/gi, ' ')
    .replace(/[|~`^]+/g, ' ');
}

/** 切成句子/短语片段。 */
function segments(text) {
  return String(text || '')
    .split(/[\n\r。；;！!？?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 归一化检索式：压空白、掐头去尾的标点。 */
function normalize(q) {
  const s = scrub(q)
    .replace(/[\s,，。；;、：:()（）\[\]【】<>《》"'`~!！?？/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length < 2) return '';
  if (/^[\d\s.:/-]+$/.test(s)) return ''; // 纯数字 / 日期
  return s.slice(0, 32);
}

/** 取中文片段（连续 2 个以上的汉字）。 */
function cjkRuns(text) {
  return String(text || '').match(/[\u4e00-\u9fa5]{2,}/g) || [];
}

/**
 * 这串东西**能不能**当检索式？所有来源（报错句 / 引号原文 / 标识符 / 标题）都过这一关。
 *
 * 挡掉三类噪音：
 *   ① 十六进制哈希（SQL 里的 UUID、附件 ID）——'712777ab785b4d15aded7275a747dae3'
 *   ② 通用词（"解决方案"、"原因分析"）——每篇文档都有，加了等于没加约束
 *   ③ 纯数字 / 纯符号
 */
function usablePhrase(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^[\d\s.:/-]+$/.test(v)) return false;              // 纯数字 / 日期
  if (/^[0-9a-f]{12,}$/i.test(v)) return false;            // 十六进制哈希
  // 带哈希尾巴的（child_6d378b6cf6344b6788fe0d907ea6129b）
  if (/_[0-9a-f]{16,}$/i.test(v)) return false;
  if (GENERIC.has(v)) return false;                        // 通用词
  // 通用词拼起来的（"解决方案原因分析"）也丢
  if ([...GENERIC].every((g) => !v.includes(g)) === false) {
    const rest = [...GENERIC].reduce((acc, g) => acc.split(g).join('|'), v);
    if (rest.split('|').every((p) => !p.trim())) return false;
  }
  return true;
}

/** 这个中文片段像不像"能检索的短语"？ */
function usableCjk(run) {
  if (!run || run.length < 3) return false;
  if (!usablePhrase(run)) return false;
  // 纯通用词拼接的（"解决方案目前"）也丢
  let rest = run;
  for (const g of GENERIC) rest = rest.split(g).join('|');
  const parts = rest.split('|').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const meaningful = parts.join('');
  if (meaningful.length < 3) return false;
  return true;
}

/**
 * 报错短语 —— 检索式的主力。
 *
 * 策略：先找含**高辨识度报错词**（空指针 / 连接失败 / 无法读取）的句子，
 * 找不到才退到普通错误词（异常 / 失败）。
 *
 * ⚠️ 中文片段必须**整段**取，不能切碎：切成"要求为"/"确认时间格式正确"
 * 两段反而各自失去检索力（实测）。所以这里按标点分段后再取连续汉字串。
 *
 * ⚠️ 「请」不能去掉：「请确认时间格式正确」是知识库里的原话形态，
 * 去掉「请」就再也匹配不上了。
 */
function errorPhrases(body, { minLen = 4 } = {}) {
  const out = [];
  for (const seg of segments(body)) {
    const clean = scrub(seg).replace(/[|]/g, ' ');
    for (const run of cjkRuns(clean)) {
      if (!usableCjk(run)) continue;

      const distinctive = DISTINCTIVE.find((d) => run.includes(d));
      const isValidation = !distinctive && VALIDATION_HINTS.some((v) => run.includes(v));
      const isError = !distinctive && !isValidation && ERROR_HINTS.some((h) => run.includes(h));
      if (!distinctive && !isValidation && !isError) continue;

      // 只掐掉尾巴上的语气词；「请」要留着
      const cleaned = run.replace(/(的|了|呢|吗|吧|啊|呀)+$/g, '');
      if (cleaned.length < Math.max(3, minLen)) continue;

      out.push({
        text: cleaned.slice(0, 16),
        // 排序权重：高辨识度词 > 校验类 > 普通错误词
        weight: distinctive ? 3 : isValidation ? 2 : 1,
        len: cleaned.length,
      });
    }
  }

  // 同权重内按长度降序（更长的短语带更多上下文，向量检索更准）
  out.sort((a, b) => (b.weight - a.weight) || (b.len - a.len));

  // 去掉被更长检索式包含的短式
  const kept = [];
  for (const x of out) {
    if (kept.some((k) => k.text.includes(x.text))) continue;
    kept.push(x);
    if (kept.length >= 3) break;
  }
  return kept.map((x) => x.text);
}

/**
 * 代码标识符 —— 表名 / 类名，检索最精确。
 *
 * 只认两种形态：
 *   snake_case   edu_class_info / news_section_api_service_data
 *   CamelCase    PlatformAppsNewsSectionConfigServiceImpl
 * 排除前面带包路径的残片（t.s.m.p.m.s.s.i.Xxx 里的 "iceImpl"）——
 * 那不是标识符，是被点号切碎的尾巴。
 *
 * ⚠️ SQL 里的**列名**（type_id / value / code / sort）不能当检索式：
 * 它们在每张表里都叫这个名，检索时毫无区分度。挑表名要用 ——
 * 一律带 table/表/字段清单 等上下文，没有上下文就整段丢掉。
 */
const SQL_NOISE = new Set([
  'type_id', 'group_id', 'table_filed_id', 'table_field_id', 'is_def', 'create_time',
  'update_time', 'value', 'values', 'sort', 'code', 'id', 'ids', 'name', 'names',
  'key', 'keys', 'data', 'status', 'type', 'time', 'date', 'count', 'num', 'no',
]);

function identifiers(body) {
  const out = [];
  const text = scrub(body);

  // snake_case：前面不能紧跟 . 或字母
  for (const m of text.matchAll(/(?<![.\w])([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})/g)) {
    const v = m[1];
    if (v.length < 5) continue;
    if (!usablePhrase(v)) continue;
    if (SQL_NOISE.has(v)) continue;
    out.push(v);
  }
  // CamelCase：至少三段，且前面不是点
  for (const m of text.matchAll(/(?<![.\w])([A-Z][a-z0-9]*(?:[A-Z][a-z0-9]+){2,})/g)) {
    const v = m[1];
    if (v.length < 8) continue;
    if (!usablePhrase(v)) continue;
    out.push(v);
  }
  return [...new Set(out)];
}

/** 引号里的原话 —— 报错文案 / 字段名。格式说明、日期、哈希这类直接跳过。 */
function quotedSpans(body) {
  const out = [];
  for (const m of body.matchAll(/['"「『【]([^'"「『【\n]{4,36})['"」』】]/g)) {
    const v = m[1].trim();
    if (!usablePhrase(v)) continue;
    // 时间/日期格式说明：'yyyy-MM-dd HH:mm:ss'、'2026-08-14' —— 不可检索
    if (/^\d{4}[-/.]\w/.test(v)) continue;
    if (/^(y{2,}|M{2,}|d{2,}|H{2,}|m{2,}|s{2,})([-:/ .]\w+)*$/i.test(v)) continue;
    if (!/[\u4e00-\u9fa5A-Za-z]{4,}/.test(v)) continue;
    out.push(v);
  }
  return out;
}

/** 标题清洗：去掉年份/日期前缀（"2026年等保测评支持" → "等保测评支持"）。 */
function cleanTitle(title) {
  return String(title || '')
    .replace(/^\s*\d{4}\s*年\s*/, '')
    .replace(/^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s*/, '')
    .trim();
}

/**
 * 从工单正文里提炼检索式。
 *
 * @param {{title?:string, description?:string, descriptionText?:string, logs?:Array<{logType?:string,contentText?:string,content?:string}>}} ticket
 * @returns {string[]} 最多 3 个检索式，按「最有信息量」排序
 */
export function deriveQueries(ticket = {}) {
  const logs = ticket.logs || [];
  const human = logs.filter((l) => l.logType !== 'ai');
  const description = ticket.descriptionText || ticket.description || '';
  const logText = human.map((l) => l.contentText || l.content || '').filter(Boolean).join('\n');

  const out = [];
  const push = (q, { exact = false } = {}) => {
    const s = exact ? String(q || '').trim().slice(0, 32) : normalize(q);
    if (!s || s.length < 2) return;
    if (!usablePhrase(s)) return;                 // 哈希 / 通用词 / 纯数字 —— 一律不进
    if (out.length >= 3) return;
    // 去重：互相包含的算同一个
    if (out.some((x) => x === s || x.includes(s) || s.includes(x))) return;
    out.push(s);
  };

  // ① 报错短语 —— 信息量最高，放第一。
  //    描述优先于日志：描述是报障人自己写的，日志里常混着无关的执行痕迹。
  for (const p of [...errorPhrases(description), ...errorPhrases(logText)]) {
    push(p);
    if (out.length >= 3) break;
  }

  // ② 引号里的原话 —— 字段名、报错文案
  if (out.length < 3) {
    for (const v of quotedSpans(`${description}\n${logText}`)) {
      push(v);
      if (out.length >= 3) break;
    }
  }

  // ③ 代码标识符 —— 表名 / 类名
  if (out.length < 3) {
    for (const id of identifiers(`${description}\n${logText}`)) {
      push(id, { exact: true });
      if (out.length >= 3) break;
    }
  }

  // ④ 产品/模块 + 动作 —— 至少给工单一个"业务面"的检索入口
  if (out.length < 3) {
    const all = `${ticket.title || ''}\n${description}\n${logText}`;
    const mods = MODULES.filter((m) => all.includes(m));
    const acts = ACTIONS.filter((a) => all.includes(a));
    for (const mod of mods) {
      // 动作词和模块词重复时不重复写（"数据同步 同步" → "数据同步"）
      const act = acts.find((a) => a !== '失败' && a !== '报错' && !mod.includes(a) && !mod.endsWith(a));
      push(act ? `${mod} ${act}` : mod);
      if (out.length >= 3) break;
    }
  }

  // ⑤ 还没有词 → 用清洗过的标题（"2026年等保测评支持" → "等保测评支持"）
  if (out.length < 3) {
    const t = normalize(cleanTitle(ticket.title || ''));
    if (t) push(t);
  }

  return out.slice(0, 3);
}
