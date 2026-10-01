'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv } = require('./helpers');

async function draft(env){ return (await env.api('/admin/api/drafts?docSlug=design-system')).json; }
async function gateLatest(env, extra = {}) {
  const d = await draft(env);
  const cb = await env.api('/admin/api/builds', { body: { docSlug: 'design-system', version: d.version, mode: extra.mode || 'decoupled' } });
  const g = await env.api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: extra });
  return { g, key: cb.json.buildKey };
}
const gate = (json, name) => json.results.find((x) => x.gate === name);

test('门禁：组件改名后，旧版本页面的截图被标记过期；新候选门禁拒绝旧截图当现状', async () => {
  const env = await freshEnv();
  try {
    // 1) 先发布稳定版，产生带指纹的现状截图
    const first = await gateLatest(env);
    assert.equal(first.g.json.passed, true);
    await env.api(`/admin/api/builds/${first.key}/promote`, { body: {} });
    // 2) 改名（slug 不变，名称/源码指纹变化）
    const rn = await env.api('/admin/api/components/rename', { body: { slug: 'card', displayName: 'Card 信息卡片' } });
    assert.equal(rn.status, 200);
    // 3) 线上旧页面上的 card 截图必须显示"已过期"红标，而不是现状
    const page = await env.getHtml('/d/design-system');
    assert.match(page.html, /截图已过期（组件改名\/源码或令牌变更）/);
    // 4) 新候选若沿用旧截图（不重新捕获）：保鲜门失败
    const bad = await gateLatest(env, { regenerateScreenshots: false });
    assert.equal(bad.g.status, 422);
    const fr = gate(bad.g.json, 'screenshots-fresh');
    assert.equal(fr.passed, false);
    assert.match(fr.detail, /改名|源码已变更/);
    // 5) 显式重新捕获后通过
    const fixed = await gateLatest(env, { regenerateScreenshots: true });
    assert.equal(fixed.g.status, 200, JSON.stringify(fixed.g.json.results.filter(x=>!x.passed)));
  } finally { await env.close(); }
});

test('门禁：设计令牌变化后，旧截图令牌指纹失效并在页面标记过期', async () => {
  const env = await freshEnv();
  try {
    const first = await gateLatest(env);
    await env.api(`/admin/api/builds/${first.key}/promote`, { body: {} });
    const tb = await env.api('/admin/api/tokens/bump', { body: { overrides: { color: { brand: '#0b8a5f' } } } });
    assert.equal(tb.status, 200);
    const bad = await gateLatest(env, { regenerateScreenshots: false });
    assert.equal(bad.g.status, 422);
    const fr = gate(bad.g.json, 'screenshots-fresh');
    assert.equal(fr.passed, false);
    assert.match(fr.detail, /令牌已变更/);
    const bc = gate(bad.g.json, 'breakpoint-coverage');
    assert.equal(bc.passed, true, '覆盖度本身仍满足，只是保鲜失败');
    const page = await env.getHtml('/d/design-system');
    assert.match(page.html, /截图已过期/);
    // 显式重新捕获后通过
    const fixed = await gateLatest(env, { regenerateScreenshots: true });
    assert.equal(fixed.g.status, 200);
  } finally { await env.close(); }
});

test('门禁：断链（内部锚点缺失）被拦截；断链外部 4xx 被拦截', async () => {
  const env = await freshEnv();
  try {
    // 内部坏锚点
    await env.api('/admin/api/test/patch-draft', { body: { patch: { appendLinks: [{ href: '#no-such-anchor', label: 'x' }] } } });
    const r1 = await gateLatest(env);
    const lk = gate(r1.g.json, 'links-valid');
    assert.equal(lk.passed, false);
    assert.match(lk.detail, /no-such-anchor/);
  } finally { await env.close(); }
});

test('门禁：引用不存在的组件/素材被 references-resolve 拦截', async () => {
  const env = await freshEnv();
  try {
    await env.api('/admin/api/test/patch-draft', { body: { patch: { addRefs: { components: [{ slug: 'ghost-comp' }], images: ['ghost-img'] } } } });
    const r = await gateLatest(env);
    const rr = gate(r.g.json, 'references-resolve');
    assert.equal(rr.passed, false);
    assert.match(JSON.stringify(rr.evidence.missing), /ghost-comp/);
    assert.match(JSON.stringify(rr.evidence.missing), /ghost-img/);
  } finally { await env.close(); }
});

test('门禁：契约不兼容（内容 API 版本与渲染端不一致）被拦截', async () => {
  const env = await freshEnv();
  try {
    const r = await gateLatest(env, { apiContract: 99 });
    const c = gate(r.g.json, 'contract-compatible');
    assert.equal(c.passed, false);
    assert.match(c.detail, /契约不兼容/);
  } finally { await env.close(); }
});

test('门禁：随代码发布模式校验 git_ref 一致性', async () => {
  const env = await freshEnv();
  try {
    // 错误 gitRef => coupled 门失败
    const d = await draft(env);
    const cb = await env.api('/admin/api/builds', { body: { docSlug: 'design-system', version: d.version, mode: 'coupled', gitRef: 'refs/heads/wrong' } });
    const g = await env.api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: {} });
    const c = gate(g.json, 'contract-compatible');
    assert.equal(c.passed, false);
    assert.match(c.detail, /随代码发布不一致/);
  } finally { await env.close(); }
});

test('门禁：关键断点必须全覆盖（360/768/1280）', async () => {
  const env = await freshEnv();
  try {
    const r = await gateLatest(env);
    const bc = gate(r.g.json, 'breakpoint-coverage');
    assert.equal(bc.passed, true);
    assert.deepEqual(bc.evidence.required, [360, 768, 1280]);
  } finally { await env.close(); }
});
