# 站内设计说明 · 全栈版本化页面（design-system 服务）

> 与根目录静态站「智慧学习平台」并存的版本化设计说明服务。
> 根目录 `README.md` 是静态原型说明；本文件说明如何运行设计说明全栈系统。

把设计说明建设为**版本化内容资产**：前端展示主题定位/信息结构/色彩/可访问交互/响应式样例；
内容 API 管理设计决策与组件引用；SQL 保存说明版本与对应站点构建；发布屏障保证兼容与保鲜。

## 快速开始
```bash
npm install
npm run init-db        # 初始化 SQLite（data/app.db）与种子内容
npm start              # http://localhost:4010
# 后台: /admin?token=dev-admin-token  (ADMIN_TOKEN 可覆盖)
npm test               # 25 个自动化测试
npm run delivery-check # 真实运行的交付检查（10 项，非手工清单）
```

## 与静态站的关联
信息结构章节渲染"说明章节 ↔ 站内实际页面"映射表，并通过 `/site/<file>.html`
直接打开仓库内真实页面（index/courses/plan/resources/profile…），引用因此能落到实际页面。

## 关键设计
- **单一渲染管线**：公开页/候选/截图共用 `src/render/layout.js`，引用能落到真实页面锚点与 `data-component`。
- **版本与指针**：draft→candidate→published→archived；`releases.active` 唯一指针，提升/撤回单事务原子完成。
- **截图保鲜**：组件改名/源码/令牌任一变化，旧截图页面标红过期且门禁拒绝，必须重新捕获。
- **失败只挡候选**：屏障失败 → build rejected，稳定版与正在访问的读者完全不受影响。
- **发布模式**：选定"独立内容发布"（decoupled，内容 API 契约校验），并实现"随代码发布"（coupled，git_ref 校验）作为同套件策略。
- **存储**：真实 SQLite。无预编译原生模块时用 sql.js(WASM) 并原子落盘；DAO 全是标准 SQL（`src/db/schema.sql`），可平滑切到 better-sqlite3/node:sqlite。
- **截图引擎**：默认矢量渲染（与页面同组件片段、含 360/768/1280 指纹）；若存在 Chrome 并安装 puppeteer-core，自动升级为真实像素截图，失败自动回退。

详见 `docs/architecture.md`、`docs/gates.md`、`docs/acceptance.md`。
