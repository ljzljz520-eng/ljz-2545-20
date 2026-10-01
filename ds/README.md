# 智慧学习平台 · 全栈版本化站内设计说明

把《设计说明书.md》从一份静态文档，建设为**全栈、版本化、带发布屏障**的设计说明系统：

- **前端展示**：主题定位、信息结构、响应式样例（桌面/平板/手机三断点）、设计决策与组件引用、历史版本切换。
- **内容 API**：设计决策（定位/原创素材/色彩/可访问交互/验收）、组件版本与引用关系、构建、发布尝试、审计日志。
- **SQL 持久化**：SQLite（`data/app.sqlite`）保存说明版本、组件版本、截图指纹、引用图、站点构建与发布记录。
- **发布屏障**：每次候选发布实际运行 10 道闸，任一失败只否决该候选；live 指针在单个事务内切换，失败整体回滚，**正在访问的稳定版永不被覆盖**。

## 一、运行

```bash
cd ds
npm install
node server/seed.js --force      # 建立站点构建快照 + 稳定 v1（含 5 组件/15 截图/11 决策）
npm start                        # http://localhost:4100
# 公开页：  http://localhost:4100/app/
# 编辑后台：http://localhost:4100/app/admin.html   令牌默认 dev-editor-token（DS_ADMIN_TOKEN 可改）
npm run deliver                  # 实际运行全部交付验收（38 项断言），非 0 退出码阻断交付
```

环境变量：`DS_PORT`(默认4100)、`DS_ADMIN_TOKEN`、`DS_DB_FILE`、`DS_SCREENSHOT_FAIL=1`（同进程注入截图故障）。

## 二、发布模式：文档随代码发布 vs 独立内容发布

| 维度 | 文档随代码发布（docs-as-code） | 独立内容发布（headless CMS/内容库） |
|---|---|---|
| 发布单元 | 代码+文档同一制品，回滚同进退 | 内容独立版本化，随时发布不碰代码 |
| 节奏 | 受发版窗口约束 | 编辑自主，分钟级 |
| 一致性风险 | 理论上最高（同制品） | 内容可能引用已改名组件/已变令牌/已撤回构建 |
| 回滚 | 与代码耦合，改文档要走 CI | 可按内容版本独立回滚 |
| 草稿/并发 | 依赖分支/MR | 原生草稿、etag 乐观锁、审计 |

**选定：独立内容发布**（本系统即该模式），理由是设计说明是高频编辑内容、需要草稿/审计/历史回看，且不应被代码发版节奏绑死。
为弥补其一致性短板，在内容发布屏障中强制做**对最新站点构建的兼容检查**（G1/G2/G4/G8），即：内容独立走，但放行前必须与“文档随代码发布”一侧最新的**未撤回构建快照**对齐。两种思路的取舍都落到本文件与系统内决策 `D-05` 式记录中（审计表 `audit_log`、发布尝试表 `release_attempts` 可查）。

## 三、数据模型（SQLite，见 server/db.js）

- `docs / doc_versions`：说明文档与不可变版本（draft → published → archived）。
- `decisions(kind)`：`positioning / source / color / a11y / acceptance / general`，每条可绑定 `page_path + target_selector`。
- `components / component_versions`：组件版本捕获**当时的名字与令牌值**；改名/换令牌都会产生新版本。
- `screenshots`：内容寻址截图，`fingerprint = sha1(组件名|令牌名|令牌值|断点宽|属性)`，存实际文件宽高。
- `refs`：决策→决策、组件版本→决策的引用图（供 G5 环检测）。
- `builds`：站点源码快照 + 从真实 `css/style.css` 解析的令牌与 `@media` 断点；可撤回。
- `release_attempts`：每次发布的逐闸结果；`promotions`：发布/回滚历史。

## 四、发布屏障（server/gates.js，每次候选独立实跑）

| 闸 | 作用 |
|---|---|
| G1 build-active | 对照构建未撤回 |
| G2 token-compat | 候选引用的令牌值 == 构建内 `css/style.css :root` 真实值 |
| G3 links | 正文/样例/决策中的站内页面、截图、锚点链接全部可解析（外发校验 http(s)/mailto 格式） |
| G4 page-binding | 原创素材/色彩/可访问交互说明必须绑定构建中**真实存在**的页面与元素 |
| G5 no-ref-cycle | 决策/组件引用图 DFS 无环 |
| G6 shots-fresh | 截图指纹 = 当前组件名+令牌+断点+属性；**改名或令牌变化后旧截图立即失配，不得当现状** |
| G7 image-ratio | 读取截图文件实际宽高，与 DB 声明宽高比逐张比对 |
| G8 breakpoints | 样例必须覆盖构建 CSS 关键断点（桌面 + ≤768 平板 + ≤480 手机） |
| G9 acceptance-first | 组件须为 accepted 且验收决策创建时间早于组件版本（禁止先上线后补验收） |
| G10 base-lineage | 候选必须基于当前 live 版（两编辑并发基于旧版时拒绝） |

屏障在一个串行写事务里执行：失败 → 记录 `rejected` 并 `ROLLBACK`；成功 → 原子更新 live、归档旧版、写 promotion。

## 五、关键机制如何对应需求

- **原创素材来源/色彩/可访问交互关联实际页面**：这些 kind 的决策必须有 `page_path+target_selector`，G4 在构建快照里验证元素真实存在；公开页一键跳到 `/site/<build>/<page>` 对应页面。
- **改名/令牌变化不过期截图**：G6 指纹（组件名+令牌+断点+属性）+ G7 实际比例双保险；后台“重新截图”按现状重渲染后才能通过。
- **截图生成失败**：截图与组件版本在同一事务，渲染器抛错则组件版本整体回滚（`ScreenshotError`），可经请求头 `x-inject-screenshot-fail:1` 注入验证。
- **两编辑冲突**：草稿携带 etag，保存走 `If-Match`，后保存方收到 409 且不覆盖先保存内容。
- **构建撤回**：撤回只阻止新候选（G1），旧稳定版与 `/site/<旧构建>` 快照继续 200 服务；可改对照未撤回构建恢复发布。
- **历史版本**：公开版本下拉列出全部 published/archived，读者可只读查看当时决策与当时截图；草稿在所有公开接口 404，绝不列出。
- **回滚**：激活历史 promotion 并把 live 指针切回，记录一次 rolled_back 尝试。

## 六、交付检查（实际运行，不是手工清单）

`npm run deliver`（tools/deliver.js）对运行中的服务跑九组场景并断言：
A 验收先于组件、B 引用环、C 截图失败回滚、D 两编辑冲突、E 改名/令牌后过期截图、
F 构建撤回稳定版不挂、G 历史版本+草稿隔离、H 链接/比例/断点、I 全绿发布+归档+回滚。
另外用真实 headless Chromium 校验公开页/后台渲染、0 JS 错误、图片 naturalWidth 与声明一致、375px 无横向溢出。

## 七、目录

```
ds/
├─ server/  db.js(事务/SQL) render.js(组件视觉内核+指纹) builds.js(快照/解析)
│          screenshots.js(内容寻址截图) gates.js(10闸) seed.js index.js(API)
├─ web/     index.html(公开版本页) admin.html(编辑后台)
├─ tools/   deliver.js(交付验收，实际运行)
├─ data/    app.sqlite + snapshots/<build>/（gitignore）
└─ screenshots/ cv<组件版本>-<断点>.svg（gitignore，由组件版本重建）
```

渲染器说明：截图引擎内置 SVG 渲染器（与 `/api/preview/component/:id` 预览同源，保证“所见即所截”）；
环境若有 Chromium 可在 `screenshots.js` 后接同一 `render.html` 模型生成位图，指纹/比例规则不变。
