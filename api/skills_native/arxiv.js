const axios = require('axios');
const cheerio = require('cheerio');

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';

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
      'User-Agent': 'MizukiBot/1.0 (arxiv native client)'
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
  const searchQuery = buildSearchQuery(query, categories, tags);
  const payload = await queryArxiv({
    search_query: searchQuery || 'all:machine learning',
    start: 0,
    max_results: Math.max(1, Math.min(10, Number(max_results) || 5)),
    sortBy: 'relevance',
    sortOrder: 'descending'
  });
  return formatSearchResults(query, payload);
}

async function getArxiv({ arxiv_id = '', include_abstract = true } = {}) {
  const id = normalizeText(arxiv_id);
  if (!id) return 'Missing arxiv_id.';
  const payload = await queryArxiv({
    id_list: id
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
}

async function latestArxiv({ categories = [], tags = [], max_results = 5 } = {}) {
  const searchQuery = buildSearchQuery('', categories, tags);
  const payload = await queryArxiv({
    search_query: searchQuery || 'cat:cs.AI',
    start: 0,
    max_results: Math.max(1, Math.min(10, Number(max_results) || 5)),
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  return formatSearchResults(categories.join(',') || 'latest', payload);
}

module.exports = {
  getArxiv,
  latestArxiv,
  searchArxiv
};
