const {
  materializeMemoryV3Views,
  migrateLegacyMemoryToV3
} = require('../utils/memory-v3/migration');

function requireValue(argv, index, option) {
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    importLegacy: false,
    force: false,
    converge: false,
    dryRun: false,
    applyPlan: '',
    rollbackRun: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || '').trim();
    if (item === '--import-legacy') args.importLegacy = true;
    else if (item === '--force-import-legacy') throw new Error('--force-import-legacy is not supported; use convergence migration');
    else if (item === '--force') args.force = true;
    else if (item === '--converge') args.converge = true;
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--apply-plan') {
      args.applyPlan = requireValue(argv, index, item);
      index += 1;
    } else if (item === '--rollback-run') {
      args.rollbackRun = requireValue(argv, index, item);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }

  const convergenceAction = args.converge || args.applyPlan || args.rollbackRun;
  if (convergenceAction && (args.force || args.importLegacy)) {
    throw new Error('Convergence commands cannot be combined with legacy force/import options');
  }
  if (args.force) throw new Error('--force is not supported; use an explicit migration command');
  if (args.converge && !args.dryRun) throw new Error('--converge requires --dry-run');
  if (args.dryRun && !args.converge) throw new Error('--dry-run requires --converge');
  if ([args.converge, Boolean(args.applyPlan), Boolean(args.rollbackRun)].filter(Boolean).length > 1) {
    throw new Error('Choose exactly one convergence command');
  }
  return args;
}

async function executeCommand(args, deps = {}) {
  if (args.converge) {
    const convergence = deps.convergence || require('../utils/memory-v3/convergence');
    const preflight = await (deps.evaluateConvergencePreflight || convergence.evaluateConvergencePreflight)();
    const plan = (deps.buildConvergencePlan || convergence.buildConvergencePlan)({ preflight });
    return (deps.saveConvergencePlan || convergence.saveConvergencePlan)(plan);
  }
  if (args.applyPlan) {
    const apply = deps.applyConvergencePlan || require('../utils/memory-v3/convergence').applyConvergencePlan;
    return apply(args.applyPlan);
  }
  if (args.rollbackRun) {
    const rollback = deps.rollbackConvergenceRun || require('../utils/memory-v3/convergence').rollbackConvergenceRun;
    return rollback(args.rollbackRun);
  }
  if (args.importLegacy) {
    const migrate = deps.migrateLegacyMemoryToV3 || migrateLegacyMemoryToV3;
    return migrate({ forceImport: false });
  }
  const materialize = deps.materializeMemoryV3Views || materializeMemoryV3Views;
  return materialize({ force: true, source: 'migrate_memory_v3_cli' });
}

async function runCli(argv = process.argv.slice(2), deps = {}) {
  return executeCommand(parseArgs(argv), deps);
}

if (require.main === module) {
  runCli().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result?.ok === false ? 1 : 0;
  }).catch((error) => {
    console.error('[migrate-memory-v3] failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  executeCommand,
  parseArgs,
  runCli
};
