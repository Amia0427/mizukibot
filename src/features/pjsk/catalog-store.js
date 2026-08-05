const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openSqliteDatabase } = require('../../../utils/sqliteConnection');
const { normalizeDifficulty, normalizeSongTitle } = require('./chart-analysis');

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function createPjskCatalogStore(options = {}) {
  const requestedDbFile = String(options.dbFile || '').trim();
  if (!requestedDbFile) throw new Error('PJSK catalog dbFile is required');
  const dbFile = path.resolve(requestedDbFile);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openSqliteDatabase(options.Database || Database, dbFile, { busyTimeoutMs: options.busyTimeoutMs });
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  db.exec(`
    CREATE TABLE IF NOT EXISTS pjsk_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      source_revision TEXT NOT NULL DEFAULT '',
      source_manifest_json TEXT NOT NULL DEFAULT '{}',
      vector_table TEXT NOT NULL DEFAULT '',
      vector_generation_id INTEGER NOT NULL DEFAULT 0,
      parsed_ratio REAL NOT NULL DEFAULT 0,
      note_verification_coverage REAL NOT NULL DEFAULT 0,
      document_count INTEGER NOT NULL DEFAULT 0,
      vector_count INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS pjsk_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pjsk_songs (
      generation_id INTEGER NOT NULL,
      music_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      pronunciation TEXT NOT NULL DEFAULT '',
      lyricist TEXT NOT NULL DEFAULT '',
      composer TEXT NOT NULL DEFAULT '',
      arranger TEXT NOT NULL DEFAULT '',
      assetbundle_name TEXT NOT NULL DEFAULT '',
      published_at INTEGER NOT NULL,
      PRIMARY KEY (generation_id, music_id)
    );
    CREATE TABLE IF NOT EXISTS pjsk_song_aliases (
      generation_id INTEGER NOT NULL,
      music_id INTEGER NOT NULL,
      locale TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (generation_id, music_id, normalized_alias)
    );
    CREATE TABLE IF NOT EXISTS pjsk_song_tags (
      generation_id INTEGER NOT NULL,
      music_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (generation_id, music_id, tag)
    );
    CREATE TABLE IF NOT EXISTS pjsk_characters (
      generation_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      first_name_english TEXT NOT NULL DEFAULT '',
      given_name_english TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (generation_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS pjsk_vocals (
      generation_id INTEGER NOT NULL,
      vocal_id INTEGER NOT NULL,
      music_id INTEGER NOT NULL,
      vocal_type TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      assetbundle_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (generation_id, vocal_id)
    );
    CREATE TABLE IF NOT EXISTS pjsk_vocal_characters (
      generation_id INTEGER NOT NULL,
      vocal_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      PRIMARY KEY (generation_id, vocal_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS pjsk_charts (
      generation_id INTEGER NOT NULL,
      chart_key TEXT NOT NULL,
      music_id INTEGER NOT NULL,
      difficulty TEXT NOT NULL,
      level INTEGER NOT NULL,
      note_total INTEGER NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      parse_status TEXT NOT NULL,
      parse_error TEXT NOT NULL DEFAULT '',
      feature_algorithm_version TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (generation_id, chart_key)
    );
    CREATE TABLE IF NOT EXISTS pjsk_chart_sources (
      chart_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL DEFAULT '',
      raw_sus TEXT NOT NULL DEFAULT '',
      etag TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      parse_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS pjsk_chart_features (
      content_hash TEXT PRIMARY KEY,
      algorithm_version TEXT NOT NULL,
      duration REAL NOT NULL,
      note_total INTEGER NOT NULL,
      tap_count INTEGER NOT NULL,
      flick_count INTEGER NOT NULL,
      slide_count INTEGER NOT NULL,
      trace_count INTEGER NOT NULL,
      critical_count INTEGER NOT NULL,
      chord_count INTEGER NOT NULL,
      wide_note_count INTEGER NOT NULL,
      max_chord_size INTEGER NOT NULL,
      max_chord_span REAL NOT NULL,
      slide_duration REAL NOT NULL,
      bpm_change_count INTEGER NOT NULL,
      time_scale_change_count INTEGER NOT NULL,
      bpm_min REAL NOT NULL,
      bpm_max REAL NOT NULL,
      density REAL NOT NULL,
      peak_density REAL NOT NULL,
      technique_tags_json TEXT NOT NULL,
      feature_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pjsk_chart_segments (
      content_hash TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      intensity REAL NOT NULL,
      summary_text TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      PRIMARY KEY (content_hash, segment_index)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pjsk_chart_fts USING fts5(
      generation_id UNINDEXED,
      chart_key UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    );
    CREATE INDEX IF NOT EXISTS idx_pjsk_aliases_normalized ON pjsk_song_aliases(generation_id, normalized_alias);
    CREATE INDEX IF NOT EXISTS idx_pjsk_charts_filters ON pjsk_charts(generation_id, difficulty, level);
    CREATE INDEX IF NOT EXISTS idx_pjsk_songs_published ON pjsk_songs(generation_id, published_at);
  `);

  const getMeta = db.prepare('SELECT value FROM pjsk_meta WHERE key = ?').pluck();
  const setMeta = db.prepare(`
    INSERT INTO pjsk_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  function getMetaValue(key, fallback = '') {
    return getMeta.get(String(key)) ?? fallback;
  }

  function setMetaValue(key, value) {
    setMeta.run(String(key), String(value ?? ''));
  }

  function startSync(meta = {}) {
    return Number(db.prepare(`
      INSERT INTO pjsk_sync_runs (status, started_at, source_revision, source_manifest_json)
      VALUES ('staging', ?, ?, ?)
    `).run(
      now().toISOString(),
      String(meta.sourceRevision || ''),
      JSON.stringify(meta.sourceManifest || {})
    ).lastInsertRowid);
  }

  function recordNoopSync(meta = {}) {
    return Number(db.prepare(`
      INSERT INTO pjsk_sync_runs (
        status, started_at, finished_at, source_revision, source_manifest_json,
        parsed_ratio, note_verification_coverage
      ) VALUES ('no_op', ?, ?, ?, ?, 1, 1)
    `).run(
      now().toISOString(),
      now().toISOString(),
      String(meta.sourceRevision || ''),
      JSON.stringify(meta.sourceManifest || {})
    ).lastInsertRowid);
  }

  const replaceGeneration = db.transaction((generationId, payload = {}) => {
    for (const table of ['pjsk_songs', 'pjsk_song_aliases', 'pjsk_song_tags', 'pjsk_characters', 'pjsk_vocals', 'pjsk_vocal_characters', 'pjsk_charts']) {
      db.prepare(`DELETE FROM ${table} WHERE generation_id = ?`).run(generationId);
    }
    db.prepare('DELETE FROM pjsk_chart_fts WHERE generation_id = ?').run(String(generationId));

    const insertSong = db.prepare(`
      INSERT INTO pjsk_songs (
        generation_id, music_id, title, normalized_title, pronunciation, lyricist,
        composer, arranger, assetbundle_name, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const song of payload.songs || []) {
      insertSong.run(
        generationId, song.musicId, song.title, normalizeSongTitle(song.title), song.pronunciation || '',
        song.lyricist || '', song.composer || '', song.arranger || '', song.assetbundleName || '', song.publishedAt
      );
    }

    const insertAlias = db.prepare(`
      INSERT OR IGNORE INTO pjsk_song_aliases (
        generation_id, music_id, locale, alias, normalized_alias, kind
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const alias of payload.aliases || []) {
      const normalized = normalizeSongTitle(alias.alias);
      if (normalized) insertAlias.run(generationId, alias.musicId, alias.locale, alias.alias, normalized, alias.kind);
    }

    const insertTag = db.prepare('INSERT OR IGNORE INTO pjsk_song_tags (generation_id, music_id, tag) VALUES (?, ?, ?)');
    for (const row of payload.tags || []) insertTag.run(generationId, row.musicId, row.tag);

    const insertCharacter = db.prepare(`
      INSERT INTO pjsk_characters (
        generation_id, character_id, name, first_name_english, given_name_english, unit
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const character of payload.characters || []) {
      insertCharacter.run(generationId, character.characterId, character.name, character.firstNameEnglish, character.givenNameEnglish, character.unit);
    }

    const insertVocal = db.prepare(`
      INSERT INTO pjsk_vocals (
        generation_id, vocal_id, music_id, vocal_type, caption, assetbundle_name
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertVocalCharacter = db.prepare(`
      INSERT OR IGNORE INTO pjsk_vocal_characters (generation_id, vocal_id, character_id)
      VALUES (?, ?, ?)
    `);
    for (const vocal of payload.singingVersions || []) {
      insertVocal.run(generationId, vocal.vocalId, vocal.musicId, vocal.vocalType, vocal.caption, vocal.assetbundleName);
      for (const character of vocal.characters || []) insertVocalCharacter.run(generationId, vocal.vocalId, character.characterId);
    }

    const insertChart = db.prepare(`
      INSERT INTO pjsk_charts (
        generation_id, chart_key, music_id, difficulty, level, note_total,
        content_hash, parse_status, parse_error, feature_algorithm_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chart of payload.charts || []) {
      insertChart.run(
        generationId, chart.chartKey, chart.musicId, chart.difficulty, chart.level, chart.noteTotal,
        chart.contentHash || '', chart.parseStatus, chart.parseError || '', chart.featureAlgorithmVersion || ''
      );
    }

    const upsertSource = db.prepare(`
      INSERT INTO pjsk_chart_sources (
        chart_key, content_hash, raw_sus, etag, source_url, fetched_at, parse_status, parse_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chart_key) DO UPDATE SET
        content_hash = excluded.content_hash,
        raw_sus = excluded.raw_sus,
        etag = excluded.etag,
        source_url = excluded.source_url,
        fetched_at = excluded.fetched_at,
        parse_status = excluded.parse_status,
        parse_error = excluded.parse_error
    `);
    for (const source of payload.sources || []) {
      upsertSource.run(
        source.chartKey, source.contentHash || '', source.rawSus || '', source.etag || '',
        source.sourceUrl, source.fetchedAt || now().toISOString(), source.parseStatus, source.parseError || ''
      );
    }

    const upsertFeature = db.prepare(`
      INSERT INTO pjsk_chart_features (
        content_hash, algorithm_version, duration, note_total, tap_count, flick_count,
        slide_count, trace_count, critical_count, chord_count, wide_note_count,
        max_chord_size, max_chord_span, slide_duration, bpm_change_count,
        time_scale_change_count, bpm_min, bpm_max, density, peak_density,
        technique_tags_json, feature_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        algorithm_version = excluded.algorithm_version,
        duration = excluded.duration,
        note_total = excluded.note_total,
        tap_count = excluded.tap_count,
        flick_count = excluded.flick_count,
        slide_count = excluded.slide_count,
        trace_count = excluded.trace_count,
        critical_count = excluded.critical_count,
        chord_count = excluded.chord_count,
        wide_note_count = excluded.wide_note_count,
        max_chord_size = excluded.max_chord_size,
        max_chord_span = excluded.max_chord_span,
        slide_duration = excluded.slide_duration,
        bpm_change_count = excluded.bpm_change_count,
        time_scale_change_count = excluded.time_scale_change_count,
        bpm_min = excluded.bpm_min,
        bpm_max = excluded.bpm_max,
        density = excluded.density,
        peak_density = excluded.peak_density,
        technique_tags_json = excluded.technique_tags_json,
        feature_json = excluded.feature_json
    `);
    for (const feature of payload.features || []) {
      const counts = feature.noteCounts;
      upsertFeature.run(
        feature.contentHash, feature.featureAlgorithmVersion, feature.duration, feature.noteTotal,
        counts.tap, counts.flick, counts.slide, counts.trace, counts.critical,
        feature.chordCount, feature.wideNoteCount, feature.maxChordSize, feature.maxChordSpan,
        feature.slideDuration, feature.bpmChangeCount, feature.timeScaleChangeCount,
        feature.bpmMin, feature.bpmMax, feature.density, feature.peakDensity,
        JSON.stringify(feature.techniqueTags || []), JSON.stringify(feature)
      );
    }

    const upsertSegment = db.prepare(`
      INSERT INTO pjsk_chart_segments (
        content_hash, segment_index, start_time, end_time, intensity, summary_text, document_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash, segment_index) DO UPDATE SET
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        intensity = excluded.intensity,
        summary_text = excluded.summary_text,
        document_hash = excluded.document_hash
    `);
    for (const segment of payload.segments || []) {
      upsertSegment.run(
        segment.contentHash, segment.segmentIndex, segment.startTime, segment.endTime,
        segment.intensity, segment.summaryText, segment.documentHash
      );
    }

    const aliasesByMusic = new Map();
    for (const alias of payload.aliases || []) {
      const rows = aliasesByMusic.get(alias.musicId) || [];
      rows.push(alias.alias);
      aliasesByMusic.set(alias.musicId, rows);
    }
    const tagsByMusic = new Map();
    for (const row of payload.tags || []) {
      const rows = tagsByMusic.get(row.musicId) || [];
      rows.push(row.tag);
      tagsByMusic.set(row.musicId, rows);
    }
    const vocalsByMusic = new Map();
    for (const vocal of payload.singingVersions || []) {
      const rows = vocalsByMusic.get(vocal.musicId) || [];
      rows.push(
        vocal.vocalType,
        vocal.caption,
        ...(vocal.characters || []).flatMap((character) => [
          character.name,
          `${character.firstNameEnglish || ''} ${character.givenNameEnglish || ''}`.trim()
        ])
      );
      vocalsByMusic.set(vocal.musicId, rows.filter(Boolean));
    }
    const songById = new Map((payload.songs || []).map((song) => [song.musicId, song]));
    const featureByHash = new Map((payload.features || []).map((feature) => [feature.contentHash, feature]));
    const insertFts = db.prepare('INSERT INTO pjsk_chart_fts (generation_id, chart_key, title, body) VALUES (?, ?, ?, ?)');
    for (const chart of payload.charts || []) {
      const song = songById.get(chart.musicId);
      const feature = featureByHash.get(chart.contentHash);
      if (!song) continue;
      const body = [
        song.title, song.lyricist, song.composer, song.arranger,
        ...(aliasesByMusic.get(chart.musicId) || []),
        ...(tagsByMusic.get(chart.musicId) || []),
        ...(vocalsByMusic.get(chart.musicId) || []),
        ...(feature?.techniqueTags || []),
        chart.difficulty, `等级 ${chart.level}`, `物量 ${chart.noteTotal}`
      ].filter(Boolean).join(' ');
      insertFts.run(String(generationId), chart.chartKey, song.title, body);
    }
  });

  const activateSqlGeneration = db.transaction((generationId, metrics = {}) => {
    const run = db.prepare('SELECT status FROM pjsk_sync_runs WHERE id = ?').get(generationId);
    if (!run || run.status !== 'staging') throw new Error('PJSK sync run is not staging');
    const parsedRatio = Number(metrics.parsedRatio || 0);
    const noteCoverage = Number(metrics.noteVerificationCoverage || 0);
    if (parsedRatio < 0.99) throw new Error('PJSK parsed ratio is below 0.99');
    if (noteCoverage < 0.99) throw new Error('PJSK note verification coverage is below 0.99');
    const previousId = Number(getMeta.get('active_generation_id') || 0);
    if (previousId > 0) db.prepare("UPDATE pjsk_sync_runs SET status = 'superseded' WHERE id = ? AND status IN ('active', 'active_sql_only')").run(previousId);
    db.prepare(`
      UPDATE pjsk_sync_runs
      SET status = 'active_sql_only', finished_at = ?, parsed_ratio = ?,
          note_verification_coverage = ?, error = ''
      WHERE id = ?
    `).run(now().toISOString(), parsedRatio, noteCoverage, generationId);
    setMeta.run('active_generation_id', String(generationId));
  });

  function markVectorReady(generationId, metrics = {}) {
    const activeId = Number(getMeta.get('active_generation_id') || 0);
    if (activeId !== Number(generationId)) throw new Error('PJSK vector generation is no longer active');
    const documentCount = Number(metrics.documentCount || 0);
    const vectorCount = Number(metrics.vectorCount || 0);
    if (documentCount !== vectorCount) throw new Error('PJSK vector count does not match document count');
    db.prepare(`
      UPDATE pjsk_sync_runs
      SET status = 'active', vector_table = ?, vector_generation_id = ?,
          document_count = ?, vector_count = ?, error = ''
      WHERE id = ? AND status = 'active_sql_only'
    `).run(String(metrics.vectorTable || ''), generationId, documentCount, vectorCount, generationId);
  }

  function markVectorFailed(generationId, error = '') {
    db.prepare(`
      UPDATE pjsk_sync_runs SET error = ?
      WHERE id = ? AND status = 'active_sql_only'
    `).run(`vector:${String(error || '').slice(0, 450)}`, generationId);
  }

  function failSync(generationId, error = '') {
    db.prepare(`
      UPDATE pjsk_sync_runs SET status = 'failed', finished_at = ?, error = ?
      WHERE id = ? AND status = 'staging'
    `).run(now().toISOString(), String(error || '').slice(0, 500), generationId);
  }

  function markStaleRunsFailed() {
    return db.prepare(`
      UPDATE pjsk_sync_runs SET status = 'failed', finished_at = ?, error = 'worker_interrupted'
      WHERE status = 'staging'
    `).run(now().toISOString()).changes;
  }

  function mapGeneration(row) {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      sourceRevision: row.source_revision,
      sourceManifest: parseJson(row.source_manifest_json, {}),
      vectorTable: row.vector_table,
      vectorGenerationId: row.vector_generation_id,
      parsedRatio: row.parsed_ratio,
      noteVerificationCoverage: row.note_verification_coverage,
      documentCount: row.document_count,
      vectorCount: row.vector_count,
      error: row.error
    };
  }

  function getActiveGeneration() {
    const id = Number(getMeta.get('active_generation_id') || 0);
    return id ? mapGeneration(db.prepare("SELECT * FROM pjsk_sync_runs WHERE id = ? AND status IN ('active', 'active_sql_only')").get(id)) : null;
  }

  function mapChartRow(row) {
    return {
      chartKey: row.chart_key,
      musicId: row.music_id,
      title: row.title,
      difficulty: row.difficulty,
      level: row.level,
      noteTotal: row.note_total,
      publishedAt: row.published_at,
      lyricist: row.lyricist,
      composer: row.composer,
      arranger: row.arranger,
      assetbundleName: row.assetbundle_name,
      contentHash: row.content_hash,
      parseStatus: row.parse_status,
      parseError: row.parse_error,
      analysisAvailable: row.parse_status === 'ok',
      featureAlgorithmVersion: row.algorithm_version || row.feature_algorithm_version || '',
      duration: Number(row.duration || 0),
      noteCounts: {
        tap: Number(row.tap_count || 0),
        flick: Number(row.flick_count || 0),
        slide: Number(row.slide_count || 0),
        trace: Number(row.trace_count || 0),
        critical: Number(row.critical_count || 0)
      },
      chordCount: Number(row.chord_count || 0),
      wideNoteCount: Number(row.wide_note_count || 0),
      maxChordSize: Number(row.max_chord_size || 0),
      maxChordSpan: Number(row.max_chord_span || 0),
      slideDuration: Number(row.slide_duration || 0),
      bpmChangeCount: Number(row.bpm_change_count || 0),
      timeScaleChangeCount: Number(row.time_scale_change_count || 0),
      bpmMin: Number(row.bpm_min || 0),
      bpmMax: Number(row.bpm_max || 0),
      density: Number(row.density || 0),
      peakDensity: Number(row.peak_density || 0),
      techniqueTags: parseJson(row.technique_tags_json, [])
    };
  }

  const chartSelect = `
    SELECT c.*, s.title, s.published_at, s.lyricist, s.composer, s.arranger, s.assetbundle_name,
           f.algorithm_version, f.duration, f.tap_count, f.flick_count, f.slide_count,
           f.trace_count, f.critical_count, f.chord_count, f.wide_note_count,
           f.max_chord_size, f.max_chord_span, f.slide_duration, f.bpm_change_count,
           f.time_scale_change_count, f.bpm_min, f.bpm_max, f.density, f.peak_density,
           f.technique_tags_json
    FROM pjsk_charts c
    JOIN pjsk_songs s ON s.generation_id = c.generation_id AND s.music_id = c.music_id
    LEFT JOIN pjsk_chart_features f ON f.content_hash = c.content_hash
  `;

  function queryTerms(query = '') {
    return Array.from(new Set(String(query || '').normalize('NFKC').split(/[^\p{L}\p{N}]+/u).map((term) => term.trim()).filter(Boolean))).slice(0, 12);
  }

  function matchingChartKeys(generationId, query = '') {
    const normalized = normalizeSongTitle(query);
    const keys = [];
    if (normalized) {
      keys.push(...db.prepare(`
        SELECT DISTINCT c.chart_key
        FROM pjsk_charts c
        JOIN pjsk_songs s ON s.generation_id = c.generation_id AND s.music_id = c.music_id
        LEFT JOIN pjsk_song_aliases a ON a.generation_id = c.generation_id AND a.music_id = c.music_id
        WHERE c.generation_id = ? AND (
          s.normalized_title = ? OR a.normalized_alias = ?
          OR instr(?, s.normalized_title) > 0
          OR (length(a.normalized_alias) >= 2 AND instr(?, a.normalized_alias) > 0)
        )
        LIMIT 100
      `).all(generationId, normalized, normalized, normalized, normalized).map((row) => row.chart_key));
    }
    const terms = queryTerms(query);
    if (terms.length > 0) {
      const ftsQuery = terms.map((term) => `"${term}"`).join(' AND ');
      keys.push(...db.prepare(`
        SELECT chart_key FROM pjsk_chart_fts
        WHERE generation_id = ? AND pjsk_chart_fts MATCH ?
        ORDER BY bm25(pjsk_chart_fts)
        LIMIT 100
      `).all(String(generationId), ftsQuery).map((row) => row.chart_key));
    }
    return Array.from(new Set(keys)).slice(0, 100);
  }

  function searchCharts(input = {}) {
    const active = getActiveGeneration();
    if (!active) return [];
    const params = { generationId: active.id, publishedAt: Number(input.nowMs || now().getTime()) };
    const filters = ['c.generation_id = @generationId', 's.published_at <= @publishedAt'];
    const difficulty = normalizeDifficulty(input.difficulty);
    if (difficulty) {
      filters.push('c.difficulty = @difficulty');
      params.difficulty = difficulty;
    }
    if (Number.isFinite(Number(input.levelMin ?? input.level_min))) {
      filters.push('c.level >= @levelMin');
      params.levelMin = Number(input.levelMin ?? input.level_min);
    }
    if (Number.isFinite(Number(input.levelMax ?? input.level_max))) {
      filters.push('c.level <= @levelMax');
      params.levelMax = Number(input.levelMax ?? input.level_max);
    }
    const matchedKeys = matchingChartKeys(active.id, input.query);
    if (queryTerms(input.query).length > 0 && matchedKeys.length === 0) return [];
    if (matchedKeys.length > 0) {
      filters.push(`c.chart_key IN (${matchedKeys.map((_, index) => `@key${index}`).join(', ')})`);
      matchedKeys.forEach((key, index) => { params[`key${index}`] = key; });
    }
    params.limit = Math.max(1, Math.min(100, Number(input.limit || 10) || 10));
    const rows = db.prepare(`
      ${chartSelect}
      WHERE ${filters.join(' AND ')}
      ORDER BY s.title COLLATE NOCASE, c.difficulty
      LIMIT @limit
    `).all(params).map(mapChartRow);
    const enrichedRows = enrichCharts(active.id, rows);
    const order = new Map(matchedKeys.map((key, index) => [key, index]));
    return matchedKeys.length > 0
      ? enrichedRows.sort((left, right) => (order.get(left.chartKey) ?? 100) - (order.get(right.chartKey) ?? 100))
      : enrichedRows;
  }

  function enrichCharts(generationId, charts) {
    if (charts.length === 0) return [];
    const musicIds = Array.from(new Set(charts.map((chart) => chart.musicId)));
    const placeholders = musicIds.map(() => '?').join(', ');
    const aliasesByMusic = new Map();
    for (const row of db.prepare(`
      SELECT music_id, locale, alias, kind FROM pjsk_song_aliases
      WHERE generation_id = ? AND music_id IN (${placeholders})
      ORDER BY music_id, locale, alias
    `).all(generationId, ...musicIds)) {
      const aliases = aliasesByMusic.get(row.music_id) || [];
      aliases.push({ locale: row.locale, alias: row.alias, kind: row.kind });
      aliasesByMusic.set(row.music_id, aliases);
    }

    const tagsByMusic = new Map();
    for (const row of db.prepare(`
      SELECT music_id, tag FROM pjsk_song_tags
      WHERE generation_id = ? AND music_id IN (${placeholders})
      ORDER BY music_id, tag
    `).all(generationId, ...musicIds)) {
      const tags = tagsByMusic.get(row.music_id) || [];
      tags.push(row.tag);
      tagsByMusic.set(row.music_id, tags);
    }

    const singingVersionsByMusic = new Map();
    const vocalRows = db.prepare(`
      SELECT v.music_id, v.vocal_id, v.vocal_type, v.caption, c.character_id, c.name,
             c.first_name_english, c.given_name_english
      FROM pjsk_vocals v
      LEFT JOIN pjsk_vocal_characters vc ON vc.generation_id = v.generation_id AND vc.vocal_id = v.vocal_id
      LEFT JOIN pjsk_characters c ON c.generation_id = vc.generation_id AND c.character_id = vc.character_id
      WHERE v.generation_id = ? AND v.music_id IN (${placeholders})
      ORDER BY v.music_id, v.vocal_id, c.character_id
    `).all(generationId, ...musicIds);
    for (const row of vocalRows) {
      const versions = singingVersionsByMusic.get(row.music_id) || new Map();
      const version = versions.get(row.vocal_id) || { vocalId: row.vocal_id, vocalType: row.vocal_type, caption: row.caption, characters: [] };
      if (row.character_id) version.characters.push({
        characterId: row.character_id,
        name: row.name,
        englishName: `${row.first_name_english || ''} ${row.given_name_english || ''}`.trim()
      });
      versions.set(row.vocal_id, version);
      singingVersionsByMusic.set(row.music_id, versions);
    }

    return charts.map((chart) => ({
      ...chart,
      aliases: aliasesByMusic.get(chart.musicId) || [],
      tags: tagsByMusic.get(chart.musicId) || [],
      singingVersions: Array.from(singingVersionsByMusic.get(chart.musicId)?.values() || [])
    }));
  }

  function getChartAnalysis(input = {}) {
    const active = getActiveGeneration();
    if (!active) return { status: 'unavailable', chart: null, candidates: [], segments: [] };
    const chartKey = String(input.chartKey || '').trim();
    const normalizedTitle = normalizeSongTitle(input.title || '');
    if (!chartKey && !normalizedTitle) return { status: 'ambiguous', reason: 'missing_title', chart: null, candidates: [], segments: [] };
    const params = { generationId: active.id, publishedAt: Number(input.nowMs || now().getTime()) };
    const filters = [
      'c.generation_id = @generationId',
      's.published_at <= @publishedAt'
    ];
    if (chartKey) {
      filters.push('c.chart_key = @chartKey');
      params.chartKey = chartKey;
    } else {
      filters.push(`(s.normalized_title = @normalizedTitle OR EXISTS (
        SELECT 1 FROM pjsk_song_aliases a
        WHERE a.generation_id = c.generation_id AND a.music_id = c.music_id
          AND a.normalized_alias = @normalizedTitle
      ))`);
      params.normalizedTitle = normalizedTitle;
    }
    const difficulty = normalizeDifficulty(input.difficulty);
    if (difficulty) {
      filters.push('c.difficulty = @difficulty');
      params.difficulty = difficulty;
    }
    const rows = db.prepare(`
      ${chartSelect}
      WHERE ${filters.join(' AND ')}
      ORDER BY c.difficulty
      LIMIT 6
    `).all(params).map(mapChartRow);
    if (rows.length === 0) return { status: 'not_found', reason: 'no_exact_match', chart: null, candidates: [], segments: [] };
    if (rows.length > 1) return { status: 'ambiguous', reason: 'multiple_matches', chart: null, candidates: rows.slice(0, 5), segments: [] };
    const chart = enrichCharts(active.id, rows)[0];
    if (!chart.analysisAvailable) return { status: 'unavailable', reason: chart.parseStatus, chart, candidates: [chart], segments: [], generation: active };
    const segments = db.prepare(`
      SELECT segment_index, start_time, end_time, intensity, summary_text, document_hash
      FROM pjsk_chart_segments WHERE content_hash = ? ORDER BY segment_index LIMIT 3
    `).all(chart.contentHash).map((row) => ({
      segmentIndex: row.segment_index,
      startTime: row.start_time,
      endTime: row.end_time,
      intensity: row.intensity,
      summaryText: row.summary_text,
      documentHash: row.document_hash
    }));
    return { status: 'ok', chart, candidates: [chart], segments, generation: active };
  }

  function getRawSus(chartKey = '', generationId = null) {
    const active = generationId ? { id: Number(generationId) } : getActiveGeneration();
    if (!active) return null;
    return db.prepare(`
      SELECT s.raw_sus, s.content_hash, s.source_url, s.etag
      FROM pjsk_charts c
      JOIN pjsk_chart_sources s ON s.chart_key = c.chart_key AND s.content_hash = c.content_hash
      WHERE c.generation_id = ? AND c.chart_key = ? AND c.parse_status = 'ok'
    `).get(active.id, String(chartKey)) || null;
  }

  function getCachedSources(chartKeys = []) {
    const keys = Array.from(new Set(chartKeys.map(String).filter(Boolean)));
    if (keys.length === 0) return new Map();
    const rows = db.prepare(`
      SELECT * FROM pjsk_chart_sources WHERE chart_key IN (${keys.map(() => '?').join(', ')})
    `).all(...keys);
    return new Map(rows.map((row) => [row.chart_key, {
      chartKey: row.chart_key,
      contentHash: row.content_hash,
      rawSus: row.raw_sus,
      etag: row.etag,
      sourceUrl: row.source_url,
      parseStatus: row.parse_status,
      parseError: row.parse_error
    }]));
  }

  function hasPendingPublishedCharts(at = now()) {
    const active = getActiveGeneration();
    if (!active) return false;
    return Boolean(db.prepare(`
      SELECT 1 FROM pjsk_charts c
      JOIN pjsk_songs s ON s.generation_id = c.generation_id AND s.music_id = c.music_id
      WHERE c.generation_id = ? AND c.parse_status = 'unpublished' AND s.published_at <= ?
      LIMIT 1
    `).get(active.id, at.getTime()));
  }

  function getLastSyncRun() {
    return db.prepare('SELECT * FROM pjsk_sync_runs ORDER BY id DESC LIMIT 1').get() || null;
  }

  function getLastSuccessfulSync() {
    return db.prepare(`
      SELECT * FROM pjsk_sync_runs
      WHERE status IN ('active', 'active_sql_only', 'no_op', 'superseded')
      ORDER BY finished_at DESC, id DESC LIMIT 1
    `).get() || null;
  }

  return {
    activateSqlGeneration,
    close() { if (db.open) db.close(); },
    db,
    failSync,
    getActiveGeneration,
    getCachedSources,
    getChartAnalysis,
    getLastSuccessfulSync,
    getLastSyncRun,
    getMetaValue,
    getRawSus,
    hasPendingPublishedCharts,
    markStaleRunsFailed,
    markVectorFailed,
    markVectorReady,
    recordNoopSync,
    replaceGeneration,
    searchCharts,
    setMetaValue,
    startSync
  };
}

module.exports = { createPjskCatalogStore };
