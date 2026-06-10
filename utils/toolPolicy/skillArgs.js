function normalizeWeatherArgs(args = {}) {
  const next = {};
  const location = String(args.location ?? args.city ?? args.text ?? '').trim();
  if (!location) throw new Error('skill_weather requires location');
  if (location.length > 120) throw new Error('skill_weather location too long');
  if (/[\r\n<>`]/.test(location)) throw new Error('skill_weather location contains unsafe characters');
  next.location = location;
  return next;
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
  normalizeWeatherArgs,
  normalizeArxivList,
  normalizeArxivSearchArgs,
  normalizeArxivGetArgs,
  normalizeArxivLatestArgs
};
