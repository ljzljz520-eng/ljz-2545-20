'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('../db/db');
const svc = require('../content/service');
const rel = require('../release/release');
const { renderPage, esc } = require('../render/layout');

const PORT = Number(process.env.PORT || 4010);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  const h = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
  if (!isStr) body = JSON.stringify(body);
  res.writeHead(code, h); res.end(body);
}
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});
function isAdmin(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${ADMIN_TOKEN}` || (req.url.includes('?') && new URL(req.url, 'http://x').searchParams.get('token') === ADMIN_TOKEN);
}

function renderContext(docSlug, dv) {
  const content = svc.hydrate(dv).content;
  content.docSlug = docSlug;
  const { tokens, hash: tokensHash } = svc.activeTokens();
  const compMap = Object.fromEntries(svc.allComponents().map((c) => [c.slug, c]));
  const assetMap = Object.fromEntries(svc.allAssets().map((a) => [a.id, a]));
  const sourceMap = Object.fromEntries(svc.allSources().map((s) => [s.slug, s]));
  return { content, tokens, tokensHash, compMap, assetMap, sourceMap };
}

// 版本切换条；历史版本显示"当前决策快照"提示；截图过期给出红标（绝不当现状）
function versionBanner(docSlug, dv, active) {
  const versions = db.all(
    `SELECT v.version, v.status, v.created_at FROM doc_versions v
     WHERE v.doc_slug=? AND v.status IN ('published','archived') ORDER BY v.version`, [docSlug]);
  const opts = versions.map((v) =>
    `<option value="${v.version}" ${v.version === dv.version ? 'selected' : ''}>v${v.version}${v.status === 'published' ? '（线上）' : '（历史）'}</option>`).join('');
  const isStable = active && active.doc_version_id === dv.id;
  return `<div class="section verswitch" role="region" aria-label="版本切换">
    版本：<select aria-label="选择历史版本" onchange="location.href='/d/${esc(docSlug)}@v'+this.value">${opts}</select>
    ${isStable ? '<span class="badge">当前稳定版</span>'
               : '<span class="stale">历史版本快照（记录当时决策，非当前现状）</span>'}
    发布时间：${esc(dv.created_at)} · <a href="/api/docs/${esc(docSlug)}/versions">JSON 版本列表</a>
  </div>`;
}

// 把该版本的截图以"现状/已过期"两种状态渲染出来
function screenshotsHtml(dv, tokensHash, compMap) {
  const shots = db.all('SELECT * FROM screenshots WHERE doc_version_id=? ORDER BY component_slug,breakpoint', [dv.id]);
  if (!shots.length) return '';
  const cards = shots.map((s) => {
    const comp = compMap[s.component_slug];
    const stale = !comp || comp.source_hash !== s.component_hash ||
      comp.display_name !== s.component_name || s.token_hash !== tokensHash;
    const file = '/' + s.file_path.replace(/^artifacts[\\/]/, 'artifacts/');
    return `<figure class="card" style="margin:0">
      <img src="${esc(file)}" alt="${esc(s.component_name)} 在 ${s.breakpoint}px 断点的截图"
           style="width:100%;height:auto;${stale ? 'opacity:.45;filter:grayscale(1)' : ''}">
      <figcaption>${esc(s.component_name)} @ ${s.breakpoint}px
        ${stale ? '<span class="stale">截图已过期（组件改名/源码或令牌变更）— 不得作为现状</span>'
                : '<span class="badge">现状截图</span>'}
        <br><small>engine=${esc(s.engine)} · ${esc(s.component_hash.slice(0, 8))} · ${esc(s.token_hash.slice(0, 8))}</small>
      </figcaption></figure>`;
  }).join('');
  return `<section class="section" id="shots" aria-labelledby="h-shots"><h2 id="h-shots">现状截图（按关键断点）</h2>
    <div class="grid">${cards}</div></section>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  try {
    // ---- 静态资源（截图制品）----
    if (p.startsWith('/artifacts/')) {
      const fp = path.join(process.cwd(), decodeURIComponent(p.slice(1)));
      if (!fp.startsWith(path.join(process.cwd(), 'artifacts'))) return send(res, 403, { error: 'forbidden' });
      if (!fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
      const ext = fp.endsWith('.png') ? 'image/png' : 'image/svg+xml';
      return send(res, 200, fs.readFileSync(fp), { 'Content-Type': ext + '; charset=utf-8' });
    }
    // 站内实际页面（仓库根目录的静态原型），使信息结构映射可点击落到真实页面
    const smSite = p.match(/^\/site\/([a-zA-Z0-9_.-]+\.html)$/);
    if (smSite) {
      const fp = path.join(process.cwd(), smSite[1]);
      if (fs.existsSync(fp)) return send(res, 200, fs.readFileSync(fp), { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 404, { error: 'site page not found' });
    }
    if (p === '/site/css/style.css') {
      const fp = path.join(process.cwd(), 'css', 'style.css');
      if (fs.existsSync(fp)) return send(res, 200, fs.readFileSync(fp), { 'Content-Type': 'text/css; charset=utf-8' });
    }
    if (p === '/health') return send(res, 200, { ok: true });

    // ---- 内容 API：公开，仅返回已发布版本；草稿一律 404（不暴露其存在）----
    let m;
    if ((m = p.match(/^\/api\/docs\/([^@/]+)\/versions$/))) {
      const docSlug = m[1];
      const vs = db.all(
        `SELECT version,status,created_at,editor FROM doc_versions
         WHERE doc_slug=? AND status IN ('published','archived') ORDER BY version`, [docSlug]);
      return send(res, 200, { docSlug, versions: vs,
        stable: rel.activeRelease(docSlug) ? db.get('SELECT version FROM doc_versions WHERE id=?',
          [rel.activeRelease(docSlug).doc_version_id]).version : null });
    }
    if ((m = p.match(/^\/api\/docs\/([^@/]+)(?:@v(\d+))?$/)) && req.method === 'GET') {
      const [, docSlug, ver] = m;
      let dv;
      if (ver) {
        dv = db.get('SELECT * FROM doc_versions WHERE doc_slug=? AND version=?', [docSlug, Number(ver)]);
        if (dv && ['draft', 'candidate'].includes(dv.status)) return send(res, 404, { error: 'not found' });
      } else {
        const active = rel.activeRelease(docSlug);
        if (!active) return send(res, 404, { error: 'no published version' });
        dv = db.get('SELECT * FROM doc_versions WHERE id=?', [active.doc_version_id]);
      }
      if (!dv) return send(res, 404, { error: 'not found' });
      const v = svc.hydrate(dv);
      return send(res, 200, { docSlug, version: dv.version, status: dv.status,
        title: dv.title, content: v.content, refs: v.refs, createdAt: dv.created_at });
    }

    // ---- 公开页面：稳定版 / 历史版本（草稿 URL 404，绝不公开）----
    if ((m = p.match(/^\/d\/([^@/]+)(?:@v(\d+))?$/)) || (m = p.match(/^\/$/))) {
      const docSlug = m && m[1] ? m[1] : 'design-system';
      const ver = m && m[2] ? Number(m[2]) : null;
      const active = rel.activeRelease(docSlug);
      let dv;
      if (ver) {
        dv = db.get('SELECT * FROM doc_versions WHERE doc_slug=? AND version=?', [docSlug, ver]);
        if (dv && ['draft', 'candidate'].includes(dv.status)) dv = null; // 历史读者看不到草稿
      } else if (active) {
        dv = db.get('SELECT * FROM doc_versions WHERE id=?', [active.doc_version_id]);
      }
      if (!dv) return send(res, 404, render404(docSlug, active));
      const ctx = renderContext(docSlug, dv);
      const html = renderPage({
        ...ctx,
        extraBanner: versionBanner(docSlug, dv, active),
        screenshotsHtml: screenshotsHtml(dv, ctx.tokensHash, ctx.compMap)
      });
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // ---- 后台管理页（简单 token，浏览器 ?token= 便于演示）----
    if (p === '/admin' && isAdmin(req)) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin.html'), 'utf8'),
        { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/admin' && !isAdmin(req)) return send(res, 401, { error: 'unauthorized' });

    // ---- 后台 API（写操作需要 Bearer token）----
    if (p.startsWith('/admin/api/')) {
      if (req.method === 'GET' && !isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET' && !isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : parsed.query;

      if (p === '/admin/api/drafts' && req.method === 'GET') {
        const docSlug = body.docSlug || parsed.query.docSlug || 'design-system';
        const d = svc.currentDraft(docSlug);
        if (!d) return send(res, 404, { error: 'no draft' });
        return send(res, 200, { version: d.version, title: d.title, content: d.content, checksum: d.checksum });
      }
      if (p === '/admin/api/drafts' && req.method === 'POST') {
        try {
          const v = svc.saveDraft({ docSlug: body.docSlug || 'design-system', title: body.title || '站内设计说明',
            content: body.content, editor: body.editor || 'editor', baseVersion: body.baseVersion || null,
            checksumHint: body.baseChecksum || null, newVersion: !!body.newVersion });
          return send(res, 201, { version: v.version, checksum: v.checksum });
        } catch (e) { return send(res, e.status || 400, { error: e.message, code: e.code, conflict: e.conflict }); }
      }
      if ((m = p.match(/^\/admin\/api\/drafts\/v(\d+)$/)) && req.method === 'PUT') {
        try {
          const v = svc.updateDraft({ docSlug: body.docSlug || 'design-system', version: Number(m[1]),
            title: body.title || '站内设计说明', content: body.content,
            editor: body.editor || 'editor', expectedChecksum: body.expectedChecksum });
          return send(res, 200, { version: v.version, checksum: v.checksum });
        } catch (e) { return send(res, e.status || 400, { error: e.message, code: e.code, conflict: e.conflict }); }
      }
      if (p === '/admin/api/components/rename' && req.method === 'POST') {
        try { return send(res, 200, svc.renameComponent(body.slug, body.displayName, body.editor)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/admin/api/components/activate' && req.method === 'POST') {
        try { return send(res, 200, svc.activateComponent(body.slug, body.editor)); }
        catch (e) { return send(res, e.status || 400, { error: e.message, code: e.code }); }
      }
      if (p === '/admin/api/components/deps' && req.method === 'POST') {
        try { return send(res, 200, svc.setDependency(body.slug, body.depends_on || [], body.editor)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/admin/api/components/acceptance' && req.method === 'POST') {
        svc.attachAcceptance(body.slug, body.docRef, body.editor);
        return send(res, 200, { ok: true });
      }
      if (p === '/admin/api/tokens/bump' && req.method === 'POST') {
        return send(res, 200, svc.bumpTokens(body.editor, body.overrides));
      }
      if (p === '/admin/api/builds' && req.method === 'POST') {
        try {
          const b = svc.createBuild({ docSlug: body.docSlug || 'design-system', version: body.version,
            mode: body.mode || 'decoupled', gitRef: body.gitRef, actor: body.editor });
          return send(res, 201, { buildKey: b.build_key, id: b.id, status: b.status });
        } catch (e) { return send(res, 400, { error: e.message, code: e.code }); }
      }
      if ((m = p.match(/^\/admin\/api\/builds\/([^/]+)\/gate$/)) && req.method === 'POST') {
        const out = await rel.gateBuild(m[1], {
          failSet: body.failSet ? new Set(body.failSet) : null,
          apiContract: body.apiContract,
          regenerateScreenshots: body.regenerateScreenshots !== false, linkChecker: null });
        return send(res, out.passed ? 200 : 422, { passed: out.passed, build: out.build.status, results: out.results });
      }
      if ((m = p.match(/^\/admin\/api\/builds\/([^/]+)\/promote$/)) && req.method === 'POST') {
        try { return send(res, 200, rel.promote(m[1], body.editor)); }
        catch (e) { return send(res, e.status || 409, { error: e.message, code: e.code }); }
      }
      if (p === '/admin/api/releases/rollback' && req.method === 'POST') {
        try { return send(res, 200, rel.rollback(body.docSlug || 'design-system', body.editor)); }
        catch (e) { return send(res, e.status || 409, { error: e.message, code: e.code }); }
      }
      // 测试/演练用：对最新草稿内容打补丁，用于触发链接、图片等门
      if (p === '/admin/api/test/patch-draft' && req.method === 'POST') {
        const draft = svc.currentDraft(body.docSlug || 'design-system');
        const content = JSON.parse(JSON.stringify(draft.content));
        const patch = body.patch || {};
        if (patch.appendLinks) {
          content.sections[0].links = (content.sections[0].links || []).concat(patch.appendLinks);
        }
        if (patch.addRefs) {
          content.sections.push({ id: 'sec-extra-' + Date.now(), heading: '额外引用',
            type: 'prose', body: '测试引用', components: patch.addRefs.components, images: patch.addRefs.images });
        }
        const v = svc.updateDraft({ docSlug: body.docSlug || 'design-system', version: draft.version,
          title: draft.title, content, editor: 'test', expectedChecksum: draft.checksum });
        return send(res, 200, { version: v.version, checksum: v.checksum });
      }
      if (p === '/admin/api/state' && req.method === 'GET') {
        const docSlug = parsed.query.docSlug || 'design-system';
        return send(res, 200, {
          versions: svc.listVersions(docSlug),
          components: svc.allComponents(),
          tokens: svc.activeTokens(),
          release: rel.activeRelease(docSlug),
          builds: db.all('SELECT id,build_key,status,mode,git_ref FROM builds ORDER BY id DESC LIMIT 10')
        });
      }
      return send(res, 404, { error: 'unknown admin endpoint' });
    }

    return send(res, 404, { error: 'not found', path: p });
  } catch (e) {
    return send(res, 500, { error: e.message, stack: process.env.NODE_ENV === 'production' ? undefined : e.stack });
  }
});

function render404(docSlug, active) {
  return `<!doctype html><meta charset="utf-8"><title>未发布</title>
  <body style="font-family:system-ui;padding:40px"><h1>该版本尚不可公开访问</h1>
  <p>它可能仍是后台草稿，或未通过发布屏障。${active ? '<a href="/d/' + esc(docSlug) + '">前往当前稳定版</a>' : ''}</p></body>`;
}

if (require.main === module) {
  db.open().then(() => {
    svc.seedAll();
    server.listen(PORT, () => console.log(`design-docs server on http://localhost:${PORT} (admin token: ${ADMIN_TOKEN})`));
  });
}
module.exports = server;
