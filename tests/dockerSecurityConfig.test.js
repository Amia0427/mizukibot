const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const compose = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));

function parseDockerfileInstructions(source) {
  const logicalLines = [];
  let current = '';
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    current = current ? `${current} ${line}` : line;
    if (current.endsWith('\\')) {
      current = current.slice(0, -1).trim();
      continue;
    }
    const match = current.match(/^([A-Za-z]+)\s+(.+)$/);
    if (match) logicalLines.push({ instruction: match[1].toUpperCase(), value: match[2].trim() });
    current = '';
  }
  return logicalLines;
}

const dockerInstructions = parseDockerfileInstructions(dockerfile);
const runInstructions = dockerInstructions.filter((item) => item.instruction === 'RUN').map((item) => item.value);
assert.ok(runInstructions.some((value) => (
  value.includes('mkdir -p /app/data')
  && value.includes('touch /app/runtime.env')
  && value.includes('chown -R node:node /app/data /app/runtime.env')
)));
assert.strictEqual(dockerInstructions.filter((item) => item.instruction === 'USER').at(-1).value, 'node');
assert.deepStrictEqual(
  JSON.parse(dockerInstructions.filter((item) => item.instruction === 'CMD').at(-1).value),
  ['node', 'index.js']
);

const mainService = compose.services.mizukibot;
const workerService = compose.services['post-reply-worker'];
assert.ok(mainService.ports.includes(
  '127.0.0.1:${NAPCAT_HTTP_REVERSE_PORT:-3002}:${NAPCAT_HTTP_REVERSE_PORT:-3002}'
));
assert.ok(mainService.ports.includes('127.0.0.1:${WEB_PORT:-3005}:${WEB_PORT:-3005}'));
assert.ok(mainService.healthcheck.test.some((item) => String(item).includes('/ready')));
assert.strictEqual(workerService.depends_on.mizukibot.condition, 'service_healthy');
assert.ok(!Object.hasOwn(workerService, 'ports'));
assert.ok(workerService.healthcheck.test.some((item) => String(item).includes('check-post-reply-worker-ready.js')));

const expectedLimits = {
  mizukibot: { cpus: '2.0', memLimit: '2g', pidsLimit: 256 },
  'post-reply-worker': { cpus: '1.5', memLimit: '1536m', pidsLimit: 192 }
};

for (const [serviceName, expected] of Object.entries(expectedLimits)) {
  const service = compose.services[serviceName];
  assert.ok(service, `${serviceName} service must exist`);
  assert.strictEqual(service.user, 'node');
  assert.strictEqual(service.read_only, true);
  assert.strictEqual(service.init, true);
  assert.deepStrictEqual(service.cap_drop, ['ALL']);
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.strictEqual(service.cpus, expected.cpus);
  assert.strictEqual(service.mem_limit, expected.memLimit);
  assert.strictEqual(service.pids_limit, expected.pidsLimit);
  assert.strictEqual(service.stop_grace_period, '30s');
  assert.ok(service.tmpfs.includes('/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777'));
  assert.strictEqual(service.environment.HOME, '/tmp');
  assert.strictEqual(service.environment.TMPDIR, '/tmp');
  assert.strictEqual(service.environment.XDG_CACHE_HOME, '/tmp/.cache');
  assert.ok(service.volumes.includes('mizukibot-data:/app/data'));
  assert.strictEqual(service.logging.driver, 'local');
  assert.deepStrictEqual(service.logging.options, { 'max-size': '10m', 'max-file': '5' });
  assert.ok(service.volumes.every((volume) => !volume.includes('/app/logs')));
}

assert.strictEqual(mainService.environment.MIZUKIBOT_MAIN_LOCK_FILE, '/app/data/runtime/main/.mizukibot.lock');
assert.strictEqual(mainService.environment.MIZUKIBOT_ENV_FILE, '/app/runtime.env');
assert.ok(mainService.volumes.includes('./.env:/app/runtime.env:ro'));
assert.ok(!Object.hasOwn(workerService.environment, 'MIZUKIBOT_ENV_FILE'));
assert.ok(workerService.volumes.every((volume) => !volume.includes('/app/runtime.env')));
assert.strictEqual(
  workerService.environment.MIZUKIBOT_POST_REPLY_WORKER_PID_FILE,
  '/app/data/runtime/post-reply-worker/worker.pid'
);
assert.strictEqual(
  workerService.environment.MIZUKIBOT_POST_REPLY_WORKER_LOCK_FILE,
  '/app/data/runtime/post-reply-worker/worker.lock'
);
assert.deepStrictEqual(workerService.command, ['node', 'scripts/post-reply-worker.js']);
assert.ok(!Object.hasOwn(compose.volumes || {}, 'mizukibot-logs'));
for (const service of Object.values(compose.services)) {
  assert.ok((service.volumes || []).every((volume) => !volume.includes('/app/logs')));
}
