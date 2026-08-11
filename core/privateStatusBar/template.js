const { getDatePartsInTz } = require('../../utils/time');

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
  const affection = clamp(relationship.affection, 0, 100, 0);
  return {
    affection,
    affectionText: formatAffection(affection),
    stageLabel: String(relationship.stageLabel || relationship.stage || '陌生人').trim() || '陌生人',
    attitude: String(relationship.attitude || '中立、保持距离').replace(/\s+/g, ' ').trim() || '中立、保持距离',
    mood: moodLabel(character.mood),
    innerThought: String(input.innerThought || '').replace(/\s+/g, ' ').trim(),
    time: formatTime(options.now instanceof Date ? options.now : new Date(options.now || Date.now()), options.timezone)
  };
}

function buildPrivateStatusBarHtml(input = {}, options = {}) {
  const data = normalizeStatusBarData(input, options);
  const affectionWidth = Math.round(data.affection * 100) / 100;
  return [
    '<style>',
    ':root{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#25252d;background:#fff}',
    '.status-bar{width:800px;height:260px;overflow:hidden;padding:18px 28px 16px;background:#fff;border:1px solid #d9d9df;border-top:6px solid #c22f70}',
    '.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;height:40px}',
    '.eyebrow{margin:0;color:#c22f70;font-size:17px;font-weight:700;line-height:1.4}',
    '.time{margin:2px 0 0;color:#72727c;font-size:14px;line-height:1.4}',
    '.main{display:grid;grid-template-columns:260px 1fr;gap:24px;height:156px}',
    '.metrics{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:80px 64px;gap:12px}',
    '.metric{padding:9px 13px;border:1px solid #e2e2e7;background:#fafafd}',
    '.label{display:block;color:#777781;font-size:13px;line-height:1.3}',
    '.value{display:block;margin-top:4px;color:#282833;font-size:20px;font-weight:700;line-height:1.25;overflow-wrap:anywhere}',
    '.affection{grid-column:1 / -1}',
    '.meter{height:8px;margin-top:7px;background:#eeeef2;border-radius:4px;overflow:hidden}',
    '.meter>span{display:block;height:100%;background:#c22f70;border-radius:4px}',
    '.thought{padding:16px 18px;background:#fff6fa;border-left:5px solid #c22f70}',
    '.thought-label{margin:0 0 8px;color:#9a2859;font-size:14px;font-weight:700;line-height:1.3}',
    '.thought-text{margin:0;color:#292932;font-size:22px;font-weight:700;line-height:1.5;overflow-wrap:anywhere}',
    '.bottom{display:flex;gap:10px;height:23px;align-items:flex-end;color:#555560;font-size:14px;line-height:1.3;overflow:hidden}',
    '.attitude{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '</style>',
    '<article class="status-bar">',
    '<header class="top">',
    '<p class="eyebrow">瑞希 · 私聊状态</p>',
    `<p class="time">${escapeHtml(data.time)}</p>`,
    '</header>',
    '<main class="main">',
    '<section class="metrics">',
    '<div class="metric affection"><span class="label">好感度</span><span class="value">',
    `${escapeHtml(data.affectionText)} / 100`,
    '</span><div class="meter"><span style="width:',
    `${affectionWidth}%`,
    '"></span></div></div>',
    `<div class="metric"><span class="label">关系等级</span><span class="value">${escapeHtml(data.stageLabel)}</span></div>`,
    `<div class="metric"><span class="label">文字情绪</span><span class="value">${escapeHtml(data.mood)}</span></div>`,
    '</section>',
    '<section class="thought">',
    '<p class="thought-label">瑞希的心里话</p>',
    `<p class="thought-text">${escapeHtml(data.innerThought)}</p>`,
    '</section>',
    '</main>',
    `<footer class="bottom"><span>稳定态度</span><span class="attitude">${escapeHtml(data.attitude)}</span></footer>`,
    '</article>'
  ].join('');
}

module.exports = {
  buildPrivateStatusBarHtml,
  escapeHtml,
  formatAffection,
  formatTime,
  moodLabel,
  normalizeStatusBarData
};
