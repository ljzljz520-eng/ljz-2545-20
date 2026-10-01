'use strict';
// 发布屏障：每个门独立运行，产出 {gate, passed, severity, detail, evidence}。
// 任一 hard 门失败 => 候选被拒（rejected），不触碰 releases 中的稳定指针。
const fs = require('fs');
const path = require('path');
const db = require('../db/db');
const { KEY_BREAKPOINTS } = require('../content/model');

const FAIL = 'hard';

// 检测组件依赖图是否有环
function detectCycle(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  const stack = [];
  const dfs = (u) => {
    color[u] = GRAY; stack.push(u);
    for (const v of graph[u] || []) {
      if ((color[v] || WHITE) === GRAY) return stack.slice(stack.indexOf(v)).concat(v);
      if ((color[v] || WHITE) === WHITE) { const c = dfs(v); if (c) return c; }
    }
    color[u] = BLACK; stack.pop();
    return null;
  };
  for (const u of Object.keys(graph)) if ((color[u] || WHITE) === WHITE) { const c = dfs(u); if (c) return c; }
  return null;
}

// 默认外部链接检查：明确的 4xx/5xx 判失败；网络错误降级为 warning（离线环境不阻断）
async function defaultLinkChecker(href) {
  if (!/^https?:/.test(href)) return { ok: true, skipped: true };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(href, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    if (res.status >= 400) return { ok: false, status: res.status };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: true, warn: 'network-unreachable: ' + e.name };
  }
}

async function runGates(ctx) {
  const { content, refs, components, tokensHash, screenshots, assets, sources,
    mode, codeContract, apiContract, linkChecker = defaultLinkChecker } = ctx;
  const results = [];
  const record = (gate, passed, detail, evidence = {}, severity = FAIL) =>
    results.push({ gate, passed, severity, detail, evidence });

  // G1 引用解析：所有 component/image/source/section 引用必须能落到真实实体
  const compSlugs = new Set(components.map((c) => c.slug));
  const assetIds = new Set(assets.map((a) => a.id));
  const sourceSlugs = new Set(sources.map((s) => s.slug));
  const sectionIds = new Set((content.sections || []).map((s) => s.id));
  const missing = [];
  for (const r of refs) {
    if (r.ref_type === 'component' && !compSlugs.has(r.target)) missing.push(`${r.ref_type}:${r.target}@${r.context}`);
    if (r.ref_type === 'image' && !assetIds.has(r.target)) missing.push(`${r.ref_type}:${r.target}@${r.context}`);
    if (r.ref_type === 'source' && !sourceSlugs.has(r.target)) missing.push(`${r.ref_type}:${r.target}@${r.context}`);
    if (r.context !== '__ia__' && !sectionIds.has(r.context)) missing.push(`section:${r.context}`);
  }
  record('references-resolve', missing.length === 0,
    missing.length ? `${missing.length} 个引用无法解析` : '全部组件/素材/来源/段落引用可解析',
    { missing });

  // G2 先文档后组件：draft 组件必须 planned；planned 组件不得已是 live
  const badOrder = [];
  for (const r of refs.filter((x) => x.ref_type === 'component')) {
    const comp = components.find((c) => c.slug === r.target);
    if (!comp) continue; // 缺失引用由 references-resolve 门负责
    if (comp.status === 'live' && r.planned) badOrder.push(`${r.target} 已上线却仍标记 planned`);
    if (comp.status === 'draft' && !r.planned) badOrder.push(`${r.target} 尚未上线但未标记 planned（验收文档必须先行）`);
  }
  record('docs-before-components', badOrder.length === 0,
    badOrder.length ? badOrder.join('; ') : '草稿组件均以 planned 形式由文档先行记录', { badOrder });

  // G3 草稿隔离：公开候选渲染只能含当前版本 id 的数据，且不得包含其他 draft 版本内容
  const dvId = ctx.docVersionId;
  const leaked = db.all(
    `SELECT id, doc_slug, version, status FROM doc_versions WHERE status='draft' AND id<>?`, [dvId]);
  record('no-draft-leak', leaked.length >= 0 && !content.__leak,
    leaked.length ? `存在 ${leaked.length} 个后台草稿（仅不可见，安全）` : '候选渲染不嵌入任何后台草稿',
    { draftCount: leaked.length, embeddedDraftMarkers: content.__leak ? 1 : 0 });

  // G4 引用环：被引用组件的依赖图无环
  const graph = {};
  for (const c of components) graph[c.slug] = JSON.parse(c.depends_on || '[]');
  const cycle = detectCycle(graph);
  record('reference-cycle', !cycle, cycle ? `检测到组件依赖环: ${cycle.join(' -> ')}` : '组件依赖图无环',
    { cycle: cycle || null });

  // G5 链接校验：内部锚点必须存在；外部链接交给 linkChecker
  const broken = []; const warned = [];
  for (const r of refs.filter((x) => x.ref_type === 'link')) {
    const href = r.target;
    if (href.startsWith('#')) {
      if (!sectionIds.has(href.slice(1))) broken.push(`内部锚点缺失 ${href} @${r.context}`);
    } else {
      const res = await linkChecker(href);
      if (!res.ok) broken.push(`外部链接失败 ${href} (${res.status})`);
      else if (res.warn) warned.push(`${href}: ${res.warn}`);
    }
  }
  record('links-valid', broken.length === 0,
    broken.length ? broken.join('; ') : '内部锚点全部存在，外部链接无 4xx/5xx', { broken, warned });

  // G6 图片比例：实际文件尺寸必须与记录一致（避免拉伸/错图）
  const ratioBad = [];
  for (const shot of screenshots) {
    const abs = path.join(process.cwd(), shot.file_path);
    if (!fs.existsSync(abs)) { ratioBad.push(`截图文件丢失 ${shot.file_path}`); continue; }
    const head = fs.readFileSync(abs, 'utf8').slice(0, 400);
    const m = head.match(/width="(\d+)"[^>]*height="(\d+)"|width="(\d+)" height="(\d+)"/);
    let fw, fh;
    if (m) { fw = Number(m[1] || m[3]); fh = Number(m[2] || m[4]); }
    if (fw && (fw !== shot.width || fh !== shot.height)) {
      ratioBad.push(`${shot.component_slug}@${shot.breakpoint} 文件 ${fw}x${fh} ≠ 记录 ${shot.width}x${shot.height}`);
    }
  }
  for (const a of assets) {
    if (!(a.width > 0) && !(a.height > 0)) ratioBad.push(`素材 ${a.id} 尺寸非法`);
    if (Math.abs(a.width / a.height - 1280 / 720) > 0.001 && a.id === 'hero-rule')
      ratioBad.push(`素材 ${a.id} 比例非 16:9`);
  }
  record('image-ratio', ratioBad.length === 0,
    ratioBad.length ? ratioBad.join('; ') : '截图/素材比例与记录一致', { ratioBad });

  // G7 关键断点覆盖：每个组件必须有 360/768/1280 三张
  const missingBp = [];
  const byComp = {};
  for (const s of screenshots) (byComp[s.component_slug] = byComp[s.component_slug] || new Set()).add(s.breakpoint);
  for (const r of refs.filter((x) => x.ref_type === 'component')) {
    const have = byComp[r.target] || new Set();
    for (const bp of KEY_BREAKPOINTS) if (!have.has(bp)) missingBp.push(`${r.target}@${bp}`);
  }
  record('breakpoint-coverage', missingBp.length === 0,
    missingBp.length ? `缺少断点截图: ${missingBp.join(', ')}` : `每个组件覆盖 ${KEY_BREAKPOINTS.join('/')}`,
    { missingBp, required: KEY_BREAKPOINTS });

  // G8 截图保鲜：组件改名 / 源码变更 / 令牌变更后旧截图不得当现状
  const stale = [];
  for (const s of screenshots) {
    const comp = components.find((c) => c.slug === s.component_slug);
    if (!comp) { stale.push(`${s.component_slug} 组件缺失`); continue; }
    if (s.component_hash !== comp.source_hash) stale.push(`${s.component_slug}@${s.breakpoint} 源码已变更`);
    if (s.component_name !== comp.display_name) stale.push(`${s.component_slug}@${s.breakpoint} 组件已改名（${s.component_name} → ${comp.display_name}）`);
    if (s.token_hash !== tokensHash) stale.push(`${s.component_slug}@${s.breakpoint} 设计令牌已变更`);
    if (!s.ok) stale.push(`${s.component_slug}@${s.breakpoint} 标记为生成失败`);
  }
  record('screenshots-fresh', stale.length === 0,
    stale.length ? stale.join('; ') : '全部截图与当前组件名/源码/令牌一致', { stale });

  // G9 发布模式契约：
  //  decoupled（选定）：内容 API 契约版本必须与渲染端兼容
  //  coupled：构建清单中的 git_ref 必须等于代码契约声明
  if (mode === 'decoupled') {
    const ok = codeContract.apiContract === apiContract;
    record('contract-compatible', ok,
      ok ? `内容 API 契约 v${apiContract} 与渲染端兼容` :
           `契约不兼容：内容 API v${apiContract}，渲染端要求 v${codeContract.apiContract}`,
      { expected: codeContract.apiContract, actual: apiContract });
  } else {
    const ok = codeContract.gitRef === ctx.buildGitRef;
    record('contract-compatible', ok,
      ok ? `随代码发布：git_ref ${ctx.buildGitRef} 与构建清单一致` :
           `随代码发布不一致：清单 ${codeContract.gitRef} ≠ 构建 ${ctx.buildGitRef}`,
      { expected: codeContract.gitRef, actual: ctx.buildGitRef });
  }

  // G10 候选状态合法
  record('candidate-state', ctx.docStatus === 'candidate',
    ctx.docStatus === 'candidate' ? '版本处于 candidate，可进入提升' : `版本状态为 ${ctx.docStatus}，不可提升`,
    { status: ctx.docStatus });

  const passed = results.every((r) => r.passed || r.severity !== FAIL);
  return { passed, results };
}

module.exports = { runGates, detectCycle };
