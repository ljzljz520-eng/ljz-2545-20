-- 全栈版本化设计说明：SQL 持久化（设计说明版本 + 站点构建 + 发布指针）
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 设计令牌（颜色/字号/间距…）按版本保存，渲染与截图都对令牌指纹负责
CREATE TABLE IF NOT EXISTS token_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hash       TEXT NOT NULL UNIQUE,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 组件：slug 永不改变（引用靠它），显示名可改；改名/源码变更会刷新指纹
CREATE TABLE IF NOT EXISTS components (
  slug        TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','retired')),
  source_hash TEXT NOT NULL,
  depends_on  TEXT NOT NULL DEFAULT '[]',   -- JSON: 引用的其他组件 slug（用于引用环检测）
  acceptance_doc TEXT,                     -- 已发布验收文档版本标识 doc_slug@version
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS component_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  status       TEXT NOT NULL,
  editor       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 原创素材来源（可关联到实际页面段落）
CREATE TABLE IF NOT EXISTS sources (
  slug  TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,                    -- image / illustration / copy
  title TEXT NOT NULL,
  author TEXT,
  url   TEXT,
  license TEXT,
  note  TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id     TEXT PRIMARY KEY,                -- e.g. hero-wave
  source_slug TEXT REFERENCES sources(slug),
  kind   TEXT NOT NULL DEFAULT 'image',
  width  INTEGER NOT NULL,
  height INTEGER NOT NULL,
  alt    TEXT NOT NULL,
  hash   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  slug  TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 设计说明版本：draft（草稿，可多轮保存，带乐观锁）/ candidate / published / archived
CREATE TABLE IF NOT EXISTS doc_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_slug     TEXT NOT NULL REFERENCES docs(slug),
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','candidate','published','archived')),
  title        TEXT NOT NULL,
  content_json TEXT NOT NULL,
  checksum     TEXT NOT NULL,             -- 内容指纹，同时充当乐观锁 token
  base_version INTEGER,                   -- 编辑时基于的版本（两编辑冲突检测）
  editor       TEXT,
  build_id     INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doc_slug, version)
);

CREATE TABLE IF NOT EXISTS doc_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_version_id INTEGER NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('component','image','link','section','source')),
  target   TEXT NOT NULL,                 -- 组件 slug / 资源 id / 锚点 / 来源 slug
  planned  INTEGER NOT NULL DEFAULT 0,    -- 组件尚未上线时必须为 1（先文档后组件）
  context  TEXT                           -- 页面段落 id：关联实际页面
);

-- 每个组件 × 关键断点的现状截图；指纹用于保鲜（改名/令牌变更后即过期）
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_version_id INTEGER NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
  component_slug  TEXT NOT NULL,
  breakpoint      INTEGER NOT NULL,       -- 360 / 768 / 1280
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  file_path       TEXT NOT NULL,
  engine          TEXT NOT NULL,          -- vector / browser
  component_hash  TEXT NOT NULL,          -- 捕获时组件 source_hash
  component_name  TEXT NOT NULL,          -- 捕获时组件显示名（改名即过期）
  token_hash      TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  ok              INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doc_version_id, component_slug, breakpoint)
);

-- 站点构建：coupled=随代码发布 / decoupled=独立内容发布
CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_key TEXT NOT NULL UNIQUE,
  doc_slug  TEXT NOT NULL,
  doc_version_id INTEGER REFERENCES doc_versions(id),
  mode TEXT NOT NULL CHECK (mode IN ('coupled','decoupled')),
  git_ref TEXT,
  status TEXT NOT NULL DEFAULT 'building'
     CHECK (status IN ('building','gating','rejected','passed','promoted','rolled_back')),
  artifact_path TEXT,
  manifest_json TEXT,
  gates_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 当前线上指针：每个文档至多一条 active=1；提升/撤回只在一个事务里改这张表
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_slug TEXT NOT NULL,
  doc_version_id INTEGER NOT NULL REFERENCES doc_versions(id),
  build_id INTEGER NOT NULL REFERENCES builds(id),
  mode TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  promoted_at TEXT NOT NULL DEFAULT (datetime('now')),
  rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS gate_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id INTEGER NOT NULL REFERENCES builds(id),
  passed INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT, action TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_docv_status ON doc_versions(doc_slug, status);
CREATE INDEX IF NOT EXISTS idx_refs_dv ON doc_refs(doc_version_id);
CREATE INDEX IF NOT EXISTS idx_shots_dv ON screenshots(doc_version_id);
CREATE INDEX IF NOT EXISTS idx_releases_active ON releases(doc_slug, active);
