const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { sendImageMessageForContext } = require('../../../api/qqActionService');
const { reviewVisualRenderContent } = require('../../../utils/visualRenderModeration');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 15000;
const GROUP_IMAGE_INTENT = /(?:谱面图|譜面圖|看谱|看譜|发图|發圖)/i;

function resolveCurrentText(context = {}) {
  return String(context.rawText || context.question || context.cleanText || context.routeMeta?.rawText || '').trim();
}

function shouldSendChartImage(context = {}, text = resolveCurrentText(context)) {
  const chatType = String(context.chatType || context.routeMeta?.chatType || (context.groupId ? 'group' : 'private')).toLowerCase();
  return chatType === 'private' || GROUP_IMAGE_INTENT.test(String(text || ''));
}

function runPythonRenderer(payload, options = {}) {
  const python = String(options.python || process.env.PJSK_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'));
  const script = path.resolve(options.script || path.join(__dirname, '..', '..', '..', 'scripts', 'pjsk-render-chart.py'));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || RENDER_TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('PJSK renderer timed out')));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 8192) stderr.push(chunk);
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) return reject(new Error('PJSK renderer output is too large'));
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `PJSK renderer exited ${code}`));
      resolve(Buffer.concat(stdout));
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function constrainPng(buffer) {
  let output = buffer;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const metadata = await sharp(output).metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (metadata.format !== 'png' || width <= 0 || height <= 0) throw new Error('PJSK renderer returned an invalid PNG');
    const pixels = width * height;
    if (pixels <= MAX_IMAGE_PIXELS && output.length <= MAX_IMAGE_BYTES) return { buffer: output, width, height };
    const pixelScale = Math.sqrt(MAX_IMAGE_PIXELS / pixels);
    const byteScale = Math.sqrt(MAX_IMAGE_BYTES / output.length);
    const scale = Math.min(0.95, pixelScale, byteScale);
    output = await sharp(output)
      .resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  throw new Error('PJSK rendered PNG exceeds output limits');
}

async function renderChartImage(input = {}, options = {}) {
  const raw = await (options.runRenderer || runPythonRenderer)({
    sus: String(input.sus || ''),
    title: String(input.title || ''),
    artist: String(input.artist || ''),
    difficulty: String(input.difficulty || '').toUpperCase(),
    level: String(input.level || ''),
    fontDirs: options.fontDirs || [
      '/usr/share/fonts/opentype/noto',
      'C:\\Windows\\Fonts'
    ]
  }, options);
  return constrainPng(raw);
}

async function renderAndSendChart(input = {}, deps = {}) {
  const context = input.context || {};
  if (!shouldSendChartImage(context)) return { requested: false, status: 'not_requested' };
  const review = (deps.reviewContent || reviewVisualRenderContent)({
    prompt: resolveCurrentText(context),
    renderer: 'html',
    markup: String(input.chart?.title || '')
  }, deps.moderationOptions || {});
  if (!review.allowed) return { requested: true, status: 'blocked', reason: review.reason };
  let rendered;
  try {
    rendered = await (deps.renderChartImage || renderChartImage)({
      sus: input.sus,
      title: input.chart.title,
      artist: input.chart.composer || input.chart.lyricist || '',
      difficulty: input.chart.difficulty,
      level: input.chart.level
    }, deps.renderOptions || {});
  } catch (error) {
    return { requested: true, status: 'render_failed', reason: String(error.message || error) };
  }
  try {
    const sent = await (deps.sendImage || sendImageMessageForContext)(context, rendered.buffer, deps.sendOptions || {});
    return {
      requested: true,
      status: 'sent',
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.buffer.length,
      messageId: sent.messageId ?? null
    };
  } catch (error) {
    return {
      requested: true,
      status: 'send_failed',
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.buffer.length,
      reason: String(error.message || error)
    };
  }
}

module.exports = {
  GROUP_IMAGE_INTENT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  RENDER_TIMEOUT_MS,
  constrainPng,
  renderAndSendChart,
  renderChartImage,
  runPythonRenderer,
  shouldSendChartImage
};
