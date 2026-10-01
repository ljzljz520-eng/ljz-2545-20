#!/usr/bin/env node
'use strict';
// 发布流水线 CLI（独立内容发布为主；随代码发布为策略变体）
//   node scripts/release.js gate <buildKey> [--fail card]
//   node scripts/release.js promote <buildKey>
//   node scripts/release.js rollback
const db = require('../src/db/db');
const svc = require('../src/content/service');
const rel = require('../src/release/release');

async function main() {
  await db.open();
  svc.seedAll();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'gate') {
    const buildKey = rest[0];
    const failIdx = rest.indexOf('--fail');
    const failSet = failIdx >= 0 ? new Set(rest.slice(failIdx + 1)) : null;
    const out = await rel.gateBuild(buildKey, { failSet });
    console.log(JSON.stringify({ passed: out.passed, status: out.build.status,
      gates: out.results.map((r) => `${r.passed ? 'PASS' : 'FAIL'} ${r.gate} — ${r.detail}`) }, null, 2));
    process.exitCode = out.passed ? 0 : 1;
  } else if (cmd === 'promote') {
    console.log(JSON.stringify(rel.promote(rest[0], 'cli'), null, 2));
  } else if (cmd === 'rollback') {
    console.log(JSON.stringify(rel.rollback('design-system', 'cli'), null, 2));
  } else {
    console.log('usage: release.js gate <buildKey> [--fail slug] | promote <buildKey> | rollback');
    process.exitCode = 2;
  }
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
