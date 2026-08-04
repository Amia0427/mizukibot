const maimaiToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'maimai_chart_search',
      description: '查询舞萌曲目与谱面，支持定数、难度、标准/ DX 和手法筛选。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '曲名、谱面特征或手法关键词' },
          level_min: { type: 'number' },
          level_max: { type: 'number' },
          chart_type: { type: 'string', enum: ['SD', 'DX'] },
          difficulty: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'maimai_chart_analyze',
      description: '分析一张舞萌谱面的结构化特征，并返回最多三个代表原始谱面片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          title: { type: 'string' },
          chart_type: { type: 'string', enum: ['SD', 'DX'] },
          difficulty: { type: 'string' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'maimai_player_analysis',
      description: '基于当前 QQ 用户的成绩快照推断舞萌手法弱项，不接受 user_id。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          focus: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 }
        },
        required: ['query']
      }
    }
  }
];

module.exports = { maimaiToolSchemas };
