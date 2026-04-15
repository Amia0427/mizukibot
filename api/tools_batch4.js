// ========================= [可复制粘贴开始] api/tools_batch4.js =========================
/**
 * 第四批工具：围绕本地知识库与笔记行为
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const {
  notebook_reindex_folder,
  notebook_add_document,
  notebook_list_docs,
  notebook_search
} = require('./localNotebook');

const JOURNAL_FILE = path.join(config.DATA_DIR, 'journal.md');

async function notebook_append_journal(entry, tag = 'daily') {
  const e = String(entry || '').trim();
  if (!e) return '请提供 entry。';

  const line = `\n## ${new Date().toISOString()} [${tag}]\n${e}\n`;
  fs.appendFileSync(JOURNAL_FILE, line, 'utf-8');

  return JSON.stringify({
    ok: true,
    file: JOURNAL_FILE,
    appended_chars: e.length
  });
}

async function notebook_read_recent_journal(limit = 5) {
  const n = Math.max(1, Math.min(50, Number(limit) || 5));
  if (!fs.existsSync(JOURNAL_FILE)) return '日记文件不存在，先写一条吧。';

  const text = fs.readFileSync(JOURNAL_FILE, 'utf-8');
  const blocks = text.split(/\n## /g).filter(Boolean);
  const recent = blocks.slice(-n).map((b, i) => `${i + 1}. ${b.slice(0, 300)}`);

  return `最近 ${recent.length} 条日记：\n\n${recent.join('\n\n')}`;
}

module.exports = {
  notebook_reindex_folder,
  notebook_add_document,
  notebook_list_docs,
  notebook_search,
  notebook_append_journal,
  notebook_read_recent_journal
};
// ========================= [可复制粘贴结束] api/tools_batch4.js =========================
