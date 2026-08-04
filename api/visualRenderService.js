const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const config = require('../config');

const MIN_WIDTH = 320;
const MAX_WIDTH = 1200;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 2000;
const DEFAULT_WIDTH = 800;
const DEFAULT_MAX_HEIGHT = 1600;
const MAX_MARKUP_CHARS = 100000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const BLOCKED_HTML_TAGS = new Set([
  'base', 'button', 'canvas', 'embed', 'form', 'iframe', 'img', 'input', 'link',
  'meta', 'object', 'picture', 'script', 'select', 'source', 'textarea', 'video', 'audio',
  'foreignobject'
]);
const BLOCKED_SVG_TAGS = new Set(['audio', 'canvas', 'foreignobject', 'iframe', 'image', 'script', 'video']);
const BLOCKED_PROTOCOL_PATTERN = /(?:^|[\s("'])(?:https?|file|javascript|data|blob):/i;
const SAFE_XML_NAMESPACES = new Map([
  ['xmlns', 'http://www.w3.org/2000/svg'],
  ['xmlns:xlink', 'http://www.w3.org/1999/xlink']
]);

class VisualRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VisualRenderError';
    this.code = code;
  }
}

function normalizeRenderer(value = '') {
  const renderer = String(value || '').trim().toLowerCase();
  if (!new Set(['svg', 'html']).has(renderer)) {
    throw new VisualRenderError('invalid_renderer', 'renderer must be svg or html');
  }
  return renderer;
}

function normalizeInteger(value, fallback, minimum, maximum, name) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new VisualRenderError('invalid_dimensions', `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function normalizeRenderInput(input = {}) {
  const renderer = normalizeRenderer(input.renderer);
  const markup = String(input.markup || '').trim();
  if (!markup) throw new VisualRenderError('empty_markup', 'markup is required');
  if (markup.length > MAX_MARKUP_CHARS) {
    throw new VisualRenderError('markup_too_large', `markup exceeds ${MAX_MARKUP_CHARS} characters`);
  }
  return {
    renderer,
    markup,
    width: normalizeInteger(input.width, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, 'width'),
    maxHeight: normalizeInteger(input.max_height, DEFAULT_MAX_HEIGHT, MIN_HEIGHT, MAX_HEIGHT, 'max_height')
  };
}

function assertSafeCss(css = '') {
  const source = String(css || '');
  if (/@import\b|expression\s*\(|-moz-binding\s*:/i.test(source)) {
    throw new VisualRenderError('unsafe_markup', 'external or executable CSS is not allowed');
  }
  for (const match of source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!String(match[2] || '').trim().startsWith('#')) {
      throw new VisualRenderError('unsafe_markup', 'external CSS resources are not allowed');
    }
  }
}

function assertSafeAttributes($, renderer) {
  const blockedTags = renderer === 'svg' ? BLOCKED_SVG_TAGS : BLOCKED_HTML_TAGS;
  $.root().find('*').each((_, element) => {
    const tagName = String(element.tagName || element.name || '').toLowerCase();
    if (blockedTags.has(tagName)) {
      throw new VisualRenderError('unsafe_markup', `<${tagName}> is not allowed`);
    }

    for (const [rawName, rawValue] of Object.entries(element.attribs || {})) {
      const name = String(rawName || '').toLowerCase();
      const value = String(rawValue || '').trim();
      if (name.startsWith('on')) {
        throw new VisualRenderError('unsafe_markup', 'event handler attributes are not allowed');
      }
      if (name === 'style') assertSafeCss(value);
      if (SAFE_XML_NAMESPACES.get(name) === value) continue;
      if (BLOCKED_PROTOCOL_PATTERN.test(value)) {
        throw new VisualRenderError('unsafe_markup', 'external resource protocols are not allowed');
      }
      if (new Set(['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction']).has(name)) {
        if (renderer !== 'svg' || !value.startsWith('#')) {
          throw new VisualRenderError('unsafe_markup', `attribute ${name} is not allowed`);
        }
      }
    }
  });
  $('style').each((_, element) => assertSafeCss($(element).text()));
}

function validateMarkup(markup = '', renderer = 'html') {
  const normalizedRenderer = normalizeRenderer(renderer);
  const source = String(markup || '').trim();
  let $;
  try {
    $ = normalizedRenderer === 'svg'
      ? cheerio.load(source, { xmlMode: true })
      : cheerio.load(source, undefined, false);
  } catch (_) {
    throw new VisualRenderError('invalid_markup', 'markup could not be parsed');
  }

  if (normalizedRenderer === 'svg') {
    const root = $.root().children().first();
    if (String(root[0]?.tagName || root[0]?.name || '').toLowerCase() !== 'svg') {
      throw new VisualRenderError('invalid_markup', 'SVG markup must have an svg root element');
    }
    const hasViewBox = Boolean(root.attr('viewBox') || root.attr('viewbox'));
    if (!hasViewBox && !(root.attr('width') && root.attr('height'))) {
      throw new VisualRenderError('invalid_markup', 'SVG markup requires viewBox or width and height');
    }
  } else if (/<(?:!doctype|html|head|body)\b/i.test(source)) {
    throw new VisualRenderError('invalid_markup', 'HTML renderer accepts fragments, not full documents');
  }

  assertSafeAttributes($, normalizedRenderer);
  return source;
}

function buildHtmlDocument(fragment = '', width = DEFAULT_WIDTH) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'none\'; font-src \'none\'; media-src \'none\'; connect-src \'none\'; frame-src \'none\';">',
    '<style>html,body{margin:0;padding:0;background:#fff}*{box-sizing:border-box;letter-spacing:0}#render-root{width:' + width + 'px;overflow:hidden;background:#fff}</style>',
    '</head><body><div id="render-root">',
    fragment,
    '</div></body></html>'
  ].join('');
}

function assertLocalHtmlEndpoint(endpoint = '') {
  let url;
  try {
    url = new URL(String(endpoint || ''));
  } catch (_) {
    throw new VisualRenderError('invalid_html_endpoint', 'HTML render endpoint is invalid');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(hostname)) {
    throw new VisualRenderError('invalid_html_endpoint', 'HTML render endpoint must use local HTTP');
  }
  return url.toString();
}

function decodeBase64Png(value = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/^data:image\/png;base64,/i, '')
    .replace(/\s+/g, '');
  if (!normalized || !/^[a-z0-9+/]*={0,2}$/i.test(normalized) || normalized.length % 4 === 1) {
    throw new VisualRenderError('invalid_html_response', 'HTML renderer returned invalid base64');
  }
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  const buffer = Buffer.from(padded, 'base64');
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new VisualRenderError('invalid_html_response', 'HTML renderer did not return a PNG image');
  }
  return buffer;
}

async function validatePngBuffer(buffer, input, sharpFactory = sharp) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new VisualRenderError('empty_output', 'renderer returned an empty image');
  }
  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new VisualRenderError('output_too_large', `rendered image exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  let metadata;
  try {
    metadata = await sharpFactory(buffer).metadata();
  } catch (_) {
    throw new VisualRenderError('invalid_output', 'rendered image is not readable');
  }
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw new VisualRenderError('invalid_output', 'rendered output must be PNG');
  }
  if (metadata.width > input.width || metadata.height > input.maxHeight) {
    throw new VisualRenderError('output_dimensions_exceeded', 'rendered image exceeds configured dimensions');
  }
  return { buffer, width: metadata.width, height: metadata.height, bytes: buffer.length };
}

async function renderSvg(input, deps = {}) {
  const sharpFactory = deps.sharpFactory || sharp;
  let buffer;
  try {
    buffer = await sharpFactory(Buffer.from(input.markup, 'utf8'), {
      density: 144,
      limitInputPixels: MAX_WIDTH * MAX_HEIGHT
    })
      .resize({ width: input.width, withoutEnlargement: false })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  } catch (error) {
    if (error instanceof VisualRenderError) throw error;
    throw new VisualRenderError('svg_render_failed', 'SVG rendering failed');
  }
  return validatePngBuffer(buffer, input, sharpFactory);
}

async function renderHtml(input, runtimeConfig, deps = {}) {
  const endpoint = assertLocalHtmlEndpoint(runtimeConfig.VISUAL_RENDER_HTML_API_URL);
  const timeout = Math.max(1000, Number(runtimeConfig.VISUAL_RENDER_TIMEOUT_MS) || 10000);
  const httpClient = deps.httpClient || axios;
  let response;
  try {
    response = await httpClient.post(endpoint, {
      html: buildHtmlDocument(input.markup, input.width),
      selector: '#render-root',
      encoding: 'base64',
      type: 'png',
      omitBackground: false,
      setViewport: {
        width: input.width,
        height: input.maxHeight,
        deviceScaleFactor: 1
      },
      pageGotoParams: {
        waitUntil: 'domcontentloaded',
        timeout
      },
      waitForSelector: '#render-root'
    }, {
      timeout,
      proxy: false,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (_) {
    throw new VisualRenderError('html_service_unavailable', 'HTML rendering service is unavailable');
  }

  const payload = response?.data || {};
  if (Number(payload.code) !== 0) {
    throw new VisualRenderError('html_render_failed', 'HTML rendering service rejected the request');
  }
  return validatePngBuffer(decodeBase64Png(payload.data), input, deps.sharpFactory || sharp);
}

async function renderVisual(rawInput = {}, deps = {}) {
  const runtimeConfig = deps.config || config;
  if (runtimeConfig.VISUAL_RENDER_ENABLED !== true) {
    throw new VisualRenderError('disabled', 'QQ visual rendering is disabled');
  }
  const input = normalizeRenderInput(rawInput);
  input.markup = validateMarkup(input.markup, input.renderer);
  const output = input.renderer === 'svg'
    ? await renderSvg(input, deps)
    : await renderHtml(input, runtimeConfig, deps);
  return { ...output, renderer: input.renderer };
}

module.exports = {
  DEFAULT_MAX_HEIGHT,
  DEFAULT_WIDTH,
  MAX_HEIGHT,
  MAX_MARKUP_CHARS,
  MAX_OUTPUT_BYTES,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  VisualRenderError,
  assertLocalHtmlEndpoint,
  buildHtmlDocument,
  decodeBase64Png,
  normalizeRenderInput,
  renderVisual,
  validateMarkup
};
