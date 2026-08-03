// @ts-check
function normalizeWeatherArgs(args = {}) {
  const next = {};
  const location = String(args.location ?? args.city ?? args.text ?? '').trim();
  if (location.length > 120) throw new Error('skill_weather location too long');
  if (/[\r\n<>`]/.test(location)) throw new Error('skill_weather location contains unsafe characters');
  next.location = location;
  return next;
}

function normalizeEarthquakeArgs(args = {}) {
  const scope = String(args.scope || 'global').trim().toLowerCase();
  if (!new Set(['global', 'china']).has(scope)) throw new Error('skill_earthquake_latest scope must be global or china');
  const timeWindow = String(args.time_window || 'day').trim().toLowerCase();
  if (!new Set(['hour', 'day', 'week', 'month']).has(timeWindow)) {
    throw new Error('skill_earthquake_latest time_window must be hour, day, week, or month');
  }

  const defaultMagnitude = scope === 'china' ? 2.5 : 4.5;
  const minMagnitude = args.min_magnitude === undefined ? defaultMagnitude : Number(args.min_magnitude);
  if (!Number.isFinite(minMagnitude) || minMagnitude < 0 || minMagnitude > 10) {
    throw new Error('skill_earthquake_latest min_magnitude must be between 0 and 10');
  }
  const limit = args.limit === undefined ? 5 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('skill_earthquake_latest limit must be an integer between 1 and 10');
  }

  return {
    scope,
    time_window: timeWindow,
    min_magnitude: minMagnitude,
    limit
  };
}

function normalizeWeatherCloudArgs(args = {}) {
  const channel = String(args.channel || 'infrared').trim().toLowerCase();
  if (!new Set(['infrared', 'visible', 'water_vapor']).has(channel)) {
    throw new Error('skill_weather_cloud channel must be infrared, visible, or water_vapor');
  }
  const area = String(args.area || 'china').trim().toLowerCase();
  if (!new Set(['china', 'full_disk']).has(area)) {
    throw new Error('skill_weather_cloud area must be china or full_disk');
  }
  return { channel, area };
}

function normalizeArxivList(raw) {
  const values = Array.isArray(raw) ? raw : [];
  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => {
      if (/[\r\n\u0000-\u001f]/.test(item)) {
        throw new Error('arxiv list contains unsafe characters');
      }
      return item.slice(0, 50);
    })
    .slice(0, 10);
}

function normalizeArxivSearchArgs(args = {}) {
  const next = {};
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('skill_arxiv_search requires query');
  if (query.length > 300) throw new Error('skill_arxiv_search query too long');
  if (/[\r\n\u0000-\u001f]/.test(query)) throw new Error('skill_arxiv_search query contains unsafe characters');
  next.query = query;
  next.max_results = Math.max(1, Math.min(10, Number(args.max_results) || 5));
  next.categories = normalizeArxivList(args.categories ?? []);
  next.tags = normalizeArxivList(args.tags ?? []);
  return next;
}

function normalizeArxivGetArgs(args = {}) {
  const next = {};
  const arxivId = String(args.arxiv_id ?? args.id ?? '').trim();
  if (!arxivId) throw new Error('skill_arxiv_get requires arxiv_id');
  if (arxivId.length > 80) throw new Error('skill_arxiv_get arxiv_id too long');
  if (/[\r\n\u0000-\u001f]/.test(arxivId)) throw new Error('skill_arxiv_get arxiv_id contains unsafe characters');
  next.arxiv_id = arxivId;
  next.include_abstract = Boolean(args.include_abstract ?? true);
  return next;
}

function normalizeArxivLatestArgs(args = {}) {
  return {
    categories: normalizeArxivList(args.categories ?? []),
    tags: normalizeArxivList(args.tags ?? []),
    max_results: Math.max(1, Math.min(10, Number(args.max_results) || 5))
  };
}

module.exports = {
  normalizeEarthquakeArgs,
  normalizeWeatherArgs,
  normalizeWeatherCloudArgs,
  normalizeArxivList,
  normalizeArxivSearchArgs,
  normalizeArxivGetArgs,
  normalizeArxivLatestArgs
};
