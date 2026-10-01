'use strict';
/*
 * 组件视觉内核：后台预览页与截图引擎共用同一份模型，杜绝“截图和现状两张皮”。
 * 输出：
 *  - html(descriptor)  预览 iframe 内的真实 DOM（展示 token 当前值）
 *  - svg(descriptor,width,height) 截图引擎渲染结果（SVG 1.1，无外部浏览器依赖）
 * 指纹 fingerprint = sha1(name|tokenName|tokenValue|width|props)
 *   => 组件改名 / 设计令牌值变化 / 断点宽度变化 / 属性变化 都会让旧截图失配
 */
const crypto = require('crypto');

const BREAKPOINTS = { desktop: 1200, tablet: 768, mobile: 375 };
// 组件在各断点的视口高（与真实页面占位一致，比例即由此声明）
const VIEWPORT_HEIGHT = {
  navbar: { desktop: 76, tablet: 64, mobile: 56 },
  'hero-slider': { desktop: 420, tablet: 360, mobile: 480 },
  'course-card': { desktop: 260, tablet: 260, mobile: 300 },
  'feature-card': { desktop: 200, tablet: 200, mobile: 220 },
  'btn-primary': { desktop: 48, tablet: 48, mobile: 48 },
  'btn-secondary': { desktop: 48, tablet: 48, mobile: 48 },
  'section-title': { desktop: 90, tablet: 84, mobile: 76 },
  footer: { desktop: 300, tablet: 300, mobile: 420 },
};
function heightFor(kind, width) {
  const bp = width >= 1024 ? 'desktop' : width >= 480 ? 'tablet' : 'mobile';
  const table = VIEWPORT_HEIGHT[kind] || { desktop: 240, tablet: 240, mobile: 260 };
  return table[bp];
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function descriptorOf(cv) {
  let props = {};
  try { props = JSON.parse(cv.props_json || '{}'); } catch (_) {}
  return {
    kind: cv.component_id,            // 组件种类（navbar / course-card ...）
    name: cv.name,                    // 当前组件名（改名即变）
    tokenName: cv.token_name,
    tokenValue: cv.token_value,
    tokenSemantic: cv.token_semantic,
    props,
  };
}

function fingerprint(cv, width) {
  const d = descriptorOf(cv);
  const basis = JSON.stringify([d.name, d.tokenName, d.tokenValue, width, d.props]);
  return crypto.createHash('sha1').update(basis).digest('hex');
}

/* ---------- 真实预览 DOM（/preview/render 使用） ---------- */
function html(cv) {
  const d = descriptorOf(cv);
  const p = d.props;
  const t = `
:root{--${d.tokenName}:${d.tokenValue};--secondary:#764ba2;--text-dark:#2d3748;--text-light:#718096;--bg-light:#f7fafc;--white:#fff;--border:#e2e8f0;}
*{box-sizing:border-box;margin:0;padding:0;font-family:'PingFang SC','Microsoft YaHei',sans-serif}
body{background:var(--bg-light);color:var(--text-dark)}
.preview{padding:0}
.ds-navbar{display:flex;align-items:center;justify-content:space-between;padding:.8rem 1.5rem;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.1)}
.ds-navbar .brand{font-size:1.4rem;font-weight:700;color:var(--${d.tokenName})}
.ds-navbar ul{display:flex;gap:1.6rem;list-style:none}
.ds-navbar a{color:var(--text-dark);text-decoration:none;font-weight:500}
.ds-hero{background:linear-gradient(135deg,var(--${d.tokenName}),var(--secondary));color:#fff;padding:3rem 2rem;border-radius:0 0 14px 14px}
.ds-hero h2{font-size:2rem;margin-bottom:.6rem}
.ds-card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.07);margin:1rem}
.ds-card .img{height:140px;background:linear-gradient(135deg,var(--${d.tokenName})22,var(--secondary)22);display:flex;align-items:center;justify-content:center;color:var(--${d.tokenName});font-size:2.4rem}
.ds-card .body{padding:1rem}
.ds-card h3{margin-bottom:.4rem}
.ds-card small{color:var(--text-light)}
.ds-fcard{background:#fff;border-radius:12px;padding:1.6rem;margin:1rem;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.ds-fcard .ic{width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,var(--${d.tokenName}),var(--secondary));margin:0 auto .8rem}
.ds-btn{display:inline-block;padding:.65rem 1.5rem;border-radius:8px;font-weight:600;text-decoration:none;margin:1rem}
.ds-btn-primary{background:var(--${d.tokenName});color:#fff}
.ds-btn-secondary{background:#fff;color:var(--${d.tokenName});border:2px solid var(--${d.tokenName})}
.ds-title{text-align:center;padding:1.4rem 1rem .6rem;font-size:1.6rem}
.ds-title::after{content:'';display:block;width:56px;height:3px;margin:.5rem auto 0;background:linear-gradient(90deg,var(--${d.tokenName}),var(--secondary));border-radius:2px}
.ds-footer{background:var(--text-dark);color:#cbd5e0;padding:2rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1.2rem}
.ds-footer h4{color:#fff;margin-bottom:.6rem}
.ds-footer a{color:#cbd5e0;display:block;text-decoration:none;margin:.25rem 0}
@media(max-width:768px){.ds-navbar ul{display:none}.ds-hero h2{font-size:1.5rem}}
@media(max-width:480px){.ds-footer{grid-template-columns:1fr}}
`;
  let body = '';
  switch (d.kind) {
    case 'navbar':
      body = `<nav class="ds-navbar"><span class="brand">${esc(p.brand || '智慧学习')}</span><ul>${(p.links || ['首页', '课程', '计划', '关于']).map(x => `<li><a>${esc(x)}</a></li>`).join('')}</ul></nav>`;
      break;
    case 'hero-slider':
      body = `<div class="ds-hero"><h2>${esc(p.title || '开启智慧学习之旅')}</h2><p>${esc(p.subtitle || '个性化路径 · 丰富课程 · 全程陪伴')}</p></div>`;
      break;
    case 'course-card':
      body = `<div class="ds-card"><div class="img">📘</div><div class="body"><h3>${esc(p.title || '示例课程')}</h3><small>${esc(p.meta || '讲师 · 时长 · 等级')}</small></div></div>`;
      break;
    case 'feature-card':
      body = `<div class="ds-fcard"><div class="ic"></div><h3>${esc(p.title || '平台特色')}</h3><small>${esc(p.meta || '一句话说明')}</small></div>`;
      break;
    case 'btn-primary':
      body = `<a class="ds-btn ds-btn-primary">${esc(p.label || '立即开始')}</a>`;
      break;
    case 'btn-secondary':
      body = `<a class="ds-btn ds-btn-secondary">${esc(p.label || '了解更多')}</a>`;
      break;
    case 'section-title':
      body = `<h2 class="ds-title">${esc(p.title || '板块标题')}</h2>`;
      break;
    case 'footer':
      body = `<footer class="ds-footer"><div><h4>${esc(p.brand || '智慧学习')}</h4><a>关于我们</a><a>联系方式</a></div><div><h4>学习</h4><a>课程中心</a><a>学习计划</a></div><div><h4>支持</h4><a>常见问题</a><a>帮助中心</a></div></footer>`;
      break;
    default:
      body = `<div class="ds-fcard"><h3>${esc(d.name)}</h3><small>${esc(d.kind)}</small></div>`;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${t}</style></head><body><div class="preview" data-fingerprint="${fingerprint(cv, 0)}">${body}</div></body></html>`;
}

/* ---------- 截图引擎输出（SVG） ---------- */
function svg(cv, width) {
  const d = descriptorOf(cv);
  const p = d.props;
  const h = heightFor(d.kind, width);
  const mobile = width < 480, tablet = width >= 480 && width < 1024;
  const gradId = 'g' + crypto.createHash('md5').update(d.tokenValue).digest('hex').slice(0, 8);
  const S = [];
  S.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" font-family="PingFang SC, Microsoft YaHei, sans-serif">`);
  S.push(`<rect width="${width}" height="${h}" fill="#f7fafc"/>`);
  S.push(`<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${esc(d.tokenValue)}"/><stop offset="1" stop-color="#764ba2"/></linearGradient></defs>`);
  const txt = (x, y, s, fill, size, bold) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${fill || '#2d3748'}">${esc(s)}</text>`;

  if (d.kind === 'navbar') {
    S.push(`<rect width="${width}" height="${h}" fill="#fff"/>`);
    S.push(`<line x1="0" y1="${h - 1}" x2="${width}" y2="${h - 1}" stroke="#e2e8f0"/>`);
    S.push(txt(24, h / 2 + 8, p.brand || '智慧学习', d.tokenValue, mobile ? 18 : 24, true));
    if (!mobile) {
      const links = p.links || ['首页', '课程', '计划', '关于'];
      links.forEach((l, i) => S.push(txt(width - 24 - (links.length - i) * 92, h / 2 + 6, l, '#2d3748', 16)));
    } else {
      S.push(`<rect x="${width - 40}" y="${h / 2 - 9}" width="20" height="2" fill="#2d3748"/><rect x="${width - 40}" y="${h / 2 - 2}" width="20" height="2" fill="#2d3748"/><rect x="${width - 40}" y="${h / 2 + 5}" width="20" height="2" fill="#2d3748"/>`);
    }
  } else if (d.kind === 'hero-slider') {
    S.push(`<rect width="${width}" height="${h}" fill="url(#${gradId})"/>`);
    const titleSize = mobile ? 26 : tablet ? 32 : 42;
    S.push(txt(mobile ? 24 : 48, h / 2 - 10, p.title || '开启智慧学习之旅', '#fff', titleSize, true));
    S.push(txt(mobile ? 24 : 48, h / 2 + 28, p.subtitle || '个性化路径 · 丰富课程 · 全程陪伴', 'rgba(255,255,255,.88)', mobile ? 15 : 19));
  } else if (d.kind === 'course-card') {
    const pad = mobile ? 12 : 24;
    S.push(`<rect x="${pad}" y="14" width="${width - pad * 2}" height="${h - 28}" rx="12" fill="#fff" stroke="#e2e8f0"/>`);
    S.push(`<rect x="${pad}" y="14" width="${width - pad * 2}" height="${Math.min(140, h * 0.55)}" rx="12" fill="${esc(d.tokenValue)}22"/>`);
    S.push(txt(pad + 18, Math.min(140, h * 0.55) / 2 + 10, '📘', d.tokenValue, 30));
    const top = 14 + Math.min(140, h * 0.55);
    S.push(txt(pad + 18, top + 38, p.title || '示例课程', '#2d3748', 19, true));
    S.push(txt(pad + 18, top + 68, p.meta || '讲师 · 时长 · 等级', '#718096', 14));
  } else if (d.kind === 'feature-card') {
    S.push(`<rect x="24" y="14" width="${width - 48}" height="${h - 28}" rx="12" fill="#fff" stroke="#e2e8f0"/>`);
    const cx = width / 2;
    S.push(`<rect x="${cx - 26}" y="34" width="52" height="52" rx="12" fill="url(#${gradId})"/>`);
    S.push(txt(cx, 122, p.title || '平台特色', '#2d3748', 18, true)).valueOf;
    S.push(`<text x="${cx}" y="150" font-size="13" fill="#718096" text-anchor="middle">${esc(p.meta || '一句话说明')}</text>`);
  } else if (d.kind === 'btn-primary' || d.kind === 'btn-secondary') {
    const label = p.label || (d.kind === 'btn-primary' ? '立即开始' : '了解更多');
    const bw = Math.min(180, width - 48), bh = 44, bx = (width - bw) / 2, by = (h - bh) / 2;
    if (d.kind === 'btn-primary') {
      S.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8" fill="${esc(d.tokenValue)}"/>`);
      S.push(`<text x="${width / 2}" y="${by + 29}" font-size="16" font-weight="600" fill="#fff" text-anchor="middle">${esc(label)}</text>`);
    } else {
      S.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8" fill="#fff" stroke="${esc(d.tokenValue)}" stroke-width="2"/>`);
      S.push(`<text x="${width / 2}" y="${by + 29}" font-size="16" font-weight="600" fill="${esc(d.tokenValue)}" text-anchor="middle">${esc(label)}</text>`);
    }
  } else if (d.kind === 'section-title') {
    S.push(`<text x="${width / 2}" y="${h / 2 - 4}" font-size="${mobile ? 22 : 27}" font-weight="700" fill="#2d3748" text-anchor="middle">${esc(p.title || '板块标题')}</text>`);
    S.push(`<rect x="${width / 2 - 28}" y="${h / 2 + 12}" width="56" height="3" rx="1.5" fill="url(#${gradId})"/>`);
  } else if (d.kind === 'footer') {
    S.push(`<rect width="${width}" height="${h}" fill="#2d3748"/>`);
    const cols = mobile ? 1 : 3, cw = width / cols;
    const heads = [p.brand || '智慧学习', '学习', '支持'];
    const items = [['关于我们', '联系方式'], ['课程中心', '学习计划'], ['常见问题', '帮助中心']];
    heads.forEach((hd, ci) => {
      if (mobile && ci > 0) return;
      const col = mobile ? 0 : ci;
      const x = 28 + col * cw;
      S.push(txt(x, 44 + (mobile ? ci * 110 : 0), hd, '#fff', 16, true));
      (mobile ? items.flat() : items[ci]).forEach((it, ii) => S.push(txt(x, 72 + ii * 26 + (mobile ? ci * 110 : 0), it, '#cbd5e0', 13)));
    });
  } else {
    S.push(`<rect x="24" y="24" width="${width - 48}" height="${h - 48}" rx="12" fill="#fff" stroke="#e2e8f0"/>`);
    S.push(`<text x="${width / 2}" y="${h / 2}" font-size="18" fill="#2d3748" text-anchor="middle">${esc(d.name)}</text>`);
  }
  S.push(`<text x="${width - 12}" y="${h - 10}" font-size="10" fill="#a0aec0" text-anchor="end">${esc(d.name)} · ${esc(d.tokenName)}=${esc(d.tokenValue)} · ${width}px · fp:${fingerprint(cv, width).slice(0, 8)}</text>`);
  S.push('</svg>');
  return { svg: S.join('\n'), width, height: h, fingerprint: fingerprint(cv, width) };
}

module.exports = { BREAKPOINTS, heightFor, descriptorOf, fingerprint, html, svg };
