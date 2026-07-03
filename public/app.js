'use strict';

const tabsEl = document.getElementById('tabs');
const cardsEl = document.getElementById('cards');
const statusEl = document.getElementById('status');

let accounts = [];
let activeId = null;
let latestCodes = {}; // id -> code 对象

async function apiFetch(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search}` || '/';
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    throw new Error('unauthorized');
  }
  return res;
}

// 拉取账号列表（不含密钥）
async function loadAccounts() {
  const res = await apiFetch('/api/accounts');
  const data = await res.json();
  accounts = data.accounts || [];
  if (!accounts.some((a) => a.id === activeId)) activeId = accounts.length ? accounts[0].id : null;
  renderTabs();
  renderCard();
}

// 拉取所有验证码
async function loadCodes() {
  try {
    const res = await apiFetch('/api/codes');
    const data = await res.json();
    latestCodes = {};
    for (const c of data.codes || []) latestCodes[c.id] = c;
    statusEl.textContent = '已连接 · ' + new Date().toLocaleTimeString();
    renderCard();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    statusEl.textContent = '连接失败，正在重试…';
  }
}

function renderTabs() {
  tabsEl.innerHTML = '';
  if (!accounts.length) return;
  for (const a of accounts) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (a.id === activeId ? ' active' : '');
    btn.textContent = a.issuer ? `${a.issuer} · ${a.label}` : a.label;
    btn.onclick = () => {
      activeId = a.id;
      renderTabs();
      renderCard();
    };
    tabsEl.appendChild(btn);
  }
}

function formatCode(code) {
  // 6 位分两组，8 位分两组，其它原样
  if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
  return code;
}

function renderCard() {
  if (!accounts.length) {
    cardsEl.innerHTML = '<div class="empty">未配置或无权查看任何 OTP 账号</div>';
    return;
  }
  const acc = accounts.find((a) => a.id === activeId);
  const data = latestCodes[activeId];
  if (!acc || !data) {
    cardsEl.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }

  const pct = Math.max(0, (data.secondsRemaining / data.period) * 100);
  const low = data.secondsRemaining <= 5;

  cardsEl.innerHTML = `
    <div class="card">
      <div class="card-issuer">${escapeHtml(acc.issuer || '验证码')}</div>
      <div class="card-label">${escapeHtml(acc.label)}</div>
      <div class="code-row">
        <span class="code" id="code" title="点击复制">${formatCode(data.code)}</span>
        <span class="copy-hint" id="copyHint">点击复制</span>
      </div>
      <div class="progress"><div class="progress-bar ${low ? 'low' : ''}" id="bar" style="width:${pct}%"></div></div>
      <div class="countdown"><span id="seconds">${data.secondsRemaining}</span> 秒后刷新</div>
    </div>`;

  document.getElementById('code').onclick = () => copyCode(data.code);
}

function copyCode(code) {
  navigator.clipboard?.writeText(code).then(() => {
    const el = document.getElementById('code');
    const hint = document.getElementById('copyHint');
    if (el) el.classList.add('copied');
    if (hint) hint.textContent = '已复制 ✓';
    setTimeout(() => {
      if (el) el.classList.remove('copied');
      if (hint) hint.textContent = '点击复制';
    }, 1200);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// 本地每秒更新倒计时与进度，整秒为 0 时重新拉取
let lastRemaining = Infinity;
function tick() {
  const data = latestCodes[activeId];
  if (data) {
    data.secondsRemaining = Math.max(0, data.secondsRemaining - 1);
    const bar = document.getElementById('bar');
    const sec = document.getElementById('seconds');
    if (bar) {
      const pct = (data.secondsRemaining / data.period) * 100;
      bar.style.width = pct + '%';
      bar.classList.toggle('low', data.secondsRemaining <= 5);
    }
    if (sec) sec.textContent = data.secondsRemaining;
    // 周期结束，拉取新验证码
    if (data.secondsRemaining <= 0 && lastRemaining > 0) loadCodes();
    lastRemaining = data.secondsRemaining;
  }
}

(async function init() {
  await loadAccounts();
  await loadCodes();
  setInterval(tick, 1000);
  // 兜底：每 15 秒与服务端对齐一次
  setInterval(loadCodes, 15000);
})();
