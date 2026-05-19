const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatMb(bytes = 0) {
  return Math.round((normalizeNumber(bytes, 0) / 1024 / 1024) * 10) / 10;
}

function parseWindowsProcessResourceList(raw = '') {
  const text = normalizeText(raw);
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Math.max(0, Math.floor(normalizeNumber(row.ProcessId, 0))),
    ppid: Math.max(0, Math.floor(normalizeNumber(row.ParentProcessId, 0))),
    name: normalizeText(row.Name),
    commandLine: normalizeText(row.CommandLine),
    rss: Math.max(0, normalizeNumber(row.WorkingSetSize, 0))
  })).filter((row) => row.pid);
}

function parsePosixProcessResourceList(raw = '') {
  return String(raw || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    return {
      pid: Math.max(0, Math.floor(normalizeNumber(match[1], 0))),
      ppid: Math.max(0, Math.floor(normalizeNumber(match[2], 0))),
      rss: Math.max(0, normalizeNumber(match[3], 0) * 1024),
      name: normalizeText(match[4]),
      commandLine: normalizeText(match[5])
    };
  }).filter(Boolean);
}

function listProcessResourcesDefault() {
  try {
    if (process.platform === 'win32') {
      const command = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress";
      const raw = execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
      return parseWindowsProcessResourceList(raw);
    }
    const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm=,args='], {
      encoding: 'utf8',
      timeout: 5000
    });
    return parsePosixProcessResourceList(raw);
  } catch (_) {
    return [];
  }
}

function getDiagnosticProjectRoot() {
  return path.resolve(__dirname, '..', '..').replace(/\\/g, '/').toLowerCase();
}

function extractKnownProjectScriptTokens(cmd = '') {
  const tokens = [];
  const pattern = /"([^"]*(?:index|post-reply-worker|subagent-command-worker|backfill-memory-v3-embeddings|local-mcp-server)\.js)"|'([^']*(?:index|post-reply-worker|subagent-command-worker|backfill-memory-v3-embeddings|local-mcp-server)\.js)'|([^\s"]*(?:index|post-reply-worker|subagent-command-worker|backfill-memory-v3-embeddings|local-mcp-server)\.js)/ig;
  let match = pattern.exec(cmd);
  while (match) {
    tokens.push(normalizeText(match[1] || match[2] || match[3]).replace(/\\/g, '/').toLowerCase());
    match = pattern.exec(cmd);
  }
  return tokens.filter(Boolean);
}

function isAbsoluteLikePath(value = '') {
  return /^[a-z]:\//i.test(value) || value.startsWith('/');
}

function processMatchesProjectRoot(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  if (!cmd) return false;
  const root = getDiagnosticProjectRoot();
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;
  if (cmd.includes(rootWithSlash)) return true;

  const scriptTokens = extractKnownProjectScriptTokens(cmd);
  if (scriptTokens.length > 0) {
    return scriptTokens.some((token) => !isAbsoluteLikePath(token) || token.includes(rootWithSlash));
  }
  return true;
}

function shouldExcludeOpenclawGatewayProcess(proc = {}) {
  if (config.DIAGNOSTICS_EXCLUDE_OPENCLAW_GATEWAY === false) return false;
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  return cmd.includes('/openclaw/') && /\bgateway\b/.test(cmd);
}

function processMatchesMain(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  if (shouldExcludeOpenclawGatewayProcess(proc)) return false;
  return /(^|[\s/])index\.js(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc);
}

function processMatchesPostReplyWorker(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  return /(^|[\s/])post-reply-worker\.js(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc);
}

function processMatchesMemoryBackfill(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  return /(^|[\s/])backfill-memory-v3-embeddings\.js(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc);
}

function processMatchesLocalMcpChild(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  return /(^|[\s/])local-mcp-server\.js(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc);
}

function processMatchesSubagent(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  if (shouldExcludeOpenclawGatewayProcess(proc)) return false;
  if (!processMatchesProjectRoot(proc)) return false;
  return cmd.includes('subagent-command-worker.js')
    || cmd.includes('run-claude.ps1')
    || cmd.includes('subagent');
}

function compactProcessResource(proc = {}) {
  return {
    pid: Math.max(0, Math.floor(normalizeNumber(proc.pid, 0))),
    ppid: Math.max(0, Math.floor(normalizeNumber(proc.ppid, 0))),
    name: normalizeText(proc.name),
    rssMb: formatMb(proc.rss),
    commandLine: normalizeText(proc.commandLine).slice(0, 300)
  };
}

function summarizeProcessResources(processes = []) {
  const main = processes.filter(processMatchesMain);
  const postReply = processes.filter(processMatchesPostReplyWorker);
  const subagents = processes.filter(processMatchesSubagent);
  const memoryBackfill = processes.filter(processMatchesMemoryBackfill);
  const localMcpChildren = processes.filter(processMatchesLocalMcpChild);
  const summarize = (rows = []) => ({
    count: rows.length,
    processCount: rows.length,
    rssMb: {
      total: formatMb(rows.reduce((sum, row) => sum + normalizeNumber(row.rss, 0), 0)),
      max: formatMb(rows.reduce((max, row) => Math.max(max, normalizeNumber(row.rss, 0)), 0))
    },
    processes: rows.map(compactProcessResource).slice(0, 20)
  });
  return {
    main: summarize(main),
    postReplyWorker: summarize(postReply),
    subagents: summarize(subagents),
    memoryBackfill: summarize(memoryBackfill),
    localMcpChildren: summarize(localMcpChildren),
    allNodeLike: summarize(processes)
  };
}

module.exports = {
  listProcessResourcesDefault,
  parsePosixProcessResourceList,
  parseWindowsProcessResourceList,
  summarizeProcessResources
};
