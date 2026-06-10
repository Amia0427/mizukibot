const PERSONA_SUPPORT_FIELDS = new Set([
  'persona_summary_support',
  'persona_impression_support'
]);

const BOT_PERSONA_FIELDS = new Set([
  'bot_persona_tone',
  'bot_persona_initiative',
  'bot_persona_boundaries',
  'bot_persona_playfulness',
  'bot_persona_guardedness',
  'bot_persona_verbosity'
]);

const RELATIONSHIP_STYLE_FIELDS = new Set([
  'relationship_tone',
  'relationship_distance',
  'relationship_salutation',
  'relationship_reply_style',
  'relationship_engagement',
  'relationship_boundaries'
]);

const STRICT_PROFILE_FIELD_MAP = Object.freeze({
  identity: 'identities',
  personality: 'personality_traits',
  hobby: 'hobbies',
  preference_like: 'likes',
  preference_dislike: 'dislikes',
  goal: 'goals',
  boundary: 'boundaries'
});

const WEAK_PROFILE_FIELD_MAP = Object.freeze({
  preference_like: 'single_hit_preferences',
  preference_dislike: 'single_hit_preferences',
  hobby: 'single_hit_preferences',
  personality: 'single_hit_traits',
  topic: 'recent_topics'
});

const PERSONA_DECAY_WINDOWS = Object.freeze({
  bot_persona: 365,
  relationship_style: 120
});

module.exports = {
  BOT_PERSONA_FIELDS,
  PERSONA_DECAY_WINDOWS,
  PERSONA_SUPPORT_FIELDS,
  RELATIONSHIP_STYLE_FIELDS,
  STRICT_PROFILE_FIELD_MAP,
  WEAK_PROFILE_FIELD_MAP
};
