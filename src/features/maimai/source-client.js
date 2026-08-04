const crypto = require('crypto');

const DEFAULT_MUSIC_URL = 'https://www.diving-fish.com/api/maimaidxprober/music_data';
const DEFAULT_STATS_URL = 'https://www.diving-fish.com/api/maimaidxprober/chart_stats';
const DEFAULT_GITHUB_REPO = 'TowableSpace694/maidata';
const DEFAULT_GITHUB_BRANCH = 'main';

function normalizeChartType(value = '') {
  return String(value || '').trim().toUpperCase() === 'DX' ? 'DX' : 'SD';
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parseMaidataFile(text = '', filePath = '') {
  const values = new Map();
  let currentKey = '';
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const match = line.match(/^&([^=]+)=(.*)$/);
    if (match) {
      currentKey = match[1].trim();
      values.set(currentKey, match[2]);
      continue;
    }
    if (currentKey.startsWith('inote_')) values.set(currentKey, `${values.get(currentKey) || ''}${line.trim()}`);
  }

  const pathId = String(filePath).match(/(?:^|[\\/])songs[\\/]+([^\\/]+)[\\/]maidata\.txt$/i)?.[1] || '';
  const musicId = String(values.get('shortid') || pathId).trim();
  const chartKeys = Array.from(values.keys())
    .map((key) => key.match(/^inote_(\d+)$/))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
  const difficultyOffset = chartKeys.includes(0)
    ? 0
    : chartKeys.includes(1)
      ? 1
      : 2;
  const charts = chartKeys.map((suffix) => {
    const difficultyIndex = suffix - difficultyOffset;
    return {
      difficultyIndex,
      level: String(values.get(`lv_${suffix}`) || '').trim(),
      charter: String(values.get(`des_${suffix}`) || values.get(`des`) || '').trim(),
      rawChart: String(values.get(`inote_${suffix}`) || '').replace(/\s+/g, ''),
      sourceChartKey: `source:${musicId}:${normalizeChartType(values.get('cabinet'))}:${difficultyIndex}`
    };
  });
  return {
    musicId,
    title: String(values.get('title') || '').trim(),
    artist: String(values.get('artist') || '').trim(),
    bpm: Number(String(values.get('wholebpm') || '').split(/[;,]/)[0]) || 0,
    chartType: normalizeChartType(values.get('cabinet')),
    charts,
    filePath
  };
}

function buildMaidataCharts(entries = []) {
  const songs = [];
  const sourceCharts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const parsed = parseMaidataFile(entry.content, entry.path);
    if (!parsed.musicId || !parsed.title) continue;
    for (const chart of parsed.charts) {
      if (chart.difficultyIndex < 0 || chart.difficultyIndex > 4 || !chart.rawChart) continue;
      const contentHash = sha256(chart.rawChart);
      songs.push({
        musicId: parsed.musicId,
        title: parsed.title,
        artist: parsed.artist,
        bpm: parsed.bpm,
        chartType: parsed.chartType
      });
      sourceCharts.push({
        sourceChartKey: chart.sourceChartKey,
        sourceId: parsed.musicId,
        title: parsed.title,
        chartType: parsed.chartType,
        difficultyIndex: chart.difficultyIndex,
        level: chart.level,
        noteTotal: 0,
        charter: chart.charter,
        contentHash,
        rawChart: chart.rawChart,
        filePath: parsed.filePath
      });
    }
  }
  const uniqueSongs = Array.from(new Map(songs.map((song) => [
    `${song.musicId}:${song.chartType}`,
    song
  ])).values());
  return { songs: uniqueSongs, sourceCharts };
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || response?.headers?.[name] || '').trim();
}

async function readJson(response) {
  if (typeof response?.json === 'function') return response.json();
  return response?.body;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = Array(items.length);
  let cursor = 0;
  let failure = null;
  async function run() {
    while (cursor < items.length && !failure) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        failure = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  if (failure) throw failure;
  return results;
}

function createMaimaiSourceClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const musicUrl = String(options.musicUrl || DEFAULT_MUSIC_URL);
  const statsUrl = String(options.statsUrl || DEFAULT_STATS_URL);
  const repo = String(options.githubRepo || DEFAULT_GITHUB_REPO);
  const branch = String(options.githubBranch || DEFAULT_GITHUB_BRANCH);
  const githubToken = String(options.githubToken || process.env.GITHUB_TOKEN || '').trim();
  const githubHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MizukiBot-maimai-sync',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {})
  };
  const downloadConcurrency = Math.max(1, Math.min(16, Number(options.downloadConcurrency || 8) || 8));
  let rawUnavailable = false;

  async function requestJson(url, headers = {}) {
    const response = await fetchImpl(url, { headers });
    const etag = responseHeader(response, 'etag');
    const requestedEtag = Object.entries(headers).find(
      ([name]) => String(name).toLowerCase() === 'if-none-match'
    )?.[1];
    if (response.status === 304 || (requestedEtag && etag === String(requestedEtag))) {
      return { notModified: true, etag };
    }
    if (!response.ok) throw new Error(`maimai source request failed (${response.status})`);
    return { body: await readJson(response), etag };
  }

  async function requestText(url, headers = {}) {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`maimai source request failed (${response.status})`);
    return typeof response.text === 'function' ? response.text() : String(response.body || '');
  }

  async function requestTextWithRetry(url, headers = {}, retries = 2) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await requestText(url, headers);
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function downloadChangedEntry(entry, commitSha) {
    const encodedPath = String(entry.path).split('/').map(encodeURIComponent).join('/');
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${commitSha}/${encodedPath}`;
    let content;
    if (!rawUnavailable) {
      try {
        content = await requestText(rawUrl, { 'User-Agent': 'MizukiBot-maimai-sync' });
      } catch (_) {
        rawUnavailable = true;
      }
    }
    if (content === undefined) {
      const cdnUrl = `https://cdn.jsdelivr.net/gh/${repo}@${commitSha}/${encodedPath}`;
      try {
        content = await requestTextWithRetry(cdnUrl, { 'User-Agent': 'MizukiBot-maimai-sync' });
      } catch (error) {
        throw new Error(`maimai source download failed for ${entry.path}: ${error.message || error}`);
      }
    }
    return { path: entry.path, sha: entry.sha, content };
  }

  async function downloadChangedEntries(entries, commitSha) {
    return mapConcurrent(entries, downloadConcurrency, (entry) => downloadChangedEntry(entry, commitSha));
  }

  async function fetchDivingFish(state = {}) {
    const [music, stats] = await Promise.all([
      requestJson(musicUrl, state.musicEtag ? { 'If-None-Match': state.musicEtag } : {}),
      requestJson(statsUrl, state.statsEtag ? { 'If-None-Match': state.statsEtag } : {})
    ]);
    return {
      music: music.notModified ? { unchanged: true, etag: state.musicEtag || music.etag, songs: null } : { unchanged: false, etag: music.etag, songs: music.body },
      stats: stats.notModified ? { unchanged: true, etag: state.statsEtag || stats.etag, charts: null } : { unchanged: false, etag: stats.etag, charts: stats.body }
    };
  }

  async function fetchMaidata(state = {}) {
    const commitUrl = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`;
    const commitResponse = await requestJson(commitUrl, githubHeaders);
    const commitSha = String(commitResponse.body?.sha || '').trim();
    const treeSha = String(commitResponse.body?.commit?.tree?.sha || commitSha).trim();
    if (!commitSha || !treeSha) throw new Error('maimai maidata GitHub commit is missing sha');
    const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`;
    const treeResponse = await requestJson(treeUrl, githubHeaders);
    const tree = treeResponse.body;
    if (tree.truncated) throw new Error('maimai maidata GitHub tree is truncated');
    const previousTree = state.previousTree || {};
    const currentTree = {};
    const changedEntries = [];
    for (const entry of tree.tree || []) {
      if (entry.type !== 'blob' || !/(^|[\\/])maidata\.txt$/i.test(entry.path)) continue;
      currentTree[entry.path] = entry.sha;
      if (previousTree[entry.path] === entry.sha) continue;
      changedEntries.push(entry);
    }
    const changed = await downloadChangedEntries(changedEntries, commitSha);
    return {
      sourceRevision: commitSha,
      currentTree,
      changed,
      removed: Object.keys(previousTree).filter((filePath) => !Object.prototype.hasOwnProperty.call(currentTree, filePath)),
      noop: changed.length === 0 && Object.keys(previousTree).length === Object.keys(currentTree).length
    };
  }

  async function fetchAll(state = {}) {
    const [divingFish, maidata] = await Promise.all([
      fetchDivingFish(state),
      fetchMaidata(state)
    ]);
    return { ...divingFish, maidata };
  }

  return { fetchAll, fetchDivingFish, fetchMaidata };
}

module.exports = {
  DEFAULT_GITHUB_BRANCH,
  DEFAULT_GITHUB_REPO,
  DEFAULT_MUSIC_URL,
  DEFAULT_STATS_URL,
  buildMaidataCharts,
  createMaimaiSourceClient,
  mapConcurrent,
  parseMaidataFile,
  sha256
};
