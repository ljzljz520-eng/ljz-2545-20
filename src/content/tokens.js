'use strict';
const { checksum } = require('./model');

// 设计令牌（含色彩）。令牌变化 => 新 hash => 旧截图指纹不符 => 保鲜门失败
function defaultTokens() {
  return {
    version: 1,
    color: {
      // 取自智慧学习平台真实样式（css/style.css 的渐变主色系）
      brand: '#f5576c',        // 主渐变起（hero/按钮）
      brandAlt: '#764ba2',     // 主渐变止
      brandContrast: '#ffffff',
      ink: '#2d3748',
      surface: '#ffffff',
      muted: '#718096',
      line: '#e2e8f0',
      canvas: '#f7fafc',
      successBg: '#d4edda',
      dangerBg: '#f8d7da',
      focus: '#ed8936',
      danger: '#721c24'
    },
    radius: { sm: 4, md: 10, lg: 18 },
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },
    type: { base: 16, h1: 32, h2: 22, lineHeight: 1.55 },
    motion: { reduce: 'respect-prefers-reduced-motion' }
  };
}
const tokenHash = (tokens) => 'tok_' + checksum(tokens).slice(0, 16);
module.exports = { defaultTokens, tokenHash };
