function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderParagraphs(body = '') {
  return String(body || '')
    .split(/\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 14px;color:#27312e;font-size:16px;line-height:1.8;">${escapeHtml(paragraph)}</p>`)
    .join('');
}

function renderEventLabels(events = []) {
  return events.map((event) => (
    `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 10px;border:1px solid #d6dfdc;border-radius:6px;color:#31584d;background:#f7faf9;font-size:13px;line-height:1.2;">${escapeHtml(event.name)}</span>`
  )).join('');
}

function renderGreetingEmail(input = {}) {
  const recipientName = String(input.recipientName || '你好').trim() || '你好';
  const subject = String(input.subject || '来自瑞希的问候').trim() || '来自瑞希的问候';
  const greeting = String(input.greeting || recipientName).trim() || recipientName;
  const closing = String(input.closing || '愿今天有值得记住的好心情。').trim();
  const events = Array.isArray(input.events) ? input.events : [];
  const dateLabel = String(input.dateLabel || '').trim();
  const eventNames = events.map((event) => String(event?.name || '').trim()).filter(Boolean);
  const text = [
    greeting,
    String(input.body || '').trim(),
    closing,
    dateLabel,
    eventNames.length ? `今日纪念：${eventNames.join('、')}` : ''
  ].filter(Boolean).join('\n\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
  <style>
    @media only screen and (max-width:620px){.mail-shell{width:100%!important}.mail-body{padding:28px 22px!important}.mail-header{padding:24px 22px!important}}
  </style>
</head>
<body style="margin:0;padding:0;background:#eef2f0;font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef2f0;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" class="mail-shell" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #dce4e1;border-radius:8px;overflow:hidden;">
          <tr>
            <td class="mail-header" style="padding:26px 36px;background:#244a40;border-bottom:4px solid #e46e52;">
              <div style="color:#ffffff;font-size:20px;line-height:1.4;font-weight:700;">瑞希的问候</div>
              <div style="margin-top:5px;color:#d9e7e2;font-size:13px;line-height:1.5;">${escapeHtml(dateLabel)}</div>
            </td>
          </tr>
          <tr>
            <td class="mail-body" style="padding:36px;">
              <div style="margin-bottom:20px;">${renderEventLabels(events)}</div>
              <h1 style="margin:0 0 22px;color:#17231f;font-size:25px;line-height:1.45;font-weight:700;letter-spacing:0;overflow-wrap:anywhere;">${escapeHtml(greeting)}</h1>
              ${renderParagraphs(input.body)}
              <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e5eae8;color:#426158;font-size:15px;line-height:1.8;">${escapeHtml(closing)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px;background:#f7f9f8;color:#71807b;font-size:12px;line-height:1.6;text-align:center;">这封邮件来自你主动订阅的瑞希节日与纪念日问候。</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

function renderVerificationEmail(code = '') {
  const normalizedCode = String(code || '').trim();
  const subject = '确认订阅瑞希邮件问候';
  return {
    subject,
    text: `你的验证码是 ${normalizedCode}，15 分钟内有效。请回到 QQ 私聊输入：/邮件问候 验证 ${normalizedCode}`,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head><body style="margin:0;padding:24px;background:#eef2f0;font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center"><table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:520px;background:#fff;border:1px solid #dce4e1;border-radius:8px;"><tr><td style="padding:30px;"><h1 style="margin:0 0 16px;color:#17231f;font-size:22px;line-height:1.4;letter-spacing:0;">确认邮件问候订阅</h1><p style="margin:0 0 22px;color:#3c4a46;font-size:15px;line-height:1.8;">请在 15 分钟内回到 QQ 私聊完成验证。</p><div style="padding:16px;background:#f3f7f5;border-left:4px solid #e46e52;color:#244a40;font-size:30px;font-weight:700;text-align:center;letter-spacing:4px;">${escapeHtml(normalizedCode)}</div><p style="margin:22px 0 0;color:#71807b;font-size:12px;line-height:1.7;">如果这不是你的操作，可以忽略此邮件。</p></td></tr></table></td></tr></table></body></html>`
  };
}

module.exports = {
  escapeHtml,
  renderGreetingEmail,
  renderVerificationEmail
};
