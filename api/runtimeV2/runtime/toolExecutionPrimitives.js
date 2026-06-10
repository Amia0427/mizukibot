function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isToolFailureText(resultText = '') {
  const text = String(resultText || '').trim();
  if (!text) return true;
  return /^Tool error:/i.test(text)
    || /^Unknown tool:/i.test(text)
    || /^Tool not allowed:/i.test(text)
    || /^页面提取失败[:：]/i.test(text)
    || /^MCP tool failed:/i.test(text)
    || /^request was blocked/i.test(text)
    || /^invalid api key$/i.test(text)
    || /刚刚翻记忆没翻稳|记忆那边刚刚绕住了|翻完以后那句空掉了|刚刚那句被卡掉了|配置像是没扣好|额度好像见底/i.test(text);
}

function isMemorySearchCommand(commandText = '') {
  return /^mem search\b/i.test(normalizeText(commandText));
}

function isUnresolvedMemoryOpenCommand(commandText = '') {
  const text = normalizeText(commandText);
  if (!/^mem open --ref\s+/i.test(text)) return false;
  return /^mem open --ref\s+\"mc_ref:planner_pending:/i.test(text)
    || /^mem open --ref\s+\"<[^"]+>\"/i.test(text);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildToolCallFingerprint(toolName = '', args = {}) {
  return `${normalizeText(toolName)}:${stableStringify(normalizeObject(args, {}))}`;
}

function describeExpectedType(schema = {}) {
  if (Array.isArray(schema?.type)) return schema.type.join('|');
  return String(schema?.type || '').trim();
}

function isMissingRequiredValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function matchesSchemaType(value, expectedType = '') {
  const type = String(expectedType || '').trim();
  if (!type) return true;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

function validateToolCallArgs(toolName = '', args = {}, schema = null) {
  const normalizedArgs = normalizeObject(args, {});
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      normalizedArgs,
      error: { type: 'invalid_arguments', toolName, message: 'Tool arguments must be a JSON object.' }
    };
  }
  const parameters = schema?.function?.parameters || schema?.parameters || null;
  if (!parameters || typeof parameters !== 'object') {
    return { ok: true, normalizedArgs, error: null };
  }
  const required = normalizeArray(parameters.required).map((item) => String(item || '').trim()).filter(Boolean);
  const missing = required.filter((name) => isMissingRequiredValue(normalizedArgs[name]));
  if (missing.length > 0) {
    return {
      ok: false,
      normalizedArgs,
      error: {
        type: 'missing_required',
        toolName,
        missing,
        message: `Missing required argument(s): ${missing.join(', ')}`
      }
    };
  }
  const properties = normalizeObject(parameters.properties, {});
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (normalizedArgs[name] === undefined || normalizedArgs[name] === null) continue;
    const expectedType = describeExpectedType(propertySchema);
    if (!matchesSchemaType(normalizedArgs[name], expectedType)) {
      return {
        ok: false,
        normalizedArgs,
        error: {
          type: 'type_mismatch',
          toolName,
          field: name,
          expectedType,
          actualType: Array.isArray(normalizedArgs[name]) ? 'array' : typeof normalizedArgs[name],
          message: `Argument "${name}" must be ${expectedType}.`
        }
      };
    }
  }
  return { ok: true, normalizedArgs, error: null };
}

function buildToolRepairMessage(error = {}) {
  const toolName = normalizeText(error.toolName) || 'unknown';
  const detail = normalizeText(error.message) || 'Invalid tool arguments.';
  return `Tool argument error for ${toolName}: ${detail} Please retry the same tool call with valid JSON arguments that match the tool schema, or answer without tools if the tool is not needed.`;
}

function summarizeToolResultForLoop(result = '', maxChars = 4000) {
  const text = String(result || '');
  const limit = Math.max(500, Number(maxChars || 0) || 4000);
  if (text.length <= limit) return text;
  const headSize = Math.floor(limit * 0.7);
  const tailSize = Math.max(200, limit - headSize - 120);
  return `${text.slice(0, headSize)}\n... [tool result truncated: ${text.length - limit} chars omitted] ...\n${text.slice(-tailSize)}`;
}

module.exports = {
  normalizeObject,
  normalizeArray,
  normalizeText,
  isToolFailureText,
  isMemorySearchCommand,
  isUnresolvedMemoryOpenCommand,
  stableStringify,
  buildToolCallFingerprint,
  describeExpectedType,
  isMissingRequiredValue,
  matchesSchemaType,
  validateToolCallArgs,
  buildToolRepairMessage,
  summarizeToolResultForLoop
};
