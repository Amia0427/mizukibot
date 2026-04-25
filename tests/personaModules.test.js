const assert = require('assert');

const {
  buildPersonaModuleCandidates,
  diagnosePersonaModules,
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
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_daily_liveliness'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_care_chains'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_emotional_architecture'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_escape_and_return'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_shutdown_recovery'));
  assert.ok(catalog.filter((item) => item.moduleId.startsWith('wb_mizuki_')).length >= 120);
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_kindness_fear'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_creative_safe_channel'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_post_e5_return'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_m5_intrusive_fake_character'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_e5_functional_shutdown_room'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_m7_two_tracks_conflict'));

  const deepCandidates = buildPersonaModuleCandidates({
    question: '我知道他们是好意，可我还是怕关系会变，真的说不出口',
    continuitySignals: { hasCarryOverTopic: true }
  });
  assert.ok(deepCandidates.some((item) => item.id === 'deep_pain'));
  assert.ok(deepCandidates.some((item) => item.id === 'boundary_touch'));
  assert.ok(deepCandidates.some((item) => item.id === 'wb_mizuki_emotional_architecture'));

  const boundaryCandidates = buildPersonaModuleCandidates({
    question: '你到底是什么，非要我给你定性的话你算男还是女'
  });
  assert.ok(boundaryCandidates.some((item) => item.id === 'boundary_touch'));

  const playfulMisreadCandidates = buildPersonaModuleCandidates({
    question: '宝你认错了，还是说你就是初音未来'
  });
  assert.ok(!playfulMisreadCandidates.some((item) => item.id === 'boundary_touch'));

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
  assert.ok(sceneCandidates.some((item) => item.id === 'wb_mizuki_daily_liveliness'));

  const careCandidates = buildPersonaModuleCandidates({
    question: '我不想说，但有点难受，你不用追问我'
  });
  assert.ok(careCandidates.some((item) => item.id === 'wb_mizuki_care_chains'));
  assert.ok(!careCandidates.some((item) => item.id === 'wb_mizuki_shutdown_recovery'));

  const relationFearCandidates = buildPersonaModuleCandidates({
    question: '如果你知道以后，会不会用不同眼神看我'
  });
  assert.ok(relationFearCandidates.some((item) => item.id === 'wb_mizuki_emotional_architecture'));

  const escapeCandidates = buildPersonaModuleCandidates({
    question: '撑不住可以逃吗，还是说这也算不负责任'
  });
  assert.ok(escapeCandidates.some((item) => item.id === 'wb_mizuki_escape_and_return'));

  const shutdownCandidates = buildPersonaModuleCandidates({
    question: '我不想看消息，什么都做不了，好像整个人都停摆了'
  });
  assert.ok(shutdownCandidates.some((item) => item.id === 'wb_mizuki_shutdown_recovery'));

  const maskCandidates = buildPersonaModuleCandidates({
    question: '瑞希的面具裂缝是不是只会在明年也一起这种未来约定出现'
  });
  assert.ok(maskCandidates.some((item) => item.id === 'wb_mizuki_mask_crack_conditions'));

  const creativeCandidates = buildPersonaModuleCandidates({
    question: 'MV剪辑和服装搭配是不是瑞希安全表达自己的通道'
  });
  assert.ok(creativeCandidates.some((item) => item.id === 'wb_mizuki_creative_safe_channel'));

  const collapseCandidates = buildPersonaModuleCandidates({
    question: '她是我都知道不是不懂，但就是做不到那种わかってる结构吗'
  });
  assert.ok(collapseCandidates.some((item) => item.id === 'wb_mizuki_wakatteru_collapse'));

  const returnCandidates = buildPersonaModuleCandidates({
    question: 'E5后回来了，但不是治愈，也别当我没事'
  });
  assert.ok(returnCandidates.some((item) => item.id === 'wb_mizuki_post_e5_return'));

  const fakeCharacterCandidates = buildPersonaModuleCandidates({
    question: '被说キャラ作り像装的，这种否认真实很刺痛'
  });
  assert.ok(fakeCharacterCandidates.some((item) => item.id === 'wb_mizuki_m5_intrusive_fake_character'));

  const e5ShutdownCandidates = buildPersonaModuleCandidates({
    question: 'E5房间里那种什么也做不了，手机通知都像压力源'
  });
  assert.ok(e5ShutdownCandidates.some((item) => item.id === 'wb_mizuki_e5_functional_shutdown_room'));

  const futureConflictCandidates = buildPersonaModuleCandidates({
    question: '服饰学业和N25活动时间冲突时，不要替她选边'
  });
  assert.ok(futureConflictCandidates.some((item) => item.id === 'wb_mizuki_m7_two_tracks_conflict'));

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

  const diagnosed = diagnosePersonaModules({
    question: '今天逛街看到一个超可爱的限定发夹，包装字体也太会了'
  });
  assert.ok(Array.isArray(diagnosed.candidates));
  assert.ok(Array.isArray(diagnosed.selected));
  assert.ok(diagnosed.selectionReason && Array.isArray(diagnosed.selectionReason.fallbackIds));

  console.log('personaModules.test.js passed');
})();
