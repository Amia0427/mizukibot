const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openSqliteDatabase } = require('../../../utils/sqliteConnection');
const { normalizeSongTitle } = require('./chart-analysis');

const DEFAULT_DIFFICULTY_NAMES = Object.freeze(['basic', 'advanced', 'expert', 'master', 'remaster']);

function json(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function difficultyIndex(value = '') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s:_-]+/g, '');
  if (!normalized) return null;
  if (/^(0|basic|绿|绿色)$/.test(normalized)) return 0;
  if (/^(1|advanced|黄|黄色)$/.test(normalized)) return 1;
  if (/^(2|expert|红|红色)$/.test(normalized)) return 2;
  if (/^(3|master|紫|紫色|紫谱)$/.test(normalized)) return 3;
  if (/^(4|remaster|白|白色|白谱)$/.test(normalized)) return 4;
  return null;
}

function createMaimaiCatalogStore(options = {}) {
  const requestedDbFile = String(options.dbFile || '').trim();
  if (!requestedDbFile) throw new Error('maimai catalog dbFile is required');
  const dbFile = path.resolve(requestedDbFile);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openSqliteDatabase(options.Database || Database, dbFile, { busyTimeoutMs: options.busyTimeoutMs });

  db.exec(`
    CREATE TABLE IF NOT EXISTS maimai_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      music_etag TEXT NOT NULL DEFAULT '',
      stats_etag TEXT NOT NULL DEFAULT '',
      source_revision TEXT NOT NULL DEFAULT '',
      vector_table TEXT NOT NULL DEFAULT '',
      parsed_ratio REAL NOT NULL DEFAULT 0,
      mapping_coverage REAL NOT NULL DEFAULT 0,
      document_count INTEGER NOT NULL DEFAULT 0,
      vector_count INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS maimai_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maimai_songs (
      generation_id INTEGER NOT NULL,
      music_id TEXT NOT NULL,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT '',
      bpm REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (generation_id, music_id, chart_type)
    );
    CREATE TABLE IF NOT EXISTS maimai_charts (
      generation_id INTEGER NOT NULL,
      chart_key TEXT NOT NULL,
      music_id TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      difficulty_index INTEGER NOT NULL,
      difficulty_name TEXT NOT NULL,
      level TEXT NOT NULL,
      constant REAL NOT NULL DEFAULT 0,
      note_total INTEGER NOT NULL DEFAULT 0,
      charter TEXT NOT NULL DEFAULT '',
      stats_avg REAL NOT NULL DEFAULT 0,
      stats_std_dev REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (generation_id, chart_key)
    );
    CREATE TABLE IF NOT EXISTS maimai_chart_sources (
      content_hash TEXT PRIMARY KEY,
      raw_chart TEXT NOT NULL,
      parse_status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maimai_chart_mappings (
      generation_id INTEGER NOT NULL,
      source_chart_key TEXT NOT NULL,
      chart_key TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (generation_id, source_chart_key)
    );
    CREATE TABLE IF NOT EXISTS maimai_chart_features (
      content_hash TEXT PRIMARY KEY,
      algorithm_version TEXT NOT NULL,
      duration REAL NOT NULL DEFAULT 0,
      tap_count INTEGER NOT NULL DEFAULT 0,
      touch_count INTEGER NOT NULL DEFAULT 0,
      hold_count INTEGER NOT NULL DEFAULT 0,
      slide_count INTEGER NOT NULL DEFAULT 0,
      break_count INTEGER NOT NULL DEFAULT 0,
      density REAL NOT NULL DEFAULT 0,
      peak_density REAL NOT NULL DEFAULT 0,
      chord_count INTEGER NOT NULL DEFAULT 0,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      vertical_stream_count INTEGER NOT NULL DEFAULT 0,
      slide_combo_count INTEGER NOT NULL DEFAULT 0,
      bpm_change_count INTEGER NOT NULL DEFAULT 0,
      bpm_min REAL NOT NULL DEFAULT 0,
      bpm_max REAL NOT NULL DEFAULT 0,
      technique_tags_json TEXT NOT NULL DEFAULT '[]',
      feature_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS maimai_chart_events (
      content_hash TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_time REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '',
      collection_size INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (content_hash, event_index)
    );
    CREATE TABLE IF NOT EXISTS maimai_chart_segments (
      content_hash TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      intensity REAL NOT NULL,
      raw_text TEXT NOT NULL,
      template_text TEXT NOT NULL,
      polished_text TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      PRIMARY KEY (content_hash, segment_index)
    );
    CREATE TABLE IF NOT EXISTS maimai_summary_cache (
      cache_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      model_version TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS maimai_chart_fts USING fts5(
      generation_id UNINDEXED,
      chart_key UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    );
    CREATE INDEX IF NOT EXISTS idx_maimai_mapping_active
      ON maimai_chart_mappings (generation_id, status, chart_key);
    CREATE INDEX IF NOT EXISTS idx_maimai_chart_title
      ON maimai_songs (generation_id, normalized_title);
  `);

  const setMeta = db.prepare(`
    INSERT INTO maimai_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const getMeta = db.prepare('SELECT value FROM maimai_meta WHERE key = ?').pluck();

  function setMetaValue(key, value) {
    setMeta.run(String(key), String(value));
  }

  function getMetaValue(key, fallback = '') {
    const value = getMeta.get(String(key));
    return value === undefined ? fallback : value;
  }

  function startSync(meta = {}) {
    const result = db.prepare(`
      INSERT INTO maimai_sync_runs (
        status, started_at, music_etag, stats_etag, source_revision
      ) VALUES ('staging', ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      String(meta.musicEtag || ''),
      String(meta.statsEtag || ''),
      String(meta.sourceRevision || '')
    );
    return Number(result.lastInsertRowid);
  }

  function recordNoopSync(meta = {}) {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO maimai_sync_runs (
        status, started_at, finished_at, music_etag, stats_etag, source_revision
      ) VALUES ('no_op', ?, ?, ?, ?, ?)
    `).run(
      now,
      now,
      String(meta.musicEtag || ''),
      String(meta.statsEtag || ''),
      String(meta.sourceRevision || '')
    );
    return Number(result.lastInsertRowid);
  }

  const replaceGeneration = db.transaction((generationId, payload = {}) => {
    const run = db.prepare('SELECT status FROM maimai_sync_runs WHERE id = ?').get(generationId);
    if (!run || run.status !== 'staging') throw new Error('maimai sync run is not staging');
    for (const table of ['maimai_songs', 'maimai_charts', 'maimai_chart_mappings']) {
      db.prepare(`DELETE FROM ${table} WHERE generation_id = ?`).run(generationId);
    }
    db.prepare('DELETE FROM maimai_chart_fts WHERE generation_id = ?').run(String(generationId));

    const insertSong = db.prepare(`
      INSERT INTO maimai_songs (
        generation_id, music_id, title, normalized_title, chart_type, artist, bpm
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const song of payload.songs || []) {
      insertSong.run(
        generationId,
        String(song.musicId || ''),
        String(song.title || ''),
        String(song.normalizedTitle || normalizeSongTitle(song.title)),
        String(song.chartType || 'SD'),
        String(song.artist || ''),
        Number(song.bpm || 0)
      );
    }

    const insertChart = db.prepare(`
      INSERT INTO maimai_charts (
        generation_id, chart_key, music_id, chart_type, difficulty_index,
        difficulty_name, level, constant, note_total, charter, stats_avg, stats_std_dev
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chart of payload.charts || []) {
      insertChart.run(
        generationId,
        String(chart.chartKey || ''),
        String(chart.musicId || ''),
        String(chart.chartType || 'SD'),
        Number(chart.difficultyIndex || 0),
        String(chart.difficultyName || DEFAULT_DIFFICULTY_NAMES[chart.difficultyIndex] || ''),
        String(chart.level || ''),
        Number(chart.constant || 0),
        Number(chart.noteTotal || 0),
        String(chart.charter || ''),
        Number(chart.statsAvg || 0),
        Number(chart.statsStdDev || 0)
      );
    }

    const insertSource = db.prepare(`
      INSERT INTO maimai_chart_sources (content_hash, raw_chart, parse_status)
      VALUES (?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        raw_chart = excluded.raw_chart,
        parse_status = excluded.parse_status
    `);
    for (const source of payload.sources || []) {
      insertSource.run(String(source.contentHash || ''), String(source.rawChart || ''), String(source.parseStatus || 'ok'));
    }

    const insertMapping = db.prepare(`
      INSERT INTO maimai_chart_mappings (
        generation_id, source_chart_key, chart_key, content_hash, status, confidence, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const mapping of payload.mappings || []) {
      insertMapping.run(
        generationId,
        String(mapping.sourceChartKey || ''),
        String(mapping.chartKey || ''),
        String(mapping.contentHash || ''),
        String(mapping.status || 'quarantined'),
        Number(mapping.confidence || 0),
        String(mapping.reason || '')
      );
    }

    const insertFeature = db.prepare(`
      INSERT INTO maimai_chart_features (
        content_hash, algorithm_version, duration, tap_count, touch_count, hold_count,
        slide_count, break_count, density, peak_density, chord_count, interaction_count,
        vertical_stream_count, slide_combo_count, bpm_change_count, bpm_min, bpm_max,
        technique_tags_json, feature_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        algorithm_version = excluded.algorithm_version,
        duration = excluded.duration,
        tap_count = excluded.tap_count,
        touch_count = excluded.touch_count,
        hold_count = excluded.hold_count,
        slide_count = excluded.slide_count,
        break_count = excluded.break_count,
        density = excluded.density,
        peak_density = excluded.peak_density,
        chord_count = excluded.chord_count,
        interaction_count = excluded.interaction_count,
        vertical_stream_count = excluded.vertical_stream_count,
        slide_combo_count = excluded.slide_combo_count,
        bpm_change_count = excluded.bpm_change_count,
        bpm_min = excluded.bpm_min,
        bpm_max = excluded.bpm_max,
        technique_tags_json = excluded.technique_tags_json,
        feature_json = excluded.feature_json
    `);
    for (const feature of payload.features || []) {
      const counts = feature.noteCounts || {};
      insertFeature.run(
        String(feature.contentHash || ''),
        String(feature.featureAlgorithmVersion || ''),
        Number(feature.duration || 0),
        Number(counts.tap || 0),
        Number(counts.touch || 0),
        Number(counts.hold || 0),
        Number(counts.slide || 0),
        Number(counts.break || 0),
        Number(feature.density || 0),
        Number(feature.peakDensity || 0),
        Number(feature.chordCount || 0),
        Number(feature.interactionCount || 0),
        Number(feature.verticalStreamCount || 0),
        Number(feature.slideComboCount || 0),
        Number(feature.bpmChangeCount || 0),
        Number(feature.bpmMin || 0),
        Number(feature.bpmMax || 0),
        JSON.stringify(feature.techniqueTags || []),
        JSON.stringify(feature)
      );
    }

    const insertEvent = db.prepare(`
      INSERT INTO maimai_chart_events (
        content_hash, event_index, event_type, event_time, duration,
        location, collection_size, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash, event_index) DO UPDATE SET
        event_type = excluded.event_type,
        event_time = excluded.event_time,
        duration = excluded.duration,
        location = excluded.location,
        collection_size = excluded.collection_size,
        payload_json = excluded.payload_json
    `);
    for (const event of payload.events || []) {
      insertEvent.run(
        String(event.contentHash || ''),
        Number(event.eventIndex || 0),
        String(event.type || ''),
        Number(event.time || 0),
        Number(event.duration || 0),
        String(event.location || ''),
        Number(event.collectionSize || 0),
        JSON.stringify(event)
      );
    }

    const insertSegment = db.prepare(`
      INSERT INTO maimai_chart_segments (
        content_hash, segment_index, start_time, end_time, intensity,
        raw_text, template_text, polished_text, document_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash, segment_index) DO UPDATE SET
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        intensity = excluded.intensity,
        raw_text = excluded.raw_text,
        template_text = excluded.template_text,
        polished_text = excluded.polished_text,
        document_hash = excluded.document_hash
    `);
    for (const segment of payload.segments || []) {
      insertSegment.run(
        String(segment.contentHash || ''),
        Number(segment.segmentIndex || 0),
        Number(segment.startTime || 0),
        Number(segment.endTime || 0),
        Number(segment.intensity || 0),
        String(segment.rawText || ''),
        String(segment.templateText || ''),
        String(segment.polishedText || segment.templateText || ''),
        String(segment.documentHash || '')
      );
    }

    const ftsRows = db.prepare(`
      SELECT c.chart_key, s.title, s.normalized_title, f.technique_tags_json,
             f.density, f.peak_density, f.chord_count, f.interaction_count,
             f.vertical_stream_count, f.slide_combo_count, f.bpm_change_count
      FROM maimai_charts c
      JOIN maimai_songs s
        ON s.generation_id = c.generation_id
       AND s.music_id = c.music_id
       AND s.chart_type = c.chart_type
      JOIN maimai_chart_mappings m
        ON m.generation_id = c.generation_id
       AND m.chart_key = c.chart_key
       AND m.status = 'confirmed'
      JOIN maimai_chart_features f ON f.content_hash = m.content_hash
      WHERE c.generation_id = ?
    `).all(generationId);
    const insertFts = db.prepare('INSERT INTO maimai_chart_fts (generation_id, chart_key, title, body) VALUES (?, ?, ?, ?)');
    for (const row of ftsRows) {
      const body = [
        row.title,
        row.normalized_title,
        ...json(row.technique_tags_json, []),
        `density ${row.density}`,
        `peak ${row.peak_density}`,
        `chord ${row.chord_count}`,
        `interaction ${row.interaction_count}`,
        `vertical ${row.vertical_stream_count}`,
        `slide ${row.slide_combo_count}`,
        `bpmchange ${row.bpm_change_count}`
      ].join(' ');
      insertFts.run(String(generationId), row.chart_key, row.title, body);
    }
  });

  const activateGeneration = db.transaction((generationId, metrics = {}) => {
    const run = db.prepare('SELECT * FROM maimai_sync_runs WHERE id = ?').get(generationId);
    if (!run || run.status !== 'staging') throw new Error('maimai sync run is not staging');
    const parsedRatio = Number(metrics.parsedRatio || 0);
    const mappingCoverage = Number(metrics.mappingCoverage || 0);
    const documentCount = Number(metrics.documentCount || 0);
    const vectorCount = Number(metrics.vectorCount || 0);
    if (parsedRatio < 0.99) throw new Error('maimai parsed ratio is below 0.99');
    if (mappingCoverage < 0.75) throw new Error('maimai mapping coverage is below 0.75');
    if (documentCount !== vectorCount) throw new Error('maimai vector count does not match document count');
    const previousId = Number(getMeta.get('active_generation_id') || 0);
    if (previousId > 0) {
      const previous = db.prepare('SELECT mapping_coverage FROM maimai_sync_runs WHERE id = ?').get(previousId);
      if (previous && mappingCoverage < Number(previous.mapping_coverage || 0) - 0.02) {
        throw new Error('maimai mapping coverage dropped by more than 0.02');
      }
      db.prepare("UPDATE maimai_sync_runs SET status = 'superseded' WHERE id = ? AND status = 'active'").run(previousId);
    }
    db.prepare(`
      UPDATE maimai_sync_runs
      SET status = 'active', finished_at = ?, vector_table = ?, parsed_ratio = ?,
          mapping_coverage = ?, document_count = ?, vector_count = ?, error = ''
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      String(metrics.vectorTable || ''),
      parsedRatio,
      mappingCoverage,
      documentCount,
      vectorCount,
      generationId
    );
    setMeta.run('active_generation_id', String(generationId));
  });

  function failSync(generationId, error = '') {
    db.prepare(`
      UPDATE maimai_sync_runs
      SET status = 'failed', finished_at = ?, error = ?
      WHERE id = ? AND status = 'staging'
    `).run(new Date().toISOString(), String(error || '').slice(0, 500), generationId);
  }

  function markStaleRunsFailed() {
    return db.prepare(`
      UPDATE maimai_sync_runs
      SET status = 'failed', finished_at = ?, error = 'worker_interrupted'
      WHERE status = 'staging'
    `).run(new Date().toISOString()).changes;
  }

  function getActiveGeneration() {
    const id = Number(getMeta.get('active_generation_id') || 0);
    if (!id) return null;
    const row = db.prepare('SELECT * FROM maimai_sync_runs WHERE id = ? AND status = ?').get(id, 'active');
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      musicEtag: row.music_etag,
      statsEtag: row.stats_etag,
      sourceRevision: row.source_revision,
      vectorTable: row.vector_table,
      parsedRatio: row.parsed_ratio,
      mappingCoverage: row.mapping_coverage,
      documentCount: row.document_count,
      vectorCount: row.vector_count
    };
  }

  function queryTerms(query = '') {
    return Array.from(new Set(
      String(query || '')
        .normalize('NFKC')
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 12)
    ));
  }

  function mapChartRow(row = {}) {
    return {
      chartKey: row.chart_key,
      musicId: row.music_id,
      title: row.title,
      normalizedTitle: row.normalized_title,
      chartType: row.chart_type,
      difficultyIndex: row.difficulty_index,
      difficultyName: row.difficulty_name,
      level: row.level,
      constant: row.constant,
      noteTotal: row.note_total,
      charter: row.charter,
      statsAvg: row.stats_avg,
      statsStdDev: row.stats_std_dev,
      contentHash: row.content_hash,
      mappingConfidence: row.confidence,
      featureAlgorithmVersion: row.algorithm_version,
      duration: row.duration,
      noteCounts: {
        tap: row.tap_count,
        touch: row.touch_count,
        hold: row.hold_count,
        slide: row.slide_count,
        break: row.break_count
      },
      density: row.density,
      peakDensity: row.peak_density,
      chordCount: row.chord_count,
      interactionCount: row.interaction_count,
      verticalStreamCount: row.vertical_stream_count,
      slideComboCount: row.slide_combo_count,
      bpmChangeCount: row.bpm_change_count,
      bpmMin: row.bpm_min,
      bpmMax: row.bpm_max,
      techniqueTags: json(row.technique_tags_json, [])
    };
  }

  function searchCharts(input = {}) {
    const active = getActiveGeneration();
    if (!active) return [];
    const terms = queryTerms(input.query);
    const params = { generationId: active.id };
    const filters = ["m.status = 'confirmed'"];
    const requestedChartType = input.chartType ?? input.chart_type;
    if (requestedChartType) {
      filters.push('c.chart_type = @chartType');
      params.chartType = String(requestedChartType).trim().toUpperCase();
    }
    const requestedDifficulty = difficultyIndex(input.difficulty);
    if (requestedDifficulty !== null) {
      filters.push('c.difficulty_index = @difficultyIndex');
      params.difficultyIndex = requestedDifficulty;
    }
    if (Number.isFinite(Number(input.levelMin ?? input.level_min))) {
      filters.push('c.constant >= @levelMin');
      params.levelMin = Number(input.levelMin ?? input.level_min);
    }
    if (Number.isFinite(Number(input.levelMax ?? input.level_max))) {
      filters.push('c.constant <= @levelMax');
      params.levelMax = Number(input.levelMax ?? input.level_max);
    }
    let ftsJoin = '';
    let orderBy = 's.title COLLATE NOCASE, c.difficulty_index';
    if (terms.length > 0) {
      ftsJoin = 'JOIN maimai_chart_fts fts ON fts.generation_id = CAST(c.generation_id AS TEXT) AND fts.chart_key = c.chart_key';
      filters.push('maimai_chart_fts MATCH @ftsQuery');
      params.ftsQuery = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
      orderBy = 'bm25(maimai_chart_fts), s.title COLLATE NOCASE, c.difficulty_index';
    }
    params.limit = Math.max(1, Math.min(100, Number(input.limit || 10) || 10));
    const rows = db.prepare(`
      SELECT c.*, s.title, s.normalized_title, m.content_hash, m.confidence,
             feat.*
      FROM maimai_charts c
      JOIN maimai_songs s
        ON s.generation_id = c.generation_id
       AND s.music_id = c.music_id
       AND s.chart_type = c.chart_type
      JOIN maimai_chart_mappings m
        ON m.generation_id = c.generation_id
       AND m.chart_key = c.chart_key
      JOIN maimai_chart_features feat ON feat.content_hash = m.content_hash
      ${ftsJoin}
      WHERE c.generation_id = @generationId AND ${filters.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT @limit
    `).all(params);
    return rows.map(mapChartRow);
  }

  function getChartAnalysis(input = {}) {
    const active = getActiveGeneration();
    if (!active) return { status: 'unavailable', chart: null, candidates: [], segments: [] };
    const normalizedTitle = normalizeSongTitle(input.title || input.query || '');
    if (!normalizedTitle) return { status: 'ambiguous', chart: null, candidates: [], segments: [] };
    const params = { generationId: active.id, normalizedTitle };
    const filters = ['s.normalized_title = @normalizedTitle', "m.status = 'confirmed'"];
    const requestedDifficulty = difficultyIndex(input.difficulty);
    if (requestedDifficulty !== null) {
      filters.push('c.difficulty_index = @difficultyIndex');
      params.difficultyIndex = requestedDifficulty;
    }
    const requestedChartType = input.chartType ?? input.chart_type;
    if (requestedChartType) {
      filters.push('c.chart_type = @chartType');
      params.chartType = String(requestedChartType).trim().toUpperCase();
    }
    const rows = db.prepare(`
      SELECT c.*, s.title, s.normalized_title, m.content_hash, m.confidence, feat.*
      FROM maimai_charts c
      JOIN maimai_songs s
        ON s.generation_id = c.generation_id
       AND s.music_id = c.music_id
       AND s.chart_type = c.chart_type
      JOIN maimai_chart_mappings m
        ON m.generation_id = c.generation_id
       AND m.chart_key = c.chart_key
      JOIN maimai_chart_features feat ON feat.content_hash = m.content_hash
      WHERE c.generation_id = @generationId AND ${filters.join(' AND ')}
      ORDER BY c.chart_type, c.difficulty_index
      LIMIT 6
    `).all(params).map(mapChartRow);
    if (rows.length !== 1) {
      return { status: 'ambiguous', chart: null, candidates: rows.slice(0, 5), segments: [] };
    }
    const chart = rows[0];
    const segments = db.prepare(`
      SELECT segment_index, start_time, end_time, intensity, raw_text,
             template_text, polished_text, document_hash
      FROM maimai_chart_segments
      WHERE content_hash = ?
      ORDER BY segment_index
      LIMIT 3
    `).all(chart.contentHash).map((row) => ({
      segmentIndex: row.segment_index,
      startTime: row.start_time,
      endTime: row.end_time,
      intensity: row.intensity,
      rawText: row.raw_text,
      templateText: row.template_text,
      polishedText: row.polished_text,
      documentHash: row.document_hash
    }));
    return { status: 'ok', chart, candidates: [chart], segments, generation: active };
  }

  function getChartByKey(chartKey = '') {
    const active = getActiveGeneration();
    if (!active || !String(chartKey || '').trim()) return null;
    const row = db.prepare(`
      SELECT c.*, s.title, s.normalized_title, m.content_hash, m.confidence, feat.*
      FROM maimai_charts c
      JOIN maimai_songs s
        ON s.generation_id = c.generation_id
       AND s.music_id = c.music_id
       AND s.chart_type = c.chart_type
      JOIN maimai_chart_mappings m
        ON m.generation_id = c.generation_id
       AND m.chart_key = c.chart_key
      JOIN maimai_chart_features feat ON feat.content_hash = m.content_hash
      WHERE c.generation_id = ? AND c.chart_key = ? AND m.status = 'confirmed'
      LIMIT 1
    `).get(active.id, String(chartKey));
    return row ? mapChartRow(row) : null;
  }

  function getLastSyncRun() {
    return db.prepare('SELECT * FROM maimai_sync_runs ORDER BY id DESC LIMIT 1').get() || null;
  }

  function getLastSuccessfulSync() {
    return db.prepare(`
      SELECT * FROM maimai_sync_runs
      WHERE status IN ('active', 'no_op', 'superseded')
      ORDER BY finished_at DESC, id DESC
      LIMIT 1
    `).get() || null;
  }

  function getSummaryCache(cacheKey) {
    const row = db.prepare('SELECT summary_json FROM maimai_summary_cache WHERE cache_key = ?').get(String(cacheKey));
    return row ? json(row.summary_json, null) : null;
  }

  function setSummaryCache(cacheKey, summary = {}) {
    db.prepare(`
      INSERT INTO maimai_summary_cache (
        cache_key, content_hash, prompt_version, model_version, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        summary_json = excluded.summary_json,
        created_at = excluded.created_at
    `).run(
      String(cacheKey),
      String(summary.contentHash || ''),
      String(summary.promptVersion || ''),
      String(summary.modelVersion || ''),
      JSON.stringify(summary.value || summary),
      new Date().toISOString()
    );
  }

  return {
    activateGeneration,
    close() { if (db.open) db.close(); },
    db,
    failSync,
    getMetaValue,
    getActiveGeneration,
    getChartByKey,
    getChartAnalysis,
    getLastSyncRun,
    getLastSuccessfulSync,
    getSummaryCache,
    markStaleRunsFailed,
    recordNoopSync,
    replaceGeneration,
    searchCharts,
    setSummaryCache,
    setMetaValue,
    startSync
  };
}

module.exports = {
  createMaimaiCatalogStore,
  difficultyIndex
};
