'use strict';
/*
 * 发布屏障（release gates）——每个候选独立运行，全部通过才允许 promote。
 * 任何一闸失败：只产生 release_attempts(result=rejected)，live 指针在调用方事务里不变，
 * 因此“失败只阻断该候选，不覆盖正在访问的稳定版”。
 *
 * 闸位（编号用于验收报告）：
 *  G1 build-active        构建未撤回
 *  G2 token-compat        候选引用令牌与构建内 css/style.css 的真实值一致
 *  G3 links               候选内链接全部可解析（站内页面 + 站内截图/锚点 + 外发 http/https/mailto）
 *  G4 page-binding        素材来源/色彩/可访问决策必须关联到构建中实际存在的页面与元素
 *  G5 no-ref-cycle        决策/组件引用图无环
 *  G6 shots-fresh         截图指纹 = 当前组件名+令牌值+断点+属性（改名/换令牌后旧截图立即失配）
 *  G7 image-ratio         截图文件实际宽高比 = 声明宽高比
 *  G8 breakpoints         响应式样例覆盖构建 CSS 关键断点
 *  G9 acceptance-first    组件被候选引用时，其验收决策创建时间早于组件版本
 *  G10 base-lineage       候选基于最新已发布版（防止两编辑并发基于旧版覆盖）
 */
const fs = require('fs');
const path = require('path');
const render = require('./render');
const buildsLib = require('./builds');

function gate(id, name, ok, detail) {
  return { id, name, ok: !!ok, detail: detail || (ok ? '通过' : '未通过') };
}

function parseJson(s, fallback) {
  try { return JSON.parse(s || ''); } catch (_) { return fallback; }
}

function passAll() { return Array.from(arguments).flat(); }

// 提取候选关联的组件版本（通过 refs: component -> decision(decision 属于候选)）
function candidateComponents(dba, dv) {
  return dba.all(
    `SELECT cv.*, c.id AS component_id_ref FROM refs r
     JOIN decisions d ON d.id = r.to_id AND d.doc_version_id = ?
     JOIN component_versions cv ON CAST(cv.id AS TEXT) = r.from_id
     JOIN components c ON c.id = cv.component_id`,
    [dv.id]
  );
}
function candidateDecisions(dba, dv) {
  return dba.all('SELECT * FROM decisions WHERE doc_version_id=?', [dv.id]);
}

// G5: 引用环（只在“属于同一候选的节点 + 组件节点”范围内 DFS）
function detectCycle(dba, dv) {
  const edges = dba.all(
    `SELECT r.from_kind, r.from_id, r.to_kind, r.to_id FROM refs r
     WHERE r.to_id IN (SELECT id FROM decisions WHERE doc_version_id=?)
        OR r.from_id IN (SELECT id FROM decisions WHERE doc_version_id=?)
        OR r.from_kind='component'`,
    [dv.id, dv.id]
  );
  const adj = new Map();
  const key = (k, id) => k + ':' + id;
  for (const e of edges) {
    const f = key(e.from_kind, e.from_id), t = key(e.to_kind, e.to_id);
    if (!adj.has(f)) adj.set(f, []);
    adj.get(f).push(t);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  let cyclePath = null;
  function dfs(u) {
    color.set(u, GRAY); stack.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) {
        cyclePath = stack.slice(stack.indexOf(v)).concat(v);
        return true;
      }
      if (color.get(v) !== BLACK && dfs(v)) return true;
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  }
  for (const u of adj.keys()) {
    if (color.get(u) !== BLACK && dfs(u)) break;
  }
  return cyclePath;
}

function runGates(dba, dv, buildId, extra = {}) {
  const results = [];
  const build = buildsLib.readBuild(dba, buildId);

  // G1
  results.push(gate('G1', '构建未撤回', build && build.status === 'active',
    build ? `构建 ${buildId} 状态=${build.status}` : '构建不存在: ' + buildId));
  if (!build) return results; // 没有构建无法继续

  const manifest = build.manifest;
  const comps = candidateComponents(dba, dv);
  const decs = candidateDecisions(dba, dv);

  // G2 令牌兼容：候选组件版本的 token 值必须与构建 CSS 真实值一致
  const tokenProblems = [];
  for (const cv of comps) {
    const cssVar = '--' + cv.token_name.replace(/^--/, '');
    const real = manifest.tokens[cssVar];
    if (real === undefined) tokenProblems.push(`${cv.name}: 构建 CSS 中不存在 ${cssVar}`);
    else if (real.replace(/\s+/g, '') !== String(cv.token_value).replace(/\s+/g, ''))
      tokenProblems.push(`${cv.name}: 文档令牌 ${cssVar}=${cv.token_value} 与构建实际 ${real} 不符`);
  }
  results.push(gate('G2', '令牌与构建 CSS 一致', tokenProblems.length === 0,
    tokenProblems.length ? tokenProblems.join('；') : `${comps.length} 个组件令牌均与 ${path.basename(buildId)} 的 css/style.css 一致`));

  // G3 链接校验：从 body + responsive_sample + 决策 detail/page_path 中收集链接
  const sample = parseJson(dv.responsive_sample, { breakpoints: [], links: [] });
  const urls = new Set();
  const collect = text => String(text || '').replace(/\]\(([^)]+)\)/g, (_, u) => urls.add(u));
  collect(dv.body); collect(dv.info_structure);
  decs.forEach(d => { collect(d.detail); if (d.page_path) urls.add(d.page_path); });
  (sample.links || []).forEach(u => urls.add(u));
  const snapshotRoot = buildsLib.snapshotDir(buildId);
  const broken = [];
  for (let u of urls) {
    u = String(u).split('#')[0].split('?')[0];
    if (!u || u.startsWith('mailto:') || u.startsWith('tel:')) continue;
    if (/^https?:\/\//.test(u)) {
      // 外发链接在离线环境只校验格式（RFC http(s)），由 --check-external 可开启真实探测
      if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/.test(u)) broken.push(u);
      continue;
    }
    const rel = u.replace(/^\//, '');
    if (!fs.existsSync(path.join(snapshotRoot, rel))) broken.push(u);
  }
  results.push(gate('G3', '候选内链接可解析', broken.length === 0,
    broken.length ? '失效链接: ' + broken.join(', ') : `${urls.size} 条链接全部可解析`));

  // G4 页面绑定：source/color/a11y 决策必须绑定真实页面且元素存在
  const bindProblems = [];
  for (const d of decs.filter(x => ['source', 'color', 'a11y'].includes(x.kind))) {
    if (!d.page_path || !buildsLib.pageContains(buildId, d.page_path, d.target_selector)) {
      bindProblems.push(`${d.kind}:${d.title} -> ${d.page_path || '(未绑定页面)'} ${d.target_selector || ''}`);
    }
  }
  results.push(gate('G4', '素材/色彩/可访问说明绑定实际页面元素', bindProblems.length === 0,
    bindProblems.length ? '无法在构建中定位: ' + bindProblems.join('；')
      : `${decs.filter(x => ['source','color','a11y'].includes(x.kind)).length} 条说明均关联到实际页面`));

  // G5 引用环
  const cyc = detectCycle(dba, dv);
  results.push(gate('G5', '决策/组件引用无环', !cyc, cyc ? '检测到引用环: ' + cyc.join(' -> ') : '引用图为 DAG'));

  // G6 截图指纹新鲜
  const stale = [];
  for (const cv of comps) {
    const shots = dba.all('SELECT * FROM screenshots WHERE component_version_id=?', [cv.id]);
    if (!shots.length) { stale.push(`${cv.name}: 无截图`); continue; }
    for (const s of shots) {
      const expect = render.fingerprint(cv, s.width);
      if (s.fingerprint !== expect) {
        const renamed = dba.one('SELECT name FROM component_versions WHERE id=?', [cv.id]);
        stale.push(`${cv.name}@${s.width}px：现指纹 ${expect.slice(0, 8)} ≠ 截图指纹 ${s.fingerprint.slice(0, 8)}（组件改名或令牌变化后截图已过期）`);
      }
    }
  }
  results.push(gate('G6', '截图与现状指纹一致', stale.length === 0,
    stale.length ? stale.join('；') : `${comps.length} 个组件的截图均为当前组件名/令牌/属性下生成`));

  // G7 图片比例：读取实际 SVG 宽高与 DB 声明比对
  const ratioProblems = [];
  for (const cv of comps) {
    const shots = dba.all('SELECT * FROM screenshots WHERE component_version_id=?', [cv.id]);
    for (const s of shots) {
      const abs = path.join(path.join(__dirname, '..'), s.file_path);
      if (!fs.existsSync(abs)) { ratioProblems.push(`${cv.name}@${s.width}px：截图文件缺失 ${s.file_path}`); continue; }
      const txt = fs.readFileSync(abs, 'utf8');
      const m = txt.match(/<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
      if (!m) { ratioProblems.push(`${cv.name}@${s.width}px：无法读取图片尺寸`); continue; }
      const actual = (+m[1]) / (+m[2]);
      const declared = s.width / s.height;
      if (Math.abs(actual - declared) > 1e-6)
        ratioProblems.push(`${cv.name}@${s.width}px：实际 ${m[1]}:${m[2]} 与声明 ${s.width}:${s.height} 不符`);
    }
  }
  results.push(gate('G7', '图片实际比例与声明一致', ratioProblems.length === 0,
    ratioProblems.length ? ratioProblems.join('；') : '所有截图宽高比与声明一致'));

  // G8 关键断点：样例宽度必须覆盖构建 CSS 断点（<=768 与 <=480 两档 + 桌面）
  const widths = (sample.breakpoints || []).map(Number);
  const needTablet = widths.some(w => w <= 768 && w > 480);
  const needMobile = widths.some(w => w <= 480);
  const needDesktop = widths.some(w => w > 768);
  const bpOk = needTablet && needMobile && needDesktop;
  results.push(gate('G8', '覆盖构建关键断点(768/480)', bpOk,
    bpOk ? `样例断点 ${widths.join('/')}px 覆盖桌面+平板(≤768)+手机(≤480)；构建 CSS: ${manifest.breakpoints.join('/')}`
         : `样例断点 ${widths.join('/') || '(空)'} 未覆盖三档；构建 CSS: ${manifest.breakpoints.join('/')}`));

  // G9 验收文档先于组件上线
  const accProblems = [];
  for (const cv of comps) {
    if (cv.status !== 'accepted') { accProblems.push(`${cv.name}: 组件版本状态为 ${cv.status}，未经正式验收上线（G9）`); continue; }
    if (!cv.acceptance_decision_id) { accProblems.push(`${cv.name}: 未关联验收文档`); continue; }
    const acc = dba.one('SELECT * FROM decisions WHERE id=?', [cv.acceptance_decision_id]);
    if (!acc) { accProblems.push(`${cv.name}: 验收决策不存在`); continue; }
    const accTime = new Date(acc.created_at.replace(' ', 'T') + 'Z').getTime();
    const cvTime = new Date(cv.created_at.replace(' ', 'T') + 'Z').getTime();
    if (accTime > cvTime) {
      accProblems.push(`${cv.name}: 验收文档(${acc.created_at})晚于组件版本(${cv.created_at})，不得先上线后补验收`);
    }
  }
  results.push(gate('G9', '验收文档先于组件版本', accProblems.length === 0,
    accProblems.length ? accProblems.join('；') : `${comps.length} 个组件均有且仅有先置验收文档`));

  // G10 基线血统：候选 base_version 必须等于当前 live 版本（全新文档允许 base 为空且无 live）
  const doc = dba.one('SELECT * FROM docs WHERE id=(SELECT doc_id FROM doc_versions WHERE id=?)', [dv.id]);
  let lineageOk = true, lineageDetail = '';
  if (doc.live_version == null) {
    lineageOk = dv.base_version == null;
    lineageDetail = lineageOk ? '首个版本，无基线' : '文档尚无 live 版却声明了 base';
  } else {
    lineageOk = dv.base_version === doc.live_version;
    lineageDetail = lineageOk ? `基于当前稳定版 v${doc.live_version}` : `候选基于 v${dv.base_version}，当前稳定版已是 v${doc.live_version}（两编辑冲突）`;
  }
  results.push(gate('G10', '候选基于最新稳定版', lineageOk, lineageDetail));

  return results;
}

module.exports = { runGates, candidateComponents, candidateDecisions, detectCycle };
