'use strict';

const crypto = require('crypto');

const DEFAULT_SCOPES = 'openid profile email groups';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_MS = 10 * 60 * 1000;

function boolEnv(value) {
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function required(config, key) {
  if (!config[key]) throw new Error(`OIDC 已启用，但缺少 ${key}`);
}

function parseOidcConfig(env = process.env) {
  const hasEndpoints = Boolean(env.OIDC_CLIENT_ID && env.OIDC_AUTHORIZATION_ENDPOINT && env.OIDC_TOKEN_ENDPOINT);
  const enabled = env.OIDC_ENABLED === undefined ? hasEndpoints : boolEnv(env.OIDC_ENABLED);
  if (!enabled) return { enabled: false };

  const publicUrl = trimTrailingSlash(env.PUBLIC_URL || env.OIDC_PUBLIC_URL || '');
  const config = {
    enabled: true,
    authorizationEndpoint: env.OIDC_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: env.OIDC_TOKEN_ENDPOINT,
    userinfoEndpoint: env.OIDC_USERINFO_ENDPOINT || '',
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    tokenAuthMethod: env.OIDC_TOKEN_AUTH_METHOD || 'client_secret_basic',
    redirectUri: env.OIDC_REDIRECT_URI || (publicUrl ? `${publicUrl}/auth/callback` : ''),
    scope: env.OIDC_SCOPE || env.OIDC_SCOPES || DEFAULT_SCOPES,
    groupsClaim: env.OIDC_GROUPS_CLAIM || 'groups',
    usernameClaim: env.OIDC_USERNAME_CLAIM || 'preferred_username',
    emailClaim: env.OIDC_EMAIL_CLAIM || 'email',
    sessionSecret: env.OIDC_SESSION_SECRET || env.SESSION_SECRET || '',
    sessionCookieName: env.OIDC_SESSION_COOKIE || 'otp_oidc_session',
    sessionTtlSeconds: parseInt(env.OIDC_SESSION_TTL_SECONDS || DEFAULT_TTL_SECONDS, 10),
    cookieSecure: env.OIDC_COOKIE_SECURE === undefined ? null : boolEnv(env.OIDC_COOKIE_SECURE),
  };

  required(config, 'authorizationEndpoint');
  required(config, 'tokenEndpoint');
  required(config, 'clientId');
  required(config, 'redirectUri');
  required(config, 'sessionSecret');

  for (const key of ['authorizationEndpoint', 'tokenEndpoint', 'redirectUri']) {
    new URL(config[key]);
  }
  if (config.userinfoEndpoint) new URL(config.userinfoEndpoint);

  return config;
}

function parseCookie(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function safeReturnTo(value) {
  if (!value || typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function readClaim(claims, path) {
  if (!claims || !path) return undefined;
  let current = claims;
  for (const part of String(path).split('.')) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function normalizeGroups(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return {};
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createAuth(config) {
  if (!config || !config.enabled) {
    return {
      enabled: false,
      getUser: () => null,
      requireUser: () => null,
      handleRoute: () => false,
      canViewAccount: () => true,
    };
  }

  const sessions = new Map();
  const states = new Map();

  function sign(value) {
    return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  }

  function makeCookie(req, value, maxAgeSeconds) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = config.cookieSecure === null ? forwardedProto === 'https' : config.cookieSecure;
    const attrs = [
      `${config.sessionCookieName}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  function setSessionCookie(req, res, sessionId) {
    res.setHeader('Set-Cookie', makeCookie(req, `${sessionId}.${sign(sessionId)}`, config.sessionTtlSeconds));
  }

  function clearSessionCookie(req, res) {
    res.setHeader('Set-Cookie', makeCookie(req, '', 0));
  }

  function getSession(req) {
    const raw = parseCookie(req.headers.cookie)[config.sessionCookieName];
    if (!raw) return null;
    const idx = raw.lastIndexOf('.');
    if (idx === -1) return null;
    const sessionId = raw.slice(0, idx);
    const signature = raw.slice(idx + 1);
    if (!timingSafeEqual(signature, sign(sessionId))) return null;

    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return null;
    }
    return { sessionId, ...session };
  }

  function getUser(req) {
    return getSession(req)?.user || null;
  }

  function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  function sendJSON(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  function sendText(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function cleanupStates() {
    const now = Date.now();
    for (const [state, data] of states) {
      if (now - data.createdAt > STATE_TTL_MS) states.delete(state);
    }
  }

  async function exchangeCode(code, stateData) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: stateData.codeVerifier,
    });

    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (config.clientSecret && config.tokenAuthMethod === 'client_secret_basic') {
      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else if (config.clientSecret && config.tokenAuthMethod === 'client_secret_post') {
      body.set('client_secret', config.clientSecret);
    }

    const response = await fetch(config.tokenEndpoint, { method: 'POST', headers, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Token endpoint 返回 ${response.status}`);
    }
    return data;
  }

  async function fetchUserinfo(accessToken) {
    if (!config.userinfoEndpoint || !accessToken) return {};
    const response = await fetch(config.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Userinfo endpoint 返回 ${response.status}`);
    }
    return data;
  }

  function buildUser(claims) {
    const groups = normalizeGroups(readClaim(claims, config.groupsClaim));
    const fallbackGroups = groups.length ? groups : normalizeGroups(claims.group);
    return {
      sub: claims.sub || '',
      name: readClaim(claims, config.usernameClaim) || claims.name || claims.sub || '',
      email: readClaim(claims, config.emailClaim) || '',
      groups: fallbackGroups,
    };
  }

  function createSession(req, res, user) {
    const sessionId = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionId, {
      user,
      expiresAt: Date.now() + config.sessionTtlSeconds * 1000,
    });
    setSessionCookie(req, res, sessionId);
  }

  async function handleLogin(req, res, url) {
    cleanupStates();
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    states.set(state, {
      nonce,
      codeVerifier,
      returnTo: safeReturnTo(url.searchParams.get('returnTo')),
      createdAt: Date.now(),
    });

    const authUrl = new URL(config.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('scope', config.scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    redirect(res, authUrl.toString());
  }

  async function handleCallback(req, res, url) {
    if (url.searchParams.get('error')) {
      return sendText(res, 400, url.searchParams.get('error_description') || url.searchParams.get('error'));
    }

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const stateData = states.get(state);
    states.delete(state);
    if (!stateData || Date.now() - stateData.createdAt > STATE_TTL_MS) {
      return sendText(res, 400, 'OIDC state 已失效，请重新登录');
    }
    if (!code) return sendText(res, 400, 'OIDC 回调缺少 code');

    try {
      const token = await exchangeCode(code, stateData);
      const idTokenClaims = decodeJwtPayload(token.id_token);
      if (idTokenClaims.nonce && idTokenClaims.nonce !== stateData.nonce) {
        return sendText(res, 400, 'OIDC nonce 校验失败');
      }
      const userinfo = await fetchUserinfo(token.access_token);
      const claims = { ...idTokenClaims, ...userinfo };
      createSession(req, res, buildUser(claims));
      redirect(res, stateData.returnTo);
    } catch (e) {
      sendText(res, 502, `OIDC 登录失败: ${e.message}`);
    }
  }

  function handleLogout(req, res) {
    const session = getSession(req);
    if (session) sessions.delete(session.sessionId);
    clearSessionCookie(req, res);
    redirect(res, '/');
  }

  function requireUser(req, res, url) {
    const user = getUser(req);
    if (user) return user;
    const returnTo = encodeURIComponent(`${url.pathname}${url.search}`);
    sendJSON(res, 401, { error: '需要登录', loginUrl: `/auth/login?returnTo=${returnTo}` });
    return null;
  }

  function handleRoute(req, res, url) {
    if (url.pathname === '/auth/login') {
      handleLogin(req, res, url);
      return true;
    }
    if (url.pathname === '/auth/callback') {
      handleCallback(req, res, url);
      return true;
    }
    if (url.pathname === '/auth/logout') {
      handleLogout(req, res);
      return true;
    }
    if (url.pathname === '/api/me') {
      const user = getUser(req);
      sendJSON(res, 200, { authenticated: Boolean(user), user });
      return true;
    }
    return false;
  }

  function canViewAccount(account, user) {
    const allowedGroups = Array.isArray(account.allowedGroups) ? account.allowedGroups : [];
    if (!allowedGroups.length) return true;
    if (!user) return false;
    const userGroups = new Set(user.groups || []);
    return allowedGroups.some((group) => userGroups.has(group));
  }

  return {
    enabled: true,
    getUser,
    requireUser,
    handleRoute,
    canViewAccount,
  };
}

module.exports = { createAuth, parseOidcConfig, normalizeGroups };
