const { StringDecoder } = require('string_decoder');

function appendUtf8Chunk(decoder, chunk) {
  if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
  return String(chunk || '');
}

async function readUtf8StreamToString(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const done = (error = null) => {
      if (settled) return;
      settled = true;
      buffer += decoder.end();
      if (error) return reject(error);
      resolve(buffer);
    };

    stream.on('data', (chunk) => {
      buffer += appendUtf8Chunk(decoder, chunk);
    });
    stream.once('end', () => done());
    stream.once('close', () => done());
    stream.once('error', (error) => done(error));
  });
}

module.exports = {
  appendUtf8Chunk,
  readUtf8StreamToString
};
