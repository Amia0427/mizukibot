const axios = require('axios');
const config = require('../../config');
const { extractWeatherLocation } = require('../../utils/environmentDataQuery');
const { normalizeWeatherArgs } = require('../../utils/toolPolicy/skillArgs');

const AMAP_GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/geo';
const AMAP_WEATHER_URL = 'https://restapi.amap.com/v3/weather/weatherInfo';
const AMAP_SOURCE_URL = 'https://lbs.amap.com/api/webservice/guide/api/weatherinfo';

function assertAmapResponse(data, operation) {
  if (String(data?.status) === '1') return;
  const reason = String(data?.info || data?.infocode || 'unknown error').trim();
  throw new Error(`AMap ${operation} failed: ${reason}`);
}

function formatForecast(cast = {}) {
  const dayWeather = String(cast.dayweather || '').trim();
  const nightWeather = String(cast.nightweather || '').trim();
  const weather = dayWeather === nightWeather || !nightWeather
    ? dayWeather
    : `${dayWeather}转${nightWeather}`;
  const dayWind = String(cast.daywind || '').trim();
  const nightWind = String(cast.nightwind || '').trim();
  const wind = dayWind === nightWind || !nightWind ? dayWind : `${dayWind}转${nightWind}`;
  const windText = wind ? `，${wind}风 ${cast.daypower || cast.nightpower || '-'}级` : '';
  return `${cast.date || '未知日期'}：${weather || '未知'}，${cast.nighttemp || '-'}~${cast.daytemp || '-'}℃${windText}`;
}

async function getWeatherSummary(rawArgs = {}, deps = {}) {
  const args = normalizeWeatherArgs(rawArgs);
  const location = extractWeatherLocation(args.location);
  if (!location) return '请提供要查询的城市，例如“上海今天天气”。';

  const apiKey = deps.apiKey ?? config.AMAP_KEY;
  if (!apiKey) throw new Error('AMAP_KEY is not configured');

  const httpClient = deps.httpClient || axios;
  const requestOptions = {
    timeout: 10000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  };
  const geocodeResponse = await httpClient.get(AMAP_GEOCODE_URL, {
    ...requestOptions,
    params: { address: location, key: apiKey }
  });
  assertAmapResponse(geocodeResponse?.data, 'geocoding');

  const geocode = geocodeResponse.data?.geocodes?.[0];
  if (!geocode?.adcode) return `高德地图未找到“${location}”，请换用更完整的城市或区县名称。`;

  const weatherParams = { city: geocode.adcode, key: apiKey };
  const [liveResponse, forecastResponse] = await Promise.all([
    httpClient.get(AMAP_WEATHER_URL, {
      ...requestOptions,
      params: { ...weatherParams, extensions: 'base' }
    }),
    httpClient.get(AMAP_WEATHER_URL, {
      ...requestOptions,
      params: { ...weatherParams, extensions: 'all' }
    })
  ]);
  assertAmapResponse(liveResponse?.data, 'live weather query');
  assertAmapResponse(forecastResponse?.data, 'forecast query');

  const live = liveResponse.data?.lives?.[0];
  const forecast = forecastResponse.data?.forecasts?.[0];
  if (!live || !forecast || !Array.isArray(forecast.casts)) {
    throw new Error('AMap weather response is invalid');
  }

  const city = String(live.city || forecast.city || geocode.formatted_address || location).trim();
  const province = String(live.province || forecast.province || '').trim();
  const heading = province && !city.startsWith(province) ? `${province} ${city}` : city;
  const forecasts = forecast.casts.slice(0, 4).map(formatForecast);
  return [
    `高德天气｜${heading}`,
    `实况：${live.weather || '未知'}，${live.temperature || '-'}℃，湿度 ${live.humidity || '-'}%`,
    `风况：${live.winddirection || '未知'}风 ${live.windpower || '-'}级`,
    `更新时间：${live.reporttime || forecast.reporttime || '未知'}`,
    forecasts.length > 0 ? `近4日预报：\n${forecasts.join('\n')}` : '近4日预报：暂无数据',
    `来源：高德开放平台 ${AMAP_SOURCE_URL}`
  ].join('\n');
}

module.exports = {
  AMAP_GEOCODE_URL,
  AMAP_SOURCE_URL,
  AMAP_WEATHER_URL,
  getWeatherSummary
};
