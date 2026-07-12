'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workflow = fs.readFileSync(
  path.resolve(__dirname, '../.github/workflows/ci.yml'),
  'utf8'
);

assert.ok(!workflow.includes('pull_request_target'));
assert.match(workflow, /^permissions:\s*\n\s+contents: read/m);
assert.match(workflow, /^env:\s*\n\s+CI: ['"]true['"]/m);
assert.match(workflow, /AGENT_PROMPT_EXTRA_ROOTS: ['"]{2}/);
assert.match(workflow, /DATA_DIR: \$\{\{ runner\.temp \}\}\/mizuki-data/);
assert.match(workflow, /MIZUKIBOT_ENV_FILE: \$\{\{ runner\.temp \}\}\/mizukibot-ci\.env/);
assert.match(workflow, /^concurrency:/m);
assert.match(workflow, /cancel-in-progress: true/);
assert.match(workflow, /quality:\s*\n\s+runs-on: windows-latest/);
assert.match(workflow, /timeout-minutes: 15/);
assert.match(workflow, /node-version-file: ['"]\.nvmrc['"]/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /run: npm ci/);
assert.match(workflow, /run: npm run check:node/);
assert.match(workflow, /run: npm run lint/);
assert.match(workflow, /run: npm run typecheck/);
assert.match(workflow, /run: npm run check:prompts/);
assert.match(workflow, /run: npm run check:secrets:all/);
assert.match(workflow, /run: npm audit --omit=dev/);
assert.match(workflow, /npm test 2>&1 \| Tee-Object -FilePath test-output\.log/);
assert.match(workflow, /if: failure\(\)/);
assert.match(workflow, /actions\/upload-artifact@v4/);
assert.match(workflow, /linux-policy:\s*\n\s+runs-on: ubuntu-latest/);
assert.match(workflow, /bash -n scripts\/bootstrap-debian12\.sh scripts\/install-linux\.sh scripts\/check-linux\.sh/);

console.log('CI workflow tests passed');
