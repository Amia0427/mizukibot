function normalizeText(value = '') {
  return String(value || '').trim();
}

function extractWeatherLocation(text = '') {
  return normalizeText(text)
    .replace(/(?:帮我|麻烦)?(?:查一下|查查|查询|看看|看一下)/g, ' ')
    .replace(/(?:今天|今日|明天|后天|未来(?:四|4)天|近(?:四|4)天|最近(?:四|4)天)/g, ' ')
    .replace(/(?:的)?(?:天气预报|天气|气温|温度|湿度|风力|风况|会不会下雨|会下雨吗|下雨吗|怎么样|如何|情况)/g, ' ')
    .replace(/\b(?:weather|forecast|today|tomorrow|in)\b/gi, ' ')
    .replace(/[，。！？、,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveWeatherToolArgs(text = '') {
  return { location: extractWeatherLocation(text) };
}

function isWeatherCloudQuery(text = '') {
  return /(卫星云图|气象云图|红外云图|水汽云图|可见光云图|云图|weather satellite|satellite (?:image|cloud))/i.test(normalizeText(text));
}

function isEarthquakeDataQuery(text = '') {
  const normalized = normalizeText(text);
  if (!/(地震|震中|震级|earthquakes?|seismic events?)/i.test(normalized)) return false;
  if (/(如何形成|怎么形成|为什么|原理|成因|科普|是什么|能否预测|传播机制|how .*form|what is|why)/i.test(normalized)) return false;
  return /(最新|最近|近来|刚刚|刚才|今天|本周|查询|查一下|查查|列表|数据|情况|消息|latest|recent|today|list|data)/i.test(normalized)
    || /(?:有没有|是否|是不是).{0,8}(?:地震|震中)|(?:地震|震中).{0,8}(?:有没有|是否|是不是)/i.test(normalized)
    || /(?:哪里|哪儿|何处).{0,8}(?:地震|震中)|(?:地震|震中).{0,8}(?:哪里|哪儿|何处)/i.test(normalized);
}

function deriveEarthquakeToolArgs(text = '') {
  const normalized = normalizeText(text);
  const scope = /(中国|国内|我国|境内|china)/i.test(normalized) ? 'china' : 'global';
  const timeWindow = /(?:近|最近)?(?:一|1)个?小时|hour/i.test(normalized)
    ? 'hour'
    : /一周|七天|7\s*天|本周|week/i.test(normalized)
      ? 'week'
      : /一个月|一月|30\s*天|month/i.test(normalized)
        ? 'month'
        : 'day';
  const magnitudeMatch = normalized.match(/(?:\bM\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*级(?:以上|\+)?)/i);
  const limitMatch = normalized.match(/(\d+)\s*(?:条|个|次)/);
  const explicitMagnitude = Number(magnitudeMatch?.[1] || magnitudeMatch?.[2]);
  const explicitLimit = Number(limitMatch?.[1]);

  return {
    scope,
    time_window: timeWindow,
    min_magnitude: Number.isFinite(explicitMagnitude) ? explicitMagnitude : (scope === 'china' ? 2.5 : 4.5),
    limit: Number.isInteger(explicitLimit) ? Math.max(1, Math.min(10, explicitLimit)) : 5
  };
}

function deriveWeatherCloudToolArgs(text = '') {
  const normalized = normalizeText(text);
  const area = /(全圆盘|亚太|full\s*disk)/i.test(normalized) ? 'full_disk' : 'china';
  if (/(水汽|water\s*vapou?r)/i.test(normalized)) return { channel: 'water_vapor', area };
  if (/(可见光|真彩|visible|true\s*colou?r)/i.test(normalized)) return { channel: 'visible', area };
  return { channel: 'infrared', area };
}

module.exports = {
  deriveEarthquakeToolArgs,
  deriveWeatherToolArgs,
  deriveWeatherCloudToolArgs,
  extractWeatherLocation,
  isEarthquakeDataQuery,
  isWeatherCloudQuery
};
