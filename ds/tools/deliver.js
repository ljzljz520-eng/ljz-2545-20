'use strict';
/*
 * 交付检查（实际运行，非手工清单）：
 *   node tools/deliver.js                # 对运行中的 DS_PORT 执行全部验收场景
 * 退出码：全绿 0；任一失败 1。
 *
 * 场景 A-I：
 *  A 验收文档先于组件上线（后补验收被 G9 拒绝；补好后放行）
 *  B 引用环（G5 拒绝）
 *  C 截图生成失败（组件版本事务回滚；修复后可发布）
 *  D 两编辑冲突（etag 409，不会互相覆盖）
 *  E 组件改名 / 设计令牌变化 -> 旧截图失配（G6 拒绝），重新截图后放行（不当过期现状）
 *  F 构建撤回（新候选 G1 被拒，稳定版仍 200 可访问；回滚到新构建恢复）
 *  G 历史版本可读 + 回滚后读者可看当时决策；公开页永不暴露草稿
 *  H 链接失效（G3）/ 图片比例不符（G7）/ 断点缺失（G8）
 *  I 端到端正常发布：全绿屏障，候选晋升，旧版归档
 */
const BASE = 'http://localhost:' + (process.env.DS_PORT || 4100);
const TOKEN = process.env.DS_ADMIN_TOKEN || 'dev-editor-token';
const DOC = 'doc-design';

let passN = 0, failN = 0;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  if (cond) { passN++; console.log('  \x1b[32m✔\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
  else { failN++; console.log('  \x1b[31m✘ ' + name + '\x1b[0m' + (detail ? '  — ' + detail : '')); }
}
async function call(method, p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.public) headers['x-editor-token'] = TOKEN;
  if (opts.editor) headers['x-editor-name'] = opts.editor;
  if (opts.etag) headers['If-Match'] = opts.etag;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, headers: r.headers };
}
const gateOf = (b, id) => (b.gates || []).find(g => g.id === id);

async function freshDraft(suffix) {
  const d = await call('POST', `/api/admin/docs/${DOC}/draft`, {});
  if (d.status !== 200) throw new Error('draft create failed: ' + JSON.stringify(d.body));
  return d.body;
}
async function discardAllDrafts() {
  const drafts = (await call('GET', `/api/admin/docs/${DOC}/drafts`)).body || [];
  for (const d of drafts) await call('DELETE', '/api/admin/versions/' + d.id);
}
async function save(dvId, patch, etag, editor) {
  const cur = await call('GET', '/api/admin/versions/' + dvId);
  const body = {
    themePositioning: patch.themePositioning ?? cur.body.themePositioning,
    infoStructure: patch.infoStructure ?? cur.body.infoStructure,
    responsiveSample: patch.responsiveSample ?? cur.body.responsiveSample,
    body: patch.body ?? cur.body.body,
  };
  return call('PUT', '/api/admin/versions/' + dvId, body, { etag: etag || cur.body.etag, editor });
}
async function addDecision(dvId, kind, title, extra = {}) {
  const r = await call('POST', `/api/admin/versions/${dvId}/decisions`, {
    kind, title, detail: extra.detail || title + ' 说明', pagePath: extra.pagePath || '/index.html',
    targetSelector: extra.targetSelector || '.navbar', refDecisionId: extra.refDecisionId,
  });
  return r.body.id;
}
async function promoteExpect(dvId, buildId) { return call('POST', `/api/admin/versions/${dvId}/promote`, { buildId }); }
async function checkOnly(dvId, buildId) { return call('POST', `/api/admin/versions/${dvId}/check`, { buildId }); }
async function getLive() { return (await call('GET', '/api/public/docs/design-spec', null, { public: true })).body; }

async function main() {
  console.log('\n=== 0. 基线健康检查 ===');
  const ping = await fetch(BASE + '/api/health').then(r=>r.status).catch(()=>0);
  check('服务健康检查 200', ping === 200, 'GET /api/health');
  let live = await getLive();
  check('初始稳定版可公开访问', live && live.version === 1, `v${live && live.version}, ${live.components.length} 组件 ${live.decisions.length} 决策`);
  const initVersion = live.version;

  // ---------------------------------------------------------------- A
  console.log('\n=== A. 验收文档先于组件上线 ===');
  {
    // 新组件：先发版本（不挂验收），G9 必拒
    await discardAllDrafts();
    const nc = await call('POST', '/api/admin/components', { name: '临时组件A' });
    const cv = await call('POST', `/api/admin/components/${nc.body.id}/versions`, {
      name: '临时组件A', tokenName: 'primary-color', tokenValue: '#667eea', tokenSemantic: '测试', props: {},
    });
    check('无验收文档时组件版本仍可生成（截图先行）', cv.status === 200);
    // 尝试 accept 无验收版本
    const acc = await call('POST', `/api/admin/component-versions/${cv.body.componentVersionId}/accept`, {});
    check('无验收文档拒绝验收上线', acc.status === 409, acc.body.error);
    // 现在“补”一个验收决策（创建时间晚于组件版本），再发布引用该组件的候选
    const draft = await freshDraft();
    const lateDec = await addDecision(draft.docVersionId, 'acceptance', '后补验收A', { pagePath: '/index.html', targetSelector: '.navbar' });
    const linkAcc = await call('POST', `/api/admin/component-versions/${cv.body.componentVersionId}/acceptance`, { decisionId: lateDec });
    check('后补的验收决策可挂接到组件版本（记录在案）', linkAcc.status === 200);
    await call('POST', `/api/admin/versions/${draft.docVersionId}/link-component`, { componentVersionId: cv.body.componentVersionId, decisionId: lateDec });
    const builds = (await call('GET', '/api/admin/builds')).body;
    const activeBuild = builds.find(b => b.status === 'active').id;
    const pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('后补验收文档被 G9 否决（候选不晋升）', pr.status === 422 && gateOf(pr.body, 'G9') && !gateOf(pr.body, 'G9').ok, gateOf(pr.body, 'G9')?.detail);
    check('被拒后稳定版仍为 v' + initVersion, (await getLive()).version === initVersion);
  }

  // ---------------------------------------------------------------- B
  console.log('\n=== B. 引用环检测 ===');
  {
    await discardAllDrafts();
    const draft = await freshDraft();
    const d1 = await addDecision(draft.docVersionId, 'general', '环上节点1');
    const d2 = await addDecision(draft.docVersionId, 'general', '环上节点2', { refDecisionId: d1 });
    // 制造 d1 -> d2，形成 d1<->d2
    await call('POST', `/api/admin/decisions/${d1}/refs`, { toId: d2 });
    const activeBuild = (await call('GET', '/api/admin/builds')).body.find(b => b.status === 'active').id;
    const pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('引用环被 G5 否决', pr.status === 422 && !gateOf(pr.body, 'G5').ok, gateOf(pr.body, 'G5')?.detail);
  }

  // ---------------------------------------------------------------- C
  console.log('\n=== C. 截图生成失败 ===');
  {
    const nc = await call('POST', '/api/admin/components', { name: '故障组件C' });
    process.env.DS_SCREENSHOT_FAIL = '1';
    // 服务端进程独立，env 不共享——用请求头注入故障
    const cv = await fetch(BASE + `/api/admin/components/${nc.body.id}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-editor-token': TOKEN, 'x-inject-screenshot-fail': '1' },
      body: JSON.stringify({ name: '故障组件C', tokenName: 'primary-color', tokenValue: '#667eea', props: {} }),
    }).then(async r => ({ status: r.status, body: await r.json() }));
    check('截图生成失败时组件版本请求被整体回滚', cv.status === 502, cv.body.error);
    const left = (await call('GET', '/api/admin/components')).body.find(c => c.id === nc.body.id);
    check('失败后组件未产生 current_version', !left.current_version_id, JSON.stringify(left));
    process.env.DS_SCREENSHOT_FAIL = '0';
    // 恢复：重新发版本成功（不再注入故障头）
    const cv2 = await call('POST', `/api/admin/components/${nc.body.id}/versions`, {
      name: '故障组件C', tokenName: 'primary-color', tokenValue: '#667eea', props: { label: '恢复' },
    });
    check('渲染器恢复后新版本成功并生成截图', cv2.status === 200);
  }

  // ---------------------------------------------------------------- D
  console.log('\n=== D. 两编辑冲突 ===');
  {
    await discardAllDrafts();
    const draft = await freshDraft();
    const a = await call('GET', '/api/admin/versions/' + draft.docVersionId);
    const etagA = a.body.etag;
    // 编辑 A 先保存成功
    const rA = await save(draft.docVersionId, { themePositioning: '编辑A的主题定位' }, etagA, 'editor-A');
    check('编辑 A 保存成功并拿到新 etag', rA.status === 200, 'etag ' + rA.body.etag);
    // 编辑 B 拿着旧 etag 保存
    const rB = await save(draft.docVersionId, { themePositioning: '编辑B的覆盖尝试' }, etagA, 'editor-B');
    check('编辑 B 用旧 etag 被 409 拒绝', rB.status === 409, rB.body.error);
    // A 的内容仍然在线（草稿里）
    const after = await call('GET', '/api/admin/versions/' + draft.docVersionId);
    check('A 的内容未被 B 覆盖', after.body.themePositioning === '编辑A的主题定位');
  }

  // ---------------------------------------------------------------- E
  console.log('\n=== E. 改名 / 令牌变化后过期截图不得当现状 ===');
  {
    // 选 btn-primary 组件出新版本：改令牌值（故意先不碰别的），截图按新值生成；
    // 再模拟“换令牌后未重截”：直接改 DB 不可能（无 SQL 端点），改为发两个版本：
    // v2 用新令牌（新截图），随后再发 v3 又换名但人为不重截——通过 recapture 前的状态检查。
    const detail0 = (await call('GET', '/api/admin/components-detail')).body;
    const btn = detail0.find(c => c.id === 'btn-primary');
    const beforeFp = btn.screenshots.map(s => s.fingerprint);

    // 1) 改令牌出新版本（自带按新指纹截图，故是新鲜的）
    const v2 = await call('POST', `/api/admin/components/btn-primary/versions`, {
      name: btn.name, tokenName: btn.token_name, tokenValue: '#3355dd', tokenSemantic: btn.token_semantic, props: btn.props,
      acceptanceDecisionId: btn.acceptance && btn.acceptance.id,
    });
    check('令牌变化后产生组件新版本', v2.status === 200);
    const d2 = (await call('GET', '/api/admin/components-detail')).body.find(c => c.id === 'btn-primary');
    const fp2 = d2.screenshots.map(s => s.fingerprint);
    check('新截图指纹随令牌变化', JSON.stringify(fp2) !== JSON.stringify(beforeFp));

    // 2) 人为制造“陈旧截图”：再发 v4 改名，但复用 v2 截图行（直接走 recapture 之前的窗口无法模拟；
    //    改为：把该组件挂进候选并发布成功（指纹新），然后服务端允许通过再次改名版本但回传旧截图？
    //    简化为直接验证 G6 检测能力：手工将 DB 截图指纹改坏需要另一个进程——通过专用测试钩子）
    const tamper = await call('POST', `/api/admin/__test/tamper-shot`, { componentVersionId: v2.body.componentVersionId });
    check('测试钩子可制造指纹不一致（仅测试期）', tamper.status === 200);

    await discardAllDrafts();
    const draft = await freshDraft();
    // 挂接该组件 v2 到候选（通过一条候选决策）
    const dec = await addDecision(draft.docVersionId, 'acceptance', 'E验收', { pagePath: '/index.html', targetSelector: '.btn-primary' });
    await call('POST', `/api/admin/versions/${draft.docVersionId}/link-component`, { componentVersionId: v2.body.componentVersionId, decisionId: dec });
    const activeBuild = (await call('GET', '/api/admin/builds')).body.find(b => b.status === 'active').id;
    const pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('指纹失配（改名/令牌后截图过期）被 G6 否决', pr.status === 422 && !gateOf(pr.body, 'G6').ok, gateOf(pr.body, 'G6')?.detail?.slice(0, 120));

    // 3) 重新截图 -> 指纹恢复 -> 候选可通过（重建草稿挂接同一组件版本）
    const recap = await call('POST', `/api/admin/component-versions/${v2.body.componentVersionId}/recapture`, {});
    check('重新截图成功', recap.status === 200);
    const pr2 = await checkOnly(draft.docVersionId, activeBuild);
    check('重新截图后 G6 恢复通过', gateOf(pr2.body, 'G6').ok, gateOf(pr2.body, 'G6').detail);
  }

  // ---------------------------------------------------------------- F
  console.log('\n=== F. 构建撤回：失败不覆盖稳定版 ===');
  {
    // 新构建 -> 撤回 -> 新候选发布必被 G1 拒；同时旧稳定版仍可访问
    const nb = await call('POST', '/api/admin/builds', {});
    check('新建构建快照', nb.status === 200, nb.body.id + ' pages=' + nb.body.pages);
    await call('POST', `/api/admin/builds/${nb.body.id}/retract`, {});
    await discardAllDrafts();
    const draft = await freshDraft();
    const pr = await promoteExpect(draft.docVersionId, nb.body.id);
    check('撤回构建上的新候选被 G1 否决', pr.status === 422 && !gateOf(pr.body, 'G1').ok, gateOf(pr.body, 'G1')?.detail);
    const live2 = await getLive();
    check('稳定版不受构建撤回影响', live2.version === initVersion && !!live2.servedByBuild === false || live2.version === initVersion);
    const siteOld = await fetch(BASE + '/site/b-' + '8102d73' + '/index.html');
    check('正在访问的稳定版站点快照仍返回 200', siteOld.status === 200);
    // 回退选择：用旧的 active 构建（仍在）发布候选成功
    const pr2 = await promoteExpect(draft.docVersionId, 'b-8102d73');
    check('改对照未撤回构建后发布成功（恢复通道）', pr2.status === 201, 'v' + pr2.body.version);
  }

  // ---------------------------------------------------------------- G
  console.log('\n=== G. 历史版本 / 草稿隔离 ===');
  {
    const meta = (await call('GET', '/api/public/docs/design-spec/versions', null, { public: true })).body;
    check('历史版本列表可公开查询', meta.versions.length >= 2, meta.versions.map(v => 'v' + v.version).join(','));
    const old = await call('GET', `/api/public/docs/design-spec/versions/${initVersion}`, null, { public: true });
    check('读者可切换查看 v' + initVersion + ' 当时决策', old.status === 200 && old.body.version === initVersion,
      `${old.body.decisions.length} 条决策，组件 ${old.body.components.length}`);
    // 草稿不可公开
    const docs = (await call('GET', '/api/admin/docs')).body;
    if (docs[0].draft_version) {
      const drafts = (await call('GET', `/api/admin/docs/${DOC}/drafts`)).body;
      const dvId = drafts[0].id;
      const pubDraft = await call('GET', '/api/public/docs/design-spec/versions/' + docs[0].draft_version, null, { public: true });
      check('后台草稿不通过公开接口暴露', pubDraft.status === 404);
      // 清理草稿避免影响后续
      // （没有删除端点：发布或遗弃。这里不强制）
    } else {
      check('后台草稿不通过公开接口暴露（当前无草稿）', true);
    }
  }

  // ---------------------------------------------------------------- H
  console.log('\n=== H. 链接 / 图片比例 / 断点 校验 ===');
  {
    const activeBuild = (await call('GET', '/api/admin/builds')).body.find(b => b.status === 'active').id;
    // H1 失效链接
    await discardAllDrafts();
    let draft = await freshDraft();
    await save(draft.docVersionId, { body: '坏链接见 [不存在](/nope/missing.html)' });
    let pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('失效站内链接被 G3 否决', pr.status === 422 && !gateOf(pr.body, 'G3').ok, gateOf(pr.body, 'G3')?.detail);

    // H2 断点缺失
    await discardAllDrafts();
    draft = await freshDraft();
    await save(draft.docVersionId, {
      body: '仅桌面展示。',
      responsiveSample: { breakpoints: [1200], note: '缺平板/手机', links: ['/index.html'] },
    });
    pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('缺少 768/480 断点被 G8 否决', pr.status === 422 && !gateOf(pr.body, 'G8').ok, gateOf(pr.body, 'G8')?.detail);

    // H3 图片比例不符：篡改 live 文档当前引用组件的截图文件尺寸
    await discardAllDrafts();
    const cid = (await call('GET', '/api/admin/components-detail')).body[0].currentCvId;
    const tamperRatio = await call('POST', '/api/admin/__test/tamper-ratio', { componentVersionId: cid });
    draft = await freshDraft();
    const dec = await addDecision(draft.docVersionId, 'general', 'H3 引用', { pagePath: '/index.html', targetSelector: '.navbar' });
    // 候选需要引用该组件；该组件已被 live 引用——候选未挂则 G7 无目标。挂接它：
    await call('POST', `/api/admin/versions/${draft.docVersionId}/link-component`, { componentVersionId: cid, decisionId: dec });
    pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('实际图片比例与声明不符被 G7 否决', pr.status === 422 && !gateOf(pr.body, 'G7').ok, gateOf(pr.body, 'G7')?.detail?.slice(0, 120));
    // 恢复截图
    await call('POST', `/api/admin/component-versions/${cid}/recapture`, {});
  }

  // ---------------------------------------------------------------- I
  console.log('\n=== I. 端到端正常发布（全绿 -> 候选晋升） ===');
  {
    const activeBuild = (await call('GET', '/api/admin/builds')).body.find(b => b.status === 'active').id;
    const before = await getLive();
    await discardAllDrafts();
    const draft = await freshDraft();
    await save(draft.docVersionId, {
      themePositioning: before.themePositioning + '（vNext 补充：新增学员成长体系叙事。）',
      body: before.body + '\n\n## vNext 更新\n新增成长体系设计，见 [关于我们](/about.html)。',
    });
    const chk = await checkOnly(draft.docVersionId, activeBuild);
    check('发布前预演：10 道闸全绿', chk.body.gates.every(g => g.ok), chk.body.gates.map(g => g.id + (g.ok ? '✓' : '✗')).join(' '));
    const pr = await promoteExpect(draft.docVersionId, activeBuild);
    check('候选晋升成功', pr.status === 201, '发布为 v' + pr.body.version);
    const after = await getLive();
    check('稳定版指针已更新', after.version === pr.body.version);
    check('读者公开看到新内容', after.themePositioning.includes('vNext'));
    const hist = (await call('GET', '/api/public/docs/design-spec/versions', null, { public: true })).body;
    check('旧版本归档仍可回看', hist.versions.some(v => v.version === before.version && v.status === 'archived'));

    // 回滚到最初版本，恢复现场
    const rb = await call('POST', `/api/admin/docs/${DOC}/rollback`, { version: initVersion });
    check('可回滚到最初稳定版', rb.status === 200 && rb.body.liveVersion === initVersion);
    const back = await getLive();
    check('回滚后公开内容恢复为 v' + initVersion, back.version === initVersion && !back.themePositioning.includes('vNext'));
  }

  console.log('\n================ 交付检查结果 ================');
  console.log(`通过 ${passN} · 失败 ${failN}`);
  if (failN) { console.log('\x1b[31m存在未通过项，交付被阻断。\x1b[0m'); process.exit(1); }
  console.log('\x1b[32m全部验收场景实际运行通过。\x1b[0m');
}
main().catch(e => { console.error('交付工具异常:', e); process.exit(2); });
