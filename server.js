'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { normalize, generateTOTP } = require('./totp');
const { createAuth, parseOidcConfig } = require('./auth');

// 启动时标准化所有账号（secret 只保留在内存中，不外发）
const accounts = (config.accounts || []).map((a, i) => {
  const n = normalize(a);
  return { id: i, ...n };
});

const PORT = process.env.PORT || config.port || 3000;
const HOST = process.env.HOST || config.host || '127.0.0.1';
const auth = createAuth(parseOidcConfig(process.env));

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 仅返回前端展示需要的信息：绝不包含 secret
function publicAccount(a) {
  return { id: a.id, label: a.label, issuer: a.issuer, digits: a.digits, period: a.period, fields: a.fields || [] };
}

function visibleAccounts(user) {
  return accounts.filter((a) => auth.canViewAccount(a, user));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/healthz') {
    return sendJSON(res, 200, { ok: true });
  }

  if (auth.handleRoute(req, res, url)) return;

  const user = auth.enabled && url.pathname.startsWith('/api/') ? auth.requireUser(req, res, url) : null;
  if (auth.enabled && url.pathname.startsWith('/api/') && !user) return;

  // 账号列表（不含密钥）
  if (url.pathname === '/api/accounts') {
    return sendJSON(res, 200, { accounts: visibleAccounts(user).map(publicAccount) });
  }

  // 当前所有验证码
  if (url.pathname === '/api/codes') {
    const now = Date.now();
    const codes = visibleAccounts(user).map((a) => {
      const { code, secondsRemaining, period, digits } = generateTOTP(a, now);
      return { id: a.id, label: a.label, issuer: a.issuer, code, secondsRemaining, period, digits };
    });
    return sendJSON(res, 200, { codes, serverTime: now });
  }

  // 单个账号验证码
  if (url.pathname === '/api/code') {
    const id = parseInt(url.searchParams.get('id'), 10);
    const a = visibleAccounts(user).find((x) => x.id === id);
    if (!a) return sendJSON(res, 404, { error: '账号不存在' });
    const { code, secondsRemaining, period, digits } = generateTOTP(a, Date.now());
    return sendJSON(res, 200, { id: a.id, label: a.label, issuer: a.issuer, code, secondsRemaining, period, digits });
  }

  // 静态文件（仅 public 目录）
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(__dirname, 'public', filePath);
  if (!fullPath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(fullPath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`OTP 服务已启动: http://${HOST}:${PORT}`);
  console.log(`已加载 ${accounts.length} 个账号（密钥仅保存在服务端）`);
  if (auth.enabled) console.log('OIDC 登录已启用');
});
