// api/toolAdapter.js
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const { getToolExecutors, getToolSchemas } = require('./toolRegistry');
const { enforceToolPolicy } = require('../utils/toolPolicy');

/**
 * 鎶婄幇鏈?OpenAI 椋庢牸 tool schema 杞垚 LangChain tools
 * 涓轰簡鍏煎浣犵幇鏈夊伐鍏峰弬鏁帮紝鍏堢敤 passthrough 瀹芥澗鏍￠獙
 */
function buildLangChainTools() {
  return (getToolSchemas() || []).map((schema) => {
    const name = schema?.function?.name;
    const description = schema?.function?.description || '';

    return tool(
      async (input) => {
        const executor = getToolExecutors()[name];
        if (!executor) return `鏈煡宸ュ叿锛?{name}`;

        try {
          const normalizedArgs = enforceToolPolicy(name, input || {}, {});
          const out = await executor(normalizedArgs);
          return typeof out === 'string' ? out : JSON.stringify(out);
        } catch (e) {
          return `宸ュ叿鎶ラ敊锛?{e.message}`;
        }
      },
      {
        name,
        description,
        schema: z.object({}).passthrough()
      }
    );
  });
}

module.exports = { buildLangChainTools };
