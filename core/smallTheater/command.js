const COMMAND_PATTERN = /^\s*\/小剧场(?:\s|$)/u;
const NO_MEMORY_FLAG = '--无记忆';

function countCharacters(value = '') {
  return Array.from(String(value || '')).length;
}

function matchesSmallTheaterCommand(text = '') {
  return COMMAND_PATTERN.test(String(text || ''));
}

function parseSmallTheaterCommand(text = '', options = {}) {
  const source = String(text || '');
  if (!matchesSmallTheaterCommand(source)) return { matched: false };

  let remainder = source.replace(COMMAND_PATTERN, '').trim();
  let useMemory = true;
  if (new RegExp(`^${NO_MEMORY_FLAG}(?:\\s|$)`, 'u').test(remainder)) {
    useMemory = false;
    remainder = remainder.replace(new RegExp(`^${NO_MEMORY_FLAG}(?:\\s|$)`, 'u'), '').trim();
  }

  const material = remainder;
  const quotedText = String(options.quotedText || '').trim();
  if (!material && !quotedText) {
    return { matched: true, valid: false, reason: 'empty_input' };
  }

  const inputChars = countCharacters(material) + countCharacters(quotedText);
  const maxInputChars = Math.max(1, Number(options.maxInputChars) || 4000);
  if (inputChars > maxInputChars) {
    return {
      matched: true,
      valid: false,
      reason: 'input_too_long',
      inputChars,
      maxInputChars
    };
  }

  const combinedText = [material, quotedText].filter(Boolean).join('\n');
  return {
    matched: true,
    valid: true,
    useMemory,
    material,
    quotedText,
    promptText: combinedText,
    queryText: combinedText,
    inputChars
  };
}

module.exports = {
  matchesSmallTheaterCommand,
  parseSmallTheaterCommand
};
