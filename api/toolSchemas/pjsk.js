const pjskToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'pjsk_song_search',
      description: '查询、筛选、比较或语义推荐已发布的 PJSK 日服曲目与官方谱面数据，最多返回 10 条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '曲名、作者、演唱版本或谱面特征' },
          difficulty: { type: 'string', enum: ['easy', 'normal', 'hard', 'expert', 'master', 'append'] },
          level_min: { type: 'number', minimum: 1, maximum: 40 },
          level_max: { type: 'number', minimum: 1, maximum: 40 },
          limit: { type: 'integer', minimum: 1, maximum: 10 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pjsk_chart_analyze',
      description: '分析当前问题明确指定或可信一次性引用的单张 PJSK 谱面，返回结构特征、代表段和谱面图发送状态；不得补造曲名或 musicId。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          title: { type: 'string', description: '当前问题逐字出现的曲名；使用可信引用时省略' },
          difficulty: { type: 'string', enum: ['easy', 'normal', 'hard', 'expert', 'master', 'append'] }
        },
        required: ['query']
      }
    }
  }
];

module.exports = { pjskToolSchemas };
