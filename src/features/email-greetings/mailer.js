const nodemailer = require('nodemailer');

function isSmtpConfigured(config = {}) {
  return Boolean(
    String(config.EMAIL_GREETING_SMTP_HOST || '').trim()
    && String(config.EMAIL_GREETING_SMTP_FROM || '').trim()
  );
}

function createSmtpTransport(config = {}) {
  const username = String(config.EMAIL_GREETING_SMTP_USER || '').trim();
  const password = String(config.EMAIL_GREETING_SMTP_PASS || '');
  return nodemailer.createTransport({
    host: String(config.EMAIL_GREETING_SMTP_HOST || '').trim(),
    port: Number(config.EMAIL_GREETING_SMTP_PORT || 587),
    secure: config.EMAIL_GREETING_SMTP_SECURE === true,
    ...(username ? { auth: { user: username, pass: password } } : {})
  });
}

function createSmtpMailer(config = {}, options = {}) {
  const transport = options.transport || createSmtpTransport(config);
  const from = String(config.EMAIL_GREETING_SMTP_FROM || '').trim();

  async function send(input = {}) {
    if (!isSmtpConfigured(config)) throw new Error('SMTP 配置不完整');
    return transport.sendMail({
      from,
      to: String(input.to || '').trim(),
      subject: String(input.subject || '').trim(),
      text: String(input.text || ''),
      html: String(input.html || '')
    });
  }

  return { send };
}

module.exports = {
  createSmtpMailer,
  createSmtpTransport,
  isSmtpConfigured
};
