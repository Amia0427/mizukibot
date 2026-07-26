const axios = require('axios');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseCoordinatePair(text = '') {
  const match = normalizeText(text).match(/(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  if (Math.abs(first) > 90) return { longitude: first, latitude: second, source: 'user_coordinates' };
  return { longitude: second, latitude: first, source: 'user_coordinates' };
}

function parseAmapLocation(value = '') {
  const parts = normalizeText(value).split(',');
  if (parts.length !== 2) return null;
  const longitude = Number(parts[0]);
  const latitude = Number(parts[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { longitude, latitude };
}

function createLuckinLocationResolver(options = {}) {
  const apiKey = normalizeText(options.amapKey);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 8000) || 8000);
  const httpGet = typeof options.httpGet === 'function'
    ? options.httpGet
    : async (url, requestOptions) => axios.get(url, requestOptions);

  async function resolveLocation(input = '') {
    const query = normalizeText(input);
    if (!query) return { ok: false, reason: 'location_required' };
    const coordinates = parseCoordinatePair(query);
    if (coordinates) return { ok: true, ...coordinates, label: query };
    if (!apiKey) return { ok: false, reason: 'amap_key_missing' };

    const response = await httpGet('https://restapi.amap.com/v3/geocode/geo', {
      params: {
        key: apiKey,
        address: query,
        output: 'json'
      },
      timeout: timeoutMs
    });
    const geocode = response?.data?.geocodes?.[0];
    const location = parseAmapLocation(geocode?.location);
    if (!location) return { ok: false, reason: 'location_not_found' };
    return {
      ok: true,
      ...location,
      label: geocode.formatted_address || query,
      source: 'amap_geocode'
    };
  }

  return {
    resolveLocation
  };
}

module.exports = {
  createLuckinLocationResolver,
  parseCoordinatePair
};
