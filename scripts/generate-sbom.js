#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function componentName(component = {}) {
  const group = String(component.group || '').trim();
  const name = String(component.name || '').trim();
  return group ? `${group}/${name}` : name;
}

function validateSbom(document = {}, packageJson = {}) {
  const errors = [];
  if (document.bomFormat !== 'CycloneDX') errors.push('bomFormat must be CycloneDX');
  if (!/^1\.[5-9]$/.test(String(document.specVersion || ''))) errors.push('CycloneDX specVersion must be 1.5 or newer');
  if (document.metadata?.component?.['bom-ref'] !== `${packageJson.name}@${packageJson.version}`) errors.push('root component bom-ref mismatch');
  if (document.metadata?.component?.purl !== `pkg:npm/${packageJson.name}@${packageJson.version}`) errors.push('root component purl mismatch');
  if (document.metadata?.component?.version !== packageJson.version) errors.push('root component version mismatch');
  if (!Array.isArray(document.components) || document.components.length === 0) errors.push('components must not be empty');
  if (!Array.isArray(document.dependencies) || document.dependencies.length === 0) errors.push('dependencies must not be empty');
  const componentNames = new Set((document.components || []).map(componentName));
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    if (!componentNames.has(dependency)) errors.push(`direct dependency missing from SBOM: ${dependency}`);
  }
  return { ok: errors.length === 0, errors };
}

function resolveNpmCli(options = {}) {
  const candidates = [
    options.npmCli,
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const entry of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(
      path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(entry, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    );
  }
  return candidates
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(candidate)) || '';
}

function generateSbom(options = {}) {
  const cwd = path.resolve(options.cwd || path.join(__dirname, '..'));
  const packageJson = options.packageJson || JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const npmCli = resolveNpmCli(options);
  if (!npmCli) throw new Error('npm CLI entrypoint not found');
  const spawn = options.spawnSync || spawnSync;
  const result = spawn(process.execPath, [npmCli, 'sbom', '--omit=dev', '--sbom-format=cyclonedx'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || `npm sbom exited ${result.status}`).trim());
  const document = JSON.parse(result.stdout);
  const validation = validateSbom(document, packageJson);
  if (!validation.ok) throw new Error(validation.errors.join('; '));

  const outputFile = path.resolve(options.outputFile || path.join(cwd, 'artifacts', 'sbom', `${packageJson.name}.cdx.json`));
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, contents, 'utf8');
  return {
    ok: true,
    outputFile,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    componentCount: document.components.length,
    dependencyCount: document.dependencies.length
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  let outputFile = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg.startsWith('--output=')) outputFile = arg.slice('--output='.length);
    else if (arg === '--output') outputFile = String(argv[index += 1] || '');
  }
  return { outputFile };
}

function main(argv = process.argv.slice(2)) {
  const result = generateSbom(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  componentName,
  generateSbom,
  main,
  parseArgs,
  resolveNpmCli,
  validateSbom
};
