'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/db');
const svc = require('../content/service');
const { runGates } = require('../gates/gates');
const { generateForVersion } = require('../render/screenshot');
const { renderPage, css } = require('../render/layout');
const { checksum } = require('../content/model');

const CODE_CONTRACT = { apiContract: 1, gitRef: process.env.GIT_REF || 'refs/heads/main#stable' };
const ARTIFACT_ROOT = path.join(process.cwd(), 'artifacts');

function codeContract() { return CODE_CONTRACT; }

function buildCtx(build) {
  const dv = db.get('SELECT * FROM doc_versions WHERE id=?', [build.doc_version_id]);
  const v = svc.hydrate(dv);
  const content = v.content;
  content.docSlug = dv.doc_slug;
  return {
    build, dv, v, content,
    refs: v.refs,
    components: svc.allComponents(),
    assets: svc.allAssets(),
    sources: svc.allSources(),
    tokensBundle: svc.activeTokens()
  };
}

// 运行发布屏障：生成截图 → 门检查 → 写入 gate_runs；只更新候选 build/版本，不触碰线上
async function gateBuild(buildKey, { linkChecker, failSet, apiContract, regenerateScreenshots = true } = {}) {
  let build = db.get('SELECT * FROM builds WHERE build_key=?', [buildKey]);
  if (!build) throw Object.assign(new Error('build not found'), { code: 'NOT_FOUND' });
  const ctx = buildCtx(build);
  const { tokens, hash: tokensHash } = ctx.tokensBundle;
  const outDir = path.join(ARTIFACT_ROOT, 'screenshots', String(build.id));

  db.run("UPDATE builds SET status='gating' WHERE id=?", [build.id]);

  // 1) 截图：默认对候选重新捕获；传入 regenerateScreenshots=false 时只核对既有截图
  //    （改名/令牌变更后旧截图指纹不符 => 保鲜门失败，必须显式重新捕获，杜绝过期截图静默续用）。
  let shotError = null;
  if (regenerateScreenshots) {
    let shots = [];
    try {
      shots = await generateForVersion({
        refs: ctx.refs, compMap: Object.fromEntries(ctx.components.map((c) => [c.slug, c])),
        tokens, tokensHash, outDir, failSet
      });
    } catch (e) {
      shotError = e.message;
    }
    if (!shotError) {
      db.run('DELETE FROM screenshots WHERE doc_version_id=?', [ctx.dv.id]);
      for (const s of shots) {
        db.run(`INSERT INTO screenshots
          (doc_version_id,component_slug,breakpoint,width,height,file_path,engine,component_hash,component_name,token_hash,content_hash,ok)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
          [ctx.dv.id, s.component_slug, s.breakpoint, s.width, s.height, s.file_path, s.engine,
           s.component_hash, s.component_name, s.token_hash, s.content_hash]);
      }
    }
  }

  // 1b) 非重新捕获模式：候选先继承"当前线上版本"的现状截图作为基线，
  //     再由保鲜门比对当前组件名/源码/令牌指纹——变了就判过期，防止旧截图当现状。
  if (!regenerateScreenshots && !shotError) {
    const have = db.get('SELECT COUNT(*) AS n FROM screenshots WHERE doc_version_id=?', [ctx.dv.id]);
    if (!have.n) {
      const cur = activeRelease(build.doc_slug);
      if (cur) {
        const rows = db.all('SELECT * FROM screenshots WHERE doc_version_id=?', [cur.doc_version_id]);
        for (const r of rows) {
          db.run(`INSERT INTO screenshots
            (doc_version_id,component_slug,breakpoint,width,height,file_path,engine,component_hash,component_name,token_hash,content_hash,ok)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [ctx.dv.id, r.component_slug, r.breakpoint, r.width, r.height, r.file_path, r.engine,
             r.component_hash, r.component_name, r.token_hash, r.content_hash, r.ok]);
        }
      }
    }
  }

  // 2) 门检查
  const storedShots = shotError ? [] :
    db.all('SELECT * FROM screenshots WHERE doc_version_id=?', [ctx.dv.id]);
  const { passed, results } = await runGates({
    content: ctx.content, refs: ctx.refs, components: ctx.components,
    tokensHash, screenshots: storedShots, assets: ctx.assets, sources: ctx.sources,
    mode: build.mode, codeContract: CODE_CONTRACT,
    apiContract: apiContract == null ? CODE_CONTRACT.apiContract : apiContract,
    buildGitRef: build.git_ref, docVersionId: ctx.dv.id, docStatus: ctx.dv.status,
    linkChecker
  });

  // 截图生成失败单独形成一个失败门
  if (shotError) {
    passed === false;
    results.push({ gate: 'screenshot-generation', passed: false, severity: 'hard',
      detail: shotError, evidence: { failSet: [...(failSet || [])] } });
  }

  const passedFinal = passed && !shotError;
  db.run('INSERT INTO gate_runs (build_id,passed,results_json) VALUES (?,?,?)',
    [build.id, passedFinal ? 1 : 0, JSON.stringify(results, null, 2)]);

  const status = passedFinal ? 'passed' : 'rejected';
  db.run('UPDATE builds SET status=?, gates_json=? WHERE id=?',
    [status, JSON.stringify(results, null, 2), build.id]);
  if (!passedFinal) {
    db.run("UPDATE doc_versions SET status='draft' WHERE id=?", [ctx.dv.id]);
    db.audit(null, 'build.rejected', { buildKey, gates: results.filter((r) => !r.passed).map((r) => r.gate) });
  } else {
    db.audit(null, 'build.passed', { buildKey });
  }
  build = db.get('SELECT * FROM builds WHERE build_key=?', [buildKey]);
  return { build, passed: passedFinal, results };
}

// 原子提升：一个事务里 下线旧指针(rolled_back)、归档旧版本、激活新版本
function promote(buildKey, actor) {
  const build = db.get('SELECT * FROM builds WHERE build_key=?', [buildKey]);
  if (!build) throw Object.assign(new Error('build not found'), { code: 'NOT_FOUND' });
  if (build.status !== 'passed') throw Object.assign(new Error(`构建状态 ${build.status}，仅 passed 可提升`), { code: 'NOT_PROMOTABLE', status: 409 });

  return db.tx(() => {
    const current = db.get('SELECT * FROM releases WHERE doc_slug=? AND active=1', [build.doc_slug]);
    if (current) {
      db.run('UPDATE releases SET active=0, rolled_back_at=datetime(\'now\') WHERE id=?', [current.id]);
      db.run("UPDATE doc_versions SET status='archived' WHERE id=?", [current.doc_version_id]);
    }
    // 静态快照（随构建产物保存，撤回后仍可作为历史制品）
    const ctx = buildCtx(build);
    const { tokens } = ctx.tokensBundle;
    const html = renderPage({ content: ctx.content, tokens,
      compMap: Object.fromEntries(ctx.components.map((c) => [c.slug, c])),
      assetMap: Object.fromEntries(ctx.assets.map((a) => [a.id, a])),
      sourceMap: Object.fromEntries(ctx.sources.map((s) => [s.slug, s])) });
    const artifactPath = path.join('artifacts', 'builds', build.build_key + '.html');
    fs.mkdirSync(path.dirname(path.join(process.cwd(), artifactPath)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), artifactPath), html, 'utf8');

    db.run("UPDATE builds SET status='promoted', artifact_path=? WHERE id=?", [artifactPath, build.id]);
    db.run("UPDATE doc_versions SET status='published' WHERE id=?", [build.doc_version_id]);
    db.run('INSERT INTO releases (doc_slug,doc_version_id,build_id,mode,active) VALUES (?,?,?,?,1)',
      [build.doc_slug, build.doc_version_id, build.id, build.mode]);
    // 发布后自动开下一版草稿（基于刚发布内容），保证后续编辑可继续
    const published = db.get('SELECT * FROM doc_versions WHERE id=?', [build.doc_version_id]);
    db.tx; // no-op marker to keep outer transaction context
    db.run(`INSERT INTO doc_versions (doc_slug,version,status,title,content_json,checksum,base_version,editor)
            SELECT doc_slug, version+1, 'draft', title, content_json, checksum, version, ?
            FROM doc_versions WHERE id=?`, [actor || null, build.doc_version_id]);
    const nd = db.get('SELECT id FROM doc_versions WHERE doc_slug=? ORDER BY version DESC LIMIT 1', [build.doc_slug]);
    db.run('INSERT INTO doc_refs (doc_version_id,ref_type,target,planned,context) SELECT ?,ref_type,target,planned,context FROM doc_refs WHERE doc_version_id=?',
      [nd.id, build.doc_version_id]);
    db.audit(actor, 'release.promote', { buildKey, doc: build.doc_slug,
      previous: current ? current.doc_version_id : null });
    return { release: activeRelease(build.doc_slug), artifactPath };
  });
}

// 构建撤回：当前指针下线并回到上一个发布版本（若无则无稳定版）
function rollback(docSlug, actor) {
  return db.tx(() => {
    const cur = db.get('SELECT * FROM releases WHERE doc_slug=? AND active=1', [docSlug]);
    if (!cur) throw Object.assign(new Error('没有可撤回的线上版本'), { code: 'NO_ACTIVE_RELEASE', status: 409 });
    const prev = db.get('SELECT * FROM releases WHERE doc_slug=? AND active=0 AND id<? ORDER BY id DESC LIMIT 1',
      [docSlug, cur.id]);
    db.run('UPDATE releases SET active=0, rolled_back_at=datetime(\'now\') WHERE id=?', [cur.id]);
    db.run("UPDATE builds SET status='rolled_back' WHERE id=?", [cur.build_id]);
    db.run("UPDATE doc_versions SET status='archived' WHERE id=?", [cur.doc_version_id]);
    let restored = null;
    if (prev) {
      db.run('UPDATE releases SET active=1, rolled_back_at=NULL WHERE id=?', [prev.id]);
      db.run("UPDATE builds SET status='promoted' WHERE id=?", [prev.build_id]);
      db.run("UPDATE doc_versions SET status='published' WHERE id=?", [prev.doc_version_id]);
      restored = prev;
    }
    db.audit(actor, 'release.rollback', { doc: docSlug, from: cur.id, to: prev ? prev.id : null });
    return { rolledBack: cur, restored };
  });
}

function activeRelease(docSlug) {
  return db.get(`SELECT r.*, b.build_key, b.mode AS build_mode, b.artifact_path, b.gates_json
                 FROM releases r JOIN builds b ON b.id=r.build_id
                 WHERE r.doc_slug=? AND r.active=1`, [docSlug]);
}

module.exports = { gateBuild, promote, rollback, activeRelease, codeContract, buildCtx };
