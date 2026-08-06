const axios = require('axios');
const config = require('../../config');

const DEFAULT_TIMEOUT_MS = 10000;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeApiHost(value = '') {
  const host = normalizeText(value);
  if (!host) return '';
  const withScheme = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return withScheme.replace(/\/+$/, '');
}

function getResponseCode(data) {
  return normalizeText(data?.code);
}

function assertQWeatherResponse(data, operation) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`QWeather ${operation} returned an invalid response`);
  }
  const code = getResponseCode(data);
  if (code && code !== '200') {
    throw new Error(`QWeather ${operation} failed (${code})`);
  }
  return data;
}

function getHttpStatus(error) {
  const status = Number(error?.response?.status);
  return Number.isInteger(status) && status > 0 ? status : 0;
}

function toProviderError(error, operation) {
  const status = getHttpStatus(error);
  const suffix = status ? ` (HTTP ${status})` : '';
  return new Error(`QWeather ${operation} unavailable${suffix}`);
}

function createQWeatherClient(options = {}) {
  const apiHost = normalizeApiHost(options.apiHost ?? config.QWEATHER_API_HOST);
  const apiSecret = normalizeText(options.apiSecret ?? options.apiKey ?? config.QWEATHER_API_SECRET ?? config.QWEATHER_API_KEY);
  const httpClient = options.httpClient || axios;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);

  async function request(pathname, params = {}, operation = 'request') {
    if (!apiHost || !apiSecret) {
      throw new Error('QWEATHER_API_HOST and QWEATHER_API_SECRET are required');
    }

    let response;
    try {
      response = await httpClient.get(`${apiHost}${pathname}`, {
        params,
        timeout: timeoutMs,
        proxy: false,
        headers: { 'X-QW-Api-Key': apiSecret }
      });
    } catch (error) {
      throw toProviderError(error, operation);
    }

    return assertQWeatherResponse(response?.data, operation);
  }

  function locationParams(location) {
    return { location, lang: 'zh' };
  }

  return {
    request,
    lookupLocations: (location) => request('/geo/v2/city/lookup', { ...locationParams(location), number: 1 }, 'location lookup'),
    getCurrent: (latitude, longitude) => request(`/weather/v1/current/${latitude}/${longitude}`, { lang: 'zh', unit: 'm' }, 'current weather'),
    getDaily: (latitude, longitude, days) => request(`/weather/v1/daily/${latitude}/${longitude}`, { lang: 'zh', unit: 'm', days }, 'daily forecast'),
    getHourly: (latitude, longitude, hours) => request(`/weather/v1/hourly/${latitude}/${longitude}`, { lang: 'zh', unit: 'm', hours }, 'hourly forecast'),
    getMinutely: (latitude, longitude) => request('/v7/minutely/5m', { location: `${longitude},${latitude}`, lang: 'zh', unit: 'm' }, 'minutely precipitation'),
    getAir: (latitude, longitude) => request(`/airquality/v1/current/${latitude}/${longitude}`, { lang: 'zh' }, 'air quality'),
    getWarning: (latitude, longitude) => request(`/weatheralert/v1/current/${latitude}/${longitude}`, { lang: 'zh' }, 'weather warning')
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  assertQWeatherResponse,
  createQWeatherClient,
  normalizeApiHost
};
