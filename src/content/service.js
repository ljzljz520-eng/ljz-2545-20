'use strict';
const db = require('../db/db');
const { checksum, extractRefs } = require('./model');
const { defaultTokens, tokenHash } = require('./tokens');
const { LIBRARY, sourceHash } = require('./components');
const { seedDocContent, seedSources, seedAssets } = require('./seed');

function ensureDoc(slug, title) {
  if (!db.get('SELECT 1 FROM docs WHERE slug=?', [slug])) {
    db.run('INSERT INTO docs (slug,title) VALUES (?,?)', [slug, title]);
  }
}

// 新建草稿版本（draft 可多轮保存）
function saveDraft({ docSlug, title, content, editor, baseVersion, checksumHint, newVersion = false }) {
  ensureDoc(docSlug, title);
  const sum = checksum(content);
  const existingDraft = db.get(
    "SELECT * FROM doc_versions WHERE doc_slug=? AND status='draft' ORDER BY version DESC LIMIT 1", [docSlug]);

  function persist(id) {
    db.run('DELETE FROM doc_refs WHERE doc_version_id=?', [id]);
    for (const r of extractRefs(content)) {
      db.run('INSERT INTO doc_refs (doc_version_id,ref_type,target,planned,context) VALUES (?,?,?,?,?)',
        [id, r.ref_type, r.target, r.planned, r.context]);
    }
  }

  // 显式要求新版本（即使内容与当前草稿相同）：当前草稿冻结，新建下一版草稿
  if (newVersion && existingDraft) {
    const max = db.get('SELECT COALESCE(MAX(version),0) AS m FROM doc_versions WHERE doc_slug=?', [docSlug]).m;
    const next = max + 1;
    db.tx(() => {
      db.run("UPDATE doc_versions SET status='draft' WHERE id=?", [existingDraft.id]);
      db.run(`INSERT INTO doc_versions (doc_slug,version,status,title,content_json,checksum,base_version,editor)
              VALUES (?,?,'draft',?,?,?,?,?)`,
        [docSlug, next, title, JSON.stringify(content), sum, existingDraft.version, editor || null]);
      const id = db.lastInsertRowid();
      for (const r of extractRefs(content)) {
        db.run('INSERT INTO doc_refs (doc_version_id,ref_type,target,planned,context) VALUES (?,?,?,?,?)',
          [id, r.ref_type, r.target, r.planned, r.context]);
      }
      db.audit(editor, 'draft.new-version', { docSlug, version: next });
    });
    return getVersion(docSlug, next);
  }

  if (existingDraft) {
    // 在已有草稿上提交：
    //  - 基于更旧版本 => 409；
    //  - 基于同版本但携带的 checksumHint 与当前草稿不符（他人已先保存）=> 409。
    if ((baseVersion != null && Number(baseVersion) !== existingDraft.version) ||
        (checksumHint && checksumHint !== existingDraft.checksum)) {
      throw Object.assign(new Error('conflict: 检测到两编辑冲突，草稿 v' + existingDraft.version + ' 已被更新'), {
        code: 'EDIT_CONFLICT', status: 409,
        conflict: { yourBase: baseVersion, currentDraft: existingDraft.version,
          currentEditor: existingDraft.editor, currentChecksum: existingDraft.checksum,
          yourChecksum: checksumHint || sum }
      });
    }
    db.tx(() => {
      db.run('UPDATE doc_versions SET content_json=?, checksum=?, title=?, editor=?, base_version=? WHERE id=?',
        [JSON.stringify(content), sum, title, editor || null, baseVersion || null, existingDraft.id]);
      persist(existingDraft.id);
      db.audit(editor, 'draft.update', { docSlug, version: existingDraft.version });
    });
    return getVersion(docSlug, existingDraft.version);
  }

  // 无草稿：校验 base 存在后新建下一版
  if (baseVersion) {
    const base = db.get('SELECT version FROM doc_versions WHERE doc_slug=? AND version=?',
      [docSlug, baseVersion]);
    if (!base) throw Object.assign(new Error('base version not found'), { code: 'BASE_NOT_FOUND' });
  }
  const max = db.get('SELECT COALESCE(MAX(version),0) AS m FROM doc_versions WHERE doc_slug=?', [docSlug]).m;
  const next = max + 1;
  db.tx(() => {
    db.run(`INSERT INTO doc_versions (doc_slug,version,status,title,content_json,checksum,base_version,editor)
            VALUES (?,?,'draft',?,?,?,?,?)`,
      [docSlug, next, title, JSON.stringify(content), sum, baseVersion || null, editor || null]);
    persist(db.lastInsertRowid());
    db.audit(editor, 'draft.save', { docSlug, version: next });
  });
  return getVersion(docSlug, next);
}

function updateDraft({ docSlug, version, content, title, editor, expectedChecksum }) {
  const dv = db.get('SELECT * FROM doc_versions WHERE doc_slug=? AND version=?', [docSlug, version]);
  if (!dv) throw Object.assign(new Error('not found'), { code: NOT_FOUND('draft') });
  if (dv.status !== 'draft') throw Object.assign(new Error('版本不是草稿'), { code: 'NOT_DRAFT', status: 409 });
  if (expectedChecksum && dv.checksum !== expectedChecksum) {
    const other = db.get("SELECT editor FROM doc_versions WHERE doc_slug=? AND status='draft' ORDER BY version DESC LIMIT 1", [docSlug]);
    throw Object.assign(new Error('conflict: 草稿已被他人更新'), {
      code: 'EDIT_CONFLICT', status: 409,
      conflict: { yourChecksum: expectedChecksum, currentChecksum: dv.checksum, currentEditor: other && other.editor }
    });
  }
  const sum = checksum(content);
  db.tx(() => {
    db.run('UPDATE doc_versions SET content_json=?, checksum=?, title=?, editor=? WHERE id=?',
      [JSON.stringify(content), sum, title, editor || null, dv.id]);
    db.run('DELETE FROM doc_refs WHERE doc_version_id=?', [dv.id]);
    for (const r of extractRefs(content)) {
      db.run('INSERT INTO doc_refs (doc_version_id,ref_type,target,planned,context) VALUES (?,?,?,?,?)',
        [dv.id, r.ref_type, r.target, r.planned, r.context]);
    }
    db.audit(editor, 'draft.update', { docSlug, version });
  });
  return getVersion(docSlug, version);
}
const NOT_FOUND = () => 'NOT_FOUND';

function getVersion(docSlug, version) {
  const dv = db.get('SELECT * FROM doc_versions WHERE doc_slug=? AND version=?', [docSlug, version]);
  if (!dv) return null;
  return hydrate(dv);
}
function hydrate(dv) {
  return { ...dv, content: JSON.parse(dv.content_json),
    refs: db.all('SELECT ref_type,target,planned,context FROM doc_refs WHERE doc_version_id=?', [dv.id]) };
}
function listVersions(docSlug) {
  return db.all('SELECT id,version,status,title,editor,build_id,created_at,checksum FROM doc_versions WHERE doc_slug=? ORDER BY version', [docSlug]);
}
function currentDraft(docSlug) {
  const dv = db.get("SELECT * FROM doc_versions WHERE doc_slug=? AND status='draft' ORDER BY version DESC LIMIT 1", [docSlug]);
  return dv ? hydrate(dv) : null;
}

// 组件改名：slug 不变（引用不破），display_name 与 source_hash 更新；旧截图随即过期
function renameComponent(slug, newName, actor) {
  const c = db.get('SELECT * FROM components WHERE slug=?', [slug]);
  if (!c) throw Object.assign(new Error('component not found'), { code: 'NOT_FOUND' });
  const lib = LIBRARY[slug] || { source: { custom: true, at: Date.now() } };
  const newHash = sourceHash({ ...lib.source, display_name: newName });
  db.tx(() => {
    db.run(`INSERT INTO component_versions (slug,display_name,source_hash,status,editor) VALUES (?,?,?,?,?)`,
      [slug, newName, newHash, c.status, actor || null]);
    db.run('UPDATE components SET display_name=?, source_hash=?, updated_at=datetime(\'now\') WHERE slug=?',
      [newName, newHash, slug]);
    db.audit(actor, 'component.rename', { slug, from: c.display_name, to: newName });
  });
  return db.get('SELECT * FROM components WHERE slug=?', [slug]);
}

// 组件上线（必须先有验收文档：acceptance_doc 非空）
function activateComponent(slug, actor) {
  const c = db.get('SELECT * FROM components WHERE slug=?', [slug]);
  if (!c) throw Object.assign(new Error('component not found'), { code: 'NOT_FOUND' });
  if (!c.acceptance_doc) {
    throw Object.assign(new Error(`组件 ${slug} 缺少已发布验收文档，不能上线（验收文档必须先于组件上线）`),
      { code: 'NO_ACCEPTANCE_DOC', status: 409 });
  }
  db.tx(() => {
    db.run("UPDATE components SET status='live', updated_at=datetime('now') WHERE slug=?", [slug]);
    db.run(`INSERT INTO component_versions (slug,display_name,source_hash,status,editor) VALUES (?,?,?, 'live', ?)`,
      [slug, c.display_name, c.source_hash, actor || null]);
    db.audit(actor, 'component.activate', { slug, acceptance_doc: c.acceptance_doc });
  });
  return db.get('SELECT * FROM components WHERE slug=?', [slug]);
}
function attachAcceptance(slug, docRef, actor) {
  db.run('UPDATE components SET acceptance_doc=? WHERE slug=?', [docRef, slug]);
  db.audit(actor, 'component.acceptance.attach', { slug, docRef });
}

function bumpTokens(actor, overrides) {
  const t = { ...defaultTokens(), ...(overrides || {}), version: defaultTokens().version + 1 };
  const hash = tokenHash(t);
  if (!db.get('SELECT 1 FROM token_versions WHERE hash=?', [hash])) {
    db.run('INSERT INTO token_versions (hash,payload) VALUES (?,?)', [hash, JSON.stringify(t)]);
    db.audit(actor, 'tokens.bump', { hash });
  }
  return { tokens: t, hash };
}
function activeTokens() {
  const row = db.get('SELECT * FROM token_versions ORDER BY id DESC LIMIT 1');
  if (row) return { tokens: JSON.parse(row.payload), hash: row.hash };
  const t = defaultTokens(); const hash = tokenHash(t);
  db.run('INSERT INTO token_versions (hash,payload) VALUES (?,?)', [hash, JSON.stringify(t)]);
  return { tokens: t, hash };
}

function createBuild({ docSlug, version, mode, gitRef, actor }) {
  const dv = getVersion(docSlug, version);
  if (!dv) throw Object.assign(new Error('version not found'), { code: 'NOT_FOUND' });
  const buildKey = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const manifest = JSON.stringify({ mode, gitRef: gitRef || null, doc: docSlug, version,
    apiContract: 1, generatedAt: new Date().toISOString() });
  db.tx(() => {
    db.run("UPDATE doc_versions SET status='candidate' WHERE id=?", [dv.id]);
    db.run(`INSERT INTO builds (build_key,doc_slug,doc_version_id,mode,git_ref,status,manifest_json)
            VALUES (?,?,?,?,?, 'gating', ?)`,
      [buildKey, docSlug, dv.id, mode, gitRef || null, manifest]);
    db.run('UPDATE doc_versions SET build_id=last_insert_rowid() WHERE id=?', [dv.id]);
    db.audit(actor, 'build.create', { buildKey, docSlug, version, mode });
  });
  return db.get('SELECT * FROM builds WHERE build_key=?', [buildKey]);
}

function setDependency(slug, deps, actor) {
  const c = db.get('SELECT * FROM components WHERE slug=?', [slug]);
  if (!c) throw Object.assign(new Error('component not found'), { code: 'NOT_FOUND' });
  db.run('UPDATE components SET depends_on=? WHERE slug=?', [JSON.stringify(deps), slug]);
  db.audit(actor, 'component.deps.set', { slug, deps });
  return db.get('SELECT * FROM components WHERE slug=?', [slug]);
}
function allComponents() { return db.all('SELECT * FROM components ORDER BY slug'); }
function allAssets() { return db.all('SELECT * FROM assets ORDER BY id'); }
function allSources() { return db.all('SELECT * FROM sources ORDER BY slug'); }

function seedAll(actor = 'system') {
  // 素材与来源
  for (const s of seedSources()) {
    db.run(`INSERT OR IGNORE INTO sources (slug,kind,title,author,url,license,note)
            VALUES (?,?,?,?,?,?,?)`, [s.slug, s.kind, s.title, s.author, s.url, s.license, s.note]);
  }
  // 组件（modal 保持 draft，体现"先文档后组件"）
  for (const [slug, def] of Object.entries(LIBRARY)) {
    const hash = sourceHash(def.source);
    db.run(`INSERT OR IGNORE INTO components (slug,display_name,status,source_hash,depends_on)
            VALUES (?,?,?,?,?)`, [slug, def.display_name, def.status, hash, JSON.stringify(def.depends_on)]);
  }
  // 素材
  const { sha256 } = require('./model');
  for (const a of seedAssets()) {
    db.run(`INSERT OR IGNORE INTO assets (id,source_slug,kind,width,height,alt,hash)
            VALUES (?,?,?,?,?,?,?)`,
      [a.id, a.source_slug, a.kind, a.width, a.height, a.alt, sha256(JSON.stringify(a)).slice(0, 12)]);
  }
  // 首个令牌版本
  activeTokens();
  // 初始设计说明草稿
  if (!db.get('SELECT 1 FROM docs WHERE slug=?', ['design-system'])) {
    saveDraft({ docSlug: 'design-system', title: '站内设计说明',
      content: seedDocContent(), editor: actor });
  }
}

module.exports = {
  saveDraft, updateDraft, getVersion, listVersions, currentDraft, hydrate,
  renameComponent, activateComponent, attachAcceptance, setDependency, bumpTokens, activeTokens,
  createBuild, allComponents, allAssets, allSources, seedAll, ensureDoc
};
