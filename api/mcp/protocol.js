function encodeJsonRpcPayload(message = {}, protocolMode = 'line') {
  const body = JSON.stringify(message);
  if (protocolMode === 'frame') {
    const bodyBuffer = Buffer.from(body, 'utf8');
    const header = Buffer.from(`Content-Length: ${bodyBuffer.length}\r\n\r\n`, 'utf8');
    return Buffer.concat([header, bodyBuffer]);
  }
  return Buffer.from(`${body}\n`, 'utf8');
}

function trimLeadingMessageWhitespace(buffer = Buffer.alloc(0)) {
  let offset = 0;
  while (offset < buffer.length && [0x0a, 0x0d, 0x20, 0x09].includes(buffer[offset])) {
    offset += 1;
  }
  return offset > 0 ? buffer.slice(offset) : buffer;
}

function tryParseLineDelimitedMessage(buffer = Buffer.alloc(0)) {
  const normalized = trimLeadingMessageWhitespace(buffer);
  if (!normalized.length) return { rest: normalized, skip: true };

  const newlineIndex = normalized.indexOf(0x0a);
  if (newlineIndex < 0) return null;

  let lineBuffer = normalized.slice(0, newlineIndex);
  if (lineBuffer.length && lineBuffer[lineBuffer.length - 1] === 0x0d) {
    lineBuffer = lineBuffer.slice(0, -1);
  }
  const raw = lineBuffer.toString('utf8').trim();
  return {
    raw,
    rest: normalized.slice(newlineIndex + 1),
    skip: !raw
  };
}

function tryParseFramedMessage(buffer = Buffer.alloc(0)) {
  const normalized = trimLeadingMessageWhitespace(buffer);
  if (!normalized.length) return { rest: normalized, skip: true };

  const headerEndCrLf = normalized.indexOf(Buffer.from('\r\n\r\n'));
  const headerEndLf = normalized.indexOf(Buffer.from('\n\n'));
  let headerEnd = -1;
  let separatorLength = 0;

  if (headerEndCrLf >= 0 && (headerEndLf < 0 || headerEndCrLf <= headerEndLf)) {
    headerEnd = headerEndCrLf;
    separatorLength = 4;
  } else if (headerEndLf >= 0) {
    headerEnd = headerEndLf;
    separatorLength = 2;
  } else {
    return null;
  }

  const headerText = normalized.slice(0, headerEnd).toString('utf8');
  const contentLengthMatch = headerText.match(/content-length\s*:\s*(\d+)/i);
  if (!contentLengthMatch) {
    return {
      error: new Error('missing content-length header'),
      rest: Buffer.alloc(0)
    };
  }

  const contentLength = Number(contentLengthMatch[1]);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return {
      error: new Error('invalid content-length header'),
      rest: Buffer.alloc(0)
    };
  }

  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + contentLength;
  if (normalized.length < bodyEnd) return null;

  return {
    raw: normalized.slice(bodyStart, bodyEnd).toString('utf8').trim(),
    rest: normalized.slice(bodyEnd),
    skip: false
  };
}

module.exports = {
  encodeJsonRpcPayload,
  trimLeadingMessageWhitespace,
  tryParseFramedMessage,
  tryParseLineDelimitedMessage
};
