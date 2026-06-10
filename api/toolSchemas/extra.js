// Static tool schemas split from api/toolSchemas.js.
const extraToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '鑾峰彇褰撳墠鏃堕棿',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'translate_text',
      description: '缈昏瘧鏂囨湰',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          to: { type: 'string' },
          from: { type: 'string' }
        },
        required: ['text', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_rss_feed',
      description: '璇诲彇 RSS/Atom',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_uuid',
      description: '鐢熸垚 UUID',
      parameters: {
        type: 'object',
        properties: {
          version: { type: 'string', description: '鐩墠鏀寔 v4' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hash_text',
      description: '璁＄畻鏂囨湰鍝堝笇',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          algorithm: { type: 'string', description: 'md5|sha1|sha256|sha512' },
          encoding: { type: 'string', description: 'hex|base64' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract_urls',
      description: '浠庢枃鏈彁鍙?URL',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          unique: { type: 'boolean' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'json_query',
      description: 'Query value by JSON path',
      parameters: {
        type: 'object',
        properties: {
          json_text: { type: 'string' },
          path: { type: 'string', description: '濡?a.b[0].c' }
        },
        required: ['json_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'render_template',
      description: 'Render string template',
      parameters: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Supports placeholders like {{name}}' },
          variables: { type: 'object' }
        },
        required: ['template']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jwt_decode',
      description: 'Decode JWT without signature verification',
      parameters: {
        type: 'object',
        properties: {
          token: { type: 'string' }
        },
        required: ['token']
      }
    }
  }
];

module.exports = { extraToolSchemas };
