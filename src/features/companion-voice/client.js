const { createExternalTtsProvider } = require('./provider');

function createCompanionVoiceClient(options = {}) {
  const provider = createExternalTtsProvider(options);

  async function synthesize(text) {
    const generated = await provider.synthesize({ text, format: 'mp3' });
    return generated.buffer;
  }

  return { synthesize };
}

module.exports = {
  createCompanionVoiceClient
};
