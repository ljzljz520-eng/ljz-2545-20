'use strict';
// 初始设计说明内容与原创素材（对齐仓库内真实"智慧学习平台"静态站）。
// 每个段落都有稳定 id，页面渲染复用同一 id，doc_refs.context 因而能关联到实际页面。

function seedDocContent() {
  return {
    lang: 'zh-CN',
    title: '智慧学习平台 · 站内设计说明',
    theme: {
      positioning: '面向学习者的在线教育平台：以课程资源、个性化学习路径与学习支持为核心；' +
                    '视觉上采用渐变品牌色与卡片式布局，信息优先、交互可访问。',
      keywords: ['在线教育', '渐变品牌', '卡片式布局', '移动优先', '可访问交互']
    },
    ia: [
      { id: 'i1', anchor: 'theme', label: '主题定位' },
      { id: 'i2', anchor: 'ia', label: '信息结构（对应实际页面）' },
      { id: 'i3', anchor: 'color', label: '色彩与令牌' },
      { id: 'i4', anchor: 'a11y', label: '可访问交互' },
      { id: 'i5', anchor: 'components', label: '组件' },
      { id: 'i6', anchor: 'responsive', label: '响应式样例' }
    ],
    sections: [
      {
        id: 'theme', heading: '主题定位', type: 'prose',
        body: '本说明是"智慧学习平台"的单一事实来源。平台提供课程浏览、学习计划、资源中心与个人中心；' +
              '品牌渐变（#f5576c → #764ba2）用于主操作与首屏，装饰让位于结构。',
        links: [{ href: '#components', label: '查看组件章节' }],
        source: 'inhouse-design-2026'
      },
      {
        id: 'ia', heading: '信息结构（对应实际页面）', type: 'ia',
        body: '站内实际页面与说明章节一一对应：index（首页/轮播）、courses（课程）、plan（学习计划）、' +
              'resources（资源中心）、profile（个人中心）、about、contact。',
        pageMap: [
          { page: 'index.html', anchor: 'navMenu', role: '首页与课程轮播入口' },
          { page: 'courses.html', anchor: '', role: '课程列表与筛选' },
          { page: 'plan.html', anchor: '', role: '个性化学习计划' },
          { page: 'resources.html', anchor: '', role: '资源中心' },
          { page: 'profile.html', anchor: '', role: '个人中心' }
        ],
        links: [{ href: '#color', label: '下一节：色彩与令牌' }],
        source: 'inhouse-design-2026'
      },
      {
        id: 'color', heading: '色彩与设计令牌', type: 'tokens',
        body: '颜色仅通过设计令牌引用，取值与 css/style.css 一致；令牌按版本保存。' +
              '修改令牌会产生新版本，所有组件截图的令牌指纹随即失效，必须重新生成。',
        links: [{ href: '#a11y', label: '对比度与焦点要求' }]
      },
      {
        id: 'a11y', heading: '可访问交互说明', type: 'a11y',
        body: '导航可折叠（#navToggle/#navMenu）且键盘可达；交互件满足 44px 最小触控目标、' +
              '可见焦点环（color.focus=#ed8936）；表单有明确错误态（#f8d7da/#721c24）与成功态（#d4edda）；' +
              '正文对比度 ≥ 4.5:1，并遵守 prefers-reduced-motion。',
        links: [
          { href: '#components', label: '组件清单' },
          { href: '#responsive', label: '响应式行为' }
        ]
      },
      {
        id: 'components', heading: '组件', type: 'components',
        body: '下列组件在真实页面中渲染。对话框（Modal）将在文档发布后上线，属于"先文档后组件"，' +
              '以 planned 标记且页面给出即将上线提示。',
        components: [
          { slug: 'nav' },
          { slug: 'card' },
          { slug: 'button' },
          { slug: 'modal', planned: true }
        ]
      },
      {
        id: 'responsive', heading: '响应式样例', type: 'responsive',
        body: '站点现有断点为 480（手机）/ 768（平板）；本说明额外纳入 1280 桌面基准，' +
              '在 360 / 768 / 1280 三个关键断点生成现状截图。窄屏导航折叠为单列，卡片网格 1→2→3 列。',
        images: [{ id: 'hero-rule' }],
        links: [{ href: '#theme', label: '返回主题定位' }]
      }
    ]
  };
}

function seedSources() {
  return [
    { slug: 'inhouse-design-2026', kind: 'copy', title: '智慧学习平台设计基线（站内原创）', author: '设计平台组',
      url: null, license: '内部原创 · 仅限站内', note: '主题定位、信息结构与可访问性章节的原始文案来源' }
  ];
}

function seedAssets() {
  return [
    { id: 'hero-rule', source_slug: 'inhouse-design-2026', kind: 'image',
      width: 1280, height: 720, alt: '三条响应式断点竖线示意：360、768、1280' }
  ];
}

module.exports = { seedDocContent, seedSources, seedAssets };
