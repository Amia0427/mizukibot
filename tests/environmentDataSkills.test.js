const assert = require('assert');

const {
  queryLatestEarthquakes
} = require('../api/skills_native/earthquake');
const {
  sendLatestWeatherCloud
} = require('../api/skills_native/weatherCloud');

const FIXED_NOW = new Date('2026-08-02T06:00:00.000Z');
const JMA_PAGE = [
  '<select name="slt_time">',
  '<option value="0510">05:20 UTC 02 August 2026</option>',
  '<option value="0500">05:10 UTC 02 August 2026</option>',
  '</select>'
].join('');

function jpegBuffer(content = '') {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(content),
    Buffer.from([0xff, 0xd9])
  ]);
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

function createCloudHttpClient({ imageChannel = 'b13', failLatest = false, contentType = 'image/jpeg' } = {}) {
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url, options });
      if (url.includes('sat_img.php')) return { data: JMA_PAGE };
      if (!url.includes(`_${imageChannel}_`)) throw new Error(`unexpected channel url: ${url}`);
      if (failLatest && url.endsWith('_0510.jpg')) {
        const error = new Error('not ready');
        error.response = { status: 404 };
        throw error;
      }
      return {
        data: jpegBuffer(`cloud-${imageChannel}`),
        headers: { 'content-type': contentType }
      };
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

  const groupCloudHttp = createCloudHttpClient();
  const groupSends = [];
  const groupResult = JSON.parse(await sendLatestWeatherCloud({
    channel: 'infrared',
    __context: { chatType: 'group', groupId: 'g1', userId: 'u1' }
  }, {
    httpClient: groupCloudHttp,
    sendImageMessageForContext: async (context, image) => {
      groupSends.push({ context, image });
      return { messageId: 'group-message' };
    }
  }));
  assert.strictEqual(groupSends.length, 1);
  assert.strictEqual(groupSends[0].context.groupId, 'g1');
  assert.deepStrictEqual(groupSends[0].image, jpegBuffer('cloud-b13'));
  assert.strictEqual(groupResult.status, 'sent');
  assert.strictEqual(groupResult.channel, 'infrared');
  assert.strictEqual(groupResult.observed_at_utc, '2026-08-02T05:20:00.000Z');
  assert.strictEqual(groupResult.observed_at_beijing, '2026-08-02 13:20');
  assert.strictEqual(groupResult.message_id, 'group-message');
  assert.match(groupResult.image_url, /fd__b13_0510\.jpg$/);

  const privateCloudHttp = createCloudHttpClient({ imageChannel: 'b08', failLatest: true });
  const privateSends = [];
  const privateResult = JSON.parse(await sendLatestWeatherCloud({
    channel: 'water_vapor',
    __context: { chatType: 'private', userId: 'u2' }
  }, {
    httpClient: privateCloudHttp,
    sendImageMessageForContext: async (context, image) => {
      privateSends.push({ context, image });
      return { messageId: 'private-message' };
    }
  }));
  assert.strictEqual(privateSends.length, 1);
  assert.strictEqual(privateSends[0].context.userId, 'u2');
  assert.match(privateResult.image_url, /fd__b08_0500\.jpg$/);
  assert.strictEqual(privateResult.observed_at_utc, '2026-08-02T05:10:00.000Z');
  assert.strictEqual(privateCloudHttp.calls.filter((call) => call.url.includes('/img/')).length, 2);

  const visibleCloudHttp = createCloudHttpClient({ imageChannel: 'b03' });
  await sendLatestWeatherCloud({ channel: 'visible', __context: { chatType: 'private', userId: 'u3' } }, {
    httpClient: visibleCloudHttp,
    sendImageMessageForContext: async () => ({ messageId: 'visible-message' })
  });
  assert.ok(visibleCloudHttp.calls.some((call) => call.url.includes('_b03_')));

  const failedSendHttp = createCloudHttpClient();
  let failedSendCount = 0;
  const failedSendResult = JSON.parse(await sendLatestWeatherCloud({
    __context: { chatType: 'group', groupId: 'g2', userId: 'u4' }
  }, {
    httpClient: failedSendHttp,
    sendImageMessageForContext: async () => {
      failedSendCount += 1;
      throw new Error('NapCat offline');
    }
  }));
  assert.strictEqual(failedSendCount, 1);
  assert.strictEqual(failedSendResult.status, 'send_failed');
  assert.match(failedSendResult.image_url, /fd__b13_0510\.jpg$/);

  await assert.rejects(
    sendLatestWeatherCloud({ __context: { chatType: 'private', userId: 'u5' } }, {
      httpClient: createCloudHttpClient({ contentType: 'text/html' }),
      sendImageMessageForContext: async () => ({ messageId: 'unexpected' })
    }),
    /JPEG/
  );

  await assert.rejects(
    sendLatestWeatherCloud({ __context: { chatType: 'private', userId: 'u6' } }, {
      httpClient: {
        get: async (url) => url.includes('sat_img.php')
          ? { data: JMA_PAGE }
          : { data: Buffer.from('not-a-jpeg'), headers: { 'content-type': 'image/jpeg' } }
      },
      sendImageMessageForContext: async () => ({ messageId: 'unexpected' })
    }),
    /content is not JPEG/
  );

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
