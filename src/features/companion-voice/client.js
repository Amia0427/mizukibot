const axios = require('axios');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createCompanionVoiceClient(options = {}) {
  const apiUrl = normalizeText(options.apiUrl);
  const apiKey = normalizeText(options.apiKey);
  const model = normalizeText(options.model);
  const voice = normalizeText(options.voice);
  const speed = Number(options.speed || 1) || 1;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000) || 15000);
  const request = options.request || axios.post;

  async function synthesize(text) {
    const input = normalizeText(text);
    if (!apiUrl || !apiKey || !model || !voice) throw new Error('companion voice TTS is not configured');
    const response = await request(apiUrl, {
      model,
      voice,
      input,
      response_format: 'mp3',
      speed
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
      timeout: timeoutMs
    });
    return Buffer.from(response.data);
  }

  return { synthesize };
}

module.exports = {
  createCompanionVoiceClient
};
