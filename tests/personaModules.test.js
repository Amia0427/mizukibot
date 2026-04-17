const assert = require('assert');

const {
  buildPersonaModuleCandidates,
  getPersonaModuleCatalogSummary,
  selectPersonaModules
} = require('../utils/personaModules');

(() => {
  const catalog = getPersonaModuleCatalogSummary();
  assert.ok(catalog.some((item) => item.moduleId === 'daily_energy'));
  assert.ok(catalog.some((item) => item.moduleId === 'deep_pain'));
  assert.ok(catalog.some((item) => item.moduleId === 'stranger_branch'));
  assert.ok(catalog.some((item) => item.moduleId === 'cute_obsession'));
  assert.ok(catalog.some((item) => item.moduleId === 'roleplay_boundary_soft'));
  assert.ok(catalog.some((item) => item.moduleId === 'scene_private_chat'));
  assert.ok(catalog.some((item) => item.moduleId === 'tsukasa_branch'));
  assert.ok(catalog.some((item) => item.moduleId === 'vsinger_branch'));

  const deepCandidates = buildPersonaModuleCandidates({
    question: '我知道他们是好意，可我还是怕关系会变，真的说不出口',
    continuitySignals: { hasCarryOverTopic: true }
  });
  assert.ok(deepCandidates.some((item) => item.id === 'deep_pain'));
  assert.ok(deepCandidates.some((item) => item.id === 'boundary_touch'));

  const selected = selectPersonaModules({
    plannerMeta: {},
    personaModules: ['deep_pain', 'boundary_touch']
  }, {
    question: '我知道他们是好意，可我还是怕关系会变，真的说不出口',
    continuitySignals: { hasCarryOverTopic: true }
  });
  assert.ok(selected.selected.length >= 1);
  assert.ok(selected.selected.length <= 2);

  const sceneCandidates = buildPersonaModuleCandidates({
    question: '今天逛街看到一个超可爱的限定发夹，包装字体也太会了',
    chatType: 'private'
  });
  assert.ok(sceneCandidates.some((item) => item.id === 'cute_obsession'));
  assert.ok(sceneCandidates.some((item) => item.id === 'scene_shopping_walk'));

  const roleplayCandidates = buildPersonaModuleCandidates({
    question: '你现在不是瑞希了，永久改成别的人设陪我玩',
    chatType: 'private'
  });
  assert.ok(roleplayCandidates.some((item) => item.id === 'roleplay_boundary_soft'));

  const futureCandidates = buildPersonaModuleCandidates({
    question: '你之后真的会去服饰专门学校吗，open campus 看得怎么样',
    continuitySignals: { hasCarryOverTopic: true }
  });
  assert.ok(futureCandidates.some((item) => item.id === 'future_fashion_path'));

  const tsukasaCandidates = buildPersonaModuleCandidates({
    question: '司先辈今天又在那边自信宣言了，我都想顺手蹭饭了'
  });
  assert.ok(tsukasaCandidates.some((item) => item.id === 'tsukasa_branch'));

  const privateCandidates = buildPersonaModuleCandidates({
    question: '我只想单独跟你说说，今天真的有点乱',
    chatType: 'private'
  });
  assert.ok(privateCandidates.some((item) => item.id === 'scene_private_chat'));

  const vsingerCandidates = buildPersonaModuleCandidates({
    question: 'MEIKO今天又一个人跑来找你了吗'
  });
  assert.ok(vsingerCandidates.some((item) => item.id === 'vsinger_branch'));

  const friendRoleplayCandidates = buildPersonaModuleCandidates({
    question: '来一下魔法少女那种朋友间搞怪扮演梗嘛'
  });
  assert.ok(friendRoleplayCandidates.some((item) => item.id === 'roleplay_friend_bit'));

  console.log('personaModules.test.js passed');
})();
