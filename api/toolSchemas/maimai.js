const maimaiToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'maimai_chart_search',
      description: '查找、筛选、推荐或比较多张舞萌谱面，支持定数、难度、标准/DX 和手法条件。',
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
      description: '分析当前问题中明确写出的单张舞萌谱面，返回结构化特征和最多三个代表原始谱面片段；不得补造曲名。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          title: { type: 'string', description: '必须逐字来自当前用户问题的完整曲名' },
          chart_type: { type: 'string', enum: ['SD', 'DX'] },
          difficulty: { type: 'string' }
        },
        required: ['query', 'title']
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
