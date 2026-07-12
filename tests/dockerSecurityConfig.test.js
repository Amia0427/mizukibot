const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

function serviceBlock(name) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `${name} service must exist`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_.-]+:\s*$/.test(line) || (/^\S/.test(line) && line.trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

assert.match(
  dockerfile,
  /RUN mkdir -p \/app\/data[\s\S]*touch \/app\/runtime\.env[\s\S]*chown -R node:node \/app\/data \/app\/runtime\.env/
);
assert.match(dockerfile, /\nUSER node\s*\n[\s\S]*CMD \["node", "index\.js"\]/);
assert.match(
  compose,
  /127\.0\.0\.1:\$\{NAPCAT_HTTP_REVERSE_PORT:-3002\}:\$\{NAPCAT_HTTP_REVERSE_PORT:-3002\}/
);
assert.match(
  compose,
  /127\.0\.0\.1:\$\{WEB_PORT:-3005\}:\$\{WEB_PORT:-3005\}/
);
assert.match(compose, /healthcheck:[\s\S]*\/healthz/);
assert.match(compose, /depends_on:[\s\S]*mizukibot:[\s\S]*condition:\s*service_healthy/);

const expectedLimits = {
  mizukibot: { cpus: '2.0', memLimit: '2g', pidsLimit: 256 },
  'post-reply-worker': { cpus: '1.5', memLimit: '1536m', pidsLimit: 192 }
};

for (const [serviceName, expected] of Object.entries(expectedLimits)) {
  const service = serviceBlock(serviceName);
  assert.match(service, /^    user: node$/m);
  assert.match(service, /^    read_only: true$/m);
  assert.match(service, /^    init: true$/m);
  assert.match(service, /^    cap_drop:\s*\r?\n      - ALL$/m);
  assert.match(service, /^    security_opt:\s*\r?\n      - no-new-privileges:true$/m);
  assert.match(service, new RegExp(`^    cpus: "${expected.cpus}"$`, 'm'));
  assert.match(service, new RegExp(`^    mem_limit: ${expected.memLimit}$`, 'm'));
  assert.match(service, new RegExp(`^    pids_limit: ${expected.pidsLimit}$`, 'm'));
  assert.match(service, /^    stop_grace_period: 30s$/m);
  assert.match(service, /^    tmpfs:\s*\r?\n      - \/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777$/m);
  assert.match(service, /^      HOME: \/tmp$/m);
  assert.match(service, /^      TMPDIR: \/tmp$/m);
  assert.match(service, /^      XDG_CACHE_HOME: \/tmp\/\.cache$/m);
  assert.match(service, /^      - mizukibot-data:\/app\/data$/m);
  assert.match(service, /^    logging:\s*\r?\n      driver: local\s*\r?\n      options:\s*\r?\n        max-size: "10m"\s*\r?\n        max-file: "5"$/m);
  assert.doesNotMatch(service, /\/app\/logs/);
}

const mainService = serviceBlock('mizukibot');
const workerService = serviceBlock('post-reply-worker');
assert.match(mainService, /^      MIZUKIBOT_MAIN_LOCK_FILE: \/app\/data\/runtime\/main\/\.mizukibot\.lock$/m);
assert.match(mainService, /^      MIZUKIBOT_ENV_FILE: \/app\/runtime\.env$/m);
assert.match(mainService, /^      - \.\/\.env:\/app\/runtime\.env:rw$/m);
assert.doesNotMatch(workerService, /MIZUKIBOT_ENV_FILE|\/app\/runtime\.env/);
assert.match(workerService, /^      MIZUKIBOT_POST_REPLY_WORKER_PID_FILE: \/app\/data\/runtime\/post-reply-worker\/worker\.pid$/m);
assert.match(workerService, /^      MIZUKIBOT_POST_REPLY_WORKER_LOCK_FILE: \/app\/data\/runtime\/post-reply-worker\/worker\.lock$/m);
assert.match(workerService, /^    command: \["node", "scripts\/post-reply-worker\.js"\]$/m);
assert.doesNotMatch(compose, /mizukibot-logs|\/app\/logs/);
