'use strict';
// 单一渲染管线：公开页面、候选预览、断点截图全部从这里出 HTML，
// 保证"文档引用"与"实际页面"一致（段落 id、组件片段、素材 SVG 完全复用）。
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function css(t) {
  const c = t.color, s = t.space, r = t.radius, ty = t.type;
  return `:root{--brand:${c.brand};--brand-contrast:${c.brandContrast};--ink:${c.ink};--surface:${c.surface};--muted:${c.muted};--line:${c.line};--focus:${c.focus};--danger:${c.danger};--r-sm:${r.sm}px;--r-md:${r.md}px;--r-lg:${r.lg}px}
*{box-sizing:border-box}
html{font-size:${ty.base}px}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:#f6f7fb;line-height:${ty.lineHeight}}
a{color:var(--brand)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.layout{max-width:1180px;margin:0 auto;padding:${s.md}px}
.topbar{display:flex;align-items:center;gap:${s.md}px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:${s.sm}px ${s.md}px}
.brand{font-weight:700}
.topbar nav{display:flex;gap:${s.sm}px;flex-wrap:wrap}
.topbar nav a{padding:6px 10px;border-radius:var(--r-sm);text-decoration:none}
.topbar nav a[aria-current]{background:var(--brand);color:var(--brand-contrast)}
.section{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:${s.lg}px;margin:${s.md}px 0}
.section h2{font-size:${ty.h2}px;margin:0 0 ${s.sm}px}
.grid{display:grid;gap:${s.md}px;grid-template-columns:1fr}
.swatches{display:flex;gap:${s.sm}px;flex-wrap:wrap}
.swatch{width:120px;min-height:72px;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;font-size:12px}
.swatch i{display:block;height:36px}
.swatch span{display:block;padding:4px 6px;color:var(--muted)}
.a11y li{margin-bottom:6px}
.pagemap{border-collapse:collapse;width:100%;font-size:14px;margin-top:10px}
.pagemap th,.pagemap td{border:1px solid var(--line);padding:6px 10px;text-align:left}
.pagemap thead th{background:var(--canvas)}
.btn{min-height:44px;padding:0 18px;border:none;border-radius:var(--r-sm);background:var(--brand);color:var(--brand-contrast);font-size:${ty.base}px;cursor:pointer}
.card{border:1px solid var(--line);border-radius:var(--r-md);padding:${s.lg}px;background:var(--surface)}
.card h3{margin-top:0}
.figure img,.figure svg{max-width:100%;height:auto;border:1px solid var(--line);border-radius:var(--r-sm)}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#fff4e0;color:#8a4b00;border:1px solid #f0c882}
.stale{background:#fdecea;border:1px solid var(--danger);color:var(--danger);border-radius:var(--r-sm);padding:2px 8px;font-size:12px}
.verswitch{font-size:14px}
@media (min-width:768px){.grid{grid-template-columns:repeat(2,1fr)}.layout{padding:${s.lg}px}}
@media (min-width:1280px){.grid{grid-template-columns:repeat(3,1fr)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-width:480px){.topbar nav{flex-direction:column;align-items:stretch}}`;
}

// 组件真实片段（按钮/卡片/导航/对话框）。截图与页面都调用它。
function componentFragment(slug, comp, planned) {
  if (planned) {
    return `<div class="card"><h3 data-component="${esc(slug)}">${esc(comp ? comp.display_name : slug)}</h3>
      <span class="badge">即将上线（文档先行）</span>
      <p style="color:var(--muted)">该组件尚未发布，本说明先记录设计决策；上线后此处替换为真实示例。</p></div>`;
  }
  switch (slug) {
    case 'button':
      return `<p><button class="btn" data-component="${esc(slug)}" aria-label="主操作按钮示例">主要操作</button></p>`;
    case 'card':
      return `<article class="card" data-component="${esc(slug)}"><h3>示例卡片</h3><p>卡片承载一段摘要与一个操作。</p><button class="btn">了解更多</button></article>`;
    case 'nav':
      return `<div class="topbar" data-component="${esc(slug)}"><span class="brand">Brand</span>
        <nav><a href="#" aria-current="page">概览</a><a href="#">项目</a><a href="#">设置</a></nav></div>`;
    case 'modal':
      return `<div class="card" data-component="${esc(slug)}"><h3>对话框示例</h3>
        <p role="dialog" aria-label="确认对话框">确认保存更改？</p><button class="btn">确认</button></div>`;
    default:
      return `<div class="card" data-component="${esc(slug)}"><h3>${esc(slug)}</h3></div>`;
  }
}

function assetSvg(asset, tokens) {
  const c = tokens.color;
  if (asset.id === 'hero-rule') {
    const bp = [360, 768, 1280];
    const lines = bp.map((x, i) => {
      const xx = 60 + i * 360;
      return `<line x1="${xx}" y1="40" x2="${xx}" y2="680" stroke="${c.brand}" stroke-width="3"/>
        <text x="${xx + 8}" y="70" font-size="22" fill="${c.ink}">${x}</text>`;
    }).join('');
    return `<svg viewBox="0 0 1280 720" width="1280" height="720" role="img" aria-label="${esc(asset.alt)}" xmlns="http://www.w3.org/2000/svg">
      <rect width="1280" height="720" fill="#eef1ff"/>${lines}
      <text x="60" y="40" font-size="24" fill="${c.muted}">关键断点</text></svg>`;
  }
  return `<svg viewBox="0 0 ${asset.width} ${asset.height}" width="${asset.width}" height="${asset.height}" role="img" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${c.line}"/></svg>`;
}

function renderSection(sec, ctx) {
  const { tokens, compMap, assetMap } = ctx;
  let inner = '';
  if (sec.body) inner += `<p>${esc(sec.body)}</p>`;
  if (sec.type === 'ia') {
    const lis = (ctx.content.ia || []).map((n) => `<li><a href="#${esc(n.anchor)}">${esc(n.label)}</a></li>`).join('');
    inner += `<ul>${lis}</ul>`;
    if (Array.isArray(sec.pageMap)) {
      inner += `<table class="pagemap"><caption style="text-align:left;color:var(--muted);font-size:13px">说明章节 ↔ 站内实际页面</caption>
        <thead><tr><th scope="col">实际页面</th><th scope="col">锚点/元素</th><th scope="col">承担职责</th></tr></thead><tbody>` +
        sec.pageMap.map((m) => `<tr>
          <td><a href="/site/${esc(m.page)}">${esc(m.page)}</a></td>
          <td>${m.anchor ? '<code>#' + esc(m.anchor) + '</code>' : '—'}</td>
          <td>${esc(m.role)}</td></tr>`).join('') + `</tbody></table>`;
    }
  }
  if (sec.type === 'tokens') {
    inner += `<div class="swatches">` + Object.entries(tokens.color).map(([k, v]) =>
      `<div class="swatch"><i style="background:${esc(v)}"></i><span>${esc(k)}<br>${esc(v)}</span></div>`).join('') + `</div>`;
  }
  if (sec.type === 'a11y') {
    inner += `<ul class="a11y"><li>44px 最小触控目标，<code>:focus-visible</code> 焦点环使用 <code>color.focus</code></li>
      <li>正文对比度 ≥ 4.5:1；浮层 <code>role="dialog"</code>、焦点陷阱、ESC 关闭</li>
      <li>遵守 <code>prefers-reduced-motion</code></li></ul>`;
  }
  if (sec.components) {
    inner += `<div class="grid">` + sec.components.map((ref) => {
      const comp = compMap[ref.slug];
      return componentFragment(ref.slug, comp, !!ref.planned);
    }).join('') + `</div>`;
  }
  if (sec.images) {
    inner += sec.images.map((im) => {
      const a = assetMap[im.id || im];
      if (!a) return `<p class="stale">缺失素材：${esc(im.id || im)}</p>`;
      return `<figure class="figure">${assetSvg(a, tokens)}<figcaption>${esc(a.alt)}</figcaption></figure>`;
    }).join('');
  }
  if (sec.links) {
    inner += `<nav class="rellinks">` + sec.links.map((l) =>
      `<a href="${esc(l.href)}">${esc(l.label || l.href)}</a>`).join(' · ') + `</nav>`;
  }
  if (sec.source) {
    const src = ctx.sourceMap && ctx.sourceMap[sec.source];
    inner += `<p class="badge">原创素材来源：${esc(src ? src.title : sec.source)}${src && src.author ? ' · ' + esc(src.author) : ''}</p>`;
  }
  return `<section class="section" id="${esc(sec.id)}" aria-labelledby="h-${esc(sec.id)}">
    <h2 id="h-${esc(sec.id)}">${esc(sec.heading)}</h2>${inner}</section>`;
}

function renderPage(opts) {
  const { content, tokens, compMap, assetMap, sourceMap, extraHead = '', extraBanner = '', screenshotsHtml = '' } = opts;
  const ctx = { content, tokens, compMap, assetMap, sourceMap };
  const nav = (content.ia || []).map((n) =>
    `<a href="/d/${encodeURIComponent(content.docSlug || 'design-system')}#${esc(n.anchor)}">${esc(n.label)}</a>`).join('');
  return `<!doctype html><html lang="${esc(content.lang || 'zh-CN')}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(content.title)}</title><style>${css(tokens)}</style>${extraHead}</head><body>
<div class="layout">
 ${extraBanner}
 <header class="topbar"><span class="brand">${esc(content.title)}</span><nav>${nav}</nav></header>
 ${(content.sections || []).map((s) => renderSection(s, ctx)).join('\n')}
 ${screenshotsHtml}
</div></body></html>`;
}

module.exports = { css, esc, componentFragment, assetSvg, renderSection, renderPage };
