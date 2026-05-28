# 页面探索与操作经验

## 操作节奏
```
snapshot → 分析 YAML 树 → 操作 → 再次 snapshot 确认
```
每次操作后必须 snapshot 确认状态，不要假设操作成功。

## 快照使用要点
- `viewportOnly` 默认 false（否则 Drawer/Modal 动画中内容在视口外被过滤）
- `boxes` 默认 true（获取位置，用于坐标点击）
- 用 `textIncludes` + `roles` 快速定位元素
- **无 ARIA role 的元素不会以 button/option/link 等角色出现**，而是降级为 `generic`。搜索时不能只看特定 role，也要搜 `generic` + `[cursor=pointer]`
- 状态过渡期可能读到 `x=-9999, w=0` 的中间态（Portal 定位未完成），等待后重试

## 点击操作
- 有 @e ref → `click {target}`（最可靠）
- 无 @e ref 但有 box → `click_text {text, x, y}`（坐标消歧义，选距离最近的可见文本匹配；需扩展支持 cdp_click_at）
- @e ref 在导航/插件刷新后会失效，**每次操作前先 snapshot** 重新分配

## Portal/Overlay 组件
- 下拉框、弹窗、浮层通常渲染在 Portal 中（脱离主 DOM 树），可能不在可访问性树中，或位置在视口外
- 多个同类浮层（如下拉选项）可能共享同一个 DOM 容器，需要用 visible/hidden 状态区分哪些是当前可见的

## evaluate 使用限制
- 复杂多行脚本易被 CSP 阻止（站点无 `unsafe-eval`），简单单行表达式也可能被拦，**不可靠**
- 无 `return` 时语句模式不返回值，必须显式加 `return`
- **优先使用原始指令（click/fill/press 等）组合操作**，不要用 evaluate 批量执行——每条指令经过验证、错误处理，比 evaluate 更可靠
- evaluate 只在 snapshot 信息不足以决策时用于查 DOM 辅助诊断，不作为操作手段

## 通用原则
1. 先 snapshot 确认页面状态，再操作
2. @e ref 是脆弱的——导航、刷新、插件重载都会使其失效
3. 等待是必须的——React 渲染、API 请求、Portal 定位都需要时间
4. 失败时先检查 ref 是否过期、弹窗是否打开、页面是否加载完，不要盲目重试
