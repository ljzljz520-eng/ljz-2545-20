'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv } = require('./helpers');

async function publishedPage(env) {
  const d = await (await env.api('/admin/api/drafts?docSlug=design-system')).json;
  const cb = await env.api('/admin/api/builds', { body: { docSlug: 'design-system', version: d.version } });
  const g = await env.api(`/admin/api/builds/${cb.json.buildKey}/gate`, { body: {} });
  assert.equal(g.status, 200);
  await env.api(`/admin/api/builds/${cb.json.buildKey}/promote`, { body: {} });
  return (await env.getHtml('/d/design-system')).html;
}

test('前端展示：主题定位、信息结构、色彩令牌、可访问交互、组件、响应式章节齐全', async () => {
  const env = await freshEnv();
  try {
    const html = await publishedPage(env);
    assert.match(html, /主题定位/);
    assert.match(html, /单一事实来源/);
    assert.match(html, /信息结构/);
    assert.match(html, /色彩与设计令牌/);
    assert.match(html, /#f5576c|f5576c/);
    assert.match(html, /可访问交互说明/);
    assert.match(html, /44px/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /data-component="nav"/);
    assert.match(html, /data-component="card"/);
    assert.match(html, /data-component="button"/);
    assert.match(html, /即将上线（文档先行）/); // planned modal
    assert.match(html, /响应式样例/);
    assert.match(html, /关键断点/);
  } finally { await env.close(); }
});

test('响应式：360 / 768 / 1280 三个关键断点媒体查询真实存在', async () => {
  const env = await freshEnv();
  try {
    const html = await publishedPage(env);
    assert.match(html, /@media \(min-width:768px\)/);
    assert.match(html, /@media \(min-width:1280px\)/);
    assert.match(html, /@media \(max-width:480px\)/);
    assert.match(html, /grid-template-columns:repeat\(3,1fr\)/);
  } finally { await env.close(); }
});

test('原创素材来源与引用：来源标注出现在被引用段落，素材 SVG 可渲染且带 alt', async () => {
  const env = await freshEnv();
  try {
    const html = await publishedPage(env);
    assert.match(html, /原创素材来源：智慧学习平台设计基线/);
    assert.match(html, /设计平台组/);
    assert.match(html, /<svg[^>]*aria-label="三条响应式断点竖线示意：360、768、1280"/);
    // 引用的关联上下文 = 真实存在的页面锚点
    assert.match(html, /id="theme"/);
    assert.match(html, /id="responsive"/);
    assert.match(html, /href="\/d\/design-system#theme"/);
  } finally { await env.close(); }
});

test('可访问交互：焦点环、对比度信息、语义化 landmark 与 aria-current 呈现', async () => {
  const env = await freshEnv();
  try {
    const html = await publishedPage(env);
    assert.match(html, /:focus-visible\{outline:3px solid var\(--focus\)/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, /role="dialog"/);
    assert.match(html, /对比度 ≥ 4.5:1/);
  } finally { await env.close(); }
});

test('现状截图：页面同时渲染三个断点的截图入口并标注尺寸/引擎', async () => {
  const env = await freshEnv();
  try {
    const html = await publishedPage(env);
    for (const bp of [360, 768, 1280]) {
      assert.match(html, new RegExp(`@ ${bp}px`));
    }
    assert.match(html, /engine=vector/);
    assert.match(html, /现状截图/);
  } finally { await env.close(); }
});

test('信息结构映射：说明章节链接到站内实际页面且可打开', async () => {
  const env = await freshEnv();
  try {
    const html = await publishedPage(env);
    assert.match(html, /说明章节 ↔ 站内实际页面/);
    assert.match(html, /href="\/site\/index\.html"/);
    assert.match(html, /<code>#navMenu<\/code>/);
    const page = await env.getHtml('/site/index.html');
    assert.equal(page.status, 200);
    assert.match(page.html, /智慧学习|学习|课程/);
    const cssRes = await fetch(`${env.base}/site/css/style.css`);
    assert.equal(cssRes.status, 200);
  } finally { await env.close(); }
});
