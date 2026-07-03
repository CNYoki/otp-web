// Cloudflare Pages —— 单文件 advanced 模式
// 放在输出目录(public)根部,接管全部请求；API 在此计算,其余走静态资源
// secret 来自环境变量 OTP_ACCOUNTS,不进代码、不下发前端

// ---------- TOTP（Web Crypto） ----------
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function parseOtpauth(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'otpauth:') throw new Error('不是 otpauth URI: ' + uri);
  const labelPart = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const p = u.searchParams;
  let issuer = p.get('issuer') || '';
  let label = labelPart;
  if (labelPart.includes(':')) {
    const [iss, acc] = labelPart.split(':');
    if (!issuer) issuer = iss.trim();
    label = acc.trim();
  }
  return {
    type: u.host.toLowerCase(),
    label: label || issuer || '未命名',
    issuer,
    secret: p.get('secret') || '',
    digits: parseInt(p.get('digits') || '6', 10),
    period: parseInt(p.get('period') || '30', 10),
    algorithm: (p.get('algorithm') || 'SHA1').toUpperCase(),
  };
}

function normalize(account) {
  const base = account.uri
    ? parseOtpauth(account.uri)
    : {
        type: 'totp',
        label: account.label || account.issuer || '未命名',
        issuer: account.issuer || '',
        secret: account.secret || '',
        digits: account.digits || 6,
        period: account.period || 30,
        algorithm: (account.algorithm || 'SHA1').toUpperCase(),
      };
  return {
    type: base.type,
    label: account.label || base.label,
    issuer: account.issuer || base.issuer,
    secret: account.secret || base.secret,
    digits: account.digits || base.digits,
    period: account.period || base.period,
    algorithm: (account.algorithm || base.algorithm).toUpperCase(),
    fields: normalizeDisplayFields(account),
  };
}

function optionalText(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

function normalizeDisplayFields(account) {
  const fields = [];
  const username = optionalText(account.username ?? account.user ?? account.account);
  const password = optionalText(account.password ?? account.pass);
  const note = optionalText(account.note ?? account.remark ?? account.notes);

  if (username) fields.push({ label: '用户名', value: username });
  if (password) fields.push({ label: '密码', value: password });
  if (note) fields.push({ label: '备注', value: note });

  const extra = account.fields;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (!item || typeof item !== 'object') continue;
      const label = optionalText(item.label ?? item.name ?? item.key);
      const value = optionalText(item.value);
      if (label && value) fields.push({ label, value });
    }
  } else if (extra && typeof extra === 'object') {
    for (const [label, value] of Object.entries(extra)) {
      const text = optionalText(value);
      if (label && text) fields.push({ label, value: text });
    }
  }

  return fields;
}

function getAccounts(env) {
  const raw = env && env.OTP_ACCOUNTS;
  if (!raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error('环境变量 OTP_ACCOUNTS 不是合法 JSON');
  }
  return list.map((a, i) => ({ id: i, ...normalize(a) }));
}

async function generateTOTP(account, forTime = Date.now()) {
  const period = account.period || 30;
  const digits = account.digits || 6;
  const counter = Math.floor(forTime / 1000 / period);

  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(counter), false);

  const algoMap = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
  const hash = algoMap[account.algorithm] || 'SHA-1';
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(account.secret),
    { name: 'HMAC', hash },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));

  const offset = sig[sig.length - 1] & 0x0f;
  const binCode =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);

  const code = (binCode % 10 ** digits).toString().padStart(digits, '0');
  const secondsRemaining = period - Math.floor((forTime / 1000) % period);
  return { code, period, digits, secondsRemaining };
}

function json(data) {
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}

// ---------- 请求入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/accounts') {
      const accounts = getAccounts(env).map((a) => ({
        id: a.id, label: a.label, issuer: a.issuer, digits: a.digits, period: a.period, fields: a.fields || [],
      }));
      return json({ accounts });
    }

    if (url.pathname === '/api/codes') {
      const accounts = getAccounts(env);
      const now = Date.now();
      const codes = await Promise.all(
        accounts.map(async (a) => {
          const { code, secondsRemaining, period, digits } = await generateTOTP(a, now);
          return { id: a.id, label: a.label, issuer: a.issuer, code, secondsRemaining, period, digits };
        })
      );
      return json({ codes, serverTime: now });
    }

    if (url.pathname === '/api/code') {
      const id = parseInt(url.searchParams.get('id'), 10);
      const a = getAccounts(env).find((x) => x.id === id);
      if (!a) return Response.json({ error: '账号不存在' }, { status: 404 });
      const { code, secondsRemaining, period, digits } = await generateTOTP(a, Date.now());
      return json({ id: a.id, label: a.label, issuer: a.issuer, code, secondsRemaining, period, digits });
    }

    // 其余请求交给静态资源
    return env.ASSETS.fetch(request);
  },
};
