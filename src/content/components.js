'use strict';
const { sha256 } = require('./model');

// 组件"源码"：这里以结构化描述充当源码（真实项目里是组件实现文件）。
// source_hash 对实现负责；display_name 的改名不影响 slug（引用稳定），但会让旧截图的名称指纹过期。
const LIBRARY = {
  button: {
    display_name: 'Button 按钮',
    status: 'live',
    depends_on: [],
    source: { tag: 'button', styles: ['radius.sm', 'color.brand', 'focus.ring'], a11y: ['focus-visible', 'min-target-44px'] }
  },
  card: {
    display_name: 'Card 卡片',
    status: 'live',
    depends_on: ['button'],
    source: { tag: 'article', styles: ['radius.md', 'color.surface', 'space.lg'], a11y: ['landmark', 'heading-order'] }
  },
  nav: {
    display_name: 'TopNav 顶部导航',
    status: 'live',
    depends_on: ['button'],
    source: { tag: 'nav', styles: ['space.md', 'color.line'], a11y: ['aria-current', 'keyboard-trap-free'] }
  },
  modal: {
    display_name: 'Modal 对话框',
    status: 'draft',
    depends_on: ['button'],
    source: { tag: 'dialog', styles: ['radius.lg', 'focus.ring'], a11y: ['role-dialog', 'focus-trap', 'esc-close'] }
  }
};
const sourceHash = (src) => 'src_' + sha256(JSON.stringify(src)).slice(0, 14);
module.exports = { LIBRARY, sourceHash };
