'use strict';
/* 种子：建立 1 个 active 构建 + 5 个组件（含截图、验收决策）+ 设计说明 v1 并通过屏障发布 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { init } = require('./db');
const buildsLib = require('./builds');
const shots = require('./screenshots');
const { runGates } = require('./gates');

const WIDTHS = [1200, 768, 375];
const codeRef = '8102d73'; // 当前仓库 commit

const COMPONENTS = [
  { id: 'navbar', name: '顶部导航', token: ['primary-color', '#667eea', '品牌主色：渐变起点/激活态'], props: { brand: '智慧学习', links: ['首页', '课程', '计划', '资源', '关于'] }, sel: '.navbar', page: '/index.html' },
  { id: 'hero-slider', name: '首页轮播', token: ['primary-color', '#667eea', '品牌主色：横幅渐变'], props: { title: '开启智慧学习之旅', subtitle: '个性化路径 · 10+ 课程 · 全程陪伴' }, sel: '.slider', page: '/index.html' },
  { id: 'course-card', name: '课程卡片', token: ['primary-color', '#667eea', '品牌主色：标题强调'], props: { title: '前端工程化实战', meta: '王老师 · 12小时 · 初级' }, sel: '.course-card', page: '/courses.html' },
  { id: 'feature-card', name: '特色卡片', token: ['secondary-color', '#764ba2', '辅助色：渐变终点/图标'], props: { title: '智能规划', meta: '按基础与目标推荐路径' }, sel: '.feature-card', page: '/index.html' },
  { id: 'btn-primary', name: '主要按钮', token: ['primary-color', '#667eea', '品牌主色：主要行动按钮'], props: { label: '立即开始学习' }, sel: '.btn-primary', page: '/index.html' },
];

async function main() {
  if (process.argv.includes('--force')) {
    const dbFile = path.join(__dirname, '..', 'data', 'app.sqlite');
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    fs.rmSync(path.join(__dirname, '..', 'data', 'snapshots'), { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, '..', 'screenshots'), { recursive: true, force: true });
  }
  const dba = await init();

  const buildId = 'b-' + codeRef;
  if (!dba.one('SELECT id FROM builds WHERE id=?', [buildId])) {
    const manifest = buildsLib.createSnapshot(buildId);
    dba.run("INSERT INTO builds (id,code_ref,status,manifest_json) VALUES (?,?, 'active', ?)",
      [buildId, codeRef, JSON.stringify(manifest)]);
  }

  if (!dba.one("SELECT id FROM docs WHERE slug='design-spec'")) {
    dba.run("INSERT INTO docs (id,slug,title) VALUES ('doc-design','design-spec','智慧学习平台 · 站内设计说明')");
  }

  const dvId = 1;
  if (!dba.one('SELECT id FROM doc_versions WHERE id=1')) {
    dba.run(
      `INSERT INTO doc_versions (id,doc_id,version,status,theme_positioning,info_structure,responsive_sample,body,base_version,etag,created_by,published_at)
       VALUES (1,'doc-design',1,'draft',?,?,?,?,NULL,?,?,datetime('now'))`,
      [
        '面向自学编程/设计技能的初学者与在职提升者，定位为“可信赖的在线学习陪伴者”：蓝色渐变传达理性与科技感，卡片化信息降低选择成本，移动端折叠导航保证单手可达。',
        JSON.stringify({
          layers: ['入口层：navbar 全站导航（8 页）', '转化层：hero-slider 价值主张 + btn-primary 主行动', '内容层：course-card/feature-card 卡片网格', '支撑层：footer 全站链接'],
          pages: ['/index.html', '/courses.html', '/plan.html', '/resources.html', '/profile.html', '/about.html', '/contact.html', '/demo.html'],
        }, null, 0),
        JSON.stringify({
          breakpoints: WIDTHS,
          note: '桌面 1200px 网格 4 列；平板 768px 降为 2 列并收窄间距；手机 375px 单列、汉堡导航。',
          links: ['/index.html', '/courses.html', '/plan.html', '/resources.html', '/about.html', '/contact.html'],
        }),
        `## 主题定位\n在线教育，理性蓝紫 + 卡片化。\n\n## 信息结构\n入口-转化-内容-支撑 四层。\n\n## 响应式样例\n见 [首页](/index.html) 与 [课程中心](/courses.html)。\n\n外发联系入口 [邮件](mailto:info@smartlearn.com)。`,
        'seed-v1',
      ]);
  }

  // 决策（必须先于组件版本创建：G9）
  const decIds = {};
  const decDefs = [
    ['acc-navbar', 'acceptance', '验收记录 · 顶部导航', '验收：sticky 吸顶、active 态、移动端汉堡按钮可用；键盘 Tab 可遍历全部链接。', '/index.html', '.navbar'],
    ['acc-hero', 'acceptance', '验收记录 · 首页轮播', '验收：5 秒自动播放、悬停暂停、指示点与前后箭头可用；为轮播文字保留 4.5:1 对比。', '/index.html', '.slider'],
    ['acc-course', 'acceptance', '验收记录 · 课程卡片', '验收：标题不截断、筛选淡入动画在 prefers-reduced-motion 下被禁用。', '/courses.html', '.course-card'],
    ['acc-feature', 'acceptance', '验收记录 · 特色卡片', '验收：4 卡网格在 1200/768/375 三断点不错位，图标含 aria-label。', '/index.html', '.feature-card'],
    ['acc-btn', 'acceptance', '验收记录 · 主按钮', '验收：焦点环可见，点击区 ≥44px，hover/focus/active 三态可辨。', '/index.html', '.btn-primary'],
    ['src-1', 'source', '原创素材来源 · 渐变插画', '轮播与卡片插画为站内原创 CSS 渐变图形（linear-gradient + 几何形），无外链图片；源代码见 index.html 内 .slide-illustration。', '/index.html', '.slide-illustration'],
    ['src-2', 'source', '原创素材来源 · 图标', '图标使用内联 emoji/SVG 自绘占位，字体为系统字体栈，无第三方字体下载。', '/courses.html', '.course-thumbnail'],
    ['color-1', 'color', '色彩说明 · 品牌主色', '--primary-color #667eea：导航激活态、主按钮、标题强调；与白色文字对比 4.6:1。', '/index.html', '.navbar'],
    ['color-2', 'color', '色彩说明 · 辅助色', '--secondary-color #764ba2：渐变终点、图标底色；禁止用于正文。', '/index.html', '.feature-icon'],
    ['a11y-1', 'a11y', '可访问交互 · 键盘与焦点', '所有交互元素可 Tab 到达，:focus-visible 有清晰焦点环；FAQ 手风琴使用 aria-expanded。', '/contact.html', '.footer'],
    ['a11y-2', 'a11y', '可访问交互 · 动效降级', '响应 prefers-reduced-motion：关闭轮播自动播放与数字递增动画。', '/index.html', '.slider'],
  ];
  for (const [id, kind, title, detail, pg, sel] of decDefs) {
    if (!dba.one('SELECT id FROM decisions WHERE id=?', [id])) {
      dba.run('INSERT INTO decisions (id,doc_version_id,kind,title,detail,page_path,target_selector,editor,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, dvId, kind, title, detail, pg, sel, 'seed', '2026-09-20 10:00:00']);
    }
    decIds[id] = id;
  }
  // 修正 created_at（早于组件版本）
  dba.run("UPDATE decisions SET created_at='2026-09-20 10:00:00' WHERE doc_version_id=1");

  // 组件 + v1（验收在前，组件在后）
  for (const c of COMPONENTS) {
    if (!dba.one('SELECT id FROM components WHERE id=?', [c.id]))
      dba.run('INSERT INTO components (id,name,current_version_id) VALUES (?,?,NULL)', [c.id, c.name]);
    const accId = { navbar: 'acc-navbar', 'hero-slider': 'acc-hero', 'course-card': 'acc-course', 'feature-card': 'acc-feature', 'btn-primary': 'acc-btn' }[c.id];
    const cv = {
      component_id: c.id, name: c.name,
      token_name: c.token[0], token_value: c.token[1], token_semantic: c.token[2],
      props_json: JSON.stringify(c.props),
    };
    if (!dba.one('SELECT id FROM component_versions WHERE component_id=? AND version=1', [c.id])) {
      dba.run(
        `INSERT INTO component_versions (component_id,version,name,token_name,token_value,token_semantic,props_json,acceptance_decision_id,status,created_by,created_at)
         VALUES (?,1,?,?,?,?,?,?, 'accepted', 'seed', '2026-09-21 09:00:00')`,
        [cv.component_id, cv.name, cv.token_name, cv.token_value, cv.token_semantic, cv.props_json, accId]);
      const cvId = dba.one('SELECT id FROM component_versions WHERE component_id=? AND version=1', [c.id]).id;
      const rows = shots.refreshFor(dba, cvId, WIDTHS);
      dba.run('UPDATE components SET current_version_id=? WHERE id=?', [cvId, c.id]);
      dba.run('INSERT INTO refs (from_kind,from_id,to_kind,to_id) VALUES (?,?,?,?)',
        ['component', String(cvId), 'decision', accId]);
    }
  }

  // 发布 v1
  const dv = dba.one('SELECT * FROM doc_versions WHERE id=1');
  if (dv.status !== 'published') {
    const gates = runGates(dba, dv, buildId);
    const failed = gates.filter(g => !g.ok);
    if (failed.length) {
      console.error('种子发布屏障失败：');
      for (const g of failed) console.error(' -', g.id, g.name, '::', g.detail);
      process.exit(1);
    }
    dba.run("UPDATE doc_versions SET status='published', published_at=datetime('now') WHERE id=1");
    dba.run("UPDATE docs SET live_version=1 WHERE id='doc-design'");
    dba.run("INSERT INTO promotions (doc_id,version,build_id,active,snapshot_json) VALUES ('doc-design',1,?,1,'{}')", [buildId]);
    dba.run('INSERT INTO release_attempts (doc_version_id,build_id,result,gates_json) VALUES (1,?, ?, ?)',
      [buildId, 'promoted', JSON.stringify(gates)]);
  }
  dba.audit('seed', 'seed.complete', buildId, { components: COMPONENTS.length });
  dba.flush();
  console.log('seed complete: build', buildId, '| design-spec v1 published | components:', COMPONENTS.length);
}
main().catch(e => { console.error(e); process.exit(1); });
