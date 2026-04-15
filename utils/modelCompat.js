function isToolSchemaValidationError(error) {
  const parts = [
    error?.message,
    error?.stack,
    error?.response?.data && JSON.stringify(error.response.data)
  ].filter(Boolean);

  const text = parts.join('\n');
  const status = Number(error?.response?.status);

  if (/input_schema|json schema is invalid|draft 2020-12|tool use/i.test(text)) {
    return true;
  }

  // Some OpenAI-compatible gateways return generic request-body 4xx for tool payloads.
  if (status === 400 || status === 415 || status === 422) {
    return /unsupported request body|unsupported.*(field|parameter)|unknown parameter|invalid request body|extra inputs not permitted/i.test(text);
  }

  return false;
}

module.exports = {
  isToolSchemaValidationError
};
