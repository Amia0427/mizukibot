#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  DEFAULT_MANIFEST_PATH,
  REPORT_SCHEMA_VERSION,
  validateHarnessSuiteResult,
  writeJsonAtomic
} = require('./harness-eval-contract');
const {
  loadHarnessEvalManifest
} = require('./check-harness-eval-fixtures');
const {
  terminateProcessTree
} = require('./run-tests');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OS_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'TZ'
]);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    profile: 'ci',
    reportPath: path.join(PROJECT_ROOT, 'artifacts', 'harness-eval', 'ci.json')
  };
  let reportExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--manifest') {
      args.manifestPath = path.resolve(String(argv[index + 1] || ''));
      index += 1;
    } else if (item === '--profile') {
      args.profile = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (item === '--report') {
      args.reportPath = path.resolve(String(argv[index + 1] || ''));
      reportExplicit = true;
      index += 1;
    } else {
      throw new Error(`unknown argument ${item}`);
    }
  }
  if (!args.profile) throw new Error('--profile is required');
  if (!reportExplicit) {
    const fileName = args.profile.replace(/[^a-z0-9_-]+/gi, '-') || 'report';
    args.reportPath = path.join(PROJECT_ROOT, 'artifacts', 'harness-eval', `${fileName}.json`);
  }
  return args;
}

function buildHarnessChildEnv(parentEnv, tempDir, protocol) {
  const env = {};
  for (const key of OS_ENV_KEYS) {
    if (typeof parentEnv[key] === 'string') env[key] = parentEnv[key];
  }
  Object.assign(env, {
    CI: 'true',
    NODE_ENV: 'test',
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    TEST_TEMP_ROOT: path.join(tempDir, 'tests'),
    DATA_DIR: path.join(tempDir, 'data'),
    AGENT_PROMPT_EXTRA_ROOTS: '',
    MIZUKIBOT_ENV_FILE: path.join(tempDir, 'missing.env'),
    HARNESS_EVAL_MANIFEST_FILE: protocol.manifestPath,
    HARNESS_EVAL_SUITE_ID: protocol.suiteId,
    HARNESS_EVAL_RESULT_FILE: protocol.resultFile
  });
  return env;
}

function runNodeProcess(filePath, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', filePath], {
      cwd: options.projectRoot,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let spawnError = null;
    let terminationPromise = null;

    function terminate() {
      if (!terminationPromise) terminationPromise = terminateProcessTree(child);
      return terminationPromise;
    }

    function collect(chunk, target) {
      if (outputLimited) return;
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        outputLimited = true;
        terminate().catch((error) => {
          spawnError = error;
        });
        return;
      }
      if (target === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    }

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.once('error', (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate().catch((error) => {
        spawnError = error;
      });
    }, options.timeoutMs);

    child.once('close', async (code, signal) => {
      clearTimeout(timeout);
      if (terminationPromise) {
        try {
          await terminationPromise;
        } catch (error) {
          spawnError = error;
        }
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        outputLimited,
        error: spawnError
      });
    });
  });
}

function errorEntry(suite, code, message, result = null, thresholds = []) {
  return {
    id: suite.id,
    status: 'failed',
    caseSchemaVersion: suite.caseSchemaVersion,
    dataPolicy: suite.dataPolicy,
    caseCount: result?.caseCount ?? null,
    completedCaseCount: result?.completedCaseCount ?? null,
    metrics: result?.metrics ?? null,
    thresholds,
    error: { code, message }
  };
}

function successEntry(suite, result, validation) {
  return {
    id: suite.id,
    status: 'passed',
    caseSchemaVersion: suite.caseSchemaVersion,
    dataPolicy: suite.dataPolicy,
    caseCount: result.caseCount,
    completedCaseCount: result.completedCaseCount,
    metrics: result.metrics,
    thresholds: validation.thresholds,
    error: null
  };
}

function thresholdEntry(suite, result, validation) {
  const failedMetrics = validation.thresholds
    .filter((item) => !item.passed)
    .map((item) => item.metric)
    .join(', ');
  return errorEntry(
    suite,
    'threshold_failed',
    `${suite.id}: thresholds failed for ${failedMetrics}`,
    result,
    validation.thresholds
  );
}

async function runNodeSuite(suite, context) {
  const suiteTempDir = fs.mkdtempSync(path.join(context.tempRoot, `${suite.id}-`));
  const resultFile = path.join(suiteTempDir, 'result.json');
  const childEnv = buildHarnessChildEnv(context.parentEnv, suiteTempDir, {
    manifestPath: context.manifestPath,
    suiteId: suite.id,
    resultFile
  });
  const processResult = await runNodeProcess(suite.runnerPath, {
    projectRoot: context.projectRoot,
    env: childEnv,
    timeoutMs: suite.runner.timeoutMs,
    maxOutputBytes: suite.runner.maxOutputBytes
  });
  if (processResult.outputLimited) {
    return errorEntry(suite, 'runner_output_limit', `${suite.id}: runner output exceeded ${suite.runner.maxOutputBytes} bytes`);
  }
  if (processResult.timedOut) {
    return errorEntry(suite, 'runner_timeout', `${suite.id}: runner timed out after ${suite.runner.timeoutMs}ms`);
  }
  if (processResult.error) {
    return errorEntry(suite, 'runner_error', `${suite.id}: runner failed: ${processResult.error.message}`);
  }
  if (processResult.code !== 0) {
    return errorEntry(suite, 'runner_exit', `${suite.id}: runner exited with code ${processResult.code}`);
  }
  if (!fs.existsSync(resultFile)) {
    return errorEntry(suite, 'result_missing', `${suite.id}: runner did not write a result`);
  }

  let result;
  try {
    if (fs.statSync(resultFile).size > suite.runner.maxOutputBytes) {
      throw new Error(`${suite.id}: result exceeds ${suite.runner.maxOutputBytes} bytes`);
    }
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const validation = validateHarnessSuiteResult(suite, result, { now: context.now });
    return validation.passed
      ? successEntry(suite, result, validation)
      : thresholdEntry(suite, result, validation);
  } catch (error) {
    return errorEntry(suite, 'result_invalid', error.message, result);
  }
}

async function runExternalSuite(suite, context) {
  const configuredPath = String(context.externalEnv[suite.runner.resultFileEnv] || '').trim();
  if (!configuredPath) {
    return errorEntry(
      suite,
      'external_input_missing',
      `${suite.id}: ${suite.runner.resultFileEnv} is required`
    );
  }

  let result;
  try {
    const resultPath = path.resolve(configuredPath);
    const stat = fs.statSync(resultPath);
    if (!stat.isFile()) throw new Error(`${suite.id}: external result must be a file`);
    if (stat.size > suite.runner.maxBytes) {
      throw new Error(`${suite.id}: external result exceeds ${suite.runner.maxBytes} bytes`);
    }
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const validation = validateHarnessSuiteResult(suite, result, { now: context.now });
    return validation.passed
      ? successEntry(suite, result, validation)
      : thresholdEntry(suite, result, validation);
  } catch (error) {
    return errorEntry(suite, 'result_invalid', error.message, result);
  }
}

function baseReport(options, startedAt) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: 'failed',
    profile: options.profile || null,
    manifest: {
      path: path.resolve(options.manifestPath || DEFAULT_MANIFEST_PATH),
      version: null
    },
    startedAt,
    finishedAt: startedAt,
    suites: [],
    error: null
  };
}

async function executeHarnessEval(options = {}) {
  const startedAt = new Date().toISOString();
  const report = baseReport(options, startedAt);
  const reportPath = path.resolve(options.reportPath || path.join(PROJECT_ROOT, 'artifacts', 'harness-eval', 'report.json'));
  let tempRoot = '';
  try {
    let loaded;
    try {
      loaded = loadHarnessEvalManifest(report.manifest.path, {
        projectRoot: options.projectRoot || PROJECT_ROOT
      });
      report.manifest.version = loaded.manifest.version;
    } catch (error) {
      report.error = { code: 'manifest_invalid', message: error.message };
      report.finishedAt = new Date().toISOString();
      writeJsonAtomic(reportPath, report);
      return report;
    }

    const profile = loaded.manifest.profiles[options.profile];
    if (!profile) {
      report.error = { code: 'unknown_profile', message: `unknown Harness profile ${options.profile}` };
      report.finishedAt = new Date().toISOString();
      writeJsonAtomic(reportPath, report);
      return report;
    }

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-harness-eval-'));
    const context = {
      manifestPath: loaded.manifestPath,
      projectRoot: loaded.projectRoot,
      parentEnv: process.env,
      externalEnv: options.env || process.env,
      tempRoot,
      now: Number.isFinite(options.now) ? options.now : Date.now()
    };
    for (const suiteId of profile.suites) {
      const suite = loaded.suitesById.get(suiteId);
      const entry = suite.runner.type === 'node'
        ? await runNodeSuite(suite, context)
        : await runExternalSuite(suite, context);
      report.suites.push(entry);
    }

    const failedCount = report.suites.filter((suite) => suite.status === 'failed').length;
    report.status = failedCount === 0 ? 'passed' : 'failed';
    report.error = failedCount === 0
      ? null
      : { code: 'suite_failed', message: `${failedCount}/${report.suites.length} suites failed` };
    report.finishedAt = new Date().toISOString();
    writeJsonAtomic(reportPath, report);
    return report;
  } finally {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(`[harness-eval] failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    const report = await executeHarnessEval(args);
    console.log(`[harness-eval] ${report.profile}: ${report.status}, ${report.suites.length} suites`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(`[harness-eval] failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[harness-eval] failed:', error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  OS_ENV_KEYS,
  buildHarnessChildEnv,
  executeHarnessEval,
  parseArgs,
  runExternalSuite,
  runNodeProcess,
  runNodeSuite
};
