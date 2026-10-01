'use strict';
// 现状截图：对每个组件 × 关键断点生成一张"当前实现"的图。
// 图里写入组件显示名/source_hash/token_hash/断点，gates 用这些指纹判定保鲜。
// - browser 驱动：存在可执行 Chrome 时用 puppeteer-core 出 PNG（真实像素）
// - vector  驱动：内置，和页面共用 componentFragment，出带 foreignObject 的 SVG
const fs = require('fs');
const path = require('path');
const { componentFragment, esc } = require('./layout');
const { sha256 } = require('../content/model');
const { KEY_BREAKPOINTS } = require('../content/model');

function estimateHeight(slug) {
  return { nav: 120, button: 96, card: 220, modal: 200 }[slug] || 180;
}

function renderVectorSvg({ slug, comp, planned, breakpoint, tokens }) {
  const width = breakpoint;
  const height = estimateHeight(slug) + 56;
  const fragment = componentFragment(slug, comp, planned);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<!-- screenshot-meta engine=vector component=${esc(slug)} name=${esc(comp.display_name)} source_hash=${comp.source_hash} token_hash=PLACEHOLDER breakpoint=${breakpoint} -->
<rect width="100%" height="100%" fill="#f6f7fb"/>
<rect x="0" y="0" width="${width}" height="36" fill="${esc(tokens.color.brand)}"/>
<text x="10" y="24" font-size="14" fill="#ffffff" font-family="sans-serif">${esc(comp.display_name)} @ ${breakpoint}px · ${comp.source_hash.slice(0, 10)}</text>
<foreignObject x="8" y="44" width="${width - 16}" height="${height - 52}">
  <div xmlns="http://www.w3.org/1999/xhtml">${fragment}</div>
</foreignObject></svg>`;
  return { svg, width, height };
}

function contentFingerprint({ comp, breakpoint, tokensHash }) {
  return 'cap_' + sha256([comp.source_hash, comp.display_name, tokensHash, breakpoint].join('|')).slice(0, 16);
}

let _browserDriver = null;
function setBrowserDriver(fn) { _browserDriver = fn; }

async function maybeBrowser() {
  if (_browserDriver === 'tried') return null;
  _browserDriver = 'tried';
  const exe = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!exe) return null;
  try {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    setBrowserDriver(async ({ html, width, filePath }) => {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 800 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const el = await page.$('#capture');
      await el.screenshot({ path: filePath });
      const box = await el.boundingBox();
      await page.close();
      return { width, height: Math.round(box.height) };
    });
    return browser;
  } catch (e) {
    return null;
  }
}

async function generateOne({ slug, comp, planned, breakpoint, tokens, tokensHash, outDir, failSet }) {
  if (failSet && failSet.has(slug)) {
    throw new Error(`截图生成失败（模拟）：组件 ${slug} 渲染超时`);
  }
  const { svg, width, height } = renderVectorSvg({ slug, comp, planned, breakpoint, tokens });
  const finalSvg = svg.replace('token_hash=PLACEHOLDER', 'token_hash=' + tokensHash);
  const content_hash = contentFingerprint({ comp, breakpoint, tokensHash });
  let engine = 'vector';
  let filePath = path.join(outDir, `${slug}-${breakpoint}.svg`);
  const browserFn = typeof _browserDriver === 'function' ? _browserDriver : null;
  if (browserFn) {
    try {
      filePath = path.join(outDir, `${slug}-${breakpoint}.png`);
      const html = `<!doctype html><meta charset="utf-8"><div id="capture" style="width:${width}px">${componentFragment(slug, comp, planned)}</div>`;
      const box = await browserFn({ html, width, filePath });
      engine = 'browser';
      return { file_path: path.relative(process.cwd(), filePath), width, height: box.height, engine, content_hash };
    } catch (e) { /* 浏览器失败则回退矢量，保证管线可用 */ }
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(filePath, finalSvg, 'utf8');
  return { file_path: path.relative(process.cwd(), filePath), width, height, engine, content_hash };
}

// 为一个候选版本生成全部组件 × 断点截图
async function generateForVersion({ refs, compMap, tokens, tokensHash, outDir, failSet }) {
  const shots = [];
  const seen = new Set();
  for (const ref of refs.filter((r) => r.ref_type === 'component')) {
    const key = ref.target;
    if (seen.has(key)) continue;
    seen.add(key);
    const comp = compMap[ref.target];
    for (const breakpoint of KEY_BREAKPOINTS) {
      // 不 await 循环里的并发以便失败信息清晰（顺序即可）
      const out = await generateOne({ slug: ref.target, comp, planned: !!ref.planned,
        breakpoint, tokens, tokensHash, outDir, failSet });
      shots.push({ component_slug: ref.target, breakpoint, ...out,
        component_hash: comp.source_hash, component_name: comp.display_name, token_hash: tokensHash });
    }
  }
  return shots;
}

module.exports = { generateForVersion, generateOne, contentFingerprint, maybeBrowser, setBrowserDriver, KEY_BREAKPOINTS };
