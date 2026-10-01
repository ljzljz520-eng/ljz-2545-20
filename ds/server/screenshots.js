'use strict';
/*
 * 截图服务：对组件版本在关键断点生成内容寻址截图。
 *  - 文件落盘 screenshots/<componentVersionId>-<width>.svg
 *  - 失败注入：环境变量 DS_SCREENSHOT_FAIL=1 时强制失败（用于验收“截图生成失败”场景）
 *  - 截图含指纹水印；改名 / 令牌变化 => 指纹失配 => 屏障拒绝把过期截图当现状
 */
const fs = require('fs');
const path = require('path');
const render = require('./render');

const SHOT_DIR = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

class ScreenshotError extends Error {}

function capture(dba, componentVersionId, widths) {
  if (process.env.DS_SCREENSHOT_FAIL === '1') {
    throw new ScreenshotError('截图渲染器不可用（DS_SCREENSHOT_FAIL=1 注入故障）');
  }
  const cv = dba.one('SELECT * FROM component_versions WHERE id=?', [componentVersionId]);
  if (!cv) throw new ScreenshotError('组件版本不存在: ' + componentVersionId);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const out = [];
  for (const width of widths) {
    const { svg, height, fingerprint } = render.svg(cv, width);
    const file = path.join(SHOT_DIR, `cv${componentVersionId}-${width}.svg`);
    fs.writeFileSync(file, svg);
    const declaredRatio = `16:9`; // 声明比例（width/height 维度由 width/height 列承载，此处为展示用标签）
    out.push({ componentVersionId, width, height, fingerprint, file: path.relative(path.join(__dirname, '..'), file), declaredRatio });
  }
  return out;
}

// 刷新某组件版本全部断点截图（返回行数组供 gates 使用）
function refreshFor(dba, componentVersionId, widths) {
  const shots = capture(dba, componentVersionId, widths);
  for (const s of shots) {
    dba.run(
      `INSERT INTO screenshots (component_version_id,breakpoint,width,height,declared_ratio,fingerprint,file_path,renderer)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(component_version_id,breakpoint) DO UPDATE SET
         width=excluded.width,height=excluded.height,declared_ratio=excluded.declared_ratio,
         fingerprint=excluded.fingerprint,file_path=excluded.file_path,renderer=excluded.renderer,created_at=datetime('now')`,
      [componentVersionId, s.width, s.width, s.height, s.declaredRatio, s.fingerprint, s.file, 'builtin-svg/1.0']
    );
  }
  return shots;
}

module.exports = { capture, refreshFor, ScreenshotError, SHOT_DIR };
