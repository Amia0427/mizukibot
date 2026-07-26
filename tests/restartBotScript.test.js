'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runRestartBotBehaviorTest = require('./restartBotBehavior');

module.exports = (() => {
  const wrapper = fs.readFileSync(path.join(__dirname, '..', 'restart-bot.cmd'), 'utf8');
  assert.ok(wrapper.includes('scripts\\restart-bot.ps1'), 'cmd wrapper must invoke the production PowerShell entrypoint');
  assert.ok(wrapper.includes('restart confirm'), 'cmd wrapper must keep confirmed restart as the no-argument default');
  assert.ok(wrapper.includes('%*'), 'cmd wrapper must forward explicit arguments');
  assert.ok(!wrapper.includes('POWERSHELL_PAYLOAD'), 'cmd wrapper must not restore the embedded self-reading payload');

  runRestartBotBehaviorTest();
})();
