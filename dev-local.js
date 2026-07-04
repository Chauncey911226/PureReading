/**
 * Pure Reading · 本地开发服务器（Vercel 兼容版）
 *
 * 用途：在部署到 Vercel 之前，先在本地跑通整条链路
 *
 * 使用方法：
 *   1. 在项目根目录复制 .env.example 为 .env，填入两个 API Key
 *   2. 安装 Node.js >=18（自带 fetch）
 *   3. 命令行运行：node dev-local.js
 *   4. 浏览器打开 http://localhost:8787/  即可看到前端页面
 *
 * 这个本地服务做的事情：
 *   - 加载 .env 里的环境变量
 *   - /api/extract        → 转发给 api/extract.js（云函数）
 *   - /、/style.css、/app.js → 从 app/ 目录返回静态文件
 *   - 模拟 Vercel 的 req/res 对象
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Windows PowerShell 中文显示兼容：把中文日志转成 ASCII 安全格式
// 不依赖 chcp，避免沙箱终端阻塞
function safeLog(msg) {
  if (typeof msg !== 'string') msg = String(msg);
  // PowerShell 默认 GBK，直接输出中文会乱码但不影响功能
  // 这里用 process.stdout.write 避免 console.log 的换行符问题
  process.stdout.write(msg + '\n');
}
console.log = safeLog;
console.warn = safeLog;
console.error = safeLog;

// 加载 .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  content.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2];
    }
  });
  console.log('[dev] .env loaded');
} else {
  console.warn('[dev] .env not found, copy .env.example to .env first');
}

// 引入 Vercel Serverless Function
const handler = require('./api/extract.js');

const PORT = 8787;
const APP_DIR = path.join(__dirname, 'app');

// 静态文件 MIME 类型
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// URL → app/ 目录下的文件路径映射
const STATIC_ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js',
};

const server = http.createServer(async (req, res) => {
  // CORS（开发阶段允许所有来源）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // === 路由1：API ===
  if (req.url === '/api/extract') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '仅支持 POST' }));
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const fakeReq = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      const fakeRes = {
        statusCode: 200,
        _headers: {},
        setHeader(k, v) { this._headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(obj) {
          res.writeHead(this.statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            ...this._headers,
          });
          res.end(JSON.stringify(obj));
        },
        end() {
          res.writeHead(this.statusCode, this._headers);
          res.end();
        },
      };
      try {
        await handler(fakeReq, fakeRes);
      } catch (err) {
        console.error('[dev] handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      }
    });
    return;
  }

  // === 路由2：静态文件 ===
  const routeFile = STATIC_ROUTES[req.url];
  if (routeFile) {
    const filePath = path.join(APP_DIR, routeFile);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not Found: ' + req.url }));
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  Pure Reading local dev server running');
  console.log('========================================');
  console.log(`  Frontend:  http://localhost:${PORT}/`);
  console.log(`  API:       http://localhost:${PORT}/api/extract`);
  console.log('');
  console.log('  Environment variables:');
  console.log(`    JINA_API_KEY          : ${process.env.JINA_API_KEY ? 'configured OK' : 'not set (anonymous mode)'}`);
  console.log(`    SILICONFLOW_API_KEY   : ${process.env.SILICONFLOW_API_KEY ? 'configured OK' : 'not set (REQUIRED)'}`);
  console.log('========================================');
});
