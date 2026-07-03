// ============================================================
// OTP 账号配置 —— 仅在服务端使用，绝不会发送到前端
// ============================================================
//
// 两种配置方式，任选其一（可混用）：
//
// 1) 直接粘贴 otpauth:// URI（从其它验证器导出/扫码得到）：
//      { uri: 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub' }
//
// 2) 手动填写字段：
//      { label: '显示名称', secret: 'BASE32密钥', issuer: '可选', digits: 6, period: 30, algorithm: 'SHA1' }
//
// OIDC 启用后，每个账号可选 allowedGroups，限制哪些 OIDC group 可查看：
//      { uri: '...', allowedGroups: ['ops', 'admin'] }
// 未配置 allowedGroups 时，登录用户默认都可查看。
//
// 每个账号也可选配置前端展示字段：
//      { uri: '...', username: 'alice', password: 'pass', note: '后台账号' }
// 额外字段可放在 fields: { "地址": "https://example.com" }
//
// secret 为 Base32 编码（一般是大写字母 A-Z 和数字 2-7）。
// ============================================================

// 生产部署优先从环境变量 OTP_ACCOUNTS 读取账号（JSON 数组字符串），
// 这样真实密钥放在 systemd 的 EnvironmentFile 里，不进代码、不进仓库。
// 本地开发若未设置该变量，则回退到下面 fallbackAccounts。
let accounts;
if (process.env.OTP_ACCOUNTS) {
  try {
    accounts = JSON.parse(process.env.OTP_ACCOUNTS);
  } catch (e) {
    throw new Error('环境变量 OTP_ACCOUNTS 不是合法 JSON: ' + e.message);
  }
} else {
  accounts = fallbackAccounts();
}

function fallbackAccounts() {
  return [
    {
      uri: 'otpauth://totp/Demo%3Ademo%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Demo',
    },
  ];
}

module.exports = {
  // 监听端口
  port: process.env.PORT || 3000,
  // 监听地址：生产用 127.0.0.1，仅 nginx 可访问；设为 0.0.0.0 则对外暴露
  host: process.env.HOST || '127.0.0.1',
  accounts,
};
