// Static tool schemas split from api/toolSchemas.js.
const baseToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'getLyrics',
      description: '鏌ヨ姝屾洸姝岃瘝',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getWeather',
      description: '鏌ヨ鍩庡競澶╂皵',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '鍩庡競鍚嶆垨澶╂皵璇锋眰鏂囨湰' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_nearby_places',
      description: 'Search nearby places in a city',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string' },
          city: { type: 'string' }
        },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_academic_paper',
      description: 'Search academic papers',
      parameters: {
        type: 'object',
        properties: { keywords: { type: 'string' } },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_arcaea_info',
      description: '鏌ヨ Arcaea 鏇茬洰淇℃伅',
      parameters: {
        type: 'object',
        properties: { song_name: { type: 'string' } },
        required: ['song_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_bilibili_hot',
      description: 'Get Bilibili trending topics',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '缃戦〉鎼滅储',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract readable webpage content from a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Webpage URL to fetch and extract' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'currency_convert',
      description: '姹囩巼鎹㈢畻',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          amount: { type: 'number' }
        },
        required: ['from', 'to']
      }
    }
  }
];

module.exports = { baseToolSchemas };
