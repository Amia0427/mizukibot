'use strict';

const { migrateLegacyFavorites, closeDb } = require('../utils/conversationVariables');

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

const apply = hasFlag('--apply');
const backup = !hasFlag('--no-backup');
const result = migrateLegacyFavorites({ apply, backup });
process.stdout.write(`${JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  ...result
}, null, 2)}\n`);
closeDb();
