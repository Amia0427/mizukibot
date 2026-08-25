const POLICY_VERSION = 'tool_policy_manifest_v1';

function createPolicy(overrides = {}) {
  const effect = overrides.effect || 'none';
  const sideEffect = effect !== 'none';
  return Object.freeze({
    version: POLICY_VERSION,
    risk: overrides.risk || (sideEffect ? 'medium' : 'low'),
    capability: overrides.capability || 'general',
    effect,
    confirmation: overrides.confirmation || (sideEffect ? 'explicit' : 'none'),
    scope: overrides.scope || 'user',
    idempotency: overrides.idempotency || (sideEffect ? 'required' : 'none'),
    replay: overrides.replay || (sideEffect ? 'block_uncertain' : 'reuse_result'),
    exposure: overrides.exposure || 'public'
  });
}

function assignPolicy(target, names, policy) {
  for (const name of names) target[name] = policy;
}

const TOOL_POLICIES = {};

assignPolicy(TOOL_POLICIES, [
  'get_context_stats',
  'url_safety_check',
  'json_validate',
  'study_card_generator',
  'meeting_minutes_struct',
  'extract_todo_from_text',
  'pomodoro_plan',
  'regex_tester',
  'text_stats',
  'safe_eval_math',
  'generate_uuid',
  'hash_text',
  'extract_urls',
  'json_query',
  'render_template',
  'jwt_decode',
  'assistant_task_breakdown',
  'assistant_weekly_agenda',
  'assistant_meeting_agenda',
  'assistant_email_draft',
  'assistant_decision_matrix',
  'assistant_daily_brief',
  'research_question_refiner',
  'research_literature_matrix',
  'research_experiment_plan',
  'research_paper_outline',
  'research_peer_review_checklist',
  'study_syllabus_plan',
  'study_active_recall_quiz',
  'study_exam_revision_plan',
  'research_abstract_structurer',
  'research_intro_paragraph_builder',
  'research_result_interpreter',
  'study_mistake_diagnosis',
  'study_spaced_repetition_plan',
  'get_current_time'
], createPolicy());

assignPolicy(TOOL_POLICIES, [
  'getLyrics',
  'getWeather',
  'search_nearby_places',
  'search_academic_paper',
  'query_arcaea_info',
  'get_bilibili_hot',
  'web_search',
  'web_fetch',
  'read_shared_link',
  'currency_convert',
  'translate_text',
  'read_rss_feed',
  'skill_web_search',
  'skill_arxiv_search',
  'skill_arxiv_get',
  'skill_arxiv_latest',
  'skill_earthquake_latest',
  'skill_weather',
  'skill_youtube_transcript',
  'skill_summarize',
  'skill_brave_search',
  'skill_brave_extract',
  'skill_tavily_search',
  'skill_tavily_extract',
  'skill_stock_analyze',
  'skill_stock_dividend',
  'skill_stock_price_query',
  'skill_stock_hot',
  'skill_stock_rumor',
  'skill_ppt_theme_list',
  'minecraft_status'
], createPolicy({ risk: 'medium', capability: 'network' }));

TOOL_POLICIES.skill_weather = createPolicy({
  risk: 'low',
  capability: 'network',
  effect: 'none',
  confirmation: 'none'
});

assignPolicy(TOOL_POLICIES, [
  'maimai_chart_search',
  'maimai_chart_analyze',
  'maimai_player_analysis',
  'pjsk_song_search'
], createPolicy({ risk: 'low', capability: 'local_read' }));

TOOL_POLICIES.pjsk_chart_analyze = createPolicy({
  risk: 'medium',
  capability: 'local_read',
  effect: 'external_send',
  confirmation: 'none',
  scope: 'group'
});

TOOL_POLICIES.skill_weather_cloud = createPolicy({
  risk: 'medium',
  capability: 'network',
  effect: 'external_send',
  confirmation: 'none'
});

TOOL_POLICIES.weather_alert_subscription = createPolicy({
  risk: 'medium',
  capability: 'local_write',
  effect: 'local_write',
  confirmation: 'explicit',
  scope: 'user'
});

assignPolicy(TOOL_POLICIES, [
  'notebook_list_docs',
  'notebook_search',
  'notebook_read_recent_journal',
  'skill_vetter_report',
  'skill_qqbot_dep_check',
  'skill_skill_validate',
  'skill_agent_browser_guide',
  'skill_api_gateway_reference',
  'skill_auto_updater_guide',
  'skill_byterover_guide',
  'skill_clawddocs_reference',
  'skill_find_skills_guide',
  'skill_free_ride_guide',
  'skill_github_api_guide',
  'skill_gog_guide',
  'skill_humanizer_guide',
  'skill_larry_guide',
  'skill_n8n_workflow_guide',
  'skill_nano_pdf_guide',
  'skill_obsidian_guide',
  'skill_openai_whisper_guide',
  'skill_proactive_agent_guide',
  'skill_research_cog_guide',
  'skill_self_improving_agent_guide',
  'skill_skillhub_preference_guide',
  'skill_youtube_api_guide',
  'skill_clawddocs_search',
  'skill_clawddocs_fetch'
], createPolicy({ risk: 'medium', capability: 'fs_read' }));

assignPolicy(TOOL_POLICIES, [
  'memory_cli',
  'companion_review',
  'self_improvement_recent',
  'self_improvement_search',
  'self_improvement_patterns',
  'self_improvement_rules',
  'self_improvement_guides'
], createPolicy({ risk: 'medium', capability: 'memory_read' }));

assignPolicy(TOOL_POLICIES, [
  'notebook_reindex_folder',
  'notebook_add_document',
  'notebook_append_journal',
  'skill_image_generate_pro'
], createPolicy({ risk: 'medium', capability: 'fs_write', effect: 'local_write' }));

assignPolicy(TOOL_POLICIES, [
  'qzone_draft',
  'publish_qzone'
], createPolicy({ risk: 'medium', capability: 'local_write', effect: 'local_write', scope: 'admin' }));

assignPolicy(TOOL_POLICIES, [
  'schedule_group_message'
], createPolicy({ risk: 'medium', capability: 'local_write', effect: 'external_send', scope: 'group' }));

assignPolicy(TOOL_POLICIES, [
  'create_qzone_auto_task'
], createPolicy({
  risk: 'high',
  capability: 'local_write',
  effect: 'external_send',
  confirmation: 'admin_explicit',
  scope: 'admin'
}));

assignPolicy(TOOL_POLICIES, [
  'list_scheduled_tasks'
], createPolicy({ risk: 'medium', capability: 'local_read', scope: 'group' }));

assignPolicy(TOOL_POLICIES, [
  'cancel_scheduled_task'
], createPolicy({ risk: 'medium', capability: 'local_write', effect: 'local_write', scope: 'group' }));

assignPolicy(TOOL_POLICIES, [
  'delete_scheduled_task'
], createPolicy({ risk: 'high', capability: 'local_write', effect: 'destructive', scope: 'group' }));

assignPolicy(TOOL_POLICIES, [
  'render_qq_visual'
], createPolicy({ risk: 'medium', capability: 'local_write', effect: 'external_send', scope: 'group' }));

assignPolicy(TOOL_POLICIES, [
  'skill_ppt_generate'
], createPolicy({ risk: 'high', capability: 'network', effect: 'external_send' }));

assignPolicy(TOOL_POLICIES, [
  'minecraft_connect'
], createPolicy({ risk: 'high', capability: 'network', effect: 'external_send' }));

assignPolicy(TOOL_POLICIES, [
  'minecraft_disconnect',
  'minecraft_chat',
  'minecraft_move_to',
  'minecraft_follow_player',
  'minecraft_look_at',
  'minecraft_stop'
], createPolicy({ risk: 'medium', capability: 'network', effect: 'external_send' }));

TOOL_POLICIES.skill_stock_watchlist = createPolicy({
  risk: 'medium',
  capability: 'fs_write',
  effect: 'local_write'
});
TOOL_POLICIES.skill_stock_portfolio = createPolicy({
  risk: 'medium',
  capability: 'fs_write',
  effect: 'local_write'
});
TOOL_POLICIES.skill_ontology_graph = createPolicy({
  risk: 'medium',
  capability: 'fs_write',
  effect: 'local_write'
});
TOOL_POLICIES.create_scheduled_command = createPolicy({
  risk: 'medium',
  capability: 'local_write',
  effect: 'external_send',
  scope: 'group'
});
TOOL_POLICIES.companion_followup = createPolicy({
  risk: 'medium',
  capability: 'local_write',
  effect: 'local_write',
  scope: 'user'
});
TOOL_POLICIES.companion_memory = createPolicy({
  risk: 'medium',
  capability: 'local_write',
  effect: 'local_write',
  scope: 'user'
});
TOOL_POLICIES.local_howtocook_recipe_search = createPolicy({
  risk: 'medium',
  capability: 'network',
  exposure: 'internal'
});

Object.freeze(TOOL_POLICIES);

const UNKNOWN_POLICY = createPolicy({
  risk: 'high',
  capability: 'unknown',
  effect: 'unknown',
  confirmation: 'explicit'
});

function normalizeAction(args = {}) {
  return String(args?.action || '').trim().toLowerCase();
}

function resolveActionPolicy(basePolicy, action, groups = {}) {
  if (!action) return { policy: { ...basePolicy }, reason: '' };
  for (const [effect, actions] of Object.entries(groups)) {
    if (!actions.includes(action)) continue;
    return {
      policy: {
        ...basePolicy,
        effect,
        risk: effect === 'destructive' ? 'high' : basePolicy.risk,
        capability: effect === 'none' ? 'fs_read' : basePolicy.capability,
        confirmation: effect === 'none' ? 'none' : basePolicy.confirmation,
        idempotency: effect === 'none' ? 'none' : 'required',
        replay: effect === 'none' ? 'reuse_result' : 'block_uncertain'
      },
      reason: ''
    };
  }
  return { policy: { ...UNKNOWN_POLICY }, reason: 'unknown_action' };
}

function resolveToolPolicy(toolName, args = {}) {
  const name = String(toolName || '').trim();
  const basePolicy = TOOL_POLICIES[name];
  if (!basePolicy) return { policy: { ...UNKNOWN_POLICY }, reason: 'unknown_capability' };

  const action = normalizeAction(args);
  if (name === 'skill_stock_watchlist') {
    return resolveActionPolicy(basePolicy, action, {
      none: ['list', 'check'],
      local_write: ['add'],
      destructive: ['remove']
    });
  }
  if (name === 'skill_stock_portfolio') {
    return resolveActionPolicy(basePolicy, action, {
      none: ['list', 'show'],
      local_write: ['create', 'rename', 'add', 'update'],
      destructive: ['delete', 'remove']
    });
  }
  if (name === 'skill_ontology_graph') {
    return resolveActionPolicy(basePolicy, action, {
      none: ['get', 'list', 'query', 'related'],
      local_write: ['create', 'update', 'relate', 'validate', 'schema-append'],
      destructive: ['delete']
    });
  }
  if (name === 'weather_alert_subscription') {
    return resolveActionPolicy(basePolicy, action, {
      none: ['list'],
      local_write: ['subscribe', 'unsubscribe', 'pause', 'resume']
    });
  }
  if (name === 'create_scheduled_command') {
    if (!action) return { policy: { ...basePolicy }, reason: '' };
    if (action === 'group_message') return { policy: { ...basePolicy }, reason: '' };
    if (action === 'qzone_post') {
      return {
        policy: {
          ...basePolicy,
          risk: 'high',
          confirmation: 'admin_explicit',
          scope: 'admin'
        },
        reason: ''
      };
    }
    return { policy: { ...UNKNOWN_POLICY }, reason: 'unknown_action' };
  }
  if (name === 'companion_followup') {
    return resolveActionPolicy(basePolicy, action, {
      none: ['list'],
      local_write: ['add', 'complete', 'snooze', 'abandon'],
      destructive: ['delete']
    });
  }
  if (name === 'companion_memory') {
    return resolveActionPolicy(basePolicy, action, {
      none: ['list', 'settings'],
      local_write: ['remember', 'correct', 'set_auto'],
      destructive: ['forget']
    });
  }
  return { policy: { ...basePolicy }, reason: '' };
}

function getPolicy(toolName, args = {}) {
  return resolveToolPolicy(toolName, args).policy;
}

function hasPublicToolPolicy(toolName) {
  return TOOL_POLICIES[String(toolName || '').trim()]?.exposure === 'public';
}

module.exports = {
  POLICY_VERSION,
  TOOL_POLICIES,
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
};
