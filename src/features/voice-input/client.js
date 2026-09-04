const fs = require('fs');
const axios = require('axios');

function normalizeText(value) {
  return String(value || '').trim();
}

function createVoiceInputClient(options = {}) {
  const apiUrl = normalizeText(options.apiUrl);
  const apiKey = normalizeText(options.apiKey);
  const model = normalizeText(options.model);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60000) || 60000);
  const createReadStream = options.createReadStream || fs.createReadStream;
  const request = options.request || ((...args) => axios.postForm(...args));

  async function transcribe(filePath) {
    const audioFilePath = normalizeText(filePath);
    if (!apiUrl || !apiKey || !model) throw new Error('voice input ASR is not configured');
    if (!audioFilePath) throw new Error('voice input audio file is required');

    const response = await request(apiUrl, {
      model,
      file: createReadStream(audioFilePath),
      response_format: 'json'
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      timeout: timeoutMs,
      maxBodyLength: Infinity
    });
    const text = normalizeText(response?.data?.text);
    if (!text) throw new Error('voice input ASR returned empty text');
    return text;
  }

  return { transcribe };
}

module.exports = {
  createVoiceInputClient
};
