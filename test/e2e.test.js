'use strict';
// 验收场景：全部通过真实 HTTP 运行，每个用例独立服务器子进程 + 独立 SQLite 文件
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv } = require('./helpers');

async function currentDraft(env) {
  const r = await env.api('/admin/api/drafts?docSlug=design-system');
  assert.equal(r.status, 200, r.json.error);
  return r.json;
}
async function saveDraft(env, content, baseVersion, editor, baseChecksum) {
  const r = await env.api('/admin/api/drafts', { body: { docSlug: 'design-system', title: '站内设计说明', content, baseVersion, editor, baseChecksum: baseChecksum || null } });
  return r;
}
async function publishCurrent(env, { failSet, mode, apiContract } = {}) {
  const draft = await currentDraft(env);
  const cb = await env.api('/admin/api/builds', { body: { docSlug: 'design-system', version: draft.version, mode: mode || 'decoupled' } });
  assert.equal(cb.status, 201);
  const g = await env.api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: { failSet, apiContract } });
  let promoted = null;
  if (g.json.passed) promoted = await env.api(`/admin/api/builds/${cb.json.buildKey}/promote`, { body: { editor: 'tester' } });
  return { buildKey: cb.json.buildKey, gate: g, promoted };
}
async function stableId(env) {
  const db = await env.openSideDb();
  const r = db.exec("SELECT id FROM releases WHERE doc_slug='design-system' AND active=1");
  db.close();
  return r.length ? r[0].values[0][0] : null;
}
async function buildStatus(env, key) {
  const db = await env.openSideDb();
  const r = db.exec(`SELECT status FROM builds WHERE build_key='${key}'`);
  db.close();
  return r.length ? r[0].values[0][0] : null;
}

test('场景1：验收文档先于组件上线——缺验收文档禁止上线，挂上后可上线', async () => {
  const env = await freshEnv();
  try {
    const blocked = await env.api('/admin/api/components/activate', { body: { slug: 'modal' } });
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error, /验收文档/);
    await env.api('/admin/api/components/acceptance', { body: { slug: 'modal', docRef: 'design-system@1' } });
    const ok = await env.api('/admin/api/components/activate', { body: { slug: 'modal' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'live');
  } finally { await env.close(); }
});

test('场景2：引用环——制造环后门禁拒绝，候选构建 rejected', async () => {
  const env = await freshEnv();
  try {
    // card 依赖 button；把 button 改成依赖 card => 成环
    const dep = await env.api('/admin/api/components/deps',
      { body: { slug: 'button', depends_on: ['card'] } });
    assert.equal(dep.status, 200);
    const out = await publishCurrent(env);
    assert.equal(out.gate.status, 422);
    const cycle = out.gate.json.results.find((x) => x.gate === 'reference-cycle');
    assert.equal(cycle.passed, false);
    assert.match(cycle.detail, /环/);
    assert.equal(await buildStatus(env, out.buildKey), 'rejected');
  } finally { await env.close(); }
});

test('场景3：截图生成失败——只阻断候选，不覆盖正在访问的稳定版', async () => {
  const env = await freshEnv();
  try {
    const first = await publishCurrent(env);
    assert.equal(first.gate.status, 200);
    const id1 = await stableId(env);
    assert.ok(id1);

    const draft = await currentDraft(env); // 发布后自动开的新草稿
    await saveDraft(env, draft.content, draft.version, 'editor-b');
    const draft2 = await currentDraft(env);
    const cb = await env.api('/admin/api/builds', { body: { docSlug: 'design-system', version: draft2.version } });
    const g2 = await env.api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: { failSet: ['card'] } });
    assert.equal(g2.status, 422);
    const sg = g2.json.results.find((x) => x.gate === 'screenshot-generation');
    assert.equal(sg.passed, false);
    assert.match(sg.detail, /card/);
    assert.equal(await buildStatus(env, cb.json.buildKey), 'rejected');

    assert.equal(await stableId(env), id1, '失败候选不得覆盖稳定版');
    const page = await env.getHtml('/d/design-system');
    assert.equal(page.status, 200);
    assert.match(page.html, /当前稳定版/);
  } finally { await env.close(); }
});

test('场景4：两编辑冲突——409 且后到者不覆盖先保存内容', async () => {
  const env = await freshEnv();
  try {
    const base = await currentDraft(env);
    const cB = JSON.parse(JSON.stringify(base.content)); cB.sections[0].body = '编辑B的修改';
    const rB = await saveDraft(env, cB, base.version, 'editor-b', base.checksum);
    assert.equal(rB.status, 201);
    const cA = JSON.parse(JSON.stringify(base.content)); cA.sections[1].body = '编辑A的修改';
    const rA = await saveDraft(env, cA, base.version, 'editor-a', base.checksum);
    assert.equal(rA.status, 409);
    assert.equal(rA.json.code, 'EDIT_CONFLICT');
    assert.equal(rA.json.conflict.currentEditor, 'editor-b');
    const now = await currentDraft(env);
    assert.match(now.content.sections[0].body, /编辑B/);
    assert.doesNotMatch(now.content.sections[1].body, /编辑A/);
  } finally { await env.close(); }
});

test('场景5：构建撤回——当前版下线并回到上一个稳定版', async () => {
  const env = await freshEnv();
  try {
    const r1 = await publishCurrent(env);
    assert.equal(r1.gate.status, 200);
    const id1 = await stableId(env);

    const draft = await currentDraft(env);
    await saveDraft(env, draft.content, draft.version, 'v2-editor');
    const r2 = await publishCurrent(env);
    assert.equal(r2.gate.status, 200);
    const id2 = await stableId(env);
    assert.notEqual(id2, id1);

    const rb = await env.api('/admin/api/releases/rollback', { body: { docSlug: 'design-system' } });
    assert.equal(rb.status, 200);
    assert.equal(await stableId(env), id1, '撤回恢复上一稳定版');

    const db = await env.openSideDb();
    const active = db.exec(`SELECT active FROM releases WHERE id=${id2}`)[0].values[0][0];
    const st = db.exec(`SELECT status FROM builds WHERE id=${rb.json.rolledBack.build_id}`)[0].values[0][0];
    db.close();
    assert.equal(active, 0);
    assert.equal(st, 'rolled_back');
  } finally { await env.close(); }
});

test('场景6：读者切换历史版查看当时决策，历史页给出快照标识', async () => {
  const env = await freshEnv();
  try {
    await publishCurrent(env);
    const draft = await currentDraft(env);
    await saveDraft(env, draft.content, draft.version, 'v2-editor');
    await publishCurrent(env);

    const list = await env.api('/api/docs/design-system/versions', { auth: false });
    assert.ok(list.json.versions.length >= 2);
    const archived = list.json.versions.find((v) => v.status === 'archived');
    assert.ok(archived, '存在被归档的历史版本');
    const page = await env.getHtml(`/d/design-system@v${archived.version}`);
    assert.equal(page.status, 200);
    assert.match(page.html, /历史版本快照（记录当时决策，非当前现状）/);
    assert.match(page.html, new RegExp(`<option value="${archived.version}" selected>`));
  } finally { await env.close(); }
});

test('场景7：公开页面/API 不暴露后台草稿；未认证不能访问后台', async () => {
  const env = await freshEnv();
  try {
    await publishCurrent(env);
    const draft = await currentDraft(env); // 发布后存在新草稿
    assert.equal((await env.getHtml(`/d/design-system@v${draft.version}`)).status, 404);
    assert.equal((await env.api(`/api/docs/design-system@v${draft.version}`, { auth: false })).status, 404);
    const adm = await fetch(env.base + '/admin');
    assert.equal(adm.status, 401);
    assert.equal((await env.api('/admin/api/drafts?docSlug=design-system', { auth: false })).status, 401);
  } finally { await env.close(); }
});
