const { auditLegacyProfileProjection } = require('../utils/memoryProfileSurface');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    userId: 'all',
    shadowMigration: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || '').trim();
    if (value === '--user' || value === '--user-id') {
      args.userId = String(argv[i + 1] || 'all').trim() || 'all';
      i += 1;
      continue;
    }
    if (value === '--shadow-migration') {
      args.shadowMigration = true;
      continue;
    }
    if (value && !value.startsWith('--')) args.userId = value;
  }
  return args;
}

function main() {
  const args = parseArgs();
  const report = auditLegacyProfileProjection(args.userId, {
    shadowMigration: args.shadowMigration
  });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs
};
