# 发布屏障（兼容性检查与发布屏障）

| # | 门 | 失败条件 | 证据 |
|---|---|---|---|
| 1 | references-resolve | 组件/素材/来源/段落引用无法解析 | missing 列表 |
| 2 | docs-before-components | draft 组件未标 planned，或已上线仍 planned | badOrder |
| 3 | no-draft-leak | 候选渲染内嵌其他草稿标记 | draftCount |
| 4 | reference-cycle | 组件依赖图有环 | 环路径 |
| 5 | links-valid | 内部锚点缺失；外部链接 4xx/5xx | broken/warned |
| 6 | image-ratio | 截图/素材实际尺寸与记录不符、文件丢失 | ratioBad |
| 7 | breakpoint-coverage | 任一组件缺 360/768/1280 截图 | missingBp |
| 8 | screenshots-fresh | 组件改名/源码/令牌变更后旧截图当现状 | stale |
| 9 | contract-compatible | decoupled: API 契约版本不符；coupled: git_ref 不符 | expected/actual |
| 10 | candidate-state | 版本不在 candidate 状态 | status |
| — | screenshot-generation | 任一组件×断点截图生成失败 | failSet |

所有门都是 `hard`：任一失败 → 构建 `rejected`、版本回退 `draft`、不触碰 `releases`。
外部链接检查器可注入（测试里返回确定性结果）；默认实现网络不可达时降级为 warning，明确 4xx/5xx 才判失败。
