#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const expectedMajor = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
const packageJson = require(path.join(root, 'package.json'));
const currentMajor = process.versions.node.split('.')[0];

if (!/^\d+$/.test(expectedMajor)) {
  console.error(`[node-version] invalid .nvmrc value: ${expectedMajor || '<empty>'}`);
  process.exit(1);
}

const expectedEngine = `>=${expectedMajor} <${Number(expectedMajor) + 1}`;
if (packageJson.engines?.node !== expectedEngine) {
  console.error(`[node-version] package.json engines.node must be ${expectedEngine}`);
  process.exit(1);
}

if (currentMajor !== expectedMajor) {
  console.error(`[node-version] Node.js ${expectedMajor}.x required, current runtime is ${process.version}`);
  process.exit(1);
}

console.log(`[node-version] Node.js ${process.version} matches ${expectedMajor}.x policy`);
