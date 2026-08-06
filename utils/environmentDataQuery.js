function normalizeText(value = '') {
  return String(value || '').trim();
}

function extractWeatherLocation(text = '') {
  return normalizeText(text)
    .replace(/(?:帮我|麻烦)?(?:查一下|查查|查询|看看|看一下)/g, ' ')
    .replace(/(?:未来|最近|近)?\s*(?:\d+|[一二三四五六七八九十两])\s*(?:小时|天|日)/g, ' ')
    .replace(/(?:今天|今日|明天|后天|未来|最近|近来|当前|现在|最新|实况|预报|逐小时|小时预报|分钟降水|分钟级降水)/g, ' ')
    .replace(/(?:天气预警|天气警报|台风预警|警报|预警|空气质量|AQI|PM\s*2\.5|PM2\.5|雾霾)/gi, ' ')
    .replace(/(?:的)?(?:天气预报|天气|气温|温度|湿度|风力|风况|降雨|降水|下雨|会不会下雨|会下雨吗|下雨吗|怎么样|如何|情况)/g, ' ')
    .replace(/\b(?:weather|forecast|today|tomorrow|in)\b/gi, ' ')
    .replace(/[，。！？、,.!?]/g, ' ')
    .replace(/\s+(?:和|以及|还有)\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveWeatherToolArgs(text = '') {
  const normalized = normalizeText(text);
  const sections = new Set();
  if (/(逐小时|小时预报|未来\s*(?:\d+|[一二三四五六七八九十])\s*小时|hourly)/i.test(normalized)) sections.add('hourly');
  if (/(分钟降水|分钟级降水|未来\s*(?:两|2)\s*小时(?:降雨|下雨|降水)|minutely)/i.test(normalized)) sections.add('minutely');
  if (/(空气质量|AQI|PM\s*2\.5|PM2\.5|雾霾|air quality)/i.test(normalized)) sections.add('air');
  if (/(天气预警|天气警报|台风预警|警报|预警|warning|alert)/i.test(normalized)) sections.add('warning');
  const overviewText = normalized.replace(/天气预警|天气警报|台风预警|weather warning/gi, '');
  if (/(天气|气温|温度|湿度|风力|风况|天气预报|forecast|weather)/i.test(overviewText) && !sections.has('hourly')) sections.add('overview');
  if (sections.size === 0) sections.add('overview');

  const dayMatch = normalized.match(/(?:未来|近|最近)?\s*(\d+|[一二三四五六七八九十])\s*(?:天|日)/i);
  const hourMatch = normalized.match(/(?:未来|近|最近)?\s*(\d+|[一二三四五六七八九十两])\s*小时/i);
  const chineseNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const parseCount = (match, fallback) => {
    if (!match) return fallback;
    const value = Number(match[1]) || chineseNumbers[match[1]];
    return Number.isInteger(value) ? Math.max(1, Math.min(fallback === 24 ? 24 : 10, value)) : fallback;
  };

  return {
    location: extractWeatherLocation(text),
    sections: Array.from(['overview', 'hourly', 'minutely', 'air', 'warning'].filter((section) => sections.has(section))),
    days: parseCount(dayMatch, 4),
    hours: sections.has('hourly') ? parseCount(hourMatch, 24) : 24
  };
}

function isWeatherDataQuery(text = '') {
  const normalized = normalizeText(text);
  if (!normalized || isWeatherCloudQuery(normalized) || /地震|earthquake/i.test(normalized)) return false;
  if (/(订阅|取消订阅|暂停|恢复).{0,12}(天气)?预警|天气预警.{0,12}(订阅|取消|暂停|恢复)/i.test(normalized)) return false;
  if (/(如何形成|怎么形成|为什么|原理|成因|科普|是什么|什么是|how .*form|what is|why)/i.test(normalized)) return false;
  return /(天气|气温|温度|湿度|风力|风况|下雨|降雨|降水|逐小时|小时预报|分钟降水|空气质量|AQI|PM\s*2\.5|雾霾|天气预警|天气警报|台风预警|警报|预警|weather|forecast|hourly|minutely|air quality|warning|alert)/i.test(normalized);
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
  isWeatherDataQuery,
  isWeatherCloudQuery
};
