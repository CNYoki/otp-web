'use strict';

const crypto = require('crypto');

// 解析 Base32（RFC 4648，无填充亦可），返回 Buffer
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue; // 跳过非法字符
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// 解析 otpauth:// URI 为标准化账号对象
function parseOtpauth(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'otpauth:') throw new Error('不是 otpauth URI: ' + uri);
  const type = u.host.toLowerCase(); // totp / hotp
  const labelPart = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const params = u.searchParams;

  let issuer = params.get('issuer') || '';
  let label = labelPart;
  if (labelPart.includes(':')) {
    const [iss, acc] = labelPart.split(':');
    if (!issuer) issuer = iss.trim();
    label = acc.trim();
  }

  return {
    type,
    label: label || issuer || '未命名',
    issuer,
    secret: params.get('secret') || '',
    digits: parseInt(params.get('digits') || '6', 10),
    period: parseInt(params.get('period') || '30', 10),
    algorithm: (params.get('algorithm') || 'SHA1').toUpperCase(),
  };
}

function normalizeAllowedGroups(account) {
  const raw = account.allowedGroups ?? account.allowed_groups ?? account.groups ?? account.group;
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.trim()).filter(Boolean);
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
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

// 把 config 里的一项标准化
function normalize(account) {
  let base;
  if (account.uri) {
    base = parseOtpauth(account.uri);
  } else {
    base = {
      type: 'totp',
      label: account.label || account.issuer || '未命名',
      issuer: account.issuer || '',
      secret: account.secret || '',
      digits: account.digits || 6,
      period: account.period || 30,
      algorithm: (account.algorithm || 'SHA1').toUpperCase(),
    };
  }
  // 允许字段级覆盖
  return {
    type: base.type,
    label: account.label || base.label,
    issuer: account.issuer || base.issuer,
    secret: account.secret || base.secret,
    digits: account.digits || base.digits,
    period: account.period || base.period,
    algorithm: (account.algorithm || base.algorithm).toUpperCase(),
    allowedGroups: normalizeAllowedGroups(account),
    fields: normalizeDisplayFields(account),
  };
}

// 生成 TOTP（基于时间）
function generateTOTP(account, forTime = Date.now()) {
  const period = account.period || 30;
  const digits = account.digits || 6;
  const counter = Math.floor(forTime / 1000 / period);

  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const key = base32Decode(account.secret);
  const algoMap = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
  const algo = algoMap[account.algorithm] || 'sha1';

  const hmac = crypto.createHmac(algo, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = (binCode % 10 ** digits).toString().padStart(digits, '0');
  const secondsRemaining = period - Math.floor((forTime / 1000) % period);
  return { code, period, digits, secondsRemaining };
}

module.exports = { normalize, generateTOTP, base32Decode, parseOtpauth };
