'use strict';
/*
 * SQL 持久层（SQLite / sql.js）
 * 所有写操作经单一串行队列 + 事务，保证“失败只阻断该候选，不覆盖稳定版”：
 * promote 在单个事务内完成，任何屏障失败时事务整体回滚，live 指针永不半更新。
 */
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DS_DB_FILE || path.join(DATA_DIR, 'app.sqlite');

let SQL, db;
const writeQueue = [];
let writing = false;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  live_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','candidate','published','archived')),
  theme_positioning TEXT NOT NULL DEFAULT '',
  info_structure TEXT NOT NULL DEFAULT '',
  responsive_sample TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  base_version INTEGER,
  etag TEXT NOT NULL,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  UNIQUE(doc_id, version)
);

-- 设计决策（验收文档 / 素材来源 / 色彩 / 可访问交互 都是决策的 kind）
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  doc_version_id INTEGER REFERENCES doc_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('positioning','source','color','a11y','acceptance','general')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  page_path TEXT,          -- 关联实际页面，如 /index.html
  target_selector TEXT,    -- 关联页面内具体元素
  editor TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_version_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS component_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,                  -- 版本捕获当时组件名（改名 => 指纹变）
  token_name TEXT NOT NULL,
  token_value TEXT NOT NULL,
  token_semantic TEXT NOT NULL,
  props_json TEXT NOT NULL DEFAULT '{}',
  acceptance_decision_id TEXT REFERENCES decisions(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','retracted')),
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(component_id, version)
);

CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_version_id INTEGER NOT NULL REFERENCES component_versions(id) ON DELETE CASCADE,
  breakpoint INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  declared_ratio TEXT NOT NULL,
  fingerprint TEXT NOT NULL,           -- sha1(name|tokenName|tokenValue|width|props)
  file_path TEXT NOT NULL,
  renderer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(component_version_id, breakpoint)
);

-- 引用图（决策->决策、组件版本->决策），用于引用环检测
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('decision','component')),
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('decision','component')),
  to_id TEXT NOT NULL
);

-- 站点构建（“文档随代码发布”一侧）
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  code_ref TEXT NOT NULL,              -- git short sha / 快照标识
  status TEXT NOT NULL CHECK (status IN ('building','active','retracted','failed')),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retracted_at TEXT
);

CREATE TABLE IF NOT EXISTS release_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_version_id INTEGER NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
  build_id TEXT REFERENCES builds(id),
  result TEXT NOT NULL CHECK (result IN ('rejected','promoted','rolled_back')),
  gates_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  build_id TEXT REFERENCES builds(id),
  active INTEGER NOT NULL DEFAULT 1,   -- 0 表示历史；回滚 = 把当前置 0 并激活旧行
  promoted_at TEXT NOT NULL DEFAULT (datetime('now')),
  snapshot_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

async function init() {
  SQL = await initSqlJs({ locateFile: f => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f) });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  await flush();
  return getApi();
}

function flush() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

// 串行写队列：写事务期间其它请求等待；事务抛错则回滚
function enqueueWrite(fn) {
  return new Promise((resolve, reject) => {
    writeQueue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  if (writing || !writeQueue.length) return;
  writing = true;
  const { fn, resolve, reject } = writeQueue.shift();
  (async () => {
    db.run('BEGIN');
    try {
      const r = await fn();
      db.run('COMMIT');
      flush();
      resolve(r);
    } catch (e) {
      try { db.run('ROLLBACK'); } catch (_) {}
      reject(e);
    } finally {
      writing = false;
      pump();
    }
  })();
}

function getApi() {
  return {
    raw: () => db,
    // 只读辅助
    one(sql, params = []) {
      const stmt = db.prepare(sql); stmt.bind(params);
      let row = null;
      if (stmt.step()) row = stmt.getAsObject();
      stmt.free();
      return row;
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql); stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    run(sql, params = []) {
      const stmt = db.prepare(sql); stmt.bind(params); stmt.step(); stmt.free();
    },
    transaction(fn) { return enqueueWrite(fn); },
    audit(actor, action, target, detail) {
      const stmt = db.prepare('INSERT INTO audit_log (actor,action,target,detail) VALUES (?,?,?,?)');
      stmt.bind([actor || null, action, target || null, detail ? JSON.stringify(detail) : null]);
      stmt.step(); stmt.free();
    },
    flush,
  };
}

module.exports = { init };
