const path = require('path');
const { execFileSync } = require('child_process');
function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePid(value) {
  const pid = Math.floor(normalizeNumber(value, 0));
  return pid > 0 ? pid : 0;
}

function normalizeTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isProcessAliveDefault(pid = 0) {
  const targetPid = normalizePid(pid);
  if (!targetPid) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (error) {
    return normalizeText(error?.code).toUpperCase() === 'EPERM';
  }
}

function parseWindowsProcessList(raw = '') {
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
    pid: normalizePid(row.ProcessId),
    ppid: normalizePid(row.ParentProcessId),
    name: normalizeText(row.Name),
    commandLine: normalizeText(row.CommandLine),
    startTimeMs: normalizeTimeMs(row.StartTimeMs || row.CreationDate)
  })).filter((row) => row.pid);
}

function parseWindowsGetProcessList(raw = '') {
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
    pid: normalizePid(row.Id),
    ppid: 0,
    name: normalizeText(row.ProcessName || row.Name),
    commandLine: normalizeText(row.Path),
    startTimeMs: normalizeTimeMs(row.StartTimeMs || row.StartTime)
  })).filter((row) => row.pid);
}

function parsePosixProcessList(raw = '') {
  const now = Date.now();
  return String(raw || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    const rest = normalizeText(match[4]);
    const restParts = rest.split(/\s+/);
    const maybeElapsedSeconds = normalizeNumber(restParts[0], NaN);
    const hasElapsedSeconds = Number.isFinite(maybeElapsedSeconds) && /^\d+$/.test(restParts[0] || '');
    return {
      pid: normalizePid(match[1]),
      ppid: normalizePid(match[2]),
      name: normalizeText(match[3]),
      commandLine: hasElapsedSeconds ? normalizeText(restParts.slice(1).join(' ')) : rest,
      startTimeMs: hasElapsedSeconds ? Math.max(0, now - (maybeElapsedSeconds * 1000)) : 0
    };
  }).filter(Boolean);
}

function listProcessesDefault() {
  try {
    if (process.platform === 'win32') {
      const command = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='StartTimeMs';Expression={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } else { 0 }}} | ConvertTo-Json -Compress";
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
      const cimRows = parseWindowsProcessList(raw);
      if (cimRows.length > 0) return cimRows;

      const fallbackRaw = execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "Get-Process node,powershell,pwsh,cmd -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path,@{Name='StartTimeMs';Expression={try { ([DateTimeOffset]$_.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { 0 }}} | ConvertTo-Json -Compress"
      ], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
      return parseWindowsGetProcessList(fallbackRaw);
    }

    const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,etimes=,args='], {
      encoding: 'utf8',
      timeout: 5000
    });
    return parsePosixProcessList(raw);
  } catch (_) {
    return [];
  }
}

function listProcesses(options = {}) {
  if (typeof options.listProcesses === 'function') {
    return options.listProcesses().map((row) => ({
      pid: normalizePid(row.pid ?? row.ProcessId),
      ppid: normalizePid(row.ppid ?? row.ParentProcessId),
      name: normalizeText(row.name ?? row.Name),
      commandLine: normalizeText(row.commandLine ?? row.CommandLine),
      startTimeMs: normalizeTimeMs(row.startTimeMs ?? row.StartTimeMs ?? row.startTime ?? row.StartTime)
    })).filter((row) => row.pid);
  }
  return listProcessesDefault();
}

function findProcessByPid(processes = [], pid = 0) {
  const targetPid = normalizePid(pid);
  if (!targetPid) return null;
  return processes.find((proc) => normalizePid(proc.pid) === targetPid) || null;
}

function getDiagnosticProjectRoot(projectRoot = '') {
  return path.resolve(projectRoot || process.env.MIZUKIBOT_PROJECT_ROOT || path.join(__dirname, '..', '..')).replace(/\\/g, '/').toLowerCase();
}

function extractKnownProjectScriptTokens(cmd = '') {
  const tokens = [];
  const pattern = /"([^"]*(?:index|post-reply-worker)\.js)"|'([^']*(?:index|post-reply-worker)\.js)'|([^\s"]*(?:index|post-reply-worker)\.js)/ig;
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

function processMatchesProjectRoot(proc = {}, projectRoot = '') {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  if (!cmd) return false;
  const root = getDiagnosticProjectRoot(projectRoot);
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;
  if (cmd.includes(rootWithSlash)) return true;

  const scriptTokens = extractKnownProjectScriptTokens(cmd);
  if (scriptTokens.length > 0) {
    return scriptTokens.some((token) => !isAbsoluteLikePath(token) || token.includes(rootWithSlash));
  }
  return true;
}

function processMatchesMain(proc = {}, projectRoot = '') {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  return /(^|[\s/"'])index\.js(["']?)(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc, projectRoot);
}

function processMatchesPostReplyWorker(proc = {}, projectRoot = '') {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  return /(^|[\s/"'])post-reply-worker\.js(["']?)(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc, projectRoot);
}

function compactProcess(proc = null) {
  if (!proc) return null;
  return {
    pid: normalizePid(proc.pid),
    ppid: normalizePid(proc.ppid),
    name: normalizeText(proc.name),
    commandLine: normalizeText(proc.commandLine).slice(0, 500),
    startTimeMs: normalizeTimeMs(proc.startTimeMs)
  };
}

module.exports = {
  compactProcess,
  findProcessByPid,
  isProcessAliveDefault,
  listProcesses,
  listProcessesDefault,
  normalizePid,
  normalizeTimeMs,
  parsePosixProcessList,
  parseWindowsGetProcessList,
  parseWindowsProcessList,
  processMatchesProjectRoot,
  processMatchesMain,
  processMatchesPostReplyWorker
};
