const FEATURE_ALGORITHM_VERSION = 'pjsk-usc-v1';
const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard', 'expert', 'master', 'append']);
const WINDOW_SECONDS = 8;
const WINDOW_STEP_SECONDS = 2;

let enginePromise = null;

function loadEngine() {
  if (!enginePromise) enginePromise = import('@next-sekai/sonolus-next-sekai-engine');
  return enginePromise;
}

function normalizeSongTitle(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeDifficulty(value = '') {
  const normalized = String(value || '').normalize('NFKC').trim().toLowerCase();
  const aliases = {
    绿: 'easy', 綠: 'easy', 绿谱: 'easy', 綠譜: 'easy',
    蓝: 'normal', 藍: 'normal', 蓝谱: 'normal', 藍譜: 'normal',
    黄: 'hard', 黃: 'hard', 黄谱: 'hard', 黃譜: 'hard',
    红: 'expert', 紅: 'expert', 红谱: 'expert', 紅譜: 'expert',
    紫: 'master', 紫谱: 'master', 紫譜: 'master',
    master: 'master', mas: 'master', append: 'append', apd: 'append',
    easy: 'easy', normal: 'normal', hard: 'hard', expert: 'expert'
  };
  return aliases[normalized] || (DIFFICULTIES.includes(normalized) ? normalized : '');
}

function buildChartKey(musicId, difficulty) {
  const normalizedDifficulty = normalizeDifficulty(difficulty);
  const id = Number(musicId);
  if (!Number.isInteger(id) || id <= 0 || !normalizedDifficulty) throw new Error('invalid PJSK chart key');
  return `jp:${id}:${normalizedDifficulty}`;
}

function createBeatToSeconds(objects = []) {
  const changes = objects
    .filter((object) => object.type === 'bpm' && Number(object.bpm) > 0)
    .map((object) => ({ beat: Number(object.beat), bpm: Number(object.bpm) }))
    .sort((left, right) => left.beat - right.beat);
  if (changes.length === 0) throw new Error('PJSK chart BPM is missing');
  if (changes[0].beat > 0) changes.unshift({ beat: 0, bpm: changes[0].bpm });

  return (beatValue) => {
    const beat = Number(beatValue) || 0;
    let seconds = 0;
    let previousBeat = changes[0].beat;
    let bpm = changes[0].bpm;
    for (const change of changes.slice(1)) {
      if (change.beat >= beat) break;
      seconds += (change.beat - previousBeat) * 60 / bpm;
      previousBeat = change.beat;
      bpm = change.bpm;
    }
    return seconds + (beat - previousBeat) * 60 / bpm;
  };
}

function createVisibleActions(usc, beatToSeconds) {
  const actions = [];
  let slideCount = 0;
  let slideDuration = 0;
  for (const object of usc.objects) {
    if (object.type === 'single') {
      actions.push({
        time: beatToSeconds(object.beat),
        beat: Number(object.beat),
        kind: object.direction ? 'flick' : object.trace ? 'trace' : 'tap',
        lane: Number(object.lane),
        size: Number(object.size),
        critical: object.critical === true
      });
      continue;
    }
    if (object.type !== 'slide' || object.active !== true) continue;
    const connections = object.connections || [];
    if (connections.length === 0) continue;
    slideCount += 1;
    slideDuration += Math.max(0, beatToSeconds(connections.at(-1).beat) - beatToSeconds(connections[0].beat));
    for (const connection of connections) {
      if (connection.type === 'ignore') continue;
      actions.push({
        time: beatToSeconds(connection.beat),
        beat: Number(connection.beat),
        kind: connection.direction ? 'flick' : connection.trace ? 'trace' : `slide_${connection.type}`,
        lane: Number.isFinite(Number(connection.lane)) ? Number(connection.lane) : null,
        size: Number.isFinite(Number(connection.size)) ? Number(connection.size) : 0,
        critical: object.critical === true || connection.critical === true
      });
    }
  }
  actions.sort((left, right) => left.time - right.time || (left.lane ?? 0) - (right.lane ?? 0));
  return { actions, slideCount, slideDuration };
}

function groupSimultaneous(actions = []) {
  const groups = [];
  for (const action of actions) {
    const previous = groups.at(-1);
    if (previous && Math.abs(previous.time - action.time) <= 0.03) previous.actions.push(action);
    else groups.push({ time: action.time, actions: [action] });
  }
  return groups;
}

function scoreWindow(actions, speedChanges, startTime, endTime) {
  const selected = actions.filter((action) => action.time >= startTime && action.time < endTime);
  const groups = groupSimultaneous(selected);
  const chords = groups.filter((group) => group.actions.length >= 2);
  const span = chords.reduce((sum, group) => {
    const lanes = group.actions.map((action) => action.lane).filter(Number.isFinite);
    return sum + (lanes.length > 1 ? Math.max(...lanes) - Math.min(...lanes) : 0);
  }, 0);
  const flicks = selected.filter((action) => action.kind === 'flick').length;
  const endpoints = selected.filter((action) => action.kind === 'slide_start' || action.kind === 'slide_end').length;
  const changes = speedChanges.filter((time) => time >= startTime && time < endTime).length;
  return {
    actionCount: selected.length,
    chordCount: chords.length,
    flickCount: flicks,
    slideEndpointCount: endpoints,
    span,
    speedChangeCount: changes,
    intensity: selected.length + flicks * 1.4 + endpoints * 0.7 + chords.length * 1.8 + span * 0.25 + changes * 2.2
  };
}

function selectRepresentativeSegments(actions, speedChanges, duration) {
  const windows = [];
  const lastStart = Math.max(0, duration - WINDOW_SECONDS);
  for (let start = 0; start <= lastStart + 0.001; start += WINDOW_STEP_SECONDS) {
    const end = Math.min(duration, start + WINDOW_SECONDS);
    windows.push({ startTime: start, endTime: end, ...scoreWindow(actions, speedChanges, start, end) });
  }
  if (windows.length === 0) windows.push({ startTime: 0, endTime: duration, ...scoreWindow(actions, speedChanges, 0, duration) });
  const selected = [];
  for (const window of windows.sort((left, right) => right.intensity - left.intensity || left.startTime - right.startTime)) {
    if (selected.some((item) => window.startTime < item.endTime && item.startTime < window.endTime)) continue;
    selected.push(window);
    if (selected.length === 3) break;
  }
  return selected
    .sort((left, right) => left.startTime - right.startTime)
    .map((segment, segmentIndex) => ({
      ...segment,
      segmentIndex,
      rawText: `${segment.startTime.toFixed(1)}-${segment.endTime.toFixed(1)}s actions=${segment.actionCount} flick=${segment.flickCount} slide_endpoints=${segment.slideEndpointCount} chords=${segment.chordCount} span=${segment.span.toFixed(1)} speed_changes=${segment.speedChangeCount}`
    }));
}

function officialNoteCount(levelData = {}) {
  return (levelData.entities || []).filter((entity) => {
    const archetype = String(entity.archetype || '');
    return archetype.endsWith('Note') && archetype !== 'AnchorNote';
  }).length;
}

async function analyzeSusChart(sus = '') {
  const source = String(sus || '');
  if (!source.trim()) throw new Error('PJSK SUS is empty');
  const { susToUSC, uscToLevelData } = await loadEngine();
  const usc = susToUSC(source);
  const beatToSeconds = createBeatToSeconds(usc.objects);
  const { actions, slideCount, slideDuration } = createVisibleActions(usc, beatToSeconds);
  const lastBeat = Math.max(0, ...actions.map((action) => action.beat));
  const duration = Math.max(0, beatToSeconds(lastBeat) + Number(usc.offset || 0));
  const bpmValues = usc.objects.filter((object) => object.type === 'bpm').map((object) => Number(object.bpm)).filter((value) => value > 0);
  const speedChanges = usc.objects
    .filter((object) => object.type === 'timeScale')
    .map((object) => beatToSeconds(object.beat));
  const groups = groupSimultaneous(actions);
  const chordGroups = groups.filter((group) => group.actions.length >= 2);
  const noteTotal = officialNoteCount(uscToLevelData(usc));
  const peak = selectRepresentativeSegments(actions, speedChanges, duration);
  const noteCounts = {
    tap: actions.filter((action) => action.kind === 'tap').length,
    flick: actions.filter((action) => action.kind === 'flick').length,
    slide: slideCount,
    trace: actions.filter((action) => action.kind === 'trace').length,
    critical: actions.filter((action) => action.critical).length
  };
  return {
    featureAlgorithmVersion: FEATURE_ALGORITHM_VERSION,
    duration,
    noteTotal,
    noteCounts,
    chordCount: chordGroups.length,
    wideNoteCount: actions.filter((action) => Number(action.size) > 1).length,
    maxChordSize: Math.max(1, ...groups.map((group) => group.actions.length)),
    maxChordSpan: Math.max(0, ...chordGroups.map((group) => {
      const lanes = group.actions.map((action) => action.lane).filter(Number.isFinite);
      return lanes.length > 1 ? Math.max(...lanes) - Math.min(...lanes) : 0;
    })),
    slideDuration,
    bpmChangeCount: Math.max(0, bpmValues.length - 1),
    timeScaleChangeCount: speedChanges.length,
    bpmMin: Math.min(...bpmValues),
    bpmMax: Math.max(...bpmValues),
    density: duration > 0 ? noteTotal / duration : 0,
    peakDensity: peak.length > 0 ? Math.max(...peak.map((segment) => segment.actionCount / Math.max(1, segment.endTime - segment.startTime))) : 0,
    techniqueTags: [],
    segments: peak
  };
}

function quantile(values = [], percentile = 0.75) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
}

function assignTechniqueTags(charts = []) {
  const cohorts = new Map();
  for (const chart of charts) {
    const key = Number(chart.level || 0);
    const rows = cohorts.get(key) || [];
    rows.push(chart);
    cohorts.set(key, rows);
  }
  for (const rows of cohorts.values()) {
    const thresholds = {
      density: quantile(rows.map((row) => row.density)),
      peakDensity: quantile(rows.map((row) => row.peakDensity)),
      flick: quantile(rows.map((row) => row.noteCounts.flick)),
      slide: quantile(rows.map((row) => row.noteCounts.slide)),
      trace: quantile(rows.map((row) => row.noteCounts.trace)),
      chord: quantile(rows.map((row) => row.chordCount)),
      wide: quantile(rows.map((row) => row.wideNoteCount))
    };
    for (const row of rows) {
      const tags = [];
      if (row.density >= thresholds.density && row.peakDensity >= thresholds.peakDensity) tags.push('高密度');
      if (row.noteCounts.flick > 0 && row.noteCounts.flick >= thresholds.flick) tags.push('Flick偏多');
      if (row.noteCounts.slide > 0 && row.noteCounts.slide >= thresholds.slide) tags.push('滑条偏多');
      if (row.noteCounts.trace > 0 && row.noteCounts.trace >= thresholds.trace) tags.push('Trace偏多');
      if (row.chordCount > 0 && row.chordCount >= thresholds.chord) tags.push('多押偏多');
      if (row.wideNoteCount > 0 && row.wideNoteCount >= thresholds.wide) tags.push('宽键偏多');
      if (row.bpmChangeCount + row.timeScaleChangeCount > 0) tags.push('含变速');
      row.techniqueTags = tags;
    }
  }
  return charts;
}

module.exports = {
  DIFFICULTIES,
  FEATURE_ALGORITHM_VERSION,
  WINDOW_SECONDS,
  WINDOW_STEP_SECONDS,
  analyzeSusChart,
  assignTechniqueTags,
  buildChartKey,
  normalizeDifficulty,
  normalizeSongTitle,
  selectRepresentativeSegments
};
