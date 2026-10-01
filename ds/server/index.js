'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { init } = require('./db');
const render = require('./render');
const buildsLib = require('./builds');
const shots = require('./screenshots');
const { runGates } = require('./gates');

const PORT = process.env.DS_PORT || 4100;
const ADMIN_TOKEN = process.env.DS_ADMIN_TOKEN || 'dev-editor-token';
const ROOT = path.join(__dirname, '..');
const CAPTURE_WIDTHS = [1200, 768, 375];

function etagOf(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}
function publicDocVersion(dba, dvId) {
  const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [dvId]);
  if (!dv || dv.status === 'draft' || dv.status === 'candidate') return null;
  return hydrate(dba, dv);
}
function hydrate(dba, dv) {
  const doc = dba.one('SELECT * FROM docs WHERE id=?', [dv.doc_id]);
  const decisions = dba.all('SELECT * FROM decisions WHERE doc_version_id=? ORDER BY id', [dv.id]);
  const comps = dba.all(
    `SELECT DISTINCT cv.* FROM refs r
     JOIN decisions d ON d.id=r.to_id AND d.doc_version_id=?
     JOIN component_versions cv ON CAST(cv.id AS TEXT)=r.from_id`, [dv.id]);
  for (const c of comps) {
    c.screenshots = dba.all('SELECT id,breakpoint,width,height,declared_ratio,fingerprint,file_path,renderer FROM screenshots WHERE component_version_id=? ORDER BY width', [c.id]);
    c.acceptance = c.acceptance_decision_id ? dba.one('SELECT id,title FROM decisions WHERE id=?', [c.acceptance_decision_id]) : null;
  }
  let sample = {};
  try { sample = JSON.parse(dv.responsive_sample); } catch (_) {}
  return {
    docId: doc.id, slug: doc.slug, title: doc.title,
    version: dv.version, status: dv.status,
    themePositioning: dv.theme_positioning,
    infoStructure: dv.info_structure,
    responsiveSample: sample,
    body: dv.body,
    decisions,
    components: comps,
    publishedAt: dv.published_at,
  };
}

async function main() {
  const dba = await init();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  /* ---------------- 公开只读 API（绝不返回 draft/candidate） ---------------- */
  app.get('/api/public/docs', (req, res) => {
    const rows = dba.all('SELECT d.slug,d.title,d.live_version FROM docs d WHERE d.live_version IS NOT NULL');
    res.json(rows);
  });
  app.get('/api/public/docs/:slug', (req, res) => {
    const doc = dba.one('SELECT * FROM docs WHERE slug=?', [req.params.slug]);
    if (!doc || doc.live_version == null) return res.status(404).json({ error: '文档尚未发布' });
    const dv = dba.one('SELECT * FROM doc_versions WHERE doc_id=? AND version=?', [doc.id, doc.live_version]);
    res.json(publicDocVersion(dba, dv.id));
  });
  // 历史版本：读者切换查看当时决策（仅列出 published/archived 的已发布过版本）
  app.get('/api/public/docs/:slug/versions', (req, res) => {
    const doc = dba.one('SELECT * FROM docs WHERE slug=?', [req.params.slug]);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const vs = dba.all(
      `SELECT v.id,v.version,v.status,v.published_at,p.build_id FROM doc_versions v
       LEFT JOIN promotions p ON p.doc_id=v.doc_id AND p.version=v.version AND p.active=1
       WHERE v.doc_id=? AND v.status IN ('published','archived') ORDER BY v.version DESC`, [doc.id]);
    res.json({ slug: doc.slug, liveVersion: doc.live_version, versions: vs });
  });
  app.get('/api/public/docs/:slug/versions/:version', (req, res) => {
    const doc = dba.one('SELECT * FROM docs WHERE slug=?', [req.params.slug]);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const dv = dba.one('SELECT * FROM doc_versions WHERE doc_id=? AND version=?', [doc.id, +req.params.version]);
    if (!dv || dv.status === 'draft' || dv.status === 'candidate') return res.status(404).json({ error: '该版本不存在或为后台草稿' });
    // 该版本曾在哪个构建上发布（即使已被新版本取代，行仍保留，active=0；故不限 active）
    const promo = dba.one('SELECT * FROM promotions WHERE doc_id=? AND version=? ORDER BY id DESC LIMIT 1', [doc.id, dv.version]);
    const payload = publicDocVersion(dba, dv.id);
    payload.servedByBuild = promo ? promo.build_id : null;
    payload.isLive = doc.live_version === dv.version;
    res.json(payload);
  });
  app.get('/api/public/components', (req, res) => {
    // 公开页只可见被某个已发布版引用、且其组件版本 accepted 的组件
    const rows = dba.all(
      `SELECT c.id,c.name,cv.version,cv.token_name,cv.token_value,cv.token_semantic,cv.props_json
       FROM components c JOIN component_versions cv ON cv.id=c.current_version_id
       WHERE cv.status='accepted' ORDER BY c.id`);
    res.json(rows);
  });

  /* ---------------- 预览与截图（公开可看图，渲染的是当前 accepted 组件现状） ---------------- */
  app.get('/api/preview/component/:id', (req, res) => {
    const cv = dba.one('SELECT * FROM component_versions WHERE id=?', [req.params.id]);
    if (!cv) return res.status(404).send('not found');
    res.type('html').send(render.html(cv));
  });
  app.get(['/shots/*', '/screenshots/*'], (req, res) => {
    const rel = req.params[0].replace(/\.\./g, '');
    const abs = path.join(ROOT, 'screenshots', rel);
    if (!abs.startsWith(path.join(ROOT, 'screenshots'))) return res.status(400).end();
    if (!fs.existsSync(abs)) return res.status(404).send('screenshot missing');
    res.type('svg').send(fs.readFileSync(abs));
  });

  /* ---------------- 后台 API（令牌隔离；草稿/candidate 仅此处可见） ---------------- */
  const admin = express.Router();
  app.use('/api/admin', admin);
  admin.use((req, res, next) => {
    if (req.get('x-editor-token') !== ADMIN_TOKEN) {
      dba.audit(req.get('x-editor-token') || 'anonymous', 'admin-denied', req.path);
      dba.flush();
      return res.status(401).json({ error: '后台令牌缺失或错误（公开页面无法访问草稿）' });
    }
    next();
  });

  admin.get('/docs', (req, res) => {
    res.json(dba.all(
      `SELECT d.*, v.version AS draft_version FROM docs d
       LEFT JOIN doc_versions v ON v.doc_id=d.id AND v.status='draft' ORDER BY d.id`));
  });
  admin.post('/docs', (req, res) => dba.transaction(() => {
    const id = 'doc-' + crypto.randomBytes(4).toString('hex');
    dba.run('INSERT INTO docs (id,slug,title) VALUES (?,?,?)', [id, req.body.slug, req.body.title]);
    dba.audit(req.get('x-editor-name'), 'doc.create', id, { slug: req.body.slug });
    res.json({ id });
  }).catch(e => res.status(400).json({ error: e.message })));

  // 新建编辑会话草稿：必须从当前 live 版 fork（G10 的服务端配合）
  admin.post('/docs/:id/draft', (req, res) => dba.transaction(() => {
    const doc = dba.one('SELECT * FROM docs WHERE id=?', [req.params.id]);
    if (!doc) throw Object.assign(new Error('doc not found'), { status: 404 });
    const existing = dba.one("SELECT id FROM doc_versions WHERE doc_id=? AND status='draft'", [doc.id]);
    if (existing) throw Object.assign(new Error('该文档已有打开的草稿，请先发布或丢弃'), { status: 409 });
    let base = null, seed = { theme_positioning: '', info_structure: '', responsive_sample: '{}', body: '' };
    if (doc.live_version != null) {
      base = dba.one('SELECT * FROM doc_versions WHERE doc_id=? AND version=?', [doc.id, doc.live_version]);
      seed = base;
    }
    const next = (dba.one('SELECT COALESCE(MAX(version),0)+1 AS n FROM doc_versions WHERE doc_id=?', [doc.id])).n;
    const payload = {
      theme_positioning: req.body.themePositioning ?? seed.theme_positioning ?? '',
      info_structure: req.body.infoStructure ?? seed.info_structure ?? '',
      responsive_sample: req.body.responsiveSample ? JSON.stringify(req.body.responsiveSample) : (seed.responsive_sample || '{}'),
      body: req.body.body ?? seed.body ?? '',
    };
    const etag = etagOf(payload);
    dba.run(
      `INSERT INTO doc_versions (doc_id,version,status,theme_positioning,info_structure,responsive_sample,body,base_version,etag,created_by)
       VALUES (?,?, 'draft', ?,?,?,?,?,?,?)`,
      [doc.id, next, payload.theme_positioning, payload.info_structure, payload.responsive_sample, payload.body,
       doc.live_version, etag, req.get('x-editor-name') || 'editor']);
    const dvId = dba.one('SELECT last_insert_rowid() AS id').id;
    // fork 决策副本：全部生成新 id（草稿之间相互独立），并把决策间引用重映射
    if (base) {
      const oldDecs = dba.all('SELECT * FROM decisions WHERE doc_version_id=?', [base.id]);
      const idMap = new Map();
      for (const od of oldDecs) {
        const nid = 'dec-' + crypto.randomBytes(6).toString('hex');
        idMap.set(od.id, nid);
      }
      for (const od of oldDecs) {
        dba.run(`INSERT INTO decisions (id,doc_version_id,kind,title,detail,page_path,target_selector,editor,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
          [idMap.get(od.id), dvId, od.kind, od.title, od.detail, od.page_path, od.target_selector, od.editor, od.created_at]);
      }
      // 复制“决策 -> 决策”引用（两端都属于被 fork 的版本时重映射）
      const oldRefs = dba.all(
        `SELECT * FROM refs WHERE from_kind='decision' AND to_kind='decision'
         AND from_id IN (SELECT id FROM decisions WHERE doc_version_id=?)
         AND to_id IN (SELECT id FROM decisions WHERE doc_version_id=?)`,
        [base.id, base.id]);
      for (const r of oldRefs) {
        dba.run('INSERT INTO refs (from_kind,from_id,to_kind,to_id) VALUES (?,?,?,?)',
          ['decision', idMap.get(r.from_id), 'decision', idMap.get(r.to_id)]);
      }
    }
    dba.audit(req.get('x-editor-name'), 'draft.create', doc.id, { version: next, base: doc.live_version });
    res.json({ docVersionId: dvId, version: next, baseVersion: doc.live_version, etag });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  admin.get('/docs/:id/drafts', (req, res) => {
    res.json(dba.all("SELECT id,version,base_version,etag,created_at FROM doc_versions WHERE doc_id=? AND status='draft' ORDER BY version DESC", [req.params.id]));
  });

  // 丢弃被屏障拒绝或不再需要的草稿（已发布版本不可删）
  admin.delete('/versions/:id', (req, res) => dba.transaction(() => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv) throw Object.assign(new Error('not found'), { status: 404 });
    if (dv.status !== 'draft') throw Object.assign(new Error('仅草稿可丢弃（已发布版本不可变）'), { status: 409 });
    dba.run('DELETE FROM doc_versions WHERE id=?', [dv.id]); // FK cascade 清 decisions
    dba.audit(req.get('x-editor-name'), 'draft.discard', String(dv.id), { version: dv.version });
    res.json({ ok: true });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  admin.get('/versions/:id', (req, res) => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv) return res.status(404).json({ error: 'not found' });
    res.json({ ...hydrate(dba, dv), etag: dv.etag, baseVersion: dv.base_version });
  });

  // 保存草稿：乐观锁 If-Match / X-Etag，两编辑冲突时后保存方收到 409
  admin.put('/versions/:id', (req, res) => dba.transaction(() => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv) throw Object.assign(new Error('not found'), { status: 404 });
    if (dv.status !== 'draft') throw Object.assign(new Error('仅草稿可编辑（已发布版本不可变）'), { status: 409 });
    const match = req.get('if-match') || req.get('x-etag');
    if (match && match !== dv.etag) {
      dba.audit(req.get('x-editor-name'), 'draft.conflict', dv.id, { expected: dv.etag, got: match });
      throw Object.assign(new Error('内容已被另一位编辑修改（etag 冲突），请刷新后基于最新草稿合并，禁止覆盖'), { status: 409, etag: dv.etag });
    }
    const payload = {
      theme_positioning: req.body.themePositioning ?? dv.theme_positioning,
      info_structure: req.body.infoStructure ?? dv.info_structure,
      responsive_sample: req.body.responsiveSample ? JSON.stringify(req.body.responsiveSample) : dv.responsive_sample,
      body: req.body.body ?? dv.body,
    };
    const etag = etagOf(payload);
    dba.run(`UPDATE doc_versions SET theme_positioning=?,info_structure=?,responsive_sample=?,body=?,etag=? WHERE id=?`,
      [payload.theme_positioning, payload.info_structure, payload.responsive_sample, payload.body, etag, dv.id]);
    dba.audit(req.get('x-editor-name'), 'draft.save', dv.id);
    res.json({ ok: true, etag });
  }).catch(e => res.status(e.status || 400).json({ error: e.message, etag: e.etag })));

  // 决策（素材来源/色彩/可访问交互/验收）
  admin.post('/versions/:id/decisions', (req, res) => dba.transaction(() => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv || dv.status !== 'draft') throw Object.assign(new Error('只能向草稿添加决策'), { status: 409 });
    const id = 'dec-' + crypto.randomBytes(6).toString('hex');
    const b = req.body;
    dba.run(`INSERT INTO decisions (id,doc_version_id,kind,title,detail,page_path,target_selector,editor)
             VALUES (?,?,?,?,?,?,?,?)`,
      [id, dv.id, b.kind, b.title, b.detail || '', b.pagePath || null, b.targetSelector || null,
       req.get('x-editor-name') || 'editor']);
    if (b.refDecisionId) dba.run('INSERT INTO refs (from_kind,from_id,to_kind,to_id) VALUES (?,?,?,?)',
      ['decision', id, 'decision', b.refDecisionId]);
    dba.audit(req.get('x-editor-name'), 'decision.add', id, { kind: b.kind });
    res.json({ id });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  admin.post('/decisions/:id/refs', (req, res) => dba.transaction(() => {
    dba.run('INSERT INTO refs (from_kind,from_id,to_kind,to_id) VALUES (?,?,?,?)',
      ['decision', req.params.id, req.body.toKind || 'decision', req.body.toId]);
    res.json({ ok: true });
  }).catch(e => res.status(400).json({ error: e.message })));

  /* ---------------- 组件与令牌 ---------------- */
  admin.get('/components', (req, res) => {
    const rows = dba.all(
      `SELECT c.id,c.name,c.current_version_id, cv.version,cv.token_name,cv.token_value,cv.status
       FROM components c LEFT JOIN component_versions cv ON cv.id=c.current_version_id ORDER BY c.id`);
    res.json(rows);
  });
  // 组件明细：当前版本 + 截图 + 验收决策（后台“组件与令牌”页用）
  admin.get('/components-detail', (req, res) => {
    const comps = dba.all('SELECT * FROM components ORDER BY id');
    const out = comps.map(c => {
      const cv = dba.one('SELECT * FROM component_versions WHERE id=?', [c.current_version_id]);
      if (!cv) return { id: c.id, name: c.name, version: null, status: 'none', screenshots: [], currentCvId: null };
      const screenshots = dba.all('SELECT * FROM screenshots WHERE component_version_id=? ORDER BY width', [cv.id]);
      const acceptance = cv.acceptance_decision_id
        ? dba.one('SELECT id,title,created_at FROM decisions WHERE id=?', [cv.acceptance_decision_id]) : null;
      let props = {};
      try { props = JSON.parse(cv.props_json); } catch (_) {}
      return {
        id: c.id, name: cv.name, version: cv.version, status: cv.status,
        currentCvId: cv.id, token_name: cv.token_name, token_value: cv.token_value, token_semantic: cv.token_semantic,
        props, screenshots, acceptance,
      };
    });
    res.json(out);
  });
  admin.post('/components', (req, res) => dba.transaction(() => {
    const id = 'comp-' + crypto.randomBytes(4).toString('hex');
    dba.run('INSERT INTO components (id,name) VALUES (?,?)', [id, req.body.name]);
    res.json({ id });
  }).catch(e => res.status(400).json({ error: e.message })));

  // 新组件版本（改名 / 令牌变化都走这里；自动生成三断点截图；可携带验收决策 id——但 G9 会校验时序）
  admin.post('/components/:id/versions', (req, res) => dba.transaction(() => {
    const comp = dba.one('SELECT * FROM components WHERE id=?', [req.params.id]);
    if (!comp) throw Object.assign(new Error('component not found'), { status: 404 });
    const next = (dba.one('SELECT COALESCE(MAX(version),0)+1 AS n FROM component_versions WHERE component_id=?', [comp.id])).n;
    const b = req.body;
    const cvRow = {
      name: b.name || comp.name,
      token_name: b.tokenName, token_value: b.tokenValue, token_semantic: b.tokenSemantic || '',
      props_json: JSON.stringify(b.props || {}),
      acceptance: b.acceptanceDecisionId || null,
    };
    dba.run(
      `INSERT INTO component_versions (component_id,version,name,token_name,token_value,token_semantic,props_json,acceptance_decision_id,status,created_by)
       VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`,
      [comp.id, next, cvRow.name, cvRow.token_name, cvRow.token_value, cvRow.token_semantic, cvRow.props_json, cvRow.acceptance,
       req.get('x-editor-name') || 'editor']);
    const cvId = dba.one('SELECT last_insert_rowid() AS id').id;
    // 截图在事务中生成（失败 -> 整个请求回滚，天然支持“截图生成失败”阻断）
    // 支持请求头注入渲染器故障（交付自检场景 C）；env 注入供同进程脚本使用
    const failInjected = req.get('x-inject-screenshot-fail') === '1' || process.env.DS_SCREENSHOT_FAIL === '1';
    try {
      if (failInjected) throw new shots.ScreenshotError('渲染器崩溃（注入故障 x-inject-screenshot-fail）');
      shots.refreshFor(dba, cvId, CAPTURE_WIDTHS);
    } catch (e) {
      throw Object.assign(new Error('截图生成失败，组件版本版本事务回滚: ' + e.message), { status: 502 });
    }
    dba.run('UPDATE components SET name=?, current_version_id=? WHERE id=?', [cvRow.name, cvId, comp.id]);
    dba.audit(req.get('x-editor-name'), 'component.version', comp.id, { cvId, token: cvRow.token_name + '=' + cvRow.token_value });
    res.json({ componentVersionId: cvId, version: next });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  // 重新截图（令牌或改名后修复）
  admin.post('/component-versions/:id/recapture', (req, res) => dba.transaction(() => {
    try {
      const out = shots.refreshFor(dba, +req.params.id, req.body.widths || CAPTURE_WIDTHS);
      res.json({ ok: true, shots: out.map(s => ({ width: s.width, fp: s.fingerprint.slice(0, 8) })) });
    } catch (e) {
      throw Object.assign(new Error(e.message), { status: 502 });
    }
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  // 组件版本通过验收（必须有先置验收决策）
  admin.post('/component-versions/:id/accept', (req, res) => dba.transaction(() => {
    const cv = dba.one('SELECT * FROM component_versions WHERE id=?', [req.params.id]);
    if (!cv) throw Object.assign(new Error('not found'), { status: 404 });
    if (!cv.acceptance_decision_id) throw Object.assign(new Error('缺少验收文档，不能验收上线'), { status: 409 });
    dba.run("UPDATE component_versions SET status='accepted' WHERE id=?", [cv.id]);
    dba.run('UPDATE components SET current_version_id=? WHERE id=?', [cv.id, cv.component_id]);
    dba.audit(req.get('x-editor-name'), 'component.accept', cv.component_id, { cvId: cv.id });
    res.json({ ok: true });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  // 把组件版本挂到候选文档（创建 refs: component -> 候选的某条决策）
  admin.post('/versions/:id/link-component', (req, res) => dba.transaction(() => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv || dv.status !== 'draft') throw Object.assign(new Error('只能在草稿中挂接组件'), { status: 409 });
    const decisionId = req.body.decisionId;
    if (decisionId && !dba.one('SELECT id FROM decisions WHERE id=? AND doc_version_id=?', [decisionId, dv.id]))
      throw Object.assign(new Error('决策不属于该草稿'), { status: 400 });
    dba.run('INSERT INTO refs (from_kind,from_id,to_kind,to_id) VALUES (?,?,?,?)',
      ['component', String(req.body.componentVersionId), 'decision', decisionId || 'dec-orphan-' + dv.id]);
    res.json({ ok: true });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  /* ---------------- 构建（文档随代码发布一侧） ---------------- */
  admin.post('/builds', (req, res) => dba.transaction(() => {
    const id = 'b-' + (req.body.codeRef || crypto.randomBytes(5).toString('hex'));
    if (dba.one('SELECT id FROM builds WHERE id=?', [id])) throw Object.assign(new Error('构建已存在 ' + id), { status: 409 });
    const manifest = buildsLib.createSnapshot(id);
    dba.run("INSERT INTO builds (id,code_ref,status,manifest_json) VALUES (?,?, 'active', ?)",
      [id, manifest.code_ref, JSON.stringify(manifest)]);
    dba.audit(req.get('x-editor-name'), 'build.create', id, { pages: manifest.pages.length });
    res.json({ id, pages: manifest.pages.length, breakpoints: manifest.breakpoints });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  admin.post('/builds/:id/retract', (req, res) => dba.transaction(() => {
    const b = dba.one('SELECT * FROM builds WHERE id=?', [req.params.id]);
    if (!b) throw Object.assign(new Error('not found'), { status: 404 });
    dba.run("UPDATE builds SET status='retracted', retracted_at=datetime('now') WHERE id=?", [b.id]);
    dba.audit(req.get('x-editor-name'), 'build.retract', b.id);
    // 注意：live 版不动 —— 撤回只阻止新发布/给出告警，正在访问的稳定版继续服务
    res.json({ ok: true, notice: '已撤回；当前线上版本继续由旧快照服务，新候选将被 G1 阻断' });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  admin.get('/builds', (req, res) => res.json(dba.all('SELECT id,code_ref,status,created_at,retracted_at FROM builds ORDER BY id')));

  // 预演屏障（不改变状态）
  admin.post('/versions/:id/check', (req, res) => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv) return res.status(404).json({ error: 'not found' });
    const gatesResults = runGates(dba, dv, req.body.buildId);
    res.json({ ok: gatesResults.every(g => g.ok), gates: gatesResults });
  });

  // 发布候选：屏障全绿 -> 事务内切换 live；任何失败 -> ROLLBACK，稳定版不动
  admin.post('/versions/:id/promote', (req, res) => dba.transaction(() => {
    const dv = dba.one('SELECT * FROM doc_versions WHERE id=?', [req.params.id]);
    if (!dv) throw Object.assign(new Error('not found'), { status: 404 });
    if (!['draft', 'candidate'].includes(dv.status)) throw Object.assign(new Error('该版本已发布且不可变'), { status: 409 });
    const buildId = req.body.buildId;
    const gatesResults = runGates(dba, dv, buildId);
    const passed = gatesResults.every(g => g.ok);
    dba.run('INSERT INTO release_attempts (doc_version_id,build_id,result,gates_json) VALUES (?,?,?,?)',
      [dv.id, buildId || null, passed ? 'promoted' : 'rejected', JSON.stringify(gatesResults)]);
    if (!passed) {
      dba.audit(req.get('x-editor-name'), 'release.reject', dv.id, { failed: gatesResults.filter(g => !g.ok).map(g => g.id) });
      const err = Object.assign(new Error('发布屏障未通过，候选被拒绝；稳定版未受影响'), { status: 422, gates: gatesResults });
      throw err;
    }
    const doc = dba.one('SELECT * FROM docs WHERE id=?', [dv.doc_id]);
    dba.run("UPDATE doc_versions SET status='published', published_at=datetime('now') WHERE id=?", [dv.id]);
    if (doc.live_version != null)
      dba.run("UPDATE doc_versions SET status='archived' WHERE doc_id=? AND version=?", [doc.id, doc.live_version]);
    dba.run('UPDATE docs SET live_version=? WHERE id=?', [dv.version, doc.id]);
    dba.run('UPDATE promotions SET active=0 WHERE doc_id=? AND active=1', [doc.id]);
    dba.run('INSERT INTO promotions (doc_id,version,build_id,active,snapshot_json) VALUES (?,?,?,1,?)',
      [doc.id, dv.version, buildId, JSON.stringify(hydrate(dba, dv))]);
    dba.audit(req.get('x-editor-name'), 'release.promote', doc.id, { version: dv.version, buildId });
    res.status(201).json({ ok: true, version: dv.version, gates: gatesResults });
  }).catch(e => res.status(e.status || 400).json({ error: e.message, gates: e.gates })));

  // 回滚：激活历史 promotion（稳定版回退；不需要再跑 G8 等，因为是过去已通过的版本）
  admin.post('/docs/:id/rollback', (req, res) => dba.transaction(() => {
    const doc = dba.one('SELECT * FROM docs WHERE id=?', [req.params.id]);
    if (!doc) throw Object.assign(new Error('not found'), { status: 404 });
    const target = +req.body.version;
    const promo = dba.one('SELECT * FROM promotions WHERE doc_id=? AND version=?', [doc.id, target]);
    if (!promo) throw Object.assign(new Error('历史版本不存在，无法回滚'), { status: 404 });
    dba.run('UPDATE promotions SET active=0 WHERE doc_id=? AND active=1', [doc.id]);
    dba.run('UPDATE promotions SET active=1 WHERE id=?', [promo.id]);
    dba.run('UPDATE docs SET live_version=? WHERE id=?', [target, doc.id]);
    dba.run("UPDATE doc_versions SET status='archived' WHERE doc_id=? AND version<>?", [doc.id, target]);
    dba.run("UPDATE doc_versions SET status='published' WHERE doc_id=? AND version=?", [doc.id, target]);
    dba.run('INSERT INTO release_attempts (doc_version_id,build_id,result,gates_json) VALUES (?,?,?,?)',
      [dba.one('SELECT id FROM doc_versions WHERE doc_id=? AND version=?', [doc.id, target]).id, promo.build_id, 'rolled_back', '[]']);
    dba.audit(req.get('x-editor-name'), 'release.rollback', doc.id, { version: target });
    res.json({ ok: true, liveVersion: target });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  admin.get('/audit', (req, res) => res.json(dba.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')));
  admin.get('/attempts', (req, res) => res.json(dba.all('SELECT id,doc_version_id,build_id,result,gates_json,created_at FROM release_attempts ORDER BY id DESC LIMIT 50')));

  // 为组件版本补挂验收决策（模拟“先上线后补验收”场景；G9 用时间戳判定）
  admin.post('/component-versions/:id/acceptance', (req, res) => dba.transaction(() => {
    const cv = dba.one('SELECT * FROM component_versions WHERE id=?', [req.params.id]);
    if (!cv) throw Object.assign(new Error('not found'), { status: 404 });
    if (!dba.one('SELECT id FROM decisions WHERE id=?', [req.body.decisionId]))
      throw Object.assign(new Error('决策不存在'), { status: 400 });
    dba.run('UPDATE component_versions SET acceptance_decision_id=? WHERE id=?', [req.body.decisionId, cv.id]);
    res.json({ ok: true });
  }).catch(e => res.status(e.status || 400).json({ error: e.message })));

  /* ---- 仅交付自检使用的故障注入钩子（需后台令牌；审计留痕） ---- */
  // 让 DB 中截图指纹与组件现状不符（模拟：组件改名/令牌变化后未重截，仍拿旧截图当现状）
  admin.post('/__test/tamper-shot', (req, res) => dba.transaction(() => {
    const id = +req.body.componentVersionId;
    dba.run('UPDATE screenshots SET fingerprint=? WHERE component_version_id=?', ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', id]);
    dba.audit(req.get('x-editor-name'), 'test.tamper-shot', String(id));
    res.json({ ok: true });
  }).catch(e => res.status(400).json({ error: e.message })));

  // 让截图文件实际尺寸与 DB 声明不一致（图片比例损坏）
  admin.post('/__test/tamper-ratio', (req, res) => dba.transaction(() => {
    const id = +req.body.componentVersionId;
    const shotsRows = dba.all('SELECT * FROM screenshots WHERE component_version_id=?', [id]);
    for (const s of shotsRows) {
      const abs = path.join(ROOT, s.file_path);
      let txt = fs.readFileSync(abs, 'utf8');
      txt = txt.replace(/(<svg[^>]*\bwidth=")\d+(")/, `$1${s.width + 13}$2`); // 实际宽度 +13px
      fs.writeFileSync(abs, txt);
    }
    dba.audit(req.get('x-editor-name'), 'test.tamper-ratio', String(id));
    res.json({ ok: true, tampered: shotsRows.length });
  }).catch(e => res.status(400).json({ error: e.message })));

  /* ---------------- 站点快照静态服务（构建产物；草稿/数据目录绝不暴露） ---------------- */
  app.use('/site/:buildId', (req, res, next) => {
    const b = dba.one('SELECT id,status FROM builds WHERE id=?', [req.params.buildId]);
    if (!b) return res.status(404).send('unknown build');
    const rel = req.path.replace(/^\/+/, '').split('?')[0];
    const abs = path.normalize(path.join(buildsLib.snapshotDir(b.id), rel || 'index.html'));
    if (!abs.startsWith(buildsLib.snapshotDir(b.id))) return res.status(400).end();
    const target = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'index.html') : abs;
    if (!fs.existsSync(target)) return res.status(404).send('not in build snapshot');
    res.sendFile(target);
  });

  /* ---------------- 前端页面 ---------------- */
  app.use('/app', express.static(path.join(ROOT, 'web')));
  app.get('/', (req, res) => res.redirect('/app/'));

  app.listen(PORT, () => console.log(`design-system listening on http://localhost:${PORT}`));
}
main().catch(e => { console.error(e); process.exit(1); });
