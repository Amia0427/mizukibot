'use strict';

const config = require('../../config');
const { STAGE_LABELS, STAGE_DESCRIPTIONS, normalizeText } = require('./definitions');

function formatPublicRelationship(snapshot = {}) {
  const relationship = snapshot.relationship || {};
  const label = normalizeText(relationship.stageLabel || STAGE_LABELS[relationship.stage] || '陌生人', 32) || '陌生人';
  const description = normalizeText(relationship.stageDescription || STAGE_DESCRIPTIONS[relationship.stage] || '先保持礼貌距离，慢慢认识。', 160);
  return `我们现在算是${label}，${description}`;
}

function formatCharacterState(snapshot = {}) {
  const state = snapshot.character || {};
  const mood = Number(state.mood || 0);
  const energy = Number(state.energy || 0);
  const stress = Number(state.stress || 0);
  const social = Number(state.socialWillingness || 0);
  const moodText = mood >= 30 ? '心情还不错' : (mood <= -30 ? '心情有点低落' : '心情比较平静');
  const energyText = energy <= 35 ? '有点累' : (energy >= 75 ? '精神还不错' : '状态一般');
  const stressText = stress >= 60 ? '事情有点多，略微紧绷' : (stress <= 25 ? '没那么紧绷' : '压力中等');
  const socialText = social <= 35 ? '今天更想安静一点' : (social >= 70 ? '愿意多聊一会儿' : '可以正常聊天');
  return `${moodText}，${energyText}，${stressText}，${socialText}。`;
}

function toLegacyAffinityState(snapshot = {}, userId = '') {
  const relationship = snapshot.relationship || {};
  const stage = String(relationship.stage || 'stranger');
  const pointsByStage = {
    stranger: 0,
    acquaintance: 40,
    friend: 180,
    close: 380,
    intimate_companion: 620
  };
  const isAdmin = (Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : [])
    .map((id) => String(id || '').trim())
    .includes(String(userId || '').trim());
  return {
    points: isAdmin ? 999 : (pointsByStage[stage] ?? 0),
    level: relationship.stageLabel || STAGE_LABELS[stage] || '陌生人',
    relationship: relationship.stageLabel || STAGE_LABELS[stage] || '陌生人',
    attitude: relationship.attitude || '中立、保持距离',
    trust_score: Math.round(Number(relationship.trust || 0)),
    last_affinity_reason: '',
    last_affinity_source: 'conversation_variables',
    last_affinity_update_at: Number(relationship.lastInteractionAt || 0) || 0,
    scope: 'global',
    variableSnapshot: snapshot
  };
}

module.exports = {
  formatCharacterState,
  formatPublicRelationship,
  toLegacyAffinityState
};
