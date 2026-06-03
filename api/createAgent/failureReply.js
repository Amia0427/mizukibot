function buildUserFacingFailureReply(error = null, runtimeConfig = {}) {
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  const providerModelMatch = message.match(/unknown provider for model\s+([a-z0-9._-]+)/i);
  const providerModel = String(providerModelMatch?.[1] || runtimeConfig.model || '').trim();
  if (!message) return '生图那边刚刚没跑成。等一下再丢给我试试。';
  if (lower.includes('create_agent_api_base_url')) return '生图接口未配置';
  if (lower.includes('create_agent_api_key')) return '生图鉴权未配置';
  if (lower.includes('create_agent_model')) return '生图模型未配置';
  if (message.includes('系统网关次数不足') || message.includes('网关次数不足')) {
    return '生图供应商额度不足，请联系服务商';
  }
  if (lower.includes('error 524') || lower.includes('origin_response_timeout') || lower.includes('cloudflare') && lower.includes('524')) {
    return '生图那边等太久没回声。等一下再试，或者换个供应商。';
  }
  if (lower.includes('unknown provider for model')) {
    return `当前生图供应商不支持 ${providerModel || '该模型'}`;
  }
  if (lower.includes('chat completions endpoint returned html')) return '当前生图接口路径不兼容，供应商返回了网页页面';
  if (lower.includes('file not found') && lower.includes('resource is valid for 2 hours')) {
    return '生图临时资源已失效，请重试或更换提示词';
  }
  if (lower.includes('http_error') && lower.includes('400')) return '生图请求参数无效';
  if (lower.includes('http_error') && lower.includes('404')) return '当前生图接口不存在';
  if (lower.includes('http_error') && (lower.includes('401') || lower.includes('403'))) return '生图鉴权失败';
  if (lower.includes('http_error') && lower.includes('429')) return '生图那边被限流了。等一下再试哦。';
  if (lower.includes('http_error') && lower.includes('5')) return '生图供应商暂时异常';
  if (lower.includes('generation stream missing image data')) return '生图结果为空，当前接口返回格式不兼容';
  if (lower.includes('generation response missing image data')) return '生图结果为空，当前接口返回格式不兼容';
  if (lower.includes('image buffer invalid or truncated')) return '生图结果损坏，供应商返回了不完整图片';
  if (lower.includes('image buffer empty')) return '生图结果为空';
  if (lower.includes('napcat action send_group_msg')) return '图是有点想发出去的，但发送那下卡住了。等一下再试。';
  if (lower.includes('timeout') || lower.includes('timed out')) return '生图那边等太久没回声。等一下再试。';
  if (lower.includes('network_error')) return '生图那边网络有点飘。等一下再试。';
  return '生图那边刚刚没跑成。等一下再丢给我试试。';
}

module.exports = {
  buildUserFacingFailureReply
};
