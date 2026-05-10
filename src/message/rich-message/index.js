function pushTextSegment(segments, text) {
  const value = String(text || '');
  if (!value) return;

  const last = segments[segments.length - 1];
  if (last && last.type === 'text' && last.data && typeof last.data.text === 'string') {
    last.data.text += value;
    return;
  }

  segments.push({ type: 'text', data: { text: value } });
}

function isSupportedQqImageSource(value) {
  const input = String(value || '').trim();
  if (!input) return false;

  return (
    /^https?:\/\/\S+$/i.test(input) ||
    /^file:\/\/\S+$/i.test(input) ||
    /^[a-zA-Z]:[\\/]/.test(input) ||
    /^base64:\/\/\S+$/i.test(input)
  );
}

function parseQqRichMessage(text) {
  const input = String(text || '');
  const tokenRe = /\[\[(qq_face|qq_image):([\s\S]*?)\]\]/gi;
  const segments = [];
  let hasRichSegment = false;
  let lastIndex = 0;
  let match = tokenRe.exec(input);

  while (match) {
    if (match.index > lastIndex) {
      pushTextSegment(segments, input.slice(lastIndex, match.index));
    }

    const kind = String(match[1] || '').toLowerCase();
    const rawValue = String(match[2] || '').trim();
    const originalToken = match[0];

    if (kind === 'qq_face' && /^\d+$/.test(rawValue)) {
      segments.push({ type: 'face', data: { id: rawValue } });
      hasRichSegment = true;
    } else if (kind === 'qq_image' && isSupportedQqImageSource(rawValue)) {
      segments.push({ type: 'image', data: { file: rawValue } });
      hasRichSegment = true;
    } else {
      pushTextSegment(segments, originalToken);
    }

    lastIndex = match.index + originalToken.length;
    match = tokenRe.exec(input);
  }

  if (lastIndex < input.length) {
    pushTextSegment(segments, input.slice(lastIndex));
  }

  return {
    hasRichSegment,
    segments
  };
}

function buildQqRichMessagePayload(text, { atSender = true, senderId } = {}) {
  const parsed = parseQqRichMessage(text);
  if (!parsed.hasRichSegment) return null;

  const message = [];
  if (atSender && senderId) {
    message.push({ type: 'at', data: { qq: String(senderId) } });
    message.push({ type: 'text', data: { text: ' ' } });
  }

  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      pushTextSegment(message, segment.data.text);
      continue;
    }
    message.push(segment);
  }

  return message.length ? message : null;
}

function shouldPreferQqRichReply(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;

  return /(琛ㄦ儏鍖厊鍙戣〃鎯厊鍙戜釜琛ㄦ儏|emoji|sticker|璐寸焊|鍔ㄥ浘|gif)/i.test(t);
}

module.exports = {
  buildQqRichMessagePayload,
  isSupportedQqImageSource,
  parseQqRichMessage,
  pushTextSegment,
  shouldPreferQqRichReply
};
