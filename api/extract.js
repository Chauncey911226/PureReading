/**
 * Pure Reading · Vercel Serverless Function
 * 路由：POST /api/extract
 *
 * 调用链路：
 *   1. 接收前端 POST { url }
 *   2. 用 readability 算法提取干净正文 + 原标题（Firefox 阅读模式同款）
 *      - 静态网页：直接 fetch + readability
 *      - SPA 网站：降级到 Jina Reader（能执行 JS）
 *   3. 调用 硅基流动 Qwen/Qwen2.5-7B-Instruct 生成 3-5 句白话摘要
 *   4. 返回 { ok, title, content, summary, source }
 *
 * 环境变量（在 Vercel 控制台 → Settings → Environment Variables 配置）：
 *   - JINA_API_KEY          （Jina Reader，注册 jina.ai 领取）
 *   - SILICONFLOW_API_KEY   （硅基流动，注册 siliconflow.cn 领取）
 *   - ALLOWED_ORIGIN        （可选，CORS 白名单；不填则允许所有来源）
 */

const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

const JINA_ENDPOINT = 'https://r.jina.ai/';
const SILICONFLOW_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const SILICONFLOW_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

// 系统提示词：人设 + 任务 + 风格 + 禁忌
// 只负责生成白话摘要，标题由 readability 提取
const SYSTEM_PROMPT = `你是一位极具耐心的社区助老志愿者。
你的任务：把用户给你的网页正文，提炼成 3 到 5 句长辈能轻松听懂的"大白话"要点。

风格约束：
1. 语气必须有温度、带有安抚性，像在跟邻居奶奶面对面讲话。
2. 如果原文包含行动指南（如报销流程、防骗预警、领补贴步骤），摘要中必须明确给出"接下来该怎么做"。
3. 禁止使用书面化、公文式词汇，例如：该文章指出、据统计、综上所述、需要注意的是、根据规定。
4. 必须转换为生活化口语，例如："这文章说的是"、"算下来"、"简单讲"、"你接下来要去"。

输出格式（严格遵守）：
1. 必须输出 3 到 5 条要点，不能少于 3 条，不能多于 5 条。
2. 每条必须是完整的中文句子，表达一个完整意思。
3. 每条句子中绝对不能包含这些符号：{ } [ ] " \\
4. 只能输出一个 JSON 对象，不要 markdown 代码块、不要解释，直接以 { 开头、} 结尾。

JSON 结构：
{"summary": ["第一句完整句子", "第二句完整句子", "第三句完整句子"]}

正确示例：
{"summary": ["这文章说的是今年医保报销比例涨了", "去医院看病带上医保卡就行", "如果你住城里，社区卫生服务中心也能报"]}

错误示例（必须避免）：
- {"summary": ["只有一条要点"]}  ← 数量不足 3 条
- {"summary": ["要点1", "要点2", "}}}"]}  ← 末尾混入了符号
- {"summary": ["要点1", "要点2", "安装简单，先试试Next" ,}}}  ← JSON 没闭合`;

/**
 * Vercel Serverless Function 入口
 */
module.exports = async (req, res) => {
  // CORS
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 预检
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '仅支持 POST 请求' });
  }

  // 解析 body
  const url = typeof req.body === 'string' ? safeJsonParse(req.body)?.url : req.body?.url;
  const targetUrl = url?.trim();

  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    return res.status(400).json({
      ok: false,
      error: '请提供合法的网址（以 http 或 https 开头）',
    });
  }

  try {
    // === 步骤一：用 readability 提取干净正文 + 原标题 ===
    const { title: rawTitle, content: cleanText } = await extractContent(targetUrl);

    if (!cleanText || cleanText.length < 50) {
      return res.status(422).json({
        ok: false,
        error: '未能从该网页提取到有效正文，请换一个链接试试',
      });
    }

    // === 步骤二：硅基流动 Qwen2.5-7B 生成白话摘要 ===
    const aiResult = await fetchSiliconFlow(cleanText);

    // 兜底：如果摘要为空（模型输出全部被清洗掉），给一条提示
    const finalSummary = (aiResult.summary && aiResult.summary.length > 0)
      ? aiResult.summary
      : ['AI 这次没能总结出来，请直接看下面的正文'];

    return res.status(200).json({
      ok: true,
      title: rawTitle || '阅读模式',  // 用 readability 提取的原标题
      content: cleanText,             // 纯正文，无杂质
      summary: finalSummary,
      source: targetUrl,
    });
  } catch (err) {
    console.error('[PureReading] 处理失败:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || '服务器内部错误',
    });
  }
};

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * 带超时的 fetch（Node 18+ undici 支持 AbortSignal）
 */
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * 把 HTML 转成保留段落分隔的纯文本
 * - <p>, <div>, <h1-6>, <li>, <blockquote> 闭合转成双换行（段落分隔）
 * - <br> 转成双换行
 * - <li> 开头加 "- "（列表项）
 * - 去掉所有剩余标签
 * - 解码常见 HTML 实体
 * - 合并多余空行
 */
function htmlToParagraphText(html) {
  if (!html) return '';

  let text = html
    // 列表项之间用单换行（同一列表内）
    .replace(/<\/li>/gi, '\n')
    // 块级元素闭合标签换成双换行（段落分隔）
    .replace(/<\/(p|div|h[1-6]|blockquote|tr|section|article|ul|ol)>/gi, '\n\n')
    // <br> 换行
    .replace(/<br\s*\/?>/gi, '\n\n')
    // <li> 开头加列表标记
    .replace(/<li[^>]*>/gi, '- ')
    // 去掉所有剩余标签
    .replace(/<[^>]+>/g, '')
    // 解码常见 HTML 实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'");

  // 合并 3 个以上换行为 2 个
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * 公众号文章特殊提取
 * 公众号正文在 <div id="js_content"> 里，readability 经常识别不到
 * 标题在 <h1 id="activity-name"> 或 <h1 class="rich_media_title">
 */
function extractWechatContent(html) {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // 提取标题
    let title = '';
    const titleEl = doc.querySelector('#activity-name')
      || doc.querySelector('h1.rich_media_title')
      || doc.querySelector('h1');
    if (titleEl) {
      title = titleEl.textContent.trim();
    }

    // 提取正文
    const contentEl = doc.querySelector('#js_content');
    if (!contentEl) return null;

    const contentHtml = contentEl.innerHTML;
    const content = htmlToParagraphText(contentHtml);

    if (content.length < 50) return null;

    console.log(`[PureReading] 公众号特殊提取成功，标题「${title}」，正文 ${content.length} 字符`);
    return { title, content };
  } catch (err) {
    console.warn(`[PureReading] 公众号提取失败: ${err.message}`);
    return null;
  }
}

/**
 * 用 readability 算法提取干净正文（Firefox 阅读模式同款）
 * 返回 { title, content }
 *   - title: 去掉 SEO 后缀的干净标题
 *   - content: 纯正文文本，保留段落分隔，无广告/导航/相关推荐/评论/外链
 */
async function fetchWithReadability(targetUrl) {
  console.log(`[PureReading] readability 抽取中: ${targetUrl}`);
  const resp = await fetchWithTimeout(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  }, 20000);

  if (!resp.ok) {
    throw new Error(`抓取网页失败（HTTP ${resp.status}）`);
  }

  const html = await resp.text();
  console.log(`[PureReading] 拿到原始 HTML，长度 ${html.length} 字符`);

  // 公众号特殊处理：readability 经常识别不到 #js_content
  if (targetUrl.includes('mp.weixin.qq.com')) {
    const wechatResult = extractWechatContent(html);
    if (wechatResult && wechatResult.content.length >= 100) {
      return wechatResult;
    }
    console.warn(`[PureReading] 公众号特殊提取失败，回退到 readability`);
  }

  // 用 jsdom 解析 HTML
  const dom = new JSDOM(html, { url: targetUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('readability 无法识别正文（可能是 SPA 网站或反爬页面）');
  }

  // 用 content（HTML）转换成保留段落的纯文本，而不是 textContent（会压成一段）
  const content = htmlToParagraphText(article.content);
  console.log(`[PureReading] readability 成功，标题「${article.title}」，正文 ${content.length} 字符`);

  // 限制长度（Qwen2.5-7B 上下文 32K，留余地）
  const MAX_CHARS = 6000;
  const trimmed = content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) : content;

  return {
    title: (article.title || '').trim(),
    content: trimmed,
  };
}

/**
 * 调用 Jina Reader 抽取纯文本（带 25 秒超时 + 1 次重试）
 * Jina 返回 Markdown 格式，从 "Title: xxx" 行提取标题
 * 返回 { title, content }
 */
async function fetchJina(targetUrl) {
  const headers = { 'Accept': 'text/plain' };
  if (process.env.JINA_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
  }

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      console.log(`[PureReading] Jina 抽取中（第 ${attempt + 1}/2 次）: ${targetUrl}`);
      const resp = await fetchWithTimeout(JINA_ENDPOINT + targetUrl, { headers }, 25000);
      if (!resp.ok) {
        throw new Error(`Jina 抽取失败（HTTP ${resp.status}）`);
      }
      const text = await resp.text();
      console.log(`[PureReading] Jina 成功，原始长度 ${text.length} 字符`);

      // Jina 返回内容格式：
      // "Title: xxx\nURL: xxx\nMarkdown Content:\n正文..."
      const lines = text.split('\n');
      let title = '';
      let body = text;

      // 提取 Title 行
      for (let i = 0; i < Math.min(lines.length, 5); i++) {
        const m = lines[i].match(/^Title:\s*(.+)/i);
        if (m) {
          title = m[1].trim();
          break;
        }
      }

      // 提取正文（Markdown Content: 之后）
      const marker = 'Markdown Content:';
      const idx = text.indexOf(marker);
      if (idx >= 0) {
        body = text.slice(idx + marker.length).trim();
      }

      // 限制长度
      const MAX_CHARS = 6000;
      if (body.length > MAX_CHARS) {
        body = body.slice(0, MAX_CHARS);
      }

      return { title, content: body };
    } catch (err) {
      const cause = err.cause ? ` [cause: ${err.cause.code || err.cause.message}]` : '';
      console.warn(`[PureReading] Jina 失败（第 ${attempt + 1}/2 次）: ${err.message}${cause}`);
      lastErr = new Error(`Jina 抽取失败: ${err.message}${cause}`);
      if (attempt === 0) {
        await sleep(1500);
      }
    }
  }
  throw lastErr || new Error('Jina 抽取失败');
}

/**
 * 抽取入口：先 readability（静态网页质量高），失败或正文过短降级到 Jina（SPA 兜底）
 * 返回 { title, content }
 */
async function extractContent(targetUrl) {
  // 第一步：readability 抽取
  try {
    const result = await fetchWithReadability(targetUrl);
    if (result.content.length >= 500) {
      console.log(`[PureReading] readability 抽取成功，跳过 Jina`);
      return result;
    }
    console.warn(`[PureReading] readability 正文过短（${result.content.length} 字符），降级到 Jina`);
  } catch (err) {
    console.warn(`[PureReading] readability 失败: ${err.message}，降级到 Jina`);
  }

  // 第二步：降级到 Jina
  return await fetchJina(targetUrl);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 从模型返回内容中提取 JSON（容错处理 markdown 代码块、前后噪音文本）
 */
function extractJsonFromContent(content) {
  if (!content) return null;
  // 1. 直接尝试解析
  try { return JSON.parse(content); } catch { }
  // 2. 尝试去掉 markdown 代码块
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()); } catch { }
  }
  // 3. 尝试提取第一个 { ... } 块
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { }
  }
  return null;
}

/**
 * 清洗 summary 数组（处理小模型常见的输出污染）
 * - 去掉包含 JSON 符号的项（如 "}}}" "[" "{" 等）
 * - 去掉空字符串和过短噪音（< 4 字符）
 * - 去掉重复项
 * - 限制最多 5 条
 */
function cleanSummary(summary) {
  if (!Array.isArray(summary)) return [];

  const cleaned = summary
    .map(item => String(item).trim())
    // 去掉包含 JSON 结构符号的项
    .filter(item => !/[{}[\]]/.test(item))
    // 去掉空字符串
    .filter(item => item.length > 0)
    // 去掉过短噪音（少于 4 个字符，如 "1," "要" 等）
    .filter(item => item.length >= 4)
    // 去掉重复项
    .filter((item, idx, arr) => arr.indexOf(item) === idx)
    // 限制最多 5 条
    .slice(0, 5);

  return cleaned;
}

/**
 * 调用硅基流动 Qwen/Qwen2.5-7B-Instruct 生成白话摘要
 * - 单次请求超时 30 秒
 * - 遇到 429（限流）或网络错误时自动重试，最多 3 次，间隔递增 2s/4s/6s
 * - 只返回 { summary }，标题由 readability 负责
 */
async function fetchSiliconFlow(cleanText) {
  if (!process.env.SILICONFLOW_API_KEY) {
    throw new Error('未配置 SILICONFLOW_API_KEY，无法调用大模型');
  }

  const userPrompt = `以下是网页正文，请按系统指令的格式输出 JSON 摘要：\n\n${cleanText}`;

  const requestBody = JSON.stringify({
    model: SILICONFLOW_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.5,
    max_tokens: 800,
    response_format: { type: 'json_object' },
  });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(2000 * attempt);
    }

    try {
      console.log(`[PureReading] 硅基流动调用中（第 ${attempt + 1}/3 次）, 模型: ${SILICONFLOW_MODEL}`);
      const resp = await fetchWithTimeout(SILICONFLOW_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        },
        body: requestBody,
      }, 30000);

      if (resp.status === 429) {
        const errText = await resp.text().catch(() => '');
        lastErr = new Error(`AI 当前太忙了（429）: ${errText.slice(0, 150)}`);
        console.warn(`[PureReading] 硅基流动 429 限流，第 ${attempt + 1}/3 次重试中...`);
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`硅基流动调用失败（HTTP ${resp.status}）: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      console.log(`[PureReading] 硅基流动成功，返回内容长度 ${content.length} 字符`);

      // 解析 JSON（带容错）
      const parsed = extractJsonFromContent(content);
      if (parsed) {
        return {
          summary: cleanSummary(parsed.summary),
        };
      }
      // 容错：如果模型没按JSON返回，整段当一条摘要
      return { summary: cleanSummary([content.replace(/```/g, '').trim()]) };
    } catch (err) {
      lastErr = new Error(`硅基流动请求失败: ${err.message || err.code || err}`);
      const isTimeout = err.name === 'AbortError' || err.code === 'UND_ERR_HEADERS_TIMEOUT';
      console.warn(`[PureReading] 硅基流动失败（第 ${attempt + 1}/3 次，${isTimeout ? '超时' : err.message}），重试中...`);
    }
  }

  if (lastErr) {
    const msg = lastErr.message || '';
    if (msg.includes('429')) {
      throw new Error('AI 当前太忙了，请稍等 30 秒再试');
    }
    if (msg.includes('AbortError') || msg.includes('Timeout')) {
      throw new Error('AI 响应超时，请稍后再试');
    }
    throw lastErr;
  }
  throw new Error('硅基流动调用失败');
}
