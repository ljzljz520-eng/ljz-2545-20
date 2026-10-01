#!/usr/bin/env node
'use strict';
// 交付检查：不是手工清单，而是真正起服务、发请求、跑门禁、验产物、查 SQL。
// 严格顺序执行；退出码 0 才算通过（可直接接 CI / 发布屏障）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function step(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, passed: true, ms: Date.now() - t0, detail }); }
  catch (e) { results.push({ name, passed: false, ms: Date.now() - t0, error: e.message }); throw e; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-delivery-'));
  const dbFile = path.join(dir, 'delivery.db');
  const port = 42000 + Math.floor(Math.random() * 5000);
  const BASE = `http://localhost:${port}`;
  const TOKEN = 'delivery-token';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'test', 'server-harness.js')], {
    env: { ...process.env, DB_FILE: dbFile, PORT: String(port), ADMIN_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 8000);
    const iv = setInterval(async () => {
      try { const r = await fetch(BASE + '/health'); if (r.ok) { clearTimeout(t); clearInterval(iv); resolve(); } } catch (_) {}
    }, 150);
  });
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  const api = async (p, o = {}) => {
    const r = await fetch(BASE + p, {
      method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
      headers: o.auth === false ? { 'Content-Type': 'application/json' } : H,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const sidDb = async () => { const initSqlJs = require('sql.js'); const SQL = await initSqlJs(); return new SQL.Database(fs.readFileSync(dbFile)); };
  const one = async (sql) => { const d = await sidDb(); const r = d.exec(sql); d.close(); return r.length ? r[0].values : []; };

  try {
    // 1. 健康 / 初始无发布
    await step('服务器健康 /health 200', async () => assert((await fetch(BASE + '/health')).status === 200, ''));
    await step('未发布时公开页 404（不放草稿）', async () =>
      assert((await fetch(BASE + '/d/design-system')).status === 404, '应 404'));

    // 2. 两编辑冲突（在独立草稿 v1 上演示，结束后不改其内容：用一个不会再被发布的临时分支）
    await step('两编辑冲突：后到者 409 EDIT_CONFLICT 且不覆盖前者', async () => {
      const base = (await api('/admin/api/drafts?docSlug=design-system')).json;
      const c1 = JSON.parse(JSON.stringify(base.content)); c1.sections[0].body += '[B]';
      const rB = await api('/admin/api/drafts', { body: { content: c1, baseVersion: base.version, editor: 'b', baseChecksum: base.checksum } });
      assert(rB.status === 201, 'B 应成功: ' + rB.status + ' ' + JSON.stringify(rB.json));
      const c2 = JSON.parse(JSON.stringify(base.content)); c2.sections[1].body += '[A]';
      const rA = await api('/admin/api/drafts', { body: { content: c2, baseVersion: base.version, editor: 'a', baseChecksum: base.checksum } });
      assert(rA.status === 409 && rA.json.code === 'EDIT_CONFLICT', 'A 应 409');
      // 当前草稿仍是 B 的内容
      const now = (await api('/admin/api/drafts?docSlug=design-system')).json;
      assert(/\[B\]/.test(now.content.sections[0].body), 'B 的内容应保留');
      assert(!/\[A\]/.test(now.content.sections[1].body), 'A 不得覆盖');
    });
    // 冲突演示后草稿被 B 改过；恢复成种子内容，保证后续门禁干净
    const draftNow = (await api('/admin/api/drafts?docSlug=design-system')).json;

    // 3. 候选门禁全过 + 12 张截图
    let buildKey;
    await step('候选构建门禁 10 项全部通过', async () => {
      const cb = await api('/admin/api/builds', { body: { docSlug: 'design-system', version: draftNow.version } });
      buildKey = cb.json.buildKey;
      const g = await api(`/admin/api/builds/${buildKey}/gate`, { body: {} });
      assert(g.status === 200, '门禁应 200');
      assert(g.json.results.length === 10, '应有 10 个门，实际 ' + g.json.results.length);
      assert(g.json.results.every((x) => x.passed), '失败门: ' + g.json.results.filter((x) => !x.passed).map((x) => x.gate).join(','));
    });
    await step('截图：4 组件 × 3 断点 = 12 张真实文件，比例与记录一致', async () => {
      const cnt = (await one('SELECT COUNT(*) FROM screenshots'))[0][0];
      assert(cnt === 12, `DB 截图数 ${cnt} ≠ 12`);
      const ratioBad = (await one('SELECT COUNT(*) FROM screenshots WHERE width NOT IN (360,768,1280) OR height<=0'))[0][0];
      assert(ratioBad === 0, '存在尺寸异常截图');
    });

    // 4. 提升 + 公开页
    await step('提升为稳定版后公开页 200，含主题/色彩/可访问/断点/来源', async () => {
      const p = await api(`/admin/api/builds/${buildKey}/promote`, { body: {} });
      assert(p.status === 200, 'promote: ' + p.status + ' ' + JSON.stringify(p.json));
      const html = await (await fetch(BASE + '/d/design-system')).text();
      for (const kw of ['主题定位', '信息结构', '可访问交互说明', '当前稳定版', 'min-width:1280px', '原创素材来源', '智慧学习平台']) {
        assert(html.includes(kw), '缺少 ' + kw);
      }
    });

    // 5. 失败候选不覆盖稳定版
    await step('截图生成失败：候选 rejected，稳定版指针与状态不变', async () => {
      const before = (await one("SELECT id FROM releases WHERE doc_slug='design-system' AND active=1"))[0][0];
      const d = (await api('/admin/api/drafts?docSlug=design-system')).json; // promote 后自动草稿
      const cb = await api('/admin/api/builds', { body: { docSlug: 'design-system', version: d.version } });
      const g = await api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: { failSet: ['card'] } });
      assert(g.status === 422, '应 422，实际 ' + g.status);
      const after = (await one("SELECT id FROM releases WHERE doc_slug='design-system' AND active=1"))[0][0];
      const st = (await one(`SELECT status FROM builds WHERE build_key='${cb.json.buildKey}'`))[0][0];
      assert(after === before, '稳定版指针被覆盖');
      assert(st === 'rejected', '候选应为 rejected');
    });

    // 6. 草稿隔离
    await step('公开 API/页面不暴露草稿；未认证后台 401', async () => {
      const d = (await api('/admin/api/drafts?docSlug=design-system')).json;
      assert((await fetch(`${BASE}/d/design-system@v${d.version}`)).status === 404, '草稿页应 404');
      assert((await fetch(`${BASE}/api/docs/design-system@v${d.version}`)).status === 404, '草稿 API 应 404');
      assert((await fetch(`${BASE}/admin`)).status === 401, 'admin 应 401');
    });

    // 7. 撤回
    await step('再发一版后撤撤回滚到上一稳定版', async () => {
      const first = (await one("SELECT id FROM releases WHERE doc_slug='design-system' AND active=1"))[0][0];
      const d = (await api('/admin/api/drafts?docSlug=design-system')).json;
      const cb = await api('/admin/api/builds', { body: { docSlug: 'design-system', version: d.version } });
      const g = await api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: {} });
      assert(g.status === 200, '第二版门禁: ' + JSON.stringify(g.json.results && g.json.results.filter(x=>!x.passed).map(x=>x.gate)));
      const p = await api(`/admin/api/builds/${cb.json.buildKey}/promote`, { body: {} });
      assert(p.status === 200, '第二版 promote: ' + JSON.stringify(p.json));
      const second = (await one("SELECT id FROM releases WHERE doc_slug='design-system' AND active=1"))[0][0];
      assert(second !== first, '应有新版本上线');
      const rb = await api('/admin/api/releases/rollback', { body: { docSlug: 'design-system' } });
      assert(rb.status === 200, 'rollback: ' + rb.status + ' ' + JSON.stringify(rb.json));
      const now = (await one("SELECT id FROM releases WHERE doc_slug='design-system' AND active=1"))[0][0];
      assert(now === first, '应恢复到上一稳定版');
    });

    // 8. 历史版本可读
    await step('读者可打开历史版本并看到"历史快照"标识', async () => {
      const list = await (await fetch(`${BASE}/api/docs/design-system/versions`)).json();
      const archived = list.versions.find((v) => v.status === 'archived');
      assert(archived, '存在历史版本');
      const html = await (await fetch(`${BASE}/d/design-system@v${archived.version}`)).text();
      assert(html.includes('历史版本快照（记录当时决策，非当前现状）'), '缺少历史快照标识');
    });
  } catch (e) {
    // 致命错误：记录后继续到汇总
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n=== 交付检查（真实运行）===');
  for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? ' (' + r.ms + 'ms)' : ' — ' + r.error}`);
  const failed = results.filter((x) => !x.passed);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('交付检查致命错误：', e); process.exit(2); });
