const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const { analyzeSusChart, normalizeDifficulty } = require('../src/features/pjsk/chart-analysis');
const { createPjskCoverCache } = require('../src/features/pjsk/cover-cache');
const { renderChartImage } = require('../src/features/pjsk/renderer');
const { MASTER_FILES, buildMasterCatalog, createPjskSourceClient } = require('../src/features/pjsk/source-client');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const musicId = Number(readArg('--music-id', '1'));
  const difficulty = normalizeDifficulty(readArg('--difficulty', 'master'));
  if (!Number.isInteger(musicId) || musicId <= 0 || !difficulty) throw new Error('invalid smoke chart');

  const sourceClient = createPjskSourceClient();
  const fetchedMaster = await sourceClient.fetchMaster();
  const master = Object.fromEntries(MASTER_FILES.map(([name]) => [name, JSON.parse(fetchedMaster.files[name].text)]));
  const catalog = buildMasterCatalog(master);
  const song = catalog.songs.find((item) => item.musicId === musicId);
  const chart = catalog.charts.find((item) => item.musicId === musicId && item.difficulty === difficulty);
  if (!song || !chart || song.publishedAt > Date.now()) throw new Error('smoke chart is not published in JP master');

  const source = await sourceClient.fetchSus(chart);
  if (source.error || !source.rawSus) throw new Error(source.error || 'smoke SUS unavailable');
  const analysis = await analyzeSusChart(source.rawSus);
  if (analysis.noteTotal !== chart.noteTotal) {
    throw new Error(`note total mismatch: master=${chart.noteTotal}, parsed=${analysis.noteTotal}`);
  }

  const rendered = await renderChartImage({
    sus: source.rawSus,
    title: song.title,
    artist: song.composer || song.lyricist,
    difficulty,
    level: chart.level
  });
  const stats = await sharp(rendered.buffer).stats();
  const nonBlank = stats.channels.some((channel) => Number(channel.stdev || 0) > 0);
  if (!nonBlank) throw new Error('rendered PNG is blank');
  const outputDir = path.join(config.DATA_DIR, 'pjsk', 'smoke');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.resolve(readArg('--output', path.join(outputDir, `${musicId}-${difficulty}.png`)));
  await fs.promises.writeFile(output, rendered.buffer);

  const coverCache = createPjskCoverCache({ dir: path.join(config.DATA_DIR, 'pjsk', 'covers') });
  let coverFile = null;
  let coverError = '';
  try {
    coverFile = await coverCache.get(song);
  } catch (error) {
    coverError = String(error.message || error);
  }
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    chartKey: chart.chartKey,
    musicId,
    title: song.title,
    difficulty,
    level: chart.level,
    masterNoteTotal: chart.noteTotal,
    parsedNoteTotal: analysis.noteTotal,
    susSourceUrl: source.sourceUrl,
    susEtag: source.etag,
    susContentHash: source.contentHash,
    featureAlgorithmVersion: analysis.featureAlgorithmVersion,
    width: rendered.width,
    height: rendered.height,
    pixels: rendered.width * rendered.height,
    bytes: rendered.buffer.length,
    nonBlank,
    coverCached: Boolean(coverFile),
    coverError,
    output
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
