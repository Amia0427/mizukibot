const { z } = require('zod');
const { SharedLinkError } = require('./errors');
const { parseNeteaseReference } = require('./url');

const artistSchema = z.object({ name: z.string().optional() }).passthrough();
const albumBriefSchema = z.object({
  name: z.string().optional(),
  picUrl: z.string().optional()
}).passthrough();
const trackSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  ar: z.array(artistSchema).optional(),
  artists: z.array(artistSchema).optional(),
  al: albumBriefSchema.optional(),
  album: albumBriefSchema.optional(),
  dt: z.number().optional(),
  duration: z.number().optional()
}).passthrough();
const songResponseSchema = z.object({
  code: z.number().optional(),
  songs: z.array(trackSchema).optional()
}).passthrough();
const lyricsResponseSchema = z.object({
  code: z.number().optional(),
  lrc: z.object({ lyric: z.string().optional() }).passthrough().optional()
}).passthrough();
const playlistResponseSchema = z.object({
  code: z.number().optional(),
  playlist: z.object({
    id: z.number().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    coverImgUrl: z.string().optional(),
    trackCount: z.number().optional(),
    creator: z.object({ nickname: z.string().optional() }).passthrough().optional(),
    tracks: z.array(trackSchema).optional()
  }).passthrough().nullable().optional()
}).passthrough();
const albumResponseSchema = z.object({
  code: z.number().optional(),
  album: z.object({
    id: z.number().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    picUrl: z.string().optional(),
    artist: artistSchema.optional()
  }).passthrough().nullable().optional(),
  songs: z.array(trackSchema).optional()
}).passthrough();

function normalizeText(value = '') {
  return String(value || '').trim();
}

function validateApiCode(code) {
  const value = Number(code || 200);
  if (value === 200) return;
  if (value === 404) throw new SharedLinkError('NOT_FOUND', '网易云内容不存在');
  if (value === 401 || value === 403) throw new SharedLinkError('PRIVATE_CONTENT', '网易云内容不可公开访问');
  if (value === 429) throw new SharedLinkError('RATE_LIMITED', '网易云请求过于频繁');
  throw new SharedLinkError('INVALID_RESPONSE', `网易云接口返回异常状态 ${value}`);
}

function formatArtists(track = {}) {
  const artists = Array.isArray(track.ar) ? track.ar : (Array.isArray(track.artists) ? track.artists : []);
  return artists.map((artist) => normalizeText(artist?.name)).filter(Boolean).join(' / ');
}

function normalizeTrack(track = {}) {
  return {
    id: Number(track.id || 0) || 0,
    title: normalizeText(track.name),
    artist: formatArtists(track),
    album: normalizeText(track.al?.name || track.album?.name),
    durationSeconds: Math.max(0, Math.round(Number(track.dt || track.duration || 0) / 1000))
  };
}

function cleanLyrics(lyrics = '', maxLength = 6000) {
  const lines = normalizeText(lyrics)
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:\[[^\]]+\])+/, '').trim())
    .filter(Boolean)
    .filter((line, index, all) => index === 0 || line !== all[index - 1]);
  return lines.join('\n').slice(0, maxLength).trim();
}

function canonicalUrl(type, id) {
  return `https://music.163.com/#/${type}?id=${id}`;
}

async function readSong(reference, context) {
  const [detailResult, lyricsResult] = await Promise.allSettled([
    context.fetchJson(`https://music.163.com/api/song/detail/?ids=[${reference.id}]`),
    context.fetchJson(`https://music.163.com/api/song/lyric?id=${reference.id}&lv=1&kv=1&tv=-1`)
  ]);
  if (detailResult.status === 'rejected') throw detailResult.reason;
  const detail = songResponseSchema.parse(detailResult.value);
  validateApiCode(detail.code);
  const track = detail.songs?.[0];
  if (!track) throw new SharedLinkError('NOT_FOUND', '网易云单曲不存在');
  const normalizedTrack = normalizeTrack(track);
  let lyricText = '';
  if (lyricsResult.status === 'fulfilled') {
    const parsedLyrics = lyricsResponseSchema.safeParse(lyricsResult.value);
    if (parsedLyrics.success && Number(parsedLyrics.data.code || 200) === 200) {
      lyricText = cleanLyrics(parsedLyrics.data.lrc?.lyric);
    }
  }
  return {
    platform: 'netease_music',
    contentType: 'song',
    canonicalUrl: canonicalUrl('song', reference.id),
    title: normalizedTrack.title,
    author: normalizedTrack.artist,
    body: lyricText,
    tags: [],
    media: {
      album: normalizedTrack.album,
      coverUrl: normalizeText(track.al?.picUrl || track.album?.picUrl),
      durationSeconds: normalizedTrack.durationSeconds,
      lyrics: lyricText
    },
    imageUnderstanding: [],
    completeness: lyricText ? 'complete' : 'partial',
    failureCode: lyricText ? '' : 'LYRICS_UNAVAILABLE'
  };
}

async function readPlaylist(reference, context) {
  const raw = await context.fetchJson(`https://music.163.com/api/playlist/detail?id=${reference.id}`);
  const parsed = playlistResponseSchema.parse(raw);
  validateApiCode(parsed.code);
  if (!parsed.playlist) throw new SharedLinkError('NOT_FOUND', '网易云歌单不存在');
  const tracks = (parsed.playlist.tracks || []).slice(0, 20).map(normalizeTrack);
  return {
    platform: 'netease_music',
    contentType: 'playlist',
    canonicalUrl: canonicalUrl('playlist', reference.id),
    title: normalizeText(parsed.playlist.name),
    author: normalizeText(parsed.playlist.creator?.nickname),
    body: normalizeText(parsed.playlist.description),
    tags: [],
    media: {
      coverUrl: normalizeText(parsed.playlist.coverImgUrl),
      trackCount: Math.max(tracks.length, Number(parsed.playlist.trackCount || 0) || 0),
      tracks,
      tracksTruncated: Number(parsed.playlist.trackCount || tracks.length) > tracks.length
    },
    imageUnderstanding: [],
    completeness: 'complete',
    failureCode: ''
  };
}

async function readAlbum(reference, context) {
  const raw = await context.fetchJson(`https://music.163.com/api/album/${reference.id}`);
  const parsed = albumResponseSchema.parse(raw);
  validateApiCode(parsed.code);
  if (!parsed.album) throw new SharedLinkError('NOT_FOUND', '网易云专辑不存在');
  const tracks = (parsed.songs || []).slice(0, 20).map(normalizeTrack);
  return {
    platform: 'netease_music',
    contentType: 'album',
    canonicalUrl: canonicalUrl('album', reference.id),
    title: normalizeText(parsed.album.name),
    author: normalizeText(parsed.album.artist?.name),
    body: normalizeText(parsed.album.description),
    tags: [],
    media: {
      coverUrl: normalizeText(parsed.album.picUrl),
      trackCount: parsed.songs?.length || tracks.length,
      tracks,
      tracksTruncated: (parsed.songs?.length || 0) > tracks.length
    },
    imageUnderstanding: [],
    completeness: 'complete',
    failureCode: ''
  };
}

const neteaseParser = {
  supports(url) {
    return Boolean(parseNeteaseReference(url));
  },
  async read(context) {
    const reference = parseNeteaseReference(context.url);
    if (!reference) throw new SharedLinkError('UNSUPPORTED_URL', '不支持的网易云链接');
    if (reference.type === 'song') return readSong(reference, context);
    if (reference.type === 'playlist') return readPlaylist(reference, context);
    return readAlbum(reference, context);
  }
};

module.exports = {
  cleanLyrics,
  neteaseParser,
  normalizeTrack
};
