'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const STAGE_PROMPT_FILES = Object.freeze({
  stranger: '01.txt',
  acquaintance: '02.txt',
  friend: '03.txt',
  close: '04.txt',
  intimate_companion: '05.txt'
});

const MAIN_CHAT_SURFACES = new Set(['direct_chat', 'private_chat', 'group_direct_chat']);

function normalizeStage(value = '') {
  const stage = String(value || '').trim();
  return STAGE_PROMPT_FILES[stage] ? stage : 'stranger';
}

function normalizePromptText(value = '') {
  return String(value || '')
    .replace(/[（(]\s*\d+\s*[–—-]\s*\d+\s*[）)]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getGuanxiPromptPath(stage = '', promptsDir = config.PROMPTS_DIR) {
  return path.join(String(promptsDir || config.PROMPTS_DIR), 'guanxi', STAGE_PROMPT_FILES[normalizeStage(stage)]);
}

function loadGuanxiStagePrompt(snapshot = {}, options = {}) {
  const relationship = snapshot.relationship && typeof snapshot.relationship === 'object'
    ? snapshot.relationship
    : snapshot;
  const stage = normalizeStage(relationship?.stage);
  const promptsDir = options.promptsDir || config.PROMPTS_DIR;
  const promptPath = getGuanxiPromptPath(stage, promptsDir);
  if (!fs.existsSync(promptPath)) return null;

  const text = normalizePromptText(fs.readFileSync(promptPath, 'utf8'));
  if (!text) return null;
  return {
    stage,
    fileName: STAGE_PROMPT_FILES[stage],
    source: path.relative(promptsDir, promptPath).replace(/\\/g, '/'),
    text
  };
}

function shouldInjectGuanxiPrompt({ surface = '', isAdmin = false } = {}) {
  return !isAdmin && MAIN_CHAT_SURFACES.has(String(surface || '').trim().toLowerCase());
}

module.exports = {
  MAIN_CHAT_SURFACES,
  STAGE_PROMPT_FILES,
  getGuanxiPromptPath,
  loadGuanxiStagePrompt,
  normalizePromptText,
  normalizeStage,
  shouldInjectGuanxiPrompt
};
