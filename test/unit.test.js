'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectCycle } = require('../src/gates/gates');
const { checksum, extractRefs } = require('../src/content/model');
const { tokenHash, defaultTokens } = require('../src/content/tokens');
const { LIBRARY, sourceHash } = require('../src/content/components');

test('checksum 对键顺序不敏感，对值敏感', () => {
  assert.equal(checksum({ a: 1, b: 2 }), checksum({ b: 2, a: 1 }));
  assert.notEqual(checksum({ a: 1 }), checksum({ a: 2 }));
});

test('令牌变更产生不同 hash（截图保鲜基础）', () => {
  const h1 = tokenHash(defaultTokens());
  const t2 = defaultTokens(); t2.color.brand = '#00aa55';
  assert.notEqual(h1, tokenHash(t2));
});

test('组件源码 hash：改名改变 source_hash，slug 不变', () => {
  const base = sourceHash(LIBRARY.card.source);
  const renamed = sourceHash({ ...LIBRARY.card.source, display_name: 'Card 信息卡片' });
  assert.notEqual(base, renamed);
});

test('引用环检测：有环返回路径，无环返回 null', () => {
  assert.ok(detectCycle({ a: ['b'], b: ['c'], c: ['a'] }));
  assert.equal(detectCycle({ a: ['b'], b: ['c'], c: [] }), null);
});

test('extractRefs 解析组件 planned 与段落 context', () => {
  const content = { sections: [{ id: 's1', components: [{ slug: 'modal', planned: true }] }] };
  const refs = extractRefs(content);
  assert.equal(refs[0].ref_type, 'component');
  assert.equal(refs[0].planned, 1);
  assert.equal(refs[0].context, 's1');
});
