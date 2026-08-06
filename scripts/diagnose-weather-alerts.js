const config = require('../config');
const { createQWeatherProvider } = require('../src/features/weather-alerts/provider');
const { normalizeApiHost } = require('../src/features/weather-alerts/runtime');
const { resolveLocation } = require('../src/features/weather-alerts/service');

async function main() {
  const queryIndex = process.argv.indexOf('--query');
  const query = String(queryIndex >= 0 ? process.argv[queryIndex + 1] : process.argv[2] || '北京市朝阳区').trim();
  const provider = createQWeatherProvider({
    apiHost: normalizeApiHost(config.QWEATHER_API_HOST),
    apiSecret: config.QWEATHER_API_SECRET || config.QWEATHER_API_KEY
  });
  const candidates = await provider.lookupLocations(query);
  const resolved = resolveLocation(candidates, query);
  if (resolved.status !== 'resolved') {
    throw new Error(`QWeather location lookup did not uniquely resolve ${query} (${resolved.status})`);
  }
  const selected = resolved.location;

  const warnings = await provider.getWarnings(selected);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    query,
    selectedLocation: {
      locationId: selected.locationId,
      displayName: selected.displayName,
      adm1: selected.adm1,
      adm2: selected.adm2,
      latitude: selected.latitude,
      longitude: selected.longitude
    },
    candidateCount: candidates.length,
    selectedLocationWarningCount: warnings.length,
    warningSamples: warnings.slice(0, 3).map((warning) => ({
      id: warning.id,
      typeName: warning.typeName,
      severityLabel: warning.severityLabel,
      status: warning.status,
      sender: warning.sender
    }))
  }, null, 2)}\n`);
}

function sanitizeProviderError(error) {
  const raw = typeof error?.response?.data === 'string'
    ? error.response.data
    : JSON.stringify(error?.response?.data || '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error || ''),
    httpStatus: Number(error?.response?.status || 0) || undefined,
    providerCode: String(error?.response?.data?.code || '').trim() || undefined,
    providerMessage: sanitizeProviderError(error) || undefined
  }));
  process.exit(1);
});
