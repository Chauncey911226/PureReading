/* ============================================
   Pure Reading · 前端 SPA 逻辑
   - URL 参数 ?u=<base64编码的网址> 驱动输入态/阅读态切换
   - 调用云函数返回结构化数据
   ============================================ */

// 云函数 HTTP 触发地址
// - 本地开发：dev-local.js 同域托管前端，直接走相对路径
// - 部署到 Vercel 后：也是同域，相对路径自动生效
const API_ENDPOINT = '/api/extract';

// URL 参数 key
const URL_PARAM = 'u';

// DOM 引用
const els = {
  viewInput: document.getElementById('view-input'),
  viewLoading: document.getElementById('view-loading'),
  viewReader: document.getElementById('view-reader'),

  form: document.getElementById('url-form'),
  urlInput: document.getElementById('url-input'),
  submitBtn: document.getElementById('submit-btn'),
  inputError: document.getElementById('input-error'),

  readerTitle: document.getElementById('reader-title'),
  readerSource: document.getElementById('reader-source'),
  readerContent: document.getElementById('reader-content'),

  sidePanel: document.getElementById('side-panel'),
  sidePanelToggle: document.getElementById('side-panel-toggle'),
  sidePanelList: document.getElementById('side-panel-list'),

  shareBtnTop: document.getElementById('share-btn-top'),
  homeBtnTop: document.getElementById('home-btn-top'),

  toast: document.getElementById('toast'),
};

// ============================================
// 工具函数
// ============================================

// URL 安全的 base64 编码（兼容中文）
function encodeUrl(rawUrl) {
  const b64 = btoa(unescape(encodeURIComponent(rawUrl)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeUrl(encoded) {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

// 安全渲染纯文本（防 XSS）
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 把纯文本转成 HTML（保留段落结构）
// 后端返回的文本用 \n\n 分隔段落，列表项用 \n 分隔
// 支持：## 标题 / ### 子标题 / - 列表 / 段落
function renderContent(text) {
  // 按 \n\n 分段（保留段落结构）
  const paragraphs = text.split(/\n{2,}/);
  const html = [];
  let inList = false;

  for (const para of paragraphs) {
    const t = para.trim();
    if (!t) continue;

    // 标题
    if (/^###\s+/.test(t)) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h3>${escapeHtml(t.replace(/^###\s+/, ''))}</h3>`);
    } else if (/^##\s+/.test(t)) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h2>${escapeHtml(t.replace(/^##\s+/, ''))}</h2>`);
    } else if (/^#\s+/.test(t)) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h2>${escapeHtml(t.replace(/^#\s+/, ''))}</h2>`);
    } else if (/^[-*]\s+/.test(t)) {
      // 列表段：可能包含多个列表项（用 \n 分隔）
      if (!inList) { html.push('<ul>'); inList = true; }
      const lines = t.split(/\n/);
      for (const line of lines) {
        const itemText = line.replace(/^[-*]\s+/, '').trim();
        if (itemText) {
          html.push(`<li>${escapeHtml(itemText)}</li>`);
        }
      }
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      // 段落内部的单换行转成 <br>
      const paraHtml = escapeHtml(t).replace(/\n/g, '<br>');
      html.push(`<p>${paraHtml}</p>`);
    }
  }
  if (inList) html.push('</ul>');
  return html.join('');
}

// ============================================
// 视图切换
// ============================================
function showView(name) {
  els.viewInput.classList.toggle('is-hidden', name !== 'input');
  els.viewLoading.classList.toggle('is-hidden', name !== 'loading');
  els.viewReader.classList.toggle('is-hidden', name !== 'reader');
  // 阅读态才显示顶部按钮
  const showActions = name === 'reader';
  els.shareBtnTop.classList.toggle('is-hidden', !showActions);
  els.homeBtnTop.classList.toggle('is-hidden', !showActions);
  // 离开加载态时停止步骤提示
  if (name !== 'loading') {
    stopLoadingSteps();
  }
}

function showError(msg) {
  els.inputError.textContent = msg;
  els.inputError.hidden = false;
}

function clearError() {
  els.inputError.hidden = true;
  els.inputError.textContent = '';
}

// ============================================
// Toast
// ============================================
let toastTimer;
function showToast(msg, duration = 2500) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  // 强制 reflow
  void els.toast.offsetWidth;
  els.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-show');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, duration);
}

// ============================================
// 调用云函数（带 60 秒总体超时）
// ============================================
async function callExtract(targetUrl) {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), 60000);

  try {
    const resp = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
      signal: controller.signal,
    });

    const data = await resp.json().catch(() => ({ ok: false, error: '响应格式错误' }));

    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `服务器返回 ${resp.status}`);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('AI 处理时间过长，请稍后再试');
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

// ============================================
// 加载态步骤化提示（每 5 秒切换文案，让用户知道在干活）
// ============================================
const LOADING_STEPS = [
  '正在帮您剥离广告…',
  '正在提取正文内容…',
  'AI 正在用大白话总结…',
  '马上就好，请再等等…',
  'AI 还在思考，长文章需要一点时间…',
];
let loadingStepTimer = null;

function startLoadingSteps() {
  let i = 0;
  const textEl = document.querySelector('.loading-text');
  const subEl = document.querySelector('.loading-sub');
  if (textEl) textEl.textContent = LOADING_STEPS[0];

  loadingStepTimer = setInterval(() => {
    i = Math.min(i + 1, LOADING_STEPS.length - 1);
    if (textEl) textEl.textContent = LOADING_STEPS[i];
    if (subEl) {
      subEl.textContent = i >= 3 ? '（如果超过 1 分钟，可以刷新页面重试）' : '大约需要 5-15 秒';
    }
  }, 5000);
}

function stopLoadingSteps() {
  if (loadingStepTimer) {
    clearInterval(loadingStepTimer);
    loadingStepTimer = null;
  }
}

// ============================================
// 错误信息翻译：把技术报错转成长辈能懂的话
// ============================================
function friendlyError(msg) {
  if (!msg) return '解析失败，请稍后重试';
  if (msg.includes('429') || msg.includes('1305')) {
    return 'AI 当前太忙了，请稍等 30 秒再试一次';
  }
  if (msg.includes('1302')) {
    return '请求过于频繁，请等 1 分钟再试';
  }
  if (msg.includes('AbortError') || msg.includes('超时') || msg.includes('Timeout')) {
    return 'AI 响应超时，请稍后再试';
  }
  if (msg.includes('Jina') || msg.includes('抽取失败')) {
    return '无法读取这个网页，请换一个链接试试';
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return '网络连接失败，请检查网络后重试';
  }
  return msg;
}

// ============================================
// 渲染阅读态
// ============================================
function renderReader(data) {
  els.readerTitle.textContent = data.title || 'AI 摘要';
  els.readerSource.textContent = `来源：${data.source || ''}`;
  els.readerContent.innerHTML = renderContent(data.content || '');

  // 渲染右侧摘要列表
  els.sidePanelList.innerHTML = '';
  const summary = Array.isArray(data.summary) ? data.summary : [];
  if (summary.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'AI 暂时没能生成摘要，请直接阅读正文。';
    els.sidePanelList.appendChild(li);
  } else {
    summary.forEach(s => {
      const li = document.createElement('li');
      li.textContent = s;
      els.sidePanelList.appendChild(li);
    });
  }

  // 默认展开
  els.sidePanel.classList.add('is-open');

  showView('reader');
}

// ============================================
// 提交流程
// ============================================
async function handleSubmit(rawUrl) {
  clearError();

  // 简单校验
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    showError('请输入合法的网址（以 http 或 https 开头）');
    return;
  }

  // 防连点
  els.submitBtn.disabled = true;
  els.submitBtn.textContent = '正在解析…';
  showView('loading');
  startLoadingSteps();

  // 静默更新 URL（可分享）
  const encoded = encodeUrl(rawUrl);
  const newUrl = `${location.origin}${location.pathname}?${URL_PARAM}=${encoded}`;
  history.replaceState(null, '', newUrl);

  try {
    const data = await callExtract(rawUrl);
    renderReader(data);
  } catch (err) {
    console.error('[PureReading]', err);
    // 回到输入态并提示
    showView('input');
    showError(friendlyError(err.message));
    // 还原 URL
    history.replaceState(null, '', `${location.origin}${location.pathname}`);
  } finally {
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = '开始阅读';
  }
}

// ============================================
// 分享：复制当前地址栏 URL
// ============================================
async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('已复制，去微信粘贴给家人吧');
  } catch (e) {
    // 降级：选中文本
    const input = document.createElement('input');
    input.value = location.href;
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      showToast('已复制，去微信粘贴给家人吧');
    } catch {
      showToast('复制失败，请手动复制地址栏');
    }
    document.body.removeChild(input);
  }
}

// ============================================
// side-panel 收起/展开
// ============================================
function toggleSidePanel() {
  els.sidePanel.classList.toggle('is-open');
}

// ============================================
// 返回首页：清除 URL 参数，回到输入态
// ============================================
function goHome() {
  // 清除 URL 参数
  history.replaceState(null, '', `${location.origin}${location.pathname}`);
  // 清空输入框
  els.urlInput.value = '';
  // 清空错误提示
  clearError();
  // 切回输入态
  showView('input');
}

// ============================================
// 路由初始化（页面加载时根据 URL 参数决定视图）
// ============================================
async function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const encoded = params.get(URL_PARAM);

  if (!encoded) {
    showView('input');
    return;
  }

  // 有参数：直接进入阅读态加载
  try {
    const rawUrl = decodeUrl(encoded);
    // 回填输入框，方便用户看到当前在解析什么
    els.urlInput.value = rawUrl;
    showView('loading');
    startLoadingSteps();
    const data = await callExtract(rawUrl);
    renderReader(data);
  } catch (err) {
    console.error('[PureReading] initFromUrl', err);
    showView('input');
    showError(friendlyError(err.message));
  }
}

// ============================================
// 事件绑定
// ============================================
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSubmit(els.urlInput.value.trim());
});

els.sidePanelToggle.addEventListener('click', toggleSidePanel);
els.shareBtnTop.addEventListener('click', copyShareLink);
els.homeBtnTop.addEventListener('click', goHome);

// 启动
initFromUrl();
