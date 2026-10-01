'use strict';
/*
 * “文档随代码发布”一侧：以站点源码创建构建快照，解析真实 CSS 设计令牌与关键断点。
 * 内容发布侧（本文档系统）在 promote 时拿候选与最新 active 构建做兼容检查。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE_ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_ROOT = path.join(__dirname, '..', 'data', 'snapshots');
const SITE_FILES = [
  'index.html', 'courses.html', 'plan.html', 'resources.html',
  'profile.html', 'about.html', 'contact.html', 'demo.html',
  'css/style.css', 'js/script.js',
];

function shaFile(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

// 从真实 css/style.css 解析 :root 设计令牌与 @media 断点
function parseCss(cssText) {
  const tokens = {};
  const root = cssText.match(/:root\s*\{([\s\S]*?)\}/);
  if (root) {
    root[1].replace(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi, (_, n, v) => { tokens[n.trim()] = v.trim(); });
  }
  const breakpoints = [];
  cssText.replace(/@media[^{]*max-width\s*:\s*(\d+)px/gi, (_, w) => { if (!breakpoints.includes(+w)) breakpoints.push(+w); });
  return { tokens, breakpoints: breakpoints.sort((a, b) => b - a) };
}

function parsePageSelectors(html) {
  const set = new Set();
  html.replace(/class="([^"]+)"/g, (_, cls) => cls.split(/\s+/).forEach(c => c && set.add('.' + c)));
  return [...set];
}

function createSnapshot(buildId) {
  const dir = path.join(SNAPSHOT_ROOT, buildId);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const rel of SITE_FILES) {
    const src = path.join(SITE_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dest0(dir, rel));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files.push({ path: rel, sha1: shaFile(src) });
  }
  const css = fs.readFileSync(path.join(dir, 'css/style.css'), 'utf8');
  const { tokens, breakpoints } = parseCss(css);
  const pages = files.filter(f => f.path.endsWith('.html')).map(f => f.path);
  const selectors = new Set();
  for (const pg of pages) parsePageSelectors(fs.readFileSync(path.join(dir, pg), 'utf8')).forEach(s => selectors.add(s));
  return {
    code_ref: buildId,
    files,
    tokens,
    breakpoints,
    pages,
    selectors: [...selectors],
  };
}
function dest0(dir, rel) { return path.join(dir, rel); }

function snapshotDir(buildId) { return path.join(SNAPSHOT_ROOT, buildId); }

function readBuild(dba, buildId) {
  const row = dba.one('SELECT * FROM builds WHERE id=?', [buildId]);
  if (!row) return null;
  row.manifest = JSON.parse(row.manifest_json);
  return row;
}

function pageContains(buildId, pagePath, selector) {
  const file = path.join(snapshotDir(buildId), String(pagePath).replace(/^\//, ''));
  if (!fs.existsSync(file)) return false;
  const html = fs.readFileSync(file, 'utf8');
  if (!selector) return true;
  const sels = selector.split(',').map(s => s.trim()).filter(Boolean);
  return sels.some(sel => {
    if (sel.startsWith('.')) {
      const classes = [];
      html.replace(/class="([^"]+)"/g, (_, c) => c.split(/\s+/).forEach(x => classes.push(x)));
      return classes.includes(sel.slice(1));
    }
    if (sel.startsWith('#')) return html.includes('id="' + sel.slice(1) + '"');
    return new RegExp('<' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|>)').test(html);
  });
}

module.exports = { createSnapshot, snapshotDir, readBuild, parseCss, pageContains, SITE_FILES };
