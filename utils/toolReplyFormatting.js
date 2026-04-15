function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;]*m/g, '');
}

function resolveToolReplyFormattingPreferences(requestText = '') {
  const input = String(requestText || '').trim();
  const lower = input.toLowerCase();

  const preserveMarkdown = (
    /\bmarkdown\b/.test(lower)
    || /\bmd\b/.test(lower)
    || /markdown\s*output/i.test(input)
    || /md\s*format/i.test(input)
    || /用\s*markdown/i.test(input)
    || /markdown\s*格式/i.test(input)
  );
  const preserveCodeBlocks = (
    /code\s*block/i.test(input)
    || /fenced\s*code/i.test(input)
    || /triple\s*backticks?/i.test(input)
    || /代码块/.test(input)
    || /```/.test(input)
  );
  const preserveTables = (
    /\btable\b/i.test(input)
    || /\btabular\b/i.test(input)
    || /表格/.test(input)
  );
  const preferNumberedSteps = (
    /step[\s-]*by[\s-]*step/i.test(input)
    || /numbered\s+steps?/i.test(input)
    || /步骤/.test(input)
    || /分步骤/.test(input)
    || /按步骤/.test(input)
    || /编号/.test(input)
  );

  return {
    preserveMarkdown,
    preserveCodeBlocks,
    preserveTables,
    preserveStructuredOutput: preserveMarkdown || preserveCodeBlocks || preserveTables,
    preferNumberedSteps
  };
}

function buildToolReplyFormatInstruction(preferences = {}) {
  const resolved = {
    ...resolveToolReplyFormattingPreferences(''),
    ...(preferences && typeof preferences === 'object' ? preferences : {})
  };

  if (resolved.preserveStructuredOutput) {
    return 'The user explicitly requested Markdown, code blocks, or tables. Keep that structure if it directly helps the answer.';
  }

  return 'Final reply must be plain text only. No headings, fenced code blocks, tables, Markdown links, bold or italic emphasis, block quotes, or Markdown lists. If the user explicitly asked for steps, plain-text numbering is allowed.';
}

function replaceMarkdownLinks(text) {
  return String(text || '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const label = String(alt || '').trim();
      const target = String(url || '').trim();
      return label ? `${label} (${target})` : target;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const textLabel = String(label || '').trim();
      const target = String(url || '').trim();
      return textLabel ? `${textLabel} (${target})` : target;
    });
}

function unwrapFencedCodeBlocks(text) {
  return String(text || '')
    .replace(/^[ \t]*```[^\n]*\r?\n/gm, '')
    .replace(/^[ \t]*~~~[^\n]*\r?\n/gm, '')
    .replace(/^[ \t]*```[ \t]*$/gm, '')
    .replace(/^[ \t]*~~~[ \t]*$/gm, '');
}

function stripMarkdownEmphasis(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');
}

function isMarkdownTableSeparator(line = '') {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(String(line || ''));
}

function normalizeMarkdownTableRow(line = '') {
  const cells = String(line || '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.join(' - ').trim();
}

function normalizePlainTextLines(text, preferences = {}) {
  const lines = String(text || '').split(/\r?\n/);
  let stepIndex = 1;

  const normalized = lines.map((rawLine) => {
    let line = String(rawLine || '');
    if (!line.trim()) return '';

    line = line.replace(/^\s{0,3}#{1,6}\s+/, '');
    line = line.replace(/^\s*>\s?/, '');

    if (isMarkdownTableSeparator(line)) return '';
    if ((line.match(/\|/g) || []).length >= 2) {
      line = normalizeMarkdownTableRow(line);
    }

    const orderedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (orderedMatch) {
      const content = String(orderedMatch[1] || '').trim();
      if (!content) return '';
      if (preferences.preferNumberedSteps) {
        return `${stepIndex++}. ${content}`;
      }
      return content;
    }

    const unorderedMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      const content = String(unorderedMatch[1] || '').trim();
      if (!content) return '';
      if (preferences.preferNumberedSteps) {
        return `${stepIndex++}. ${content}`;
      }
      return content;
    }

    return line.trim();
  });

  return normalized.join('\n');
}

function collapseBlankLines(text) {
  return String(text || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanToolReplyText(text = '', options = {}) {
  const preferences = {
    ...resolveToolReplyFormattingPreferences(options?.requestText || ''),
    ...(options && typeof options === 'object' ? options : {})
  };

  let output = stripAnsi(String(text || '').replace(/\u200b/g, '')).trim();
  if (!output) return '';
  if (preferences.preserveStructuredOutput) return output;

  output = replaceMarkdownLinks(output);
  output = unwrapFencedCodeBlocks(output);
  output = normalizePlainTextLines(output, preferences);
  output = stripMarkdownEmphasis(output);
  output = collapseBlankLines(output);

  return output;
}

module.exports = {
  buildToolReplyFormatInstruction,
  cleanToolReplyText,
  resolveToolReplyFormattingPreferences
};
