'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nodeMajor = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
const packageJson = require('../package.json');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const beginnerGuide = fs.readFileSync(path.join(root, 'deploy/beginner-guide.md'), 'utf8');
const linuxReadme = fs.readFileSync(path.join(root, 'deploy/linux/README_LINUX.md'), 'utf8');
const linuxFull = fs.readFileSync(path.join(root, 'deploy/linux/LINUX_DEPLOY_FULL.md'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'scripts/bootstrap-debian12.sh'), 'utf8');

assert.strictEqual(nodeMajor, '20');
assert.strictEqual(packageJson.engines.node, '>=20 <21');
assert.match(dockerfile, /^FROM node:20-/m);
const deploymentDocs = `${readme}\n${beginnerGuide}\n${linuxReadme}\n${linuxFull}`;
assert.ok(!/Node\.js\s*(?:>=|版本)?\s*18\+?/i.test(deploymentDocs));
assert.ok(!/Node\.js[^\r\n]{0,20}(?:20\+|>=\s*20|20\s*或更高|20\s*LTS（或更高）)/i.test(deploymentDocs));
assert.match(bootstrap, /\.nvmrc/);
assert.match(bootstrap, /node_\$\{NODE_MAJOR\}\.x/);

console.log('node version policy tests passed');
