const crypto = require('crypto');
const { DIFFICULTIES, buildChartKey } = require('./chart-analysis');

const JP_MASTER_BASE_URL = 'https://sekai-world.github.io/sekai-master-db-diff';
const CN_MASTER_BASE_URL = 'https://sekai-world.github.io/sekai-master-db-cn-diff';
const SUS_BASE_URL = 'https://storage.sekai.best/sekai-jp-assets/music/music_score';
const COVER_BASE_URL = 'https://storage.sekai.best/sekai-jp-assets/thumbnail/music_jacket';
const MASTER_FILES = Object.freeze([
  ['jpMusics', JP_MASTER_BASE_URL, 'musics.json'],
  ['jpDifficulties', JP_MASTER_BASE_URL, 'musicDifficulties.json'],
  ['jpVocals', JP_MASTER_BASE_URL, 'musicVocals.json'],
  ['jpTags', JP_MASTER_BASE_URL, 'musicTags.json'],
  ['jpCharacters', JP_MASTER_BASE_URL, 'gameCharacters.json'],
  ['cnMusics', CN_MASTER_BASE_URL, 'musics.json']
]);

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || response?.headers?.[name] || '').trim();
}

function assertArray(name, value) {
  if (!Array.isArray(value)) throw new Error(`PJSK master ${name} must be an array`);
  return value;
}

function characterName(character = {}) {
  return `${String(character.firstName || '').trim()}${String(character.givenName || '').trim()}`.trim();
}

function buildMasterCatalog(master = {}) {
  const jpMusics = assertArray('jpMusics', master.jpMusics);
  const difficulties = assertArray('jpDifficulties', master.jpDifficulties);
  const cnMusics = assertArray('cnMusics', master.cnMusics);
  const vocals = assertArray('jpVocals', master.jpVocals);
  const tags = assertArray('jpTags', master.jpTags);
  const characters = assertArray('jpCharacters', master.jpCharacters);
  const musicIds = new Set();
  const songs = jpMusics.map((music) => {
    const musicId = Number(music.id);
    const title = String(music.title || '').trim();
    const publishedAt = Number(music.publishedAt);
    if (!Number.isInteger(musicId) || musicId <= 0 || !title || !Number.isFinite(publishedAt)) {
      throw new Error('PJSK musics master contains an invalid row');
    }
    if (musicIds.has(musicId)) throw new Error(`PJSK musics master contains duplicate id ${musicId}`);
    musicIds.add(musicId);
    return {
      musicId,
      title,
      pronunciation: String(music.pronunciation || '').trim(),
      lyricist: String(music.lyricist || '').trim(),
      composer: String(music.composer || '').trim(),
      arranger: String(music.arranger || '').trim(),
      assetbundleName: String(music.assetbundleName || '').trim(),
      publishedAt
    };
  });

  const aliases = [];
  for (const song of songs) {
    aliases.push({ musicId: song.musicId, locale: 'ja', alias: song.title, kind: 'canonical' });
    if (song.pronunciation) aliases.push({ musicId: song.musicId, locale: 'ja-kana', alias: song.pronunciation, kind: 'pronunciation' });
  }
  for (const music of cnMusics) {
    const musicId = Number(music.id);
    if (!musicIds.has(musicId)) continue;
    const title = String(music.title || '').trim();
    if (title) aliases.push({ musicId, locale: 'zh-CN', alias: title, kind: 'localized' });
    for (const info of Array.isArray(music.infos) ? music.infos : []) {
      const infoTitle = String(info?.title || '').trim();
      if (infoTitle) aliases.push({ musicId, locale: 'en', alias: infoTitle, kind: 'localized' });
    }
  }

  const charts = difficulties.map((row) => {
    const musicId = Number(row.musicId);
    const difficulty = String(row.musicDifficulty || '').trim().toLowerCase();
    const level = Number(row.playLevel);
    const noteTotal = Number(row.totalNoteCount);
    if (!musicIds.has(musicId) || !DIFFICULTIES.includes(difficulty) || !Number.isInteger(level) || level <= 0 || !Number.isInteger(noteTotal) || noteTotal <= 0) {
      throw new Error('PJSK musicDifficulties master contains an invalid row');
    }
    return { chartKey: buildChartKey(musicId, difficulty), musicId, difficulty, level, noteTotal };
  });

  const musicTags = tags
    .filter((row) => musicIds.has(Number(row.musicId)) && String(row.musicTag || '').trim())
    .map((row) => ({ musicId: Number(row.musicId), tag: String(row.musicTag).trim() }));
  const characterMap = new Map(characters.map((character) => [Number(character.id), {
    characterId: Number(character.id),
    name: characterName(character),
    firstNameEnglish: String(character.firstNameEnglish || '').trim(),
    givenNameEnglish: String(character.givenNameEnglish || '').trim(),
    unit: String(character.unit || '').trim()
  }]));
  const singingVersions = vocals
    .filter((vocal) => musicIds.has(Number(vocal.musicId)))
    .map((vocal) => ({
      vocalId: Number(vocal.id),
      musicId: Number(vocal.musicId),
      vocalType: String(vocal.musicVocalType || '').trim(),
      caption: String(vocal.caption || '').trim(),
      assetbundleName: String(vocal.assetbundleName || '').trim(),
      characters: (Array.isArray(vocal.characters) ? vocal.characters : [])
        .map((item) => characterMap.get(Number(item.characterId)))
        .filter(Boolean)
    }));
  return { aliases, characters: Array.from(characterMap.values()), charts, singingVersions, songs, tags: musicTags };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function createPjskSourceClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('PJSK fetch implementation is required');
  const userAgent = String(options.userAgent || 'MizukiBot-pjsk-sync');
  const susConcurrency = Math.max(1, Math.min(24, Number(options.susConcurrency || 8) || 8));

  async function fetchText(url, etag = '') {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': userAgent,
        ...(etag ? { 'If-None-Match': etag } : {})
      }
    });
    const responseEtag = responseHeader(response, 'etag') || etag;
    if (response.status === 304) return { unchanged: true, etag: responseEtag, url };
    if (!response.ok) throw new Error(`PJSK source request failed (${response.status}) for ${url}`);
    const text = typeof response.text === 'function' ? await response.text() : String(response.body || '');
    return { unchanged: false, etag: responseEtag, hash: sha256(text), text, url };
  }

  async function fetchMaster(state = {}) {
    const entries = await Promise.all(MASTER_FILES.map(async ([name, baseUrl, fileName]) => {
      const result = await fetchText(`${baseUrl}/${fileName}`, state.etags?.[name] || '');
      return [name, result];
    }));
    const files = Object.fromEntries(entries);
    return {
      unchanged: entries.every(([, result]) => result.unchanged),
      files,
      etags: Object.fromEntries(entries.map(([name, result]) => [name, result.etag || '']))
    };
  }

  async function fetchSus(chart, cached = null) {
    const musicFolder = `${String(chart.musicId).padStart(4, '0')}_01`;
    const url = `${SUS_BASE_URL}/${musicFolder}/${chart.difficulty}.txt`;
    try {
      const result = await fetchText(url, cached?.etag || '');
      if (result.unchanged && cached?.rawSus) {
        return { ...cached, chartKey: chart.chartKey, unchanged: true, sourceUrl: url };
      }
      return {
        chartKey: chart.chartKey,
        rawSus: result.text,
        contentHash: result.hash,
        etag: result.etag,
        sourceUrl: url,
        unchanged: false
      };
    } catch (error) {
      return { chartKey: chart.chartKey, error: String(error.message || error), sourceUrl: url };
    }
  }

  function fetchSusBatch(charts, cachedByKey = new Map()) {
    return mapConcurrent(charts, susConcurrency, (chart) => fetchSus(chart, cachedByKey.get(chart.chartKey)));
  }

  return { fetchMaster, fetchSus, fetchSusBatch };
}

module.exports = {
  CN_MASTER_BASE_URL,
  COVER_BASE_URL,
  JP_MASTER_BASE_URL,
  MASTER_FILES,
  SUS_BASE_URL,
  buildMasterCatalog,
  createPjskSourceClient,
  mapConcurrent,
  sha256
};
