const fs = require('fs');
const path = require('path');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function listFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (new Set(['node_modules', '.git', '__pycache__']).has(entry.name)) continue;
        stack.push(abs);
      } else {
        results.push(abs);
      }
    }
  }
  return results;
}

function validateSkillPackage(skillRoot) {
  const problems = [];
  const warnings = [];
  const skillMd = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    problems.push('Missing SKILL.md');
  }

  const files = listFiles(skillRoot);
  const hasScript = files.some((file) => /[\\/](scripts|assets|references)[\\/]/i.test(file));
  if (!hasScript) {
    warnings.push('No scripts/assets/references directory found');
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (['.js', '.ts', '.py', '.sh', '.md', '.json', '.yaml', '.yml', '.txt'].includes(ext)) continue;
    warnings.push(`Unexpected file type: ${path.relative(skillRoot, file)}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    files
  };
}

function formatValidation(skillName, validation = {}) {
  const lines = [
    `Skill: ${skillName}`,
    `Valid: ${validation.ok ? 'yes' : 'no'}`,
    `Files: ${Array.isArray(validation.files) ? validation.files.length : 0}`
  ];
  if (validation.problems?.length) {
    lines.push('Problems:');
    validation.problems.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (validation.warnings?.length) {
    lines.push('Warnings:');
    validation.warnings.slice(0, 10).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  return lines.join('\n');
}

function validateSkillByName(skillsBaseDir, skillName = '') {
  const normalizedName = normalizeText(skillName);
  if (!normalizedName) return 'Missing skill_name.';
  const skillRoot = path.join(skillsBaseDir, normalizedName);
  if (!fs.existsSync(skillRoot)) return `Skill path not found: ${skillRoot}`;
  return formatValidation(normalizedName, validateSkillPackage(skillRoot));
}

module.exports = {
  validateSkillByName
};
