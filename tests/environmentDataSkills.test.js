const assert = require('assert');
const sharp = require('sharp');

const {
  queryLatestEarthquakes
} = require('../api/skills_native/earthquake');
const {
  AMAP_GEOCODE_URL,
  AMAP_WEATHER_URL,
  getWeatherSummary
} = require('../api/skills_native/weather');
const {
  MAX_SOURCE_IMAGE_BYTES,
  PRODUCTS,
  sendLatestWeatherCloud
} = require('../api/skills_native/weatherCloud');

const FIXED_NOW = new Date('2026-08-02T06:00:00.000Z');
const LATEST_IMAGE_URL = 'https://img.nsmc.org.cn/CLOUDIMAGE/FY4B/latest.JPG';
const LATEST_THUMBNAIL_URL = 'https://img.nsmc.org.cn/CLOUDIMAGE/FY4B/latest.JPG-thumb.JPG';
const PREVIOUS_IMAGE_URL = 'https://img.nsmc.org.cn/CLOUDIMAGE/FY4B/previous.JPG';

function cloudFeed({ includeThumbnail = false } = {}) {
  return [
    '<imagelist>',
    includeThumbnail ? `<image time="2026-08-02 05:20 (UTC)" url="${LATEST_THUMBNAIL_URL}"/>` : '',
    `<image time="2026-08-02 05:20 (UTC)" url="${LATEST_IMAGE_URL}"/>`,
    `<image time="2026-08-02 05:10 (UTC)" url="${PREVIOUS_IMAGE_URL}"/>`,
    '</imagelist>'
  ].join('');
}

function earthquakeResponse(features = []) {
  return {
    data: {
      type: 'FeatureCollection',
      features
    }
  };
}

function earthquakeFeature(overrides = {}) {
  return {
    id: 'us7000test',
    properties: {
      mag: 5.2,
      place: '100 km W of Test City',
      time: Date.parse('2026-08-02T05:00:00.000Z'),
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',
      ...overrides.properties
    },
    geometry: {
      type: 'Point',
      coordinates: [120.5, 30.2, 12.3],
      ...overrides.geometry
    }
  };
}

function createWeatherHttpClient({ geocodes, live, forecast, status = '1' } = {}) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, options });
      if (url === AMAP_GEOCODE_URL) {
        return {
          data: {
            status,
            info: status === '1' ? 'OK' : 'INVALID_USER_KEY',
            geocodes: geocodes ?? [{ adcode: '310000', formatted_address: '上海市' }]
          }
        };
      }
      if (url !== AMAP_WEATHER_URL) throw new Error(`unexpected weather url: ${url}`);
      if (options.params.extensions === 'base') {
        return {
          data: {
            status,
            info: status === '1' ? 'OK' : 'INVALID_USER_KEY',
            lives: live ?? [{
              province: '上海',
              city: '上海市',
              weather: '晴',
              temperature: '35',
              winddirection: '东北',
              windpower: '3',
              humidity: '46',
              reporttime: '2026-08-02 14:00:00'
            }]
          }
        };
      }
      return {
        data: {
          status,
          info: status === '1' ? 'OK' : 'INVALID_USER_KEY',
          forecasts: forecast ?? [{
            province: '上海',
            city: '上海市',
            reporttime: '2026-08-02 14:00:00',
            casts: Array.from({ length: 5 }, (_, index) => ({
              date: `2026-08-0${index + 2}`,
              dayweather: index === 1 ? '多云' : '晴',
              nightweather: index === 1 ? '雷阵雨' : '晴',
              daytemp: String(35 - index),
              nighttemp: String(27 - index),
              daywind: '东',
              nightwind: '东北',
              daypower: '3',
              nightpower: '3'
            }))
          }]
        }
      };
    }
  };
}

function createCloudHttpClient({
  xml = cloudFeed(),
  latestImage,
  previousImage,
  thumbnailImage,
  failLatestStatus = null,
  contentType = 'image/jpeg'
} = {}) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, options });
      if (url.endsWith('.xml')) return { data: xml };
      if (url === LATEST_THUMBNAIL_URL) {
        return { data: thumbnailImage || latestImage, headers: { 'content-type': contentType } };
      }
      if (url === LATEST_IMAGE_URL && failLatestStatus) {
        const error = new Error('latest image unavailable');
        error.response = { status: failLatestStatus };
        throw error;
      }
      if (url === LATEST_IMAGE_URL) return { data: latestImage, headers: { 'content-type': contentType } };
      if (url === PREVIOUS_IMAGE_URL) return { data: previousImage || latestImage, headers: { 'content-type': contentType } };
      throw new Error(`unexpected cloud url: ${url}`);
    }
  };
}

module.exports = (async () => {
  const earthquakeCalls = [];
  const earthquakeHttp = {
    async get(url, options = {}) {
      earthquakeCalls.push({ url, options });
      return earthquakeResponse([earthquakeFeature()]);
    }
  };

  const globalResult = await queryLatestEarthquakes({}, {
    httpClient: earthquakeHttp,
    now: () => FIXED_NOW
  });
  const globalParams = earthquakeCalls[0].options.params;
  assert.strictEqual(earthquakeCalls[0].url, 'https://earthquake.usgs.gov/fdsnws/event/1/query');
  assert.strictEqual(globalParams.format, 'geojson');
  assert.strictEqual(globalParams.orderby, 'time');
  assert.strictEqual(globalParams.limit, 5);
  assert.strictEqual(globalParams.minmagnitude, 4.5);
  assert.strictEqual(globalParams.starttime, '2026-08-01T06:00:00.000Z');
  assert.ok(!Object.prototype.hasOwnProperty.call(globalParams, 'minlatitude'));
  assert.match(globalResult, /全球/);
  assert.match(globalResult, /M5\.2/);
  assert.match(globalResult, /UTC 2026-08-02 05:00/);
  assert.match(globalResult, /北京时间 2026-08-02 13:00/);
  assert.match(globalResult, /深度：12\.3 km/);
  assert.match(globalResult, /USGS/);

  earthquakeCalls.length = 0;
  await queryLatestEarthquakes({ scope: 'china', time_window: 'week', limit: 2 }, {
    httpClient: earthquakeHttp,
    now: () => FIXED_NOW
  });
  const chinaParams = earthquakeCalls[0].options.params;
  assert.strictEqual(chinaParams.minmagnitude, 2.5);
  assert.strictEqual(chinaParams.limit, 2);
  assert.strictEqual(chinaParams.starttime, '2026-07-26T06:00:00.000Z');
  assert.deepStrictEqual({
    minlatitude: chinaParams.minlatitude,
    maxlatitude: chinaParams.maxlatitude,
    minlongitude: chinaParams.minlongitude,
    maxlongitude: chinaParams.maxlongitude
  }, {
    minlatitude: 18,
    maxlatitude: 54,
    minlongitude: 73,
    maxlongitude: 135
  });

  earthquakeCalls.length = 0;
  await queryLatestEarthquakes({
    scope: 'china',
    time_window: 'month',
    min_magnitude: 4,
    limit: 1
  }, {
    httpClient: earthquakeHttp,
    now: () => FIXED_NOW
  });
  const customParams = earthquakeCalls[0].options.params;
  assert.strictEqual(customParams.minmagnitude, 4);
  assert.strictEqual(customParams.limit, 1);
  assert.strictEqual(customParams.starttime, '2026-07-03T06:00:00.000Z');

  const emptyResult = await queryLatestEarthquakes({ min_magnitude: 9 }, {
    httpClient: { get: async () => earthquakeResponse([]) },
    now: () => FIXED_NOW
  });
  assert.match(emptyResult, /没有符合条件的地震事件/);

  const weatherHttp = createWeatherHttpClient();
  const weatherResult = await getWeatherSummary({ location: '帮我查一下上海今天天气怎么样' }, {
    apiKey: 'unit-test-key',
    httpClient: weatherHttp
  });
  assert.strictEqual(weatherHttp.calls.length, 3);
  assert.strictEqual(weatherHttp.calls[0].url, AMAP_GEOCODE_URL);
  assert.deepStrictEqual(weatherHttp.calls[0].options.params, { address: '上海', key: 'unit-test-key' });
  assert.deepStrictEqual(
    weatherHttp.calls.slice(1).map((call) => call.options.params.extensions).sort(),
    ['all', 'base']
  );
  assert.ok(weatherHttp.calls.slice(1).every((call) => call.options.params.city === '310000'));
  assert.match(weatherResult, /高德天气｜上海市/);
  assert.match(weatherResult, /实况：晴，35℃，湿度 46%/);
  assert.match(weatherResult, /多云转雷阵雨/);
  assert.strictEqual((weatherResult.match(/^2026-/gm) || []).length, 4);
  assert.doesNotMatch(weatherResult, /unit-test-key/);
  assert.match(weatherResult, /来源：高德开放平台/);

  const noLocationResult = await getWeatherSummary({ location: '今天天气怎么样' }, {
    apiKey: 'unit-test-key',
    httpClient: createWeatherHttpClient()
  });
  assert.match(noLocationResult, /请提供要查询的城市/);

  const emptyLocationResult = await getWeatherSummary({}, {
    apiKey: 'unit-test-key',
    httpClient: createWeatherHttpClient()
  });
  assert.match(emptyLocationResult, /请提供要查询的城市/);

  const noGeocodeResult = await getWeatherSummary({ city: '不存在的地方' }, {
    apiKey: 'unit-test-key',
    httpClient: createWeatherHttpClient({ geocodes: [] })
  });
  assert.match(noGeocodeResult, /未找到/);

  await assert.rejects(
    getWeatherSummary({ location: '上海' }, { apiKey: '', httpClient: createWeatherHttpClient() }),
    /AMAP_KEY is not configured/
  );
  await assert.rejects(
    getWeatherSummary({ location: '上海' }, {
      apiKey: 'secret-value',
      httpClient: createWeatherHttpClient({ status: '0' })
    }),
    (error) => /AMap geocoding failed/.test(error.message) && !error.message.includes('secret-value')
  );
  await assert.rejects(
    getWeatherSummary({ location: '上海' }, {
      apiKey: 'unit-test-key',
      httpClient: createWeatherHttpClient({ live: [], forecast: [] })
    }),
    /response is invalid/
  );

  const smallImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#4786b5' }
  }).jpeg().toBuffer();
  const thumbnailImage = await sharp({
    create: { width: 320, height: 180, channels: 3, background: '#7bb36a' }
  }).jpeg().toBuffer();
  const largeImage = await sharp({
    create: { width: 5000, height: 3000, channels: 3, background: '#5d6d7e' }
  }).jpeg().toBuffer();

  const groupCloudHttp = createCloudHttpClient({ latestImage: smallImage });
  const groupSends = [];
  const groupResult = JSON.parse(await sendLatestWeatherCloud({
    channel: 'infrared',
    area: 'china',
    __context: { chatType: 'group', groupId: 'g1', userId: 'u1' }
  }, {
    httpClient: groupCloudHttp,
    sendImageMessageForContext: async (context, image) => {
      groupSends.push({ context, image });
      return { messageId: 'group-message' };
    }
  }));
  assert.strictEqual(groupCloudHttp.calls[0].url, PRODUCTS.china.channels.infrared.feedUrl);
  assert.strictEqual(groupSends.length, 1);
  assert.strictEqual(groupSends[0].context.groupId, 'g1');
  assert.deepStrictEqual(groupSends[0].image, smallImage);
  assert.strictEqual(groupResult.status, 'sent');
  assert.strictEqual(groupResult.area, 'china');
  assert.strictEqual(groupResult.channel, 'infrared');
  assert.strictEqual(groupResult.observed_at_utc, '2026-08-02T05:20:00.000Z');
  assert.strictEqual(groupResult.observed_at_beijing, '2026-08-02 13:20');
  assert.strictEqual(groupResult.message_id, 'group-message');
  assert.strictEqual(groupResult.image_url, LATEST_IMAGE_URL);
  assert.match(groupResult.source, /国家卫星气象中心/);

  const privateCloudHttp = createCloudHttpClient({
    latestImage: smallImage,
    previousImage: thumbnailImage,
    failLatestStatus: 404
  });
  const privateSends = [];
  const privateResult = JSON.parse(await sendLatestWeatherCloud({
    channel: 'water_vapor',
    area: 'full_disk',
    __context: { chatType: 'private', userId: 'u2' }
  }, {
    httpClient: privateCloudHttp,
    sendImageMessageForContext: async (context, image) => {
      privateSends.push({ context, image });
      return { messageId: 'private-message' };
    }
  }));
  assert.strictEqual(privateCloudHttp.calls[0].url, PRODUCTS.full_disk.channels.water_vapor.feedUrl);
  assert.strictEqual(privateSends.length, 1);
  assert.strictEqual(privateSends[0].context.userId, 'u2');
  assert.strictEqual(privateResult.image_url, PREVIOUS_IMAGE_URL);
  assert.strictEqual(privateResult.observed_at_utc, '2026-08-02T05:10:00.000Z');
  assert.strictEqual(privateCloudHttp.calls.filter((call) => call.url.endsWith('.JPG')).length, 2);

  const visibleCloudHttp = createCloudHttpClient({
    xml: cloudFeed({ includeThumbnail: true }),
    latestImage: largeImage,
    thumbnailImage
  });
  const visibleSends = [];
  const visibleResult = JSON.parse(await sendLatestWeatherCloud({
    channel: 'visible',
    __context: { chatType: 'private', userId: 'u3' }
  }, {
    httpClient: visibleCloudHttp,
    sendImageMessageForContext: async (_, image) => {
      visibleSends.push(image);
      return { messageId: 'visible-message' };
    }
  }));
  assert.strictEqual(visibleCloudHttp.calls[0].url, PRODUCTS.china.channels.visible.feedUrl);
  assert.strictEqual(visibleCloudHttp.calls[1].url, LATEST_THUMBNAIL_URL);
  assert.deepStrictEqual(visibleSends[0], thumbnailImage);
  assert.strictEqual(visibleResult.image_url, LATEST_IMAGE_URL);
  assert.strictEqual(visibleResult.area, 'china');

  const fullDiskVisibleHttp = createCloudHttpClient({ latestImage: largeImage });
  const fullDiskVisibleSends = [];
  await sendLatestWeatherCloud({
    channel: 'visible',
    area: 'full_disk',
    __context: { chatType: 'private', userId: 'u4' }
  }, {
    httpClient: fullDiskVisibleHttp,
    sendImageMessageForContext: async (_, image) => {
      fullDiskVisibleSends.push(image);
      return { messageId: 'full-disk-visible' };
    }
  });
  const resizedMetadata = await sharp(fullDiskVisibleSends[0]).metadata();
  assert.ok(Math.max(resizedMetadata.width, resizedMetadata.height) <= 2048);

  const failedSendHttp = createCloudHttpClient({ latestImage: smallImage });
  let failedSendCount = 0;
  const failedSendResult = JSON.parse(await sendLatestWeatherCloud({
    __context: { chatType: 'group', groupId: 'g2', userId: 'u5' }
  }, {
    httpClient: failedSendHttp,
    sendImageMessageForContext: async () => {
      failedSendCount += 1;
      throw new Error('NapCat offline');
    }
  }));
  assert.strictEqual(failedSendCount, 1);
  assert.strictEqual(failedSendResult.status, 'send_failed');
  assert.strictEqual(failedSendResult.image_url, LATEST_IMAGE_URL);

  await assert.rejects(
    sendLatestWeatherCloud({ __context: { chatType: 'private', userId: 'u6' } }, {
      httpClient: createCloudHttpClient({ latestImage: smallImage, contentType: 'text/html' }),
      sendImageMessageForContext: async () => ({ messageId: 'unexpected' })
    }),
    /JPEG/
  );

  await assert.rejects(
    sendLatestWeatherCloud({ __context: { chatType: 'private', userId: 'u7' } }, {
      httpClient: createCloudHttpClient({ latestImage: Buffer.from('not-a-jpeg') }),
      sendImageMessageForContext: async () => ({ messageId: 'unexpected' })
    }),
    /JPEG/
  );

  const oversizedImage = Buffer.alloc(MAX_SOURCE_IMAGE_BYTES + 1, 0);
  oversizedImage[0] = 0xff;
  oversizedImage[1] = 0xd8;
  oversizedImage[oversizedImage.length - 2] = 0xff;
  oversizedImage[oversizedImage.length - 1] = 0xd9;
  await assert.rejects(
    sendLatestWeatherCloud({ __context: { chatType: 'private', userId: 'u8' } }, {
      httpClient: createCloudHttpClient({ latestImage: oversizedImage }),
      sendImageMessageForContext: async () => ({ messageId: 'unexpected' })
    }),
    /JPEG|size/
  );

  const nonRetryHttp = createCloudHttpClient({ latestImage: smallImage, failLatestStatus: 500 });
  await assert.rejects(
    sendLatestWeatherCloud({ __context: { chatType: 'private', userId: 'u9' } }, {
      httpClient: nonRetryHttp,
      sendImageMessageForContext: async () => ({ messageId: 'unexpected' })
    }),
    /latest image unavailable/
  );
  assert.strictEqual(nonRetryHttp.calls.filter((call) => call.url.endsWith('.JPG')).length, 1);

  await assert.rejects(
    queryLatestEarthquakes({}, {
      httpClient: { get: async () => ({ data: {} }) },
      now: () => FIXED_NOW
    }),
    /response is invalid/
  );

  console.log('environmentDataSkills.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
