const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../../config');

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const ARXIV_HTML_SEARCH_URL = 'https://arxiv.org/search/';

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function buildSearchQuery(query = '', categories = [], tags = []) {
  const parts = [];
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery) parts.push(`all:${normalizedQuery}`);
  for (const category of normalizeArray(categories).map((item) => normalizeText(item)).filter(Boolean)) {
    parts.push(`cat:${category}`);
  }
  for (const tag of normalizeArray(tags).map((item) => normalizeText(item)).filter(Boolean)) {
    parts.push(`all:${tag}`);
  }
  return parts.filter(Boolean).join(' AND ');
}

function parseEntry(entry = {}) {
  const authors = normalizeArray(entry.author).map((item) => normalizeText(item?.name || item)).filter(Boolean);
  const categories = normalizeArray(entry.category).map((item) => normalizeText(item?.term || item?.['@_term'] || item)).filter(Boolean);
  return {
    id: normalizeText(entry.id).replace(/^https?:\/\/arxiv\.org\/abs\//i, ''),
    title: normalizeText(entry.title).replace(/\s+/g, ' '),
    summary: normalizeText(entry.summary).replace(/\s+/g, ' '),
    published: normalizeText(entry.published),
    updated: normalizeText(entry.updated),
    link: normalizeText(entry.id),
    pdf: normalizeArray(entry.link).map((item) => item?.['@_href']).find((href) => /\/pdf\//i.test(String(href || ''))) || '',
    authors,
    categories
  };
}

async function queryArxiv(params = {}) {
  const response = await axios.get(ARXIV_API_URL, {
    params,
    timeout: 20000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  const xml = String(response.data || '');
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries = $('entry').toArray().map((node) => {
    const element = $(node);
    const authors = element.find('author > name').toArray().map((item) => normalizeText($(item).text())).filter(Boolean);
    const categories = element.find('category').toArray().map((item) => normalizeText($(item).attr('term'))).filter(Boolean);
    const links = element.find('link').toArray().map((item) => ({
      href: normalizeText($(item).attr('href')),
      title: normalizeText($(item).attr('title')),
      rel: normalizeText($(item).attr('rel'))
    }));
    return {
      id: normalizeText(element.find('id').first().text()).replace(/^https?:\/\/arxiv\.org\/abs\//i, ''),
      title: normalizeText(element.find('title').first().text()).replace(/\s+/g, ' '),
      summary: normalizeText(element.find('summary').first().text()).replace(/\s+/g, ' '),
      published: normalizeText(element.find('published').first().text()),
      updated: normalizeText(element.find('updated').first().text()),
      link: normalizeText(element.find('id').first().text()),
      pdf: links.find((item) => /\/pdf\//i.test(item.href) || item.title.toLowerCase() === 'pdf')?.href || '',
      authors,
      categories
    };
  });
  const totalResults = Number($('opensearch\\:totalResults').first().text() || $('totalResults').first().text() || entries.length || 0);
  return {
    totalResults,
    entries
  };
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryArxivWithRetry(params = {}, options = {}) {
  const retries = Math.max(1, Number(options.retries || 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 800));
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await queryArxiv(params);
    } catch (error) {
      lastError = error;
      if (attempt >= retries - 1) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function buildFallbackSearchQueries(query = '', categories = [], tags = []) {
  const normalizedQuery = normalizeText(query);
  const normalizedCategories = normalizeArray(categories).map((item) => normalizeText(item)).filter(Boolean);
  const normalizedTags = normalizeArray(tags).map((item) => normalizeText(item)).filter(Boolean);
  const list = [];

  const primary = buildSearchQuery(normalizedQuery, normalizedCategories, normalizedTags);
  if (primary) list.push(primary);

  if (normalizedQuery) {
    list.push(`all:${normalizedQuery}`);
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
      list.push(tokens.map((token) => `all:${token}`).join(' AND '));
      list.push(`ti:${normalizedQuery}`);
      list.push(`abs:${normalizedQuery}`);
    }
  }

  if (normalizedCategories.length > 0 && !list.some((item) => item.includes('cat:'))) {
    list.push(normalizedCategories.map((item) => `cat:${item}`).join(' AND '));
  }

  return [...new Set(list.filter(Boolean))];
}

async function searchArxivHtml({ query = '', max_results = 5 } = {}) {
  const response = await axios.get(ARXIV_HTML_SEARCH_URL, {
    params: {
      query: normalizeText(query),
      searchtype: 'all',
      source: 'header'
    },
    timeout: 15000,
    proxy: false,
    headers: {
      'User-Agent': config.HTTP_USER_AGENT
    }
  });

  const html = String(response.data || '');
  const $ = cheerio.load(html);
  const entries = $('li.arxiv-result').toArray().map((node) => {
    const element = $(node);
    return {
      id: normalizeText(element.find('p.list-title a').first().text()).replace(/^arXiv:/i, ''),
      title: normalizeText(element.find('p.title').first().text()).replace(/\s+/g, ' '),
      summary: normalizeText(element.find('span.abstract-full').first().text()).replace(/\s+/g, ' '),
      published: '',
      updated: '',
      link: normalizeText(element.find('p.list-title a').first().attr('href')),
      pdf: normalizeText(element.find('a[title="Download PDF"]').first().attr('href')),
      authors: element.find('p.authors a').toArray().map((item) => normalizeText($(item).text())).filter(Boolean),
      categories: element.find('span.tag').toArray().map((item) => normalizeText($(item).text())).filter(Boolean)
    };
  }).filter((entry) => entry.id || entry.title);

  return {
    totalResults: entries.length,
    entries: entries.slice(0, Math.max(1, Math.min(10, Number(max_results) || 5)))
  };
}

function describeArxivError(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 429) return 'arXiv 请求过于频繁，已被限流（429）。';
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
    return 'arXiv 请求超时。';
  }
  return `arXiv 请求失败：${error?.message || String(error)}`;
}

function formatSearchResults(query = '', payload = {}) {
  const lines = [
    `arXiv 搜索：${normalizeText(query) || 'latest'}`
  ];
  const entries = normalizeArray(payload.entries);
  if (entries.length === 0) {
    lines.push('未找到结果。');
    return lines.join('\n');
  }
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.title}`);
    lines.push(`   id: ${entry.id}`);
    if (entry.authors.length) lines.push(`   authors: ${entry.authors.join(', ')}`);
    if (entry.categories.length) lines.push(`   categories: ${entry.categories.join(', ')}`);
    if (entry.published) lines.push(`   published: ${entry.published}`);
    if (entry.link) lines.push(`   link: ${entry.link}`);
    if (entry.summary) lines.push(`   summary: ${entry.summary.slice(0, 280)}${entry.summary.length > 280 ? '...' : ''}`);
  });
  return lines.join('\n');
}

async function searchArxiv({ query = '', max_results = 5, categories = [], tags = [] } = {}) {
  const limit = Math.max(1, Math.min(10, Number(max_results) || 5));
  const candidates = buildFallbackSearchQueries(query, categories, tags);
  let lastError = null;

  for (const searchQuery of candidates.length ? candidates : ['all:machine learning']) {
    try {
      const payload = await queryArxivWithRetry({
        search_query: searchQuery,
        start: 0,
        max_results: limit,
        sortBy: 'relevance',
        sortOrder: 'descending'
      }, {
        retries: 2,
        retryDelayMs: 900
      });
      if (Array.isArray(payload?.entries) && payload.entries.length > 0) {
        return formatSearchResults(query, payload);
      }
      lastError = new Error('arXiv search returned no entries');
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const htmlPayload = await searchArxivHtml({ query, max_results: limit });
    if (Array.isArray(htmlPayload?.entries) && htmlPayload.entries.length > 0) {
      return formatSearchResults(query, htmlPayload);
    }
  } catch (error) {
    lastError = error;
  }

  return describeArxivError(lastError);
}

async function getArxiv({ arxiv_id = '', include_abstract = true } = {}) {
  const id = normalizeText(arxiv_id);
  if (!id) return 'Missing arxiv_id.';
  try {
    const payload = await queryArxivWithRetry({
      id_list: id
    }, {
      retries: 2,
      retryDelayMs: 900
    });
    const entry = normalizeArray(payload.entries)[0];
    if (!entry) return `未找到 arXiv 论文：${id}`;
    const lines = [
      `title: ${entry.title}`,
      `id: ${entry.id}`,
      entry.authors.length ? `authors: ${entry.authors.join(', ')}` : '',
      entry.categories.length ? `categories: ${entry.categories.join(', ')}` : '',
      entry.published ? `published: ${entry.published}` : '',
      entry.link ? `link: ${entry.link}` : '',
      entry.pdf ? `pdf: ${entry.pdf}` : ''
    ].filter(Boolean);
    if (include_abstract && entry.summary) {
      lines.push(`abstract: ${entry.summary}`);
    }
    return lines.join('\n');
  } catch (error) {
    return describeArxivError(error);
  }
}

async function latestArxiv({ categories = [], tags = [], max_results = 5 } = {}) {
  try {
    const searchQuery = buildSearchQuery('', categories, tags);
    const payload = await queryArxivWithRetry({
      search_query: searchQuery || 'cat:cs.AI',
      start: 0,
      max_results: Math.max(1, Math.min(10, Number(max_results) || 5)),
      sortBy: 'submittedDate',
      sortOrder: 'descending'
    }, {
      retries: 2,
      retryDelayMs: 900
    });
    return formatSearchResults(categories.join(',') || 'latest', payload);
  } catch (error) {
    return describeArxivError(error);
  }
}

module.exports = {
  getArxiv,
  latestArxiv,
  searchArxiv
};
