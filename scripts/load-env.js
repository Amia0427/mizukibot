const fs = require('fs');
const path = require('path');

function main() {
  const envPath = path.resolve(process.cwd(), process.argv[2] || '.env');
  if (!fs.existsSync(envPath)) {
    process.exit(1);
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const text = String(line || '');
    if (!text.trim()) continue;
    if (/^\s*#/.test(text)) continue;

    const idx = text.indexOf('=');
    if (idx < 0) continue;

    const key = text.slice(0, idx).trim();
    const value = text.slice(idx + 1);
    if (!key) continue;

    // 只输出纯 KEY=VALUE，交给 bat 侧统一 set。
    process.stdout.write(`${key}=${value}\n`);
  }
}

main();
