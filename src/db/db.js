'use strict';
// sql.js（真实 SQLite/WASM）同步封装：行为接近 better-sqlite3，数据持久化到单个磁盘文件。
// 所有 SQL 都在 schema.sql 中声明；这里只做最小数据访问层。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
let SQL = null;
let _db = null;
let _dbFile = null;
let _dirty = false;
let _inTx = false;

async function open(dbFile = process.env.DB_FILE || path.join(process.cwd(), 'data', 'app.db')) {
  if (_db) return _db;
  SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  _dbFile = dbFile;
  if (fs.existsSync(dbFile)) {
    _db = new SQL.Database(fs.readFileSync(dbFile));
  } else {
    _db = new SQL.Database();
  }
  _db.run('PRAGMA foreign_keys = ON;');
  _db.run(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return _db;
}

function raw() {
  if (!_db) throw new Error('DB not open; call open() first');
  return _db;
}

function save() {
  if (_inTx) { _dirty = true; return; } // 事务中只在 COMMIT 后统一落盘
  _dirty = true;
  const data = Buffer.from(_db.export());
  const tmp = _dbFile + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, _dbFile); // 原子替换，避免读到半写文件
  _dirty = false;
}

// sql.js 参数绑定（? 位置参数）
function run(sql, params = []) {
  const stmt = raw().prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
  save();
}

function get(sql, params = []) {
  const stmt = raw().prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject();
    return null;
  } finally {
    stmt.free();
  }
}

function all(sql, params = []) {
  const stmt = raw().prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

// 事务：回调内所有写操作只落盘一次，失败全部回滚
function tx(fn) {
  raw().run('BEGIN');
  _inTx = true;
  try {
    const out = fn();
    _inTx = false;
    raw().run('COMMIT');
    save();
    return out;
  } catch (e) {
    _inTx = false;
    try { raw().run('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

function lastInsertRowid() {
  const r = get('SELECT last_insert_rowid() AS id');
  return Number(r.id);
}

function audit(actor, action, detail) {
  run('INSERT INTO audit_log (actor, action, detail) VALUES (?,?,?)',
    [actor || null, action, typeof detail === 'string' ? detail : JSON.stringify(detail)]);
}

function close() {
  if (_db) { _db.close(); _db = null; }
}

module.exports = { open, close, run, get, all, tx, lastInsertRowid, save, audit, raw };
