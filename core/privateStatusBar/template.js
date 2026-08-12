const { formatWeekdayInTz, getDatePartsInTz } = require('../../utils/time');

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function formatAffection(value) {
  const affection = clamp(value, 0, 100, 0);
  return Number.isInteger(affection) ? String(affection) : String(Number(affection.toFixed(2)));
}

function formatTime(date, timezone) {
  const parts = getDatePartsInTz(date, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatTipDate(date, timezone) {
  const parts = getDatePartsInTz(date, timezone);
  const weekday = formatWeekdayInTz('zh-CN', date, timezone).replace('星期', '周');
  return `${parts.month}月${parts.day}日 ${weekday}`;
}

function moodLabel(value) {
  const mood = Number(value || 0);
  return mood >= 30 ? '愉快' : (mood <= -30 ? '低落' : '平静');
}

function normalizeStatusBarData(input = {}, options = {}) {
  const snapshot = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : {};
  const relationship = snapshot.relationship && typeof snapshot.relationship === 'object'
    ? snapshot.relationship
    : {};
  const character = snapshot.character && typeof snapshot.character === 'object'
    ? snapshot.character
    : {};
  const text = input.text && typeof input.text === 'object' ? input.text : {};
  const date = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const affection = clamp(relationship.affection, 0, 100, 0);
  return {
    affection,
    affectionText: formatAffection(affection),
    stageLabel: String(relationship.stageLabel || relationship.stage || '陌生人').trim() || '陌生人',
    attitude: String(relationship.attitude || '中立、保持距离').replace(/\s+/g, ' ').trim() || '中立、保持距离',
    mood: moodLabel(character.mood),
    affectionNote: String(text.affection_note || input.affectionNote || '').replace(/\s+/g, ' ').trim(),
    moodNote: String(text.mood_note || input.moodNote || '').replace(/\s+/g, ' ').trim(),
    innerThought: String(text.inner_thought || input.innerThought || '').replace(/\s+/g, ' ').trim(),
    time: formatTime(date, options.timezone),
    tipDate: formatTipDate(date, options.timezone)
  };
}

function buildPrivateStatusBarHtml(input = {}, options = {}) {
  const data = normalizeStatusBarData(input, options);
  const affectionWidth = Math.round(data.affection * 100) / 100;
  return [
    '<style>',
    ':root{font-family:"STKaiti","KaiTi","FangSong","Microsoft YaHei",serif;color:#76564e;background:#fff}',
    '*{box-sizing:border-box}',
    '.status-bar{position:relative;width:960px;height:640px;overflow:hidden;background:#f8eee8;border:1px solid #e7c9c0;color:#76564e}',
    '.status-bar:before{content:"";position:absolute;inset:16px;border:1px solid #eed4cc;pointer-events:none}',
    '.status-bar:after{content:"";position:absolute;inset:25px;border:1px solid rgba(210,158,148,.55);pointer-events:none}',
    '.ribbon{position:absolute;width:250px;height:28px;background:rgba(232,166,168,.62);border:1px solid rgba(196,127,129,.45);transform:rotate(-17deg);opacity:.8}',
    '.ribbon:before,.ribbon:after{content:"";position:absolute;top:-18px;width:58px;height:56px;border:1px solid rgba(196,127,129,.45);background:rgba(240,181,183,.6)}',
    '.ribbon:before{left:-28px;transform:skewY(-24deg)}',
    '.ribbon:after{right:-28px;transform:skewY(24deg)}',
    '.ribbon-top{top:2px;left:-25px}',
    '.ribbon-bottom{right:-40px;bottom:10px;transform:rotate(17deg)}',
    '.photo-frame{position:absolute;z-index:2;left:43px;top:72px;width:330px;height:390px;padding:15px 15px 55px;background:#fffaf6;border:1px solid #d7c1b9;box-shadow:0 10px 12px rgba(122,86,78,.2);transform:rotate(-4deg)}',
    '.portrait{width:100%;height:100%;overflow:hidden;background:#eadbd7;border:1px solid #d8c4bf}',
    '.portrait img{display:block;width:100%;height:100%;object-fit:cover;object-position:center top}',
    '.portrait:empty:before{content:"晓山瑞希";display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#c49b93;font-size:23px}',
    '.name-tag{position:absolute;left:30px;right:30px;bottom:12px;text-align:center;color:#79584f;font-size:26px;font-weight:700;line-height:1}',
    '.name-tag:before,.name-tag:after{content:"♡";margin:0 12px;color:#d9898d;font-family:serif;font-size:21px}',
    '.paper-clip{position:absolute;z-index:3;left:59px;top:55px;width:19px;height:72px;border:4px solid #b78780;border-bottom-color:transparent;border-radius:14px;transform:rotate(6deg)}',
    '.bow{position:relative;display:inline-block;width:50px;height:34px;margin-right:12px;vertical-align:-7px}',
    '.bow:before,.bow:after{content:"";position:absolute;top:4px;width:27px;height:22px;border:2px solid #cd8588;background:#efb0b0}',
    '.bow:before{left:0;border-radius:6px 17px 6px 17px;transform:rotate(20deg)}',
    '.bow:after{right:0;border-radius:17px 6px 17px 6px;transform:rotate(-20deg)}',
    '.bow i{position:absolute;z-index:1;left:19px;top:10px;width:13px;height:13px;background:#c9757a;border-radius:4px;transform:rotate(45deg)}',
    '.panel{position:absolute;z-index:1;left:395px;right:47px;padding:22px 28px 20px;background:#fffaf6;border:1px solid #d9b7ae;border-radius:21px;box-shadow:0 6px 4px rgba(134,95,86,.08)}',
    '.panel:after{content:"";position:absolute;inset:10px;border:1px dashed #e8bcb7;border-radius:15px;pointer-events:none}',
    '.panel-title{position:relative;z-index:1;height:43px;margin:0;border-bottom:1px solid #ddbbb4;color:#79584f;font-size:25px;font-weight:700;line-height:36px}',
    '.panel-title .bow{transform:scale(.72);transform-origin:left center;margin-right:0}',
    '.affection-panel{top:60px;height:178px}',
    '.mood-panel{top:250px;height:160px;overflow:hidden}',
    '.thought-panel{top:413px;height:180px}',
    '.panel-content{position:relative;z-index:1;display:flex;height:calc(100% - 43px);padding-top:14px}',
    '.main-value{width:245px;padding-right:25px;border-right:1px dashed #e2bcb4}',
    '.main-value strong{display:block;color:#cc777d;font-size:31px;line-height:1.22;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.affection-main strong{margin-top:4px}',
    '.affection-number{display:block;margin-top:11px;color:#8b665c;font-family:"Microsoft YaHei",sans-serif;font-size:16px;line-height:1.2}',
    '.meter{height:13px;margin-top:10px;border:1px solid #dca9a7;border-radius:9px;background:#fff3ef;overflow:hidden}',
    '.meter>span{display:block;height:100%;border-radius:9px;background:#efa6a8}',
    '.model-note{flex:1;margin:1px 0 0 26px;color:#765b54;font-size:20px;line-height:1.55;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}',
    '.mood-main{display:flex;align-items:center;gap:14px}',
    '.heart-icon{position:relative;width:70px;height:62px;color:#df8e93;flex:0 0 auto}',
    '.heart-icon:before{content:"♡";position:absolute;left:0;top:-10px;font-family:serif;font-size:72px;line-height:1}',
    '.heart-icon:after{content:"⌁⌁";position:absolute;left:10px;top:26px;color:#dd8b90;font-family:serif;font-size:23px;letter-spacing:0}',
    '.mood-main>div{min-width:0;flex:1}',
    '.mood-main strong{color:#cc777d;font-size:31px;line-height:1.2}',
    '.attitude{display:block;max-width:100%;margin-top:5px;color:#946d63;font-family:"Microsoft YaHei",sans-serif;font-size:14px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.thought-content{display:flex;align-items:flex-start;padding-top:13px}',
    '.bubble{position:relative;width:104px;height:62px;margin:2px 27px 0 4px;border:1px solid #c9a69d;border-radius:50%;background:#fff8f4;flex:0 0 auto}',
    '.bubble:after{content:"";position:absolute;left:19px;bottom:-11px;width:25px;height:18px;border-left:1px solid #c9a69d;border-bottom:1px solid #c9a69d;background:#fff8f4;transform:skew(-25deg) rotate(-16deg)}',
    '.bubble i,.bubble i:before,.bubble i:after{position:absolute;width:7px;height:7px;border-radius:50%;background:#d79393;content:""}',
    '.bubble i{left:38px;top:27px}.bubble i:before{left:16px;top:0}.bubble i:after{left:32px;top:0}',
    '.thought-text{margin:3px 0 0;color:#765b54;font-size:19px;line-height:1.62;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4}',
    '.tip-panel{position:absolute;z-index:1;left:80px;bottom:38px;width:300px;height:136px;padding:17px 23px;overflow:hidden;background:#fffaf6;border:1px solid #d9b7ae;border-radius:20px}',
    '.tip-panel:after{content:"";position:absolute;inset:9px;border:1px dashed #e8bcb7;border-radius:14px;pointer-events:none}',
    '.tip-title{position:relative;z-index:1;height:29px;border-bottom:1px solid #ddbbb4;font-size:20px;font-weight:700;line-height:24px}',
    '.tip-title .bow{transform:scale(.58);transform-origin:left center;margin-right:-6px}',
    '.tip-list{position:relative;z-index:1;margin-top:4px;color:#8a665e;font-family:"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.2}',
    '.tip-list p{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tip-list b{display:inline-block;width:21px;color:#dc8a8d;font-family:serif;font-size:14px}',
    '.time-stamp{position:absolute;z-index:3;right:58px;top:30px;color:#a77e74;font-family:"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.2}',
    '.tape{position:absolute;z-index:3;width:95px;height:25px;background:rgba(239,185,185,.74);border:1px solid rgba(204,142,142,.55);transform:rotate(9deg)}',
    '.tape-one{right:65px;top:45px}.tape-two{right:50px;top:438px;transform:rotate(14deg)}',
    '.scissors{position:absolute;z-index:3;right:26px;bottom:25px;color:#b87878;font-family:serif;font-size:72px;line-height:1;transform:rotate(-18deg)}',
    '</style>',
    '<article class="status-bar">',
    '<div class="ribbon ribbon-top"></div><div class="ribbon ribbon-bottom"></div>',
    '<div class="paper-clip"></div>',
    '<section class="photo-frame"><div class="portrait" data-render-image="portrait"></div><p class="name-tag">晓山瑞希</p></section>',
    `<time class="time-stamp">${escapeHtml(data.time)}</time>`,
    '<div class="tape tape-one"></div><div class="tape tape-two"></div>',
    '<section class="panel affection-panel">',
    '<h2 class="panel-title"><span class="bow"><i></i></span>好感度</h2>',
    '<div class="panel-content"><div class="main-value affection-main">',
    `<strong>${escapeHtml(data.stageLabel)}</strong><span class="affection-number">好感度&nbsp;&nbsp;${escapeHtml(data.affectionText)} / 100</span>`,
    `<div class="meter"><span style="width:${affectionWidth}%"></span></div></div>`,
    `<p class="model-note">${escapeHtml(data.affectionNote)}</p></div>`,
    '</section>',
    '<section class="panel mood-panel">',
    '<h2 class="panel-title"><span class="bow"><i></i></span>心情</h2>',
    '<div class="panel-content"><div class="main-value mood-main"><span class="heart-icon" aria-hidden="true"></span><div><strong>',
    `${escapeHtml(data.mood)}</strong><span class="attitude">稳定态度：${escapeHtml(data.attitude)}</span></div></div>`,
    `<p class="model-note">${escapeHtml(data.moodNote)}</p></div>`,
    '</section>',
    '<section class="panel thought-panel">',
    '<h2 class="panel-title"><span class="bow"><i></i></span>心里话</h2>',
    '<div class="thought-content"><span class="bubble" aria-hidden="true"><i></i></span>',
    `<p class="thought-text">${escapeHtml(data.innerThought)}</p></div>`,
    '</section>',
    '<section class="tip-panel"><h2 class="tip-title"><span class="bow"><i></i></span>小贴士</h2>',
    '<div class="tip-list">',
    `<p><b>▦</b>${escapeHtml(data.tipDate)}</p>`,
    '<p><b>♡</b>和你聊天的时间</p>',
    `<p><b>⌁</b>${escapeHtml(data.time)} 更新</p>`,
    '</div></section>',
    '<span class="scissors" aria-hidden="true">✂</span>',
    '</article>'
  ].join('');
}

module.exports = {
  buildPrivateStatusBarHtml,
  escapeHtml,
  formatAffection,
  formatTime,
  formatTipDate,
  moodLabel,
  normalizeStatusBarData
};
