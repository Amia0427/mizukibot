const { composePersonaMemoryState, renderPersonaMemoryPrompt } = require('../utils/personaMemoryState');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2));
  return {
    json: flags.has('--json')
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const request = {
    userId: 'diagnose_persona_user',
    sessionKey: 'qq-group:g_diagnose:user:diagnose_persona_user',
    routeMeta: {
      groupId: 'g_diagnose'
    },
    routePolicyKey: 'direct_chat/default',
    topRouteType: 'direct_chat',
    question: '继续上次部署问题，顺便按群里的口吻说'
  };

  const shortTermMemory = {
    [request.sessionKey]: {
      summary: '在讨论 Linux 服务器部署与 systemd 配置。',
      activeTopic: 'Linux 部署',
      openLoops: ['补充 systemd 服务文件'],
      assistantCommitments: ['给出可执行命令'],
      userConstraints: ['先给结论'],
      carryOverUserTurn: '继续上次部署问题'
    }
  };

  const chatHistory = {
    [request.sessionKey]: [
      { role: 'user', content: '继续上次部署问题' },
      { role: 'assistant', content: '我先给你结论，再补命令。' }
    ]
  };

  const state = await composePersonaMemoryState(request, {
    surface: 'direct_chat',
    groupId: 'g_diagnose',
    shortTermMemory,
    chatHistory
  });
  const prompt = renderPersonaMemoryPrompt(state, 'direct_chat');

  if (args.json) {
    console.log(JSON.stringify({
      state,
      promptBlocks: prompt.promptBlocks.map((item) => ({
        label: item.label,
        text: item.text
      }))
    }, null, 2));
    return;
  }

  console.log('=== Persona Memory State Diagnose ===');
  console.log('[state]');
  console.log(JSON.stringify(state, null, 2));
  console.log('[prompt blocks]');
  for (const block of prompt.promptBlocks) {
    console.log(`--- ${block.label} ---`);
    console.log(block.text);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
