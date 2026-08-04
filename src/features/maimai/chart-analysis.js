const crypto = require('crypto');
const { NoteType, SimaiConvert } = require('simai.js');

const FEATURE_ALGORITHM_VERSION = 'maimai_features_v1';
const SEGMENT_SECONDS = 8;
const SEGMENT_STEP_SECONDS = 2;

const NOTE_WEIGHTS = Object.freeze({
  tap: 1,
  touch: 1.1,
  hold: 1.2,
  slide: 1.4,
  break: 1.2
});

function normalizeSongTitle(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function locationKey(note = {}) {
  const group = Number(note.location?.group ?? -1);
  const index = Number(note.location?.index ?? -1);
  return `${group}:${index}`;
}

function noteEventsFromChart(chart = {}) {
  const events = [];
  for (const collection of chart.noteCollections || []) {
    const time = Number(collection.time || 0);
    for (const note of collection) {
      const base = {
        time,
        location: locationKey(note),
        locationText: note.location?.toString?.() || '',
        collectionSize: collection.length,
        duration: Math.max(0, Number(note.length || 0))
      };
      if (note.type === NoteType.Touch) {
        events.push({ ...base, type: 'touch' });
      } else if (note.type === NoteType.Hold) {
        events.push({ ...base, type: 'hold' });
      } else if (note.type === NoteType.Break) {
        events.push({ ...base, type: 'break' });
      } else {
        events.push({ ...base, type: 'tap' });
      }
      for (const slidePath of note.slidePaths || []) {
        events.push({
          ...base,
          type: 'slide',
          duration: Math.max(0, Number(slidePath.delay || 0) + Number(slidePath.duration || 0)),
          slideType: Number(slidePath.type ?? NoteType.Slide),
          pathCount: Array.isArray(slidePath.segments) ? slidePath.segments.length : 0
        });
      }
    }
  }
  return events.sort((left, right) => left.time - right.time || left.type.localeCompare(right.type));
}

function timingAt(timingChanges = [], time = 0) {
  let selected = timingChanges[0] || { tempo: 0, subdivisions: 4 };
  for (const timing of timingChanges) {
    if (Number(timing.time || 0) > time + 1e-7) break;
    selected = timing;
  }
  return selected;
}

function secondsPerCell(timing = {}) {
  const tempo = Number(timing.tempo || 0);
  const subdivisions = Number(timing.subdivisions || 4) || 4;
  if (tempo <= 0) return 0;
  return (60 / tempo) / (subdivisions / 4);
}

function buildRawCells(rawChart = '', timingChanges = []) {
  const cells = String(rawChart || '').split(',');
  const rows = [];
  let currentTime = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const timing = timingAt(timingChanges, currentTime);
    const duration = secondsPerCell(timing);
    rows.push({
      index,
      time: currentTime,
      endTime: currentTime + duration,
      raw: cells[index]
    });
    currentTime += duration;
  }
  return rows;
}

function countRapidRuns(events = [], sameLane = false) {
  const buttons = events.filter((event) => event.type === 'tap' && event.location.startsWith('0:'));
  let runLength = 1;
  let runs = 0;
  for (let index = 1; index < buttons.length; index += 1) {
    const current = buttons[index];
    const previous = buttons[index - 1];
    const rapid = current.time - previous.time <= 0.35;
    const laneMatches = current.location === previous.location;
    const continues = rapid && (sameLane ? laneMatches : !laneMatches);
    if (continues) {
      runLength += 1;
      continue;
    }
    if (runLength >= (sameLane ? 3 : 4)) runs += 1;
    runLength = 1;
  }
  if (runLength >= (sameLane ? 3 : 4)) runs += 1;
  return runs;
}

function countSlideCombos(events = []) {
  const slides = events.filter((event) => event.type === 'slide');
  let combos = 0;
  for (const slide of slides) {
    const slideEnd = slide.time + Math.max(0.001, slide.duration);
    const overlaps = events.some((event) => (
      event !== slide
      && event.time >= slide.time
      && event.time <= slideEnd
      && (event.type === 'slide' || event.type === 'tap' || event.type === 'touch')
    ));
    if (overlaps) combos += 1;
  }
  return combos;
}

function scoreWindow(events = [], startTime = 0, endTime = 0) {
  const selected = events.filter((event) => event.time >= startTime && event.time < endTime);
  let score = selected.reduce((sum, event) => sum + (NOTE_WEIGHTS[event.type] || 1), 0);
  const collections = new Map();
  for (const event of selected) {
    if (event.type === 'slide') continue;
    const key = event.time.toFixed(7);
    collections.set(key, (collections.get(key) || 0) + 1);
  }
  for (const count of collections.values()) {
    if (count > 1) score += (count - 1) * 0.5;
  }
  const slides = selected.filter((event) => event.type === 'slide');
  for (let index = 0; index < slides.length; index += 1) {
    const leftEnd = slides[index].time + slides[index].duration;
    if (slides.slice(index + 1).some((right) => right.time <= leftEnd)) score += 0.5;
  }
  const duration = Math.max(0.001, endTime - startTime);
  return { score: score / duration, selected };
}

function buildSegmentTemplate(segment = {}, noteCounts = {}) {
  const counts = Object.entries(noteCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count}`)
    .join('、');
  return `${segment.startTime.toFixed(1)}-${segment.endTime.toFixed(1)}秒，强度${segment.intensity.toFixed(2)}，${counts || '无可见音符'}`;
}

function buildSegments(events = [], rawCells = [], duration = 0) {
  if (duration <= 0) return [];
  const windows = [];
  const maxStart = Math.max(0, duration - Math.min(SEGMENT_SECONDS, duration));
  for (let start = 0; start <= maxStart + 1e-7; start += SEGMENT_STEP_SECONDS) {
    const end = Math.min(duration, start + SEGMENT_SECONDS);
    const scored = scoreWindow(events, start, end);
    if (scored.selected.length === 0) continue;
    windows.push({ startTime: start, endTime: end, intensity: scored.score, events: scored.selected });
  }
  if (windows.length === 0) {
    const scored = scoreWindow(events, 0, duration);
    windows.push({ startTime: 0, endTime: duration, intensity: scored.score, events: scored.selected });
  }

  const selected = [];
  for (const window of windows.sort((left, right) => right.intensity - left.intensity || left.startTime - right.startTime)) {
    const overlaps = selected.some((item) => window.startTime < item.endTime && item.startTime < window.endTime);
    if (overlaps) continue;
    selected.push(window);
    if (selected.length >= 3) break;
  }

  return selected
    .sort((left, right) => left.startTime - right.startTime)
    .map((segment, segmentIndex) => {
      const noteCounts = { tap: 0, touch: 0, hold: 0, slide: 0, break: 0 };
      for (const event of segment.events) noteCounts[event.type] += 1;
      const rawText = rawCells
        .filter((cell) => cell.time < segment.endTime && cell.endTime > segment.startTime)
        .map((cell) => cell.raw)
        .join(',');
      const base = { ...segment, segmentIndex, noteCounts, rawText };
      return {
        ...base,
        templateText: buildSegmentTemplate(base, noteCounts)
      };
    });
}

function buildTechniqueTags(features = {}) {
  const tags = [];
  if (features.interactionCount > 0) tags.push('交互');
  if (features.verticalStreamCount > 0) tags.push('纵连');
  if (features.chordCount > 0) tags.push('双押');
  if (features.slideComboCount > 0) tags.push('滑键组合');
  if (features.noteCounts.touch > 0) tags.push('Touch');
  if (features.noteCounts.break > 0) tags.push('Break');
  if (features.bpmChangeCount > 0) tags.push('变速');
  return tags;
}

function analyzeSimaiChart(rawChart = '') {
  const chart = SimaiConvert.deserialize(String(rawChart || ''));
  const events = noteEventsFromChart(chart);
  const noteCounts = { tap: 0, touch: 0, hold: 0, slide: 0, break: 0 };
  for (const event of events) noteCounts[event.type] += 1;
  const duration = Math.max(Number(chart.finishTiming || 0), ...events.map((event) => event.time + event.duration), 0);
  const chordCount = (chart.noteCollections || []).filter((collection) => collection.length >= 2).length;
  const interactionCount = countRapidRuns(events, false);
  const verticalStreamCount = countRapidRuns(events, true);
  const slideComboCount = countSlideCombos(events);
  const bpms = (chart.timingChanges || []).map((timing) => Number(timing.tempo || 0)).filter((value) => value > 0);
  const rawCells = buildRawCells(rawChart, chart.timingChanges || []);
  const segments = buildSegments(events, rawCells, duration);
  const totalNotes = Object.values(noteCounts).reduce((sum, count) => sum + count, 0);
  const peakDensity = segments.reduce((max, segment) => Math.max(max, segment.intensity), 0);
  const features = {
    featureAlgorithmVersion: FEATURE_ALGORITHM_VERSION,
    duration,
    noteCounts,
    density: duration > 0 ? totalNotes / duration : 0,
    peakDensity,
    chordCount,
    interactionCount,
    verticalStreamCount,
    slideComboCount,
    bpmChangeCount: Math.max(0, (chart.timingChanges || []).length - 1),
    bpmMin: bpms.length ? Math.min(...bpms) : 0,
    bpmMax: bpms.length ? Math.max(...bpms) : 0
  };
  features.techniqueTags = buildTechniqueTags(features);
  return {
    ...features,
    contentHash: sha256(rawChart),
    chart,
    events,
    rawCells,
    segments
  };
}

module.exports = {
  FEATURE_ALGORITHM_VERSION,
  NOTE_WEIGHTS,
  analyzeSimaiChart,
  buildRawCells,
  buildSegments,
  normalizeSongTitle,
  noteEventsFromChart,
  sha256
};
