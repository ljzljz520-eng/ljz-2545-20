'use strict';
// 设计说明内容模型与指纹工具
const crypto = require('crypto');

const KEY_BREAKPOINTS = [360, 768, 1280]; // 关键断点：手机 / 平板 / 桌面

function stableJson(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc; }, {});
    }
    return v;
  }, 0);
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
const checksum = (obj) => sha256(stableJson(obj));

// 从内容中抽取全部引用（组件/图片/链接/段落/来源），组件引用必须能落到真实实体
function extractRefs(content) {
  const refs = [];
  const sections = content.sections || [];
  for (const sec of sections) {
    for (const c of sec.components || []) {
      refs.push({ ref_type: 'component', target: c.slug, planned: c.planned ? 1 : 0, context: sec.id });
    }
    for (const img of sec.images || []) {
      refs.push({ ref_type: 'image', target: typeof img === 'string' ? img : img.id, planned: 0, context: sec.id });
    }
    for (const link of sec.links || []) {
      refs.push({ ref_type: 'link', target: link.href, planned: 0, context: sec.id });
    }
    if (sec.source) refs.push({ ref_type: 'source', target: sec.source, planned: 0, context: sec.id });
  }
  // 信息架构里的锚点也算内部链接
  const walk = (nodes) => (nodes || []).forEach((n) => {
    if (n.anchor) refs.push({ ref_type: 'link', target: '#' + n.anchor, planned: 0, context: '__ia__' });
    walk(n.children);
  });
  walk(content.ia);
  return refs;
}

function sectionIds(content) {
  return new Set((content.sections || []).map((s) => s.id));
}

module.exports = { stableJson, sha256, checksum, extractRefs, sectionIds, KEY_BREAKPOINTS };
