'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 每个用例一个独立服务器子进程 + 独立临时 SQLite，彻底隔离
async function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-'));
  const dbFile = path.join(dir, 'test.db');
  const port = 41000 + Math.floor(Math.random() * 7000);
  const child = spawn(process.execPath, [path.join(__dirname, 'server-harness.js')], {
    env: { ...process.env, DB_FILE: dbFile, PORT: String(port), ADMIN_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server timeout')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
  const base = `http://localhost:${port}`;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };
  const api = async (p, opts = {}) => {
    const res = await fetch(base + p, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.auth === false ? { 'Content-Type': 'application/json' } : H,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  const getHtml = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, html: await res.text() };
  };
  return {
    base, api, getHtml,
    // 直接在主进程操作同一个磁盘库（写后即持久化，子进程读文件的一致性足够；
    // 需要强一致的场景改用 API）。使用只读/旁路 SQL 校验。
    openSideDb: async () => {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      return new SQL.Database(fs.readFileSync(dbFile));
    },
    close: () => new Promise((r) => { child.kill('SIGTERM'); child.on('exit', () => r()); setTimeout(r, 3000); })
  };
}
module.exports = { freshEnv };
