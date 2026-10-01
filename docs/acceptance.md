# 验收场景与如何复现

所有检查**实际运行**（真实 HTTP + 真实 SQLite + 真实文件制品），不是手工清单：

```bash
npm install
npm test                 # 24 个自动化用例（单元/门禁/E2E/前端）
npm run delivery-check   # 10 项端到端交付检查（独立服务器子进程，真实请求）
```

| 需求 | 覆盖位置 |
|---|---|
| 验收文档先于组件上线 | e2e 场景1；service.activateComponent 强制 `acceptance_doc` |
| 引用环 | e2e 场景2；gates.reference-cycle |
| 截图生成失败 | e2e 场景3 + delivery；失败只 rejected，稳定版指针不变 |
| 两编辑冲突 | e2e 场景4；版本号 + checksum 双重乐观锁 → 409，先存内容保留 |
| 构建撤回 | e2e 场景5 + delivery；回到上一发布版本 |
| 读者切换历史版看当时决策 | e2e 场景6 + delivery；历史页显示快照标识与切换器 |
| 公开页不暴露后台草稿 | e2e 场景7；draft/candidate 公开 URL/API 一律 404，admin 401 |
| 组件改名/令牌变化后过期截图 | gates.test；页面红标 + 保鲜门失败 + 必须重新捕获 |
| 链接/图片比例/关键断点 | gates.test：links-valid / image-ratio / breakpoint-coverage |
| 两种发布模式与契约 | gates.test：decoupled API 契约、coupled git_ref |

## 手动体验
```bash
npm start                                   # http://localhost:4010
open http://localhost:4010/admin?token=dev-admin-token
# 改名或换令牌 → 回公开页可见"截图已过期"；运行屏障会被拒，需重新捕获
```
