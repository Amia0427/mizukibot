'use strict';

const { buildBaseDynamicPrompt } = require('./base');
const {
  buildDirectedContextPromptSnippet,
  buildRoleplayInnerProtocolPromptSnippet,
  buildRoleplayRuntimeContextPromptSnippet,
  buildShortTermContinuityPrompt
} = require('./continuity');
const { promptLayerCache } = require('./cache');
const { buildDynamicPrompt } = require('./dynamic');
const { mergeAllowedToolsWithMemoryCli, shouldExposeMemoryCli } = require('./memory-inputs');
const { formatResearchBriefsForPrompt } = require('./support');
const vision = require('./vision-runtime');

module.exports = {
  buildBaseDynamicPrompt,
  buildDirectedContextPromptSnippet,
  buildDynamicPrompt,
  buildRoleplayInnerProtocolPromptSnippet,
  buildRoleplayRuntimeContextPromptSnippet,
  buildShortTermContinuityPrompt,
  buildVisionLiteTextContent: vision.buildVisionLiteTextContent,
  buildVisionMessageContent: vision.buildVisionMessageContent,
  formatResearchBriefsForPrompt,
  mergeAllowedToolsWithMemoryCli,
  promptLayerCache,
  shouldBypassHumanizerForPolicy: vision.shouldBypassHumanizerForPolicy,
  shouldExposeMemoryCli
};
