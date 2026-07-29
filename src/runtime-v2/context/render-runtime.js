'use strict';

const { buildBaseDynamicPrompt } = require('./base');

async function renderPromptLayers(materials = {}, policy = {}) {
  const normalizedMaterials = materials && typeof materials === 'object' ? materials : {};
  const modelConfig = policy.modelConfig || normalizedMaterials.modelConfig;
  const modelName = policy.modelName
    || policy.model_name
    || policy.model
    || normalizedMaterials.modelName
    || normalizedMaterials.model_name
    || normalizedMaterials.model
    || (modelConfig && typeof modelConfig === 'object' ? modelConfig.model : undefined);
  return buildBaseDynamicPrompt(
    normalizedMaterials.userInfo,
    normalizedMaterials.userId,
    normalizedMaterials.question,
    normalizedMaterials.customPrompt,
    {
      ...policy,
      routeMeta: policy.routeMeta || normalizedMaterials.routeMeta,
      routePolicyKey: policy.routePolicyKey || normalizedMaterials.routePolicyKey,
      topRouteType: policy.topRouteType || normalizedMaterials.topRouteType,
      mainReplyPromptMode: policy.mainReplyPromptMode || normalizedMaterials.mainReplyPromptMode,
      promptMaterials: normalizedMaterials,
      modelName
    }
  );
}

module.exports = { renderPromptLayers };
