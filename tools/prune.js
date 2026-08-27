'use strict';
// Permanently comments out channels that failed the last health check.
//
//   npm run health     <- must be run FROM THE NETWORK your viewers use
//   npm run prune
//   npm run build
//
// Nothing is deleted: failing channels are commented out in
// config/channels.txt, so you can put any of them back by removing the '#'.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'config', 'health-report.json');
const LIST = path.join(ROOT, 'config', 'channels.txt');

function main() {
  if (!fs.existsSync(REPORT)) {
    console.error('No health report found. Run this first:\n\n  npm run health\n');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(LIST)) {
    console.error('config/channels.txt is missing. Run:  npm run channels');
    process.exitCode = 1;
    return;
  }

  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const ageHours = (Date.now() - new Date(report.at).getTime()) / 3600000;

  const dead = new Set(report.results.filter((r) => !r.ok).map((r) => r.name));
  const alive = report.results.filter((r) => r.ok).length;

  if (!dead.size) {
    console.log('Nothing to prune - every checked channel responded.');
    return;
  }

  console.log('Health report is ' + ageHours.toFixed(1) + 'h old: ' +
    alive + ' working, ' + dead.size + ' failing.');
  console.log('');
  console.log('  NOTE: this reflects the network the health check ran on.');
  console.log('  Region-locked channels (BDIX and similar) fail from outside');
  console.log('  their country. If you ran the check somewhere your viewers');
  console.log('  will not be, you are about to remove channels that work.');
  console.log('');

  const lines = fs.readFileSync(LIST, 'utf8').split(/\r?\n/);
  let pruned = 0;

  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    if (dead.has(t)) {
      pruned++;
      return '# ' + t + '   <- not reachable at last health check';
    }
    return line;
  });

  fs.writeFileSync(LIST, out.join('\n'), 'utf8');

  console.log('Commented out ' + pruned + ' channel(s) in config/channels.txt');
  console.log('');
  console.log('Rebuild with:  npm run build');
  console.log('Undo any of them by deleting the leading "#".');
}

main();
