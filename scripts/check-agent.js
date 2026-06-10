// scripts/check-agent.js

function ok(msg) { console.log(`[OK] ${msg}`); }
function warn(msg) { console.log(`[WARN] ${msg}`); }
function fail(msg) { console.error(`[FAIL] ${msg}`); }

function looksLikeInvocationFailure(reply) {
  const text = String(reply || '').trim();
  if (!text) return true;
  return /^Model invocation failed:/i.test(text);
}

function collectExtraAgentPromptRoots() {
  const path = require('path');
  return String(process.env.AGENT_PROMPT_EXTRA_ROOTS || '')
    .split(path.delimiter)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

async function main() {
  console.log('================ LangGraph 自检开始 ================');

  let config;
  try {
    config = require('../config');
    ok('config/index.js 加载成功');
  } catch (e) {
    fail(`config/index.js 加载失败: ${e.message}`);
    return 1;
  }

  for (const d of ['@langchain/core', '@langchain/langgraph', '@langchain/openai', 'zod']) {
    try {
      require.resolve(d);
      ok(`依赖已安装: ${d}`);
    } catch (_) {
      fail(`缺少依赖: ${d}`);
      return 1;
    }
  }

  try {
    const path = require('path');
    const {
      loadAgentPromptsFromRoots
    } = require('../utils/agentPrompts');
    const projectRoot = path.join(__dirname, '..');
    const agentPrompts = loadAgentPromptsFromRoots([
      path.join(projectRoot, 'prompts'),
      path.join(projectRoot, 'skills'),
      path.join(projectRoot, 'artifacts'),
      ...collectExtraAgentPromptRoots()
    ], { rootDir: projectRoot });
    for (const parsed of agentPrompts) {
      if (!parsed.ok) {
        throw new Error(`${parsed.relativePath}: ${(parsed.problems || []).join('; ')}`);
      }
    }
    ok(`agent prompt assets parsed: ${agentPrompts.length}`);
  } catch (e) {
    fail(`agent prompt assets invalid: ${e.message}`);
    return 1;
  }

  let TOOL_SCHEMAS, TOOL_EXECUTORS;
  try {
    const reg = require('../api/toolRegistry');
    TOOL_SCHEMAS = reg.TOOL_SCHEMAS;
    TOOL_EXECUTORS = reg.TOOL_EXECUTORS;
    ok(`TOOL_SCHEMAS 数量: ${Array.isArray(TOOL_SCHEMAS) ? TOOL_SCHEMAS.length : 0}`);
    ok(`TOOL_EXECUTORS 数量: ${TOOL_EXECUTORS ? Object.keys(TOOL_EXECUTORS).length : 0}`);
    ok('TOOL_SCHEMAS 与 TOOL_EXECUTORS 映射正常');
  } catch (e) {
    fail(`toolRegistry 加载失败: ${e.message}`);
    return 1;
  }

  let askAIByGraph;
  try {
    askAIByGraph = require('../api/agentGraph').askAIByGraph;
    if (typeof askAIByGraph !== 'function') throw new Error('askAIByGraph 不是函数');
    ok('agentGraph 加载成功，askAIByGraph 可用');
  } catch (e) {
    fail(`agentGraph 加载失败: ${e.message}`);
    return 1;
  }

  ok(`API_BASE_URL: ${config.API_BASE_URL}`);
  ok(config.API_KEY ? 'API_KEY 已设置' : 'API_KEY 未设置');
  ok(`USE_LANGGRAPH: ${config.USE_LANGGRAPH}`);
  ok(`AI_MODEL: ${config.AI_MODEL}`);

  const shouldRun = String(process.env.CHECK_RUN || '1') !== '0';
  if (!shouldRun) {
    warn('已跳过实际调用（CHECK_RUN=0）');
    console.log('================ 自检完成（静态） ================');
    return 0;
  }

  console.log('\n---- 开始实际调用测试（可能会消耗一次模型请求） ----');
  try {
    const reply = await askAIByGraph(
      '你好，做个自检：请只回复“LangGraph链路正常”。',
      { level: '陌生人' },
      'self_test_user_001'
    );
    if (looksLikeInvocationFailure(reply)) {
      fail(`askAIByGraph 返回失败文本: ${String(reply).slice(0, 300)}`);
      return 1;
    }
    ok('askAIByGraph 调用成功');
    console.log(`模型返回: ${String(reply).slice(0, 300)}`);
    console.log('================ 自检完成（通过） ================');
    return 0;
  } catch (e) {
    fail(`实际调用失败: ${e.message}`);
    console.error('--- 错误详情 ---');
    console.error(e.stack || e);
    if (e.response?.data) {
      console.error('--- response.data ---');
      console.error(typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data, null, 2));
    }
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exit(code);
  }).catch((e) => {
    fail(`自检脚本异常: ${e.message}`);
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = {
  main
};
