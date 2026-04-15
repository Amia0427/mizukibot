/**
 * api/tools.js
 *
 * 这里封装了对外部服务的工具函数，统一走一个 http 客户端与重试策略。
 * 这样做的好处是：超时、代理、错误日志都能在一个地方维护。
 */

const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');

let HttpsProxyAgentCtor = null;
try {
  const mod = require('https-proxy-agent');
  HttpsProxyAgentCtor = mod.HttpsProxyAgent || mod;
} catch (_) {}

function createHttpClient() {
  const opts = {
    timeout: 10000,
    proxy: false,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MizukiBot/1.0'
    }
  };

  if (config.PROXY_URL && HttpsProxyAgentCtor) {
    opts.httpsAgent = new HttpsProxyAgentCtor(config.PROXY_URL);
  }

  return axios.create(opts);
}

const http = createHttpClient();

async function withRetry(fn, retries = 1, waitMs = 700) {
  let lastErr;
  const maxRetry = Math.max(0, Number(retries) || 0);

  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < maxRetry) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  throw lastErr;
}

function normalizeSongName(question) {
  return String(question || '')
    .replace(/歌词|的歌词|帮我找|搜一下|查询/g, '')
    .trim();
}

async function getLyrics(question) {
  const songName = normalizeSongName(question);
  if (!songName) {
    return '要先告诉我歌名哦，比如：稻香 歌词。';
  }

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

    const searchResp = await withRetry(
      () => http.get(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(songName)}&type=1&limit=1`, {
        headers,
        timeout: 8000
      }),
      1
    );

    const song = searchResp.data?.result?.songs?.[0];
    if (!song) {
      return `没有找到《${songName}》这首歌。`;
    }

    const lyricResp = await withRetry(
      () => http.get(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`, {
        headers,
        timeout: 8000
      }),
      1
    );

    const lyricRaw = lyricResp.data?.lrc?.lyric;
    if (!lyricRaw) {
      return `找到了《${song.name}》，但它可能是纯音乐，没有可读歌词。`;
    }

    const lyrics = lyricRaw
      .replace(/\[.*?\]/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const preview = lyrics.slice(0, 12).join('\n');
    return `《${song.name}》歌词预览：\n\n${preview}${lyrics.length > 12 ? '\n\n（后续歌词省略）' : ''}`;
  } catch (e) {
    console.error('getLyrics error:', e.code || e.message);
    return '歌词服务暂时不可用，稍后再试一次吧。';
  }
}

function normalizeCityText(text) {
  return String(text || '')
    .replace(/天气|查一下|今天|明天|帮我查/g, '')
    .trim();
}

async function getWeather(text) {
  let city = normalizeCityText(text);
  if (!city) city = '重庆';

  const AMAP_KEY = config.AMAP_KEY;
  if (!AMAP_KEY) {
    return '天气功能还没配置 AMAP_KEY，请先在 .env 中配置后再使用。';
  }

  try {
    const geoRes = await withRetry(
      () => http.get(`https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(city)}&key=${AMAP_KEY}`, {
        timeout: 8000
      }),
      1
    );

    const geocode = geoRes.data?.geocodes?.[0];
    if (!geocode) {
      return `地图里没有找到“${city}”，可以换个更完整的地名再试试。`;
    }

    const adcode = geocode.adcode;

    const weatherRes = await withRetry(
      () => http.get(`https://restapi.amap.com/v3/weather/weatherInfo?city=${adcode}&key=${AMAP_KEY}`, {
        timeout: 8000
      }),
      1
    );

    const info = weatherRes.data?.lives?.[0];
    if (!info) {
      return '暂时拿不到天气详情，请稍后再试。';
    }

    return [
      `${city} 当前天气：${info.weather}`,
      `温度：${info.temperature}℃`,
      `风向：${info.winddirection}`,
      `风力：${info.windpower} 级`,
      `更新时间：${info.reporttime || '未知'}`
    ].join('\n');
  } catch (error) {
    console.error('getWeather error:', error.code || error.message);
    return '天气查询失败，网络或服务可能暂时不稳定。';
  }
}

async function search_nearby_places(keywords, city) {
  const AMAP_KEY = config.AMAP_KEY;
  if (!AMAP_KEY) {
    return '附近地点功能还没配置 AMAP_KEY，请先在 .env 中填写后再使用。';
  }

  const q = String(keywords || '').trim() || '餐厅';
  const c = String(city || '').trim() || '重庆';

  try {
    const response = await withRetry(
      () => http.get('https://restapi.amap.com/v3/place/text', {
        params: {
          key: AMAP_KEY,
          keywords: q,
          city: c,
          citylimit: 'true',
          offset: 5,
          page: 1,
          output: 'json'
        },
        timeout: 9000
      }),
      1
    );

    const data = response.data;
    if (data?.status !== '1' || Number(data?.count || 0) <= 0) {
      return `在 ${c} 没有找到“${q}”相关地点。`;
    }

    const rows = (data.pois || []).slice(0, 5).map((poi, i) => {
      const name = poi.name || '未知地点';
      const address = poi.address || '地址未提供';
      return `${i + 1}. ${name}\n   地址：${address}`;
    });

    return rows.join('\n');
  } catch (error) {
    console.error('search_nearby_places error:', error.code || error.message);
    return '地点查询失败，请稍后重试。';
  }
}

function summarizeError(err) {
  if (!err) return 'unknown';
  return err.code || err.message || String(err);
}

function isNetworkError(err) {
  const code = String(err?.code || '').toUpperCase();
  return ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
}

function parseDuckDuckGoLiteResults(html, maxResults = 5) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];

  // lite 页面结构可能调整，使用宽松选择器并过滤站内跳转链接。
  $('a').each((_, el) => {
    if (rows.length >= maxResults) return false;

    const title = $(el).text().replace(/\s+/g, ' ').trim();
    let link = String($(el).attr('href') || '').trim();
    if (!title || !link) return;

    if (link.startsWith('//')) link = `https:${link}`;
    if (link.startsWith('/l/?')) {
      try {
        const u = new URL(`https://duckduckgo.com${link}`);
        const redirected = u.searchParams.get('uddg');
        if (redirected) link = decodeURIComponent(redirected);
      } catch (_) {}
    }

    if (!/^https?:\/\//i.test(link)) return;
    if (/duckduckgo\.com\//i.test(link)) return;
    rows.push({ title, link });
  });

  return rows;
}

function parseBaiduResults(html, maxResults = 5) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('h3 a').each((_, el) => {
    if (rows.length >= maxResults) return false;

    const title = $(el).text().replace(/\s+/g, ' ').trim();
    let link = String($(el).attr('href') || '').trim();
    if (!title || !link) return;

    if (link.startsWith('/')) link = `https://www.baidu.com${link}`;
    if (!/^https?:\/\//i.test(link)) return;
    if (seen.has(link)) return;
    seen.add(link);

    const block = $(el).closest('div');
    const desc = block.find('.c-abstract,.c-span-last,.content-right_8Zs40').first().text().replace(/\s+/g, ' ').trim();

    rows.push({ title, link, desc });
  });

  return rows;
}

function parseBingResults(html, maxResults = 5) {
  const $ = cheerio.load(String(html || ''));
  const rows = [];
  const seen = new Set();

  $('li.b_algo').each((_, el) => {
    if (rows.length >= maxResults) return false;
    const anchor = $(el).find('h2 a').first();
    const title = anchor.text().replace(/\s+/g, ' ').trim();
    const link = String(anchor.attr('href') || '').trim();
    if (!title || !link || !/^https?:\/\//i.test(link)) return;
    if (seen.has(link)) return;
    seen.add(link);

    const desc = $(el).find('.b_caption p').first().text().replace(/\s+/g, ' ').trim();
    rows.push({ title, link, desc });
  });

  return rows;
}

function formatSearchRows(rows = [], title = '搜索结果') {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const out = rows.map((row, i) => {
    const desc = String(row.desc || '').trim();
    return desc
      ? `${i + 1}. ${row.title}\n   ${desc}\n   ${row.link}`
      : `${i + 1}. ${row.title}\n   ${row.link}`;
  });
  return `${title}：\n\n${out.join('\n\n')}`;
}

async function searchWikipediaOpenSearch(query, host = 'zh.wikipedia.org') {
  const resp = await withRetry(
    () => http.get(`https://${host}/w/api.php`, {
      params: {
        action: 'opensearch',
        search: query,
        limit: 3,
        namespace: 0,
        format: 'json'
      },
      timeout: 12000
    }),
    2,
    900
  );

  const arr = resp.data;
  const titles = arr?.[1] || [];
  const descs = arr?.[2] || [];
  const links = arr?.[3] || [];
  if (!titles.length) return [];

  return titles.map((t, i) => ({
    title: t,
    desc: descs[i] || '暂无简介',
    link: links[i] || '无链接'
  }));
}

async function web_search(query) {
  const q = String(query || '').trim();
  if (!q) {
    return '请先告诉我要搜索什么。';
  }

  let mainErr = null;
  let backupErr = null;
  let tertiaryErr = null;
  let quaternaryErr = null;
  let quinaryErr = null;

  try {
    const localMain = await withRetry(
      () => http.get('https://www.baidu.com/s', {
        params: { wd: q, rn: 6 },
        timeout: 10000,
        headers: {
          Referer: 'https://www.baidu.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MizukiBot/1.0'
        }
      }),
      1,
      600
    );

    const mainRows = parseBaiduResults(localMain.data, 5);
    if (mainRows.length > 0) {
      return formatSearchRows(mainRows, `关于“${q}”的搜索结果`);
    }
    throw new Error('BAIDU_EMPTY_RESULT');
  } catch (error) {
    mainErr = error;
    try {
      const localBackup = await withRetry(
        () => http.get('https://www.bing.com/search', {
          params: { q, count: 6, setlang: 'zh-Hans' },
          timeout: 10000
        }),
        1,
        600
      );

      const backupRows = parseBingResults(localBackup.data, 5);
      if (backupRows.length > 0) {
        return formatSearchRows(backupRows, `关于“${q}”的备用结果`);
      }
      throw new Error('BING_EMPTY_RESULT');
    } catch (e2) {
      backupErr = e2;
    }
  }

  try {
    const resp = await withRetry(
      () => http.get('https://api.duckduckgo.com/', {
        params: {
          q,
          format: 'json',
          no_html: 1,
          skip_disambig: 1
        },
        timeout: 12000
      }),
      1,
      900
    );

    const d = resp.data || {};
    const lines = [];

    if (d.AbstractText) {
      lines.push(`摘要：${d.AbstractText}`);
    }

    if (Array.isArray(d.RelatedTopics) && d.RelatedTopics.length > 0) {
      const topics = d.RelatedTopics
        .flatMap((item) => (item.Topics ? item.Topics : [item]))
        .filter((item) => item && item.Text)
        .slice(0, 3);

      if (topics.length > 0) {
        lines.push('相关结果：');
        topics.forEach((t, i) => lines.push(`${i + 1}. ${t.Text}`));
      }
    }

    if (lines.length > 0) {
      return `关于“${q}”的搜索结果：\n\n${lines.join('\n')}`;
    }

    throw new Error('DDG_EMPTY_RESULT');
  } catch (error) {
    tertiaryErr = error;
    try {
      const lite = await withRetry(
        () => http.get('https://lite.duckduckgo.com/lite/', {
          params: { q },
          timeout: 12000
        }),
        1,
        900
      );

      const rows = parseDuckDuckGoLiteResults(lite.data, 5);
      if (rows.length > 0) {
        const formatted = rows.map((row, i) => `${i + 1}. ${row.title}\n   ${row.link}`);
        return `关于“${q}”的备用结果：\n\n${formatted.join('\n\n')}`;
      }

      throw new Error('DDG_LITE_EMPTY_RESULT');
    } catch (e2) {
      quaternaryErr = e2;
      try {
        let wikiRows = await searchWikipediaOpenSearch(q, 'zh.wikipedia.org');
        if (!wikiRows.length) {
          // 中文无结果时再尝试英文站，减少“空结果”误判。
          wikiRows = await searchWikipediaOpenSearch(q, 'en.wikipedia.org');
        }

        if (!wikiRows.length) {
          return `没有搜到“${q}”的公开结果，建议换个关键词。`;
        }

        const out = wikiRows.map((row, i) => `${i + 1}. ${row.title}\n   ${row.desc}\n   ${row.link}`);
        return `关于“${q}”的备用结果：\n\n${out.join('\n\n')}`;
      } catch (e3) {
        quinaryErr = e3;
        console.error('web_search fallback error:', {
          main: summarizeError(mainErr),
          backup: summarizeError(backupErr),
          tertiary: summarizeError(tertiaryErr),
          quaternary: summarizeError(quaternaryErr),
          quinary: summarizeError(quinaryErr)
        });

        if (
          isNetworkError(mainErr)
          && isNetworkError(backupErr)
          && isNetworkError(tertiaryErr)
          && isNetworkError(quaternaryErr)
          && isNetworkError(quinaryErr)
        ) {
          return '搜索服务网络暂时不稳定（连接超时/重置），请稍后再试。';
        }
        return '搜索服务暂时不可用，请稍后再试。';
      }
    }
  }
}

async function search_academic_paper(keywords) {
  const q = String(keywords || '').trim();
  if (!q) {
    return '请先提供论文检索关键词。';
  }

  try {
    const response = await withRetry(
      () => http.get('https://api.crossref.org/works', {
        params: {
          query: q,
          select: 'title,abstract,author,DOI',
          rows: 3
        },
        timeout: 10000
      }),
      1
    );

    const items = response.data?.message?.items;
    if (!items || items.length === 0) {
      return `没有检索到和“${q}”相关的论文。`;
    }

    const resultList = items.map((item, idx) => {
      const title = item.title?.[0] || '未知标题';
      const abstract = item.abstract
        ? item.abstract.replace(/<[^>]+>/g, '').slice(0, 180) + '...'
        : '无摘要';
      const doi = item.DOI ? `https://doi.org/${item.DOI}` : '无 DOI 链接';

      return `${idx + 1}. ${title}\n   摘要：${abstract}\n   链接：${doi}`;
    });

    return resultList.join('\n\n');
  } catch (error) {
    console.error('search_academic_paper error:', error.code || error.message);
    return '论文检索服务暂时不可用。';
  }
}

async function query_arcaea_info(song_name) {
  const song = String(song_name || '').trim();
  if (!song) {
    return '请告诉我想查的 Arcaea 曲名或缩写。';
  }

  const API_BASE = 'https://arcapi.vcanbb.top/api/v4';

  try {
    const response = await withRetry(
      () => http.get(`${API_BASE}/song/info`, {
        params: { songname: song },
        timeout: 10000
      }),
      1
    );

    const data = response.data;
    if (data?.status === 0 && data.content) {
      const info = data.content;
      const diffNames = ['PST', 'PRS', 'FTR', 'BYD', 'ETR'];
      const diffs = Array.isArray(info.difficulties) ? info.difficulties : [];

      const diffDetails = diffs.map((d) => {
        const name = diffNames[d.ratingClass] || 'UNK';
        const ccRaw = Number.isFinite(d.chart_constant) ? d.chart_constant : null;
        const constant = ccRaw !== null ? (ccRaw / 10).toFixed(1) : '未知';
        return `${name}: Lv.${d.rating ?? '?'} (${constant})`;
      });

      return [
        `曲名：${info.title_en || info.title_localized?.en || '未知曲名'}`,
        `艺术家：${info.artist || '未知'}`,
        `BPM：${info.bpm || '未知'}`,
        '难度：',
        ...(diffDetails.length ? diffDetails : ['暂无难度数据']),
        `曲包：${info.set_friendly || '未知'}`
      ].join('\n');
    }

    if (data?.status === -5) {
      return `没有找到“${song}”对应的曲目。`;
    }

    return 'Arcaea 数据服务返回了未知状态。';
  } catch (error) {
    console.error('query_arcaea_info error:', error.code || error.message);
    return 'Arcaea 查询失败，请稍后再试。';
  }
}

async function currency_convert(from, to, amount = 1) {
  const f = String(from || '').toUpperCase().trim();
  const t = String(to || '').toUpperCase().trim();
  const n = Number(amount);

  if (!f || !t || !Number.isFinite(n) || n <= 0) {
    return '参数格式不正确，示例：100 CNY JPY。';
  }

  try {
    const resp = await withRetry(
      () => http.get(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`, {
        timeout: 10000
      }),
      1
    );

    const rate = resp.data?.rates?.[t];
    if (!rate || !Number.isFinite(rate)) throw new Error('PRIMARY_NO_RATE');

    const result = (n * rate).toFixed(4);
    return `${n} ${f} ≈ ${result} ${t}`;
  } catch (error) {
    try {
      const backup = await withRetry(
        () => http.get('https://api.frankfurter.app/latest', {
          params: { from: f, to: t },
          timeout: 10000
        }),
        1
      );

      const rate = backup.data?.rates?.[t];
      if (!rate || !Number.isFinite(rate)) {
        return `无法完成 ${f} -> ${t} 的换算，请检查货币代码。`;
      }

      const result = (n * rate).toFixed(4);
      return `${n} ${f} ≈ ${result} ${t}`;
    } catch (e2) {
      console.error('currency_convert error:', {
        main: error.code || error.message,
        backup: e2.code || e2.message
      });
      return '汇率服务暂时不可用，请稍后再试。';
    }
  }
}

async function get_bilibili_hot() {
  try {
    const response = await withRetry(
      () => http.get('https://api.bilibili.com/x/web-interface/search/square?limit=10', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://www.bilibili.com'
        },
        timeout: 8000
      }),
      1
    );

    const list = response.data?.data?.trending?.list;
    if (!Array.isArray(list) || list.length === 0) {
      return '暂时拿不到 B 站热搜。';
    }

    const hotList = list.slice(0, 10).map((item, index) => `${index + 1}. ${item.keyword}`);
    return `B站热搜：\n\n${hotList.join('\n')}`;
  } catch (error) {
    console.error('get_bilibili_hot error:', error.code || error.message);
    return 'B站热搜查询失败，请稍后再试。';
  }
}

module.exports = {
  getLyrics,
  getWeather,
  search_nearby_places,
  search_academic_paper,
  query_arcaea_info,
  get_bilibili_hot,
  web_search,
  currency_convert
};
