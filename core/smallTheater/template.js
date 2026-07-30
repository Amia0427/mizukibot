const ACT_LABELS = ['第一幕', '第二幕', '第三幕', '第四幕'];

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDialogueHtml(dialogues = []) {
  return dialogues.map((dialogue) => [
    '<div class="dialogue">',
    `<span class="speaker">${escapeHtml(dialogue.speaker)}</span>`,
    `<span class="line">${escapeHtml(dialogue.text)}</span>`,
    '</div>'
  ].join('')).join('');
}

function buildSmallTheaterHtml(story) {
  const acts = story.acts.map((act, index) => [
    '<section class="act">',
    '<header class="act-header">',
    `<span class="act-number">${ACT_LABELS[index]}</span>`,
    `<h2>${escapeHtml(act.heading)}</h2>`,
    '</header>',
    `<p class="narration">${escapeHtml(act.narration)}</p>`,
    `<div class="dialogues">${buildDialogueHtml(act.dialogues)}</div>`,
    '</section>'
  ].join('')).join('');

  return [
    '<style>',
    ':root{color:#26262d;background:#f7f7f8;font-family:"Microsoft YaHei","PingFang SC",sans-serif}',
    '.theater{width:900px;padding:54px 56px 46px;background:#f7f7f8}',
    '.masthead{padding:0 0 30px;border-bottom:4px solid #282832}',
    '.eyebrow{margin:0 0 10px;color:#b72d6c;font-size:20px;font-weight:700;letter-spacing:0}',
    'h1{margin:0;color:#202028;font-size:44px;line-height:1.22;letter-spacing:0;overflow-wrap:anywhere}',
    '.acts{display:grid;grid-template-columns:1fr;gap:16px;padding:24px 0}',
    '.act{padding:22px 24px;border:1px solid #d9d9df;border-left:7px solid #2f7f75;background:#fff}',
    '.act:nth-child(2){border-left-color:#d38b23}.act:nth-child(3){border-left-color:#4f68a8}.act:nth-child(4){border-left-color:#b72d6c}',
    '.act-header{display:flex;align-items:baseline;gap:16px;margin-bottom:12px}',
    '.act-number{flex:0 0 auto;color:#6a6a74;font-size:18px;font-weight:700;letter-spacing:0}',
    'h2{margin:0;color:#25252d;font-size:28px;line-height:1.3;letter-spacing:0;overflow-wrap:anywhere}',
    '.narration{margin:0 0 15px;color:#555560;font-size:20px;line-height:1.65;letter-spacing:0;overflow-wrap:anywhere}',
    '.dialogues{display:grid;gap:9px}',
    '.dialogue{display:grid;grid-template-columns:104px minmax(0,1fr);gap:14px;align-items:start}',
    '.speaker{color:#a2245f;font-size:19px;font-weight:700;line-height:1.55;letter-spacing:0;overflow-wrap:anywhere}',
    '.line{color:#292932;font-size:20px;line-height:1.55;letter-spacing:0;overflow-wrap:anywhere}',
    '.ending{margin:0;padding:22px 24px;border-top:1px solid #c9c9d0;color:#303039;font-size:22px;font-weight:700;line-height:1.55;text-align:center;letter-spacing:0;overflow-wrap:anywhere}',
    '</style>',
    '<article class="theater">',
    '<header class="masthead">',
    '<p class="eyebrow">瑞希的番外小剧场</p>',
    `<h1>${escapeHtml(story.title)}</h1>`,
    '</header>',
    `<main class="acts">${acts}</main>`,
    `<footer class="ending">${escapeHtml(story.ending)}</footer>`,
    '</article>'
  ].join('');
}

module.exports = {
  buildSmallTheaterHtml,
  escapeHtml
};
