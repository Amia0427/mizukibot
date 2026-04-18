const { diagnosePersonaModules } = require('../utils/personaModules');

function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('usage: node scripts/diagnose-persona-modules.js <text>');
    process.exit(1);
  }

  const result = diagnosePersonaModules({ question });
  console.log(JSON.stringify(result, null, 2));
}

main();
