# 架构说明：全栈版本化站内设计说明

## 组件
```
浏览器
  ├─ 公开页  GET /d/:slug            稳定版（当前发布指针）
  │          GET /d/:slug@v:n        历史版本（只读快照 + 版本切换器）
  ├─ 内容 API GET /api/docs/:slug[..] 只返回 published/archived；draft/candidate → 404
  └─ 后台    /admin + /admin/api/*    Bearer 令牌；草稿编辑/改名/令牌/构建/门禁/提升/撤回
        │
   src/api/server.js（原生 http，零前端框架依赖）
        ├── src/content/service.js   草稿/乐观锁/组件/令牌/构建
        ├── src/release/release.js   gateBuild → promote → rollback
        ├── src/gates/gates.js       10 个发布屏障
        ├── src/render/layout.js     单一 SSR 管线（页面=组件片段=截图）
        ├── src/render/screenshot.js 矢量渲染器 + 可选 puppeteer-core
        └── src/db/db.js + schema.sql 真实 SQLite（sql.js/WASM，原子落盘）
```

## SQL 模型（要点）
- `components.slug` 永不改变，引用靠 slug；`display_name/source_hash` 变化只产生新指纹，不破坏引用。
- `doc_versions`：draft → candidate → published → archived；`checksum` 同时是内容指纹与乐观锁令牌。
- `screenshots`：记录捕获时的 `component_hash / component_name / token_hash / breakpoint / width / height`。
- `releases`：每个文档一行 `active=1`；提升/撤回只在**一个事务**里改这张表，稳定版与候选物理隔离。
- `builds / gate_runs / audit_log`：构建状态、每次门检证据、操作审计。

## 引用如何关联到"实际页面"
`doc_refs.context` 存的是段落 id（theme/ia/color/a11y/components/responsive），
SSR 用同一 id 渲染 `<section id="...">`，导航锚点与之对应；组件片段带 `data-component="<slug>"`。
因此文档里的每条组件/素材/来源/链接引用都能在公开页面定位到真实节点，而不是孤立文本。

## 截图保鲜
1. 每个组件在 360/768/1280 三个关键断点各生成一张"现状"图。
2. 图内注释与 `screenshots` 行同时记录组件名、源码指纹、令牌指纹、断点。
3. 组件改名、源码改动或令牌升级后：
   - 旧版本页面上的截图自动出现红色"截图已过期"标记（降透明度+灰化），**不得再当现状**；
   - 新候选门禁 `screenshots-fresh` 失败；只有显式重新捕获并再次全绿，才能发布。

## 两种发布模式：比较与选择
| 维度 | 随代码发布 coupled | 独立内容发布 decoupled（**本系统选定**） |
|---|---|---|
| 发布物 | 代码与文档同一构建/同一 git ref | 内容经内容 API 独立发布，渲染端按契约消费 |
| 节奏 | 受发版窗口约束 | 内容可独立上线/回滚（分钟级） |
| 风险 | 内容错误要回滚整个代码版本 | 内容错误只回滚内容指针，代码不受影响 |
| 兼容性保障 | 构建清单 git_ref 必须与代码一致（门 `contract-compatible`） | 内容 API 契约版本必须与渲染端一致 |
| 适用 | 强耦合的实现说明 | 设计决策/规范这类"内容资产" |

结论：设计说明是内容资产、迭代频繁且需独立回滚，故选定 **decoupled**；
同时保留 coupled 作为 `builds.mode` 策略变体并由同一套屏障强制其 git_ref 一致性。

## 失败只阻断候选
屏障失败时：构建置 `rejected`、版本退回 `draft`、**绝不写 releases**。
正在被访问的稳定版指针与静态制品保持不变，读者无感。
