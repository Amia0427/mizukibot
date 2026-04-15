const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const appData = process.env.APPDATA || '';
const localAppData = process.env.LOCALAPPDATA || '';

function isDirectory(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function discoverNapCatRoots() {
  const roots = [];
  const seen = new Set();

  const tryAdd = (p) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (seen.has(resolved)) return;
    if (!isDirectory(resolved)) return;
    roots.push(resolved);
    seen.add(resolved);
  };

  // High priority: explicit root from launcher script.
  tryAdd(process.env.NAPCAT_ROOT);

  // Common project-local names.
  tryAdd(path.join(projectRoot, 'NapCat.Shell (2)'));
  tryAdd(path.join(projectRoot, 'NapCat.Shell'));
  tryAdd(path.join(projectRoot, 'napcat.shell'));
  tryAdd(path.join(projectRoot, 'third_party', 'napcat', 'NapCat-OneKey'));

  // Auto-discover all local folders containing "napcat" in name.
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.toLowerCase().includes('napcat')) continue;
      tryAdd(path.join(projectRoot, entry.name));
    }
  } catch (_) {}

  return roots;
}

const napCatRoots = discoverNapCatRoots();

const configCandidates = [
  ...napCatRoots.flatMap((root) => [
    path.join(root, 'config'),
    path.join(root, 'bootmain', 'config')
  ]),
  path.join(appData, 'QQ', 'config'),
  path.join(appData, 'Tencent', 'QQ', 'config'),
  path.join(appData, 'Tencent', 'QQNT', 'config'),
  path.join(localAppData, 'QQ', 'config'),
  path.join(localAppData, 'NapCat', 'config')
].filter(Boolean);

const defaultOnebotConfig = {
  network: {
    httpServers: [],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [
      {
        name: 'WsServer',
        enable: true,
        host: '127.0.0.1',
        port: 3001,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        token: '',
        enableForcePushEvent: true,
        debug: false,
        heartInterval: 30000
      }
    ],
    websocketClients: [],
    plugins: []
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function patchOnebotConfig(obj) {
  const next = obj && typeof obj === 'object' ? obj : {};
  if (!next.network || typeof next.network !== 'object') next.network = {};
  if (!Array.isArray(next.network.httpServers)) next.network.httpServers = [];
  if (!Array.isArray(next.network.httpSseServers)) next.network.httpSseServers = [];
  if (!Array.isArray(next.network.httpClients)) next.network.httpClients = [];
  if (!Array.isArray(next.network.websocketServers)) next.network.websocketServers = [];
  if (!Array.isArray(next.network.websocketClients)) next.network.websocketClients = [];
  if (!Array.isArray(next.network.plugins)) next.network.plugins = [];

  let found = false;
  next.network.websocketServers = next.network.websocketServers.map((s) => {
    const item = s && typeof s === 'object' ? s : {};
    const host = String(item.host || '').trim();
    const port = Number(item.port);
    if (host === '127.0.0.1' && port === 3001) {
      found = true;
      return {
        name: item.name || 'WsServer',
        enable: true,
        host: '127.0.0.1',
        port: 3001,
        messagePostFormat: item.messagePostFormat || 'array',
        reportSelfMessage: Boolean(item.reportSelfMessage),
        // Easy local mode: avoid token mismatch disconnect loops.
        token: '',
        enableForcePushEvent: item.enableForcePushEvent !== false,
        debug: Boolean(item.debug),
        heartInterval: Number(item.heartInterval) || 30000
      };
    }
    return item;
  });

  if (!found) {
    next.network.websocketServers.unshift({
      name: 'WsServer',
      enable: true,
      host: '127.0.0.1',
      port: 3001,
      messagePostFormat: 'array',
      reportSelfMessage: false,
      token: '',
      enableForcePushEvent: true,
      debug: false,
      heartInterval: 30000
    });
  }

  if (typeof next.musicSignUrl !== 'string') next.musicSignUrl = '';
  if (typeof next.enableLocalFile2Url !== 'boolean') next.enableLocalFile2Url = false;
  if (typeof next.parseMultMsg !== 'boolean') next.parseMultMsg = false;

  return next;
}

function updateDotEnv() {
  const envPath = path.join(projectRoot, '.env');
  const targetLine = 'NAPCAT_WS_URL=ws://127.0.0.1:3001';

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${targetLine}\n`, 'utf8');
    return { created: true, updated: true };
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let found = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*NAPCAT_WS_URL\s*=/.test(lines[i])) {
      lines[i] = targetLine;
      found = true;
      break;
    }
  }

  if (!found) lines.push(targetLine);
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  return { created: false, updated: true };
}

function walkForOnebotFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name.toLowerCase() === 'node_modules') continue;
        stack.push(full);
        continue;
      }

      if (/^onebot11(_\d+)?\.json$/i.test(e.name)) out.push(full);
    }
  }

  return out;
}

function main() {
  if (napCatRoots.length === 0) {
    console.warn('[WARN] No project-local NapCat root found. Patching only APPDATA/LOCALAPPDATA candidates.');
  }

  const touched = [];

  for (const dir of configCandidates) {
    try {
      ensureDir(dir);
      const file = path.join(dir, 'onebot11.json');
      const existing = readJson(file);
      const next = patchOnebotConfig(existing || defaultOnebotConfig);
      writeJson(file, next);
      touched.push(file);
    } catch (_) {}
  }

  const scanRoots = [...napCatRoots, appData, localAppData].filter(Boolean);
  const discovered = new Set();
  for (const root of scanRoots) {
    for (const file of walkForOnebotFiles(root)) discovered.add(file);
  }

  for (const file of discovered) {
    const existing = readJson(file);
    const next = patchOnebotConfig(existing || defaultOnebotConfig);
    try {
      writeJson(file, next);
      touched.push(file);
    } catch (_) {}
  }

  const envRes = updateDotEnv();

  console.log('=== NapCat + OneBot configuration done ===');
  console.log('Discovered NapCat roots:', napCatRoots.length ? napCatRoots.join(' | ') : '(none)');
  console.log('Patched config files:', touched.length);
  for (const f of touched.slice(0, 30)) console.log(' -', f);
  if (touched.length > 30) console.log(` - ... (${touched.length - 30} more)`);
  console.log('.env updated:', envRes.updated ? 'yes' : 'no');
  console.log('Expected OneBot WS endpoint: ws://127.0.0.1:3001 (token empty)');
}

main();
