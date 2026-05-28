# Browser Control 项目综合审查报告

## 项目概述

Browser Control 是一个三层架构的浏览器自动化工具，专为 LLM Agent 设计：

```
LLM Agent ↔ HTTP Daemon (localhost:10087) ↔ WebSocket ↔ Chrome Extension ↔ Chrome DOM
```

提供 MCP Server 和 CLI 两种接入方式，当前定义 24 个协议命令，通过单一 MCP 工具 `browser_control_command` 统一入口暴露。

---

## 一、MCP 工具架构设计问题

### 1. [P0] 统一入口工具的 args schema 对 LLM 完全不可见

**文件**: `src/mcp/schema.ts:179-183`

```typescript
export const unifiedCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.record(z.string(), z.unknown()),  // ← 完全无类型
  ...envelopeSchema
}).strict();
```

项目已经为每个命令编写了详细的 Zod schema（`commandArgSchemas` 包含 24 个命令的完整定义），但这些 schema **在 MCP 工具层面对 LLM 完全不可见**。LLM 看到的 tool schema 只是 `args: Record<string, unknown>` —— 一个黑盒。

**影响**：
- LLM 无法通过 schema 自省得知每个命令需要什么参数、什么类型、什么枚举值
- 所有参数知识完全依赖 prompt 文本（`prompts.ts` 里的命令参考），prompt 随时可能被截断或被 LLM 忽略
- Schema 验证被推迟到运行时，而非在 tool call 构造阶段就捕获错误
- 无法使用 MCP tool annotations（`destructiveHint`、`readOnlyHint`）做逐命令标注

**建议**：将 `args` 从 `z.record` 改为 `z.discriminatedUnion`，或拆分为多个工具（详见第二节）。至少应对 `command` 字段使用 `z.enum(COMMAND_NAMES)` 而非 `z.string()`。

### 2. [P0] browser_control_command 工具描述没有列出可用命令

**文件**: `src/mcp/tools.ts:98-106`

```typescript
description: [
  'Run any Browser Control protocol command.',
  'Input: command, optional args object...',
  ...
].join('\n\n'),
```

描述没有告诉 LLM 有哪些命令可用。命令列表在 prompt 中，而 prompt 需要主动调用，形成**鸡与蛋的问题**：LLM 不知道有什么命令 → 无法正确使用工具 → 不知道要调用 prompt 获取命令列表。

### 3. [P0] MCP Prompts 属于被动触发，关键使用指南无法保证送达 LLM

**文件**: `src/mcp/prompts.ts`

`browser_control_usage`、`browser_control_command_reference`、`browser_control_safety` 三个 prompt 需要 LLM 主动调用才能获取，不会自动注入对话上下文。大多数 LLM agent 框架不会主动调用 MCP prompts，导致 LLM 只有 4 个工具描述，拿不到：
- 命令调用格式与参数详细说明
- @e ref 生命周期规则
- 安全边界与确认要求

工具描述中也没有提示 LLM 去主动获取这些 prompts。

### 4. [P1] 缺少用户确认拦截机制

**文件**: `src/mcp/prompts.ts:121`, `src/mcp/risk-notes.ts`

`browser_control_safety` prompt 告诉 LLM "Ask the user before sensitive actions"，但整个系统**没有任何机制让 LLM 真正暂停并等待用户确认**。MCP 协议中无 confirmation callback，`risk-notes.ts` 中反复写 "The MCP server does not perform user confirmation"。安全边界完全依赖 LLM 自觉遵守提示词，不可靠。

**建议**：在 MCP 层对敏感命令（click、fill、evaluate、upload）增加 confirmation tool 或 sampling 机制，或至少在 tool annotation 中标记 `destructiveHint: true`。

### 5. [P1] 建议按功能域拆分工具

当前 24 个命令通过单一入口暴露，建议按功能域分为 5-7 个工具：

| 工具名 | 包含命令 | annotation |
|--------|---------|-----------|
| `browser_navigate` | navigate, find_tab, list_tabs, close_tab | `openWorldHint: true` |
| `browser_observe` | snapshot, get_text, screenshot, wait_for | `readOnlyHint: true` |
| `browser_interact` | click, fill, press, scroll, upload | `destructiveHint: true` |
| `browser_network` | network_start, network_list, network_detail, network_stop | `readOnlyHint: true` |
| `browser_capture` | screenshot, save_as_pdf, download | — |
| `browser_evaluate` | evaluate | `destructiveHint: true` |
| `browser_session` | close_session, status, doctor | — |

每个分组工具内部用 `z.discriminatedUnion` 按 command 字段区分，使各命令的 typed schema 在 tool definition 中可见。

---

## 二、命令冗余分析（24 → 14）

### 6. [P1] click + click_probe 功能重叠，应合并

| 维度 | click | click_probe |
|------|-------|------------|
| 核心动作 | 点击元素 | 点击元素 |
| 网络捕获 | 自动 700ms 窗口，仅 URL | 可配置 filter/includeBody/includeHeaders |
| force | 无 | 有 |
| button | 无 | left/middle/right |
| 新标签页检测 | 无 | observeNewTab/expectNewTab |

`click` 已经做了网络捕获（简化版），`click_probe` 是 `click` 的超集。LLM 面对两个"点击"命令会困惑。

**建议**：合并为一个 `click`，网络捕获参数设为可选。不传 filter/includeBody 时行为等同于当前的轻量 click。

### 7. [P1] observe_start/observe_diff 与 snapshot diff_to 功能重叠，应合并

系统有**两套 diff 机制**：
- **observe 系列**：建立文本基线 → 执行动作 → 对比文本变化
- **snapshot diff_to**：DOM 结构级 diff

两者都回答"页面发生了什么变化？"，但机制不同（文本 diff vs 结构 diff），LLM 不知道该用哪个。提示词中平等描述，没有说明适用场景区别。

**建议**：合并进 `snapshot`。snapshot 本身已自动生成 baselineId，只需增加 `diff_mode: 'text' | 'structure'` 参数。

### 8. [P2] find_tab + list_tabs + close_tab 可合并为 tabs

`find_tab` 本质是带筛选条件的 `list_tabs`。三个标签页操作可合并为一个 `tabs` 命令，通过 action 参数区分 list/find/close。

### 9. [P2] screenshot + save_as_pdf 可合并为 capture

两者都是"页面视觉导出"，区别仅在输出格式。可合并为 `capture { format: 'png' | 'jpeg' | 'pdf' }`，PDF 特有参数在 format='pdf' 时生效。

### 10. [P2] network_start/list/detail/stop 4 个命令可精简

4 个命令过于碎片化，建议合并为 2-3 个：
- `network_capture { action: 'start' | 'stop', filter?, scope? }` — 控制捕获生命周期
- `network_query { requestId?, filter?, limit? }` — 有 requestId 时返回详情，否则返回列表

### 精简后的命令集（24 → 14）

| # | 命令 | 合并来源 | 说明 |
|---|------|---------|------|
| 1 | `navigate` | — | 导航到 URL |
| 2 | `tabs` | list_tabs + find_tab + close_tab | 标签页管理 |
| 3 | `snapshot` | snapshot + observe_start + observe_diff | 页面快照 + diff |
| 4 | `get_text` | — | 纯文本提取 |
| 5 | `click` | click + click_probe | 点击 + 可选网络捕获 |
| 6 | `fill` | — | 表单填写 |
| 7 | `press` | — | 键盘操作 |
| 8 | `scroll` | — | 滚动 |
| 9 | `wait_for` | — | 等待条件 |
| 10 | `capture` | screenshot + save_as_pdf | 视觉导出 |
| 11 | `evaluate` | — | 执行 JS |
| 12 | `network` | network_start/list/detail/stop | 网络监控 |
| 13 | `upload` | — | 文件上传 |
| 14 | `download` | — | 文件下载 |

---

## 三、功能设计问题

### 11. [P0] fill 的 summary 明文暴露填入内容（安全问题）

**文件**: `src/controller/commands/fill.ts:109`

```typescript
summary: `已填写元素 ${target} | 输入内容: ${value}`
```

把填入的内容（可能是密码、API key、银行卡号）原文写入 `CommandResult.summary`，然后由 `toCommandToolResult` 输出到 `content[0].text`，进入 MCP 工具调用结果、对话历史、日志中。而 extension 的 `isSensitiveField` 对密码字段做了 `[redacted]` 处理，这里却完全暴露，形成安全矛盾。

### 12. [P0] observe_start/observe_diff Controller 层 validKeys 与 MCP schema 不同步（功能性 Bug）

**文件**: `src/controller/commands/observe.ts:80, 147`

observe_start 的 validKeys：
```typescript
const validKeys = ['tabId', 'mode', 'baselineId'];
```
但 `schema.ts` 中还允许 `includeNetworkMarker`, `maxTextChars`, `maxTextRuns`。

observe_diff 的 validKeys：
```typescript
const validKeys = ['baselineId', 'tabId', 'includeNetwork', 'maxAdded', 'maxRemoved'];
```
但 `schema.ts` 中还允许 `includeCurrent`, `maxSummaryChars`, `allowStaleNavigationDiff`。

**结果**：LLM 传入这些 schema 合法参数时，Controller 直接报错"未知参数"。提示词中的示例 `{"command":"observe_start","args":{"includeNetworkMarker":true}}` 实际会触发错误。

### 13. [P1] click 命令行为"过载"，语义不清晰

**文件**: `src/controller/commands/click.ts`

click 同时承担三件事：
1. 点击元素（核心功能）
2. 700ms 内自动捕获触发的网络请求（隐性行为）
3. 自动创建 `observationBaselineId`（隐性副作用）

**问题**：
- 网络捕获时间窗口 700ms 对慢速 SPA 可能不够
- 当 click 没有触发网络请求时，`network` 字段为 `undefined`，LLM 无法区分"没有请求"和"请求在时间窗外"
- 隐性副作用增加了理解成本

### 14. [P1] 缺少"等待页面稳定"的统一策略

- `click` 后自动等待 700ms（硬编码）
- `navigate` 等待 `tab.status === 'complete'`，但 SPA 可能永远不会到 complete
- `fill` 后没有等待验证
- 没有类似 Playwright 的 "networkidle" 或 "domcontentloaded" 策略

**建议**：提供可配置的 settle 策略。

### 15. [P2] snapshot stats.refs 数量是过滤前的值，与实际返回不一致

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:90-92`

```typescript
if (childAriaNode.ref)
  stats.refs += 1;   // 过滤前计数
```

而 `rendered.refs` 在 `renderTree` 中只收集通过过滤的节点。Controller 层 `countElements` 优先使用 `refs.length`（正确），但返回数据中的 `stats.refs` 字段与 `refs.length` 不一致，LLM 解读 stats 会得到错误印象。

### 16. [P2] snapshot Controller 层的 SnapshotData.tree 字段名与内容类型冲突

**文件**: `src/controller/commands/snapshot.ts:67`

注释说 tree 是 YAML 格式字符串：
```typescript
/** 页面可访问性树（YAML 格式字符串） */
tree: string;
```

但 daemon 返回的结构中有两个字段：`snapshot`（YAML 字符串）和 `tree`（JSON 对象数组）。Controller 的 `extractTree` 读取 `raw.snapshot`，然后赋值给 `SnapshotData.tree`（字段名是 tree，内容是 YAML）。命名混乱，语义对应关系不直观。

### 17. [P2] WebSocket 和 Service Worker 网络请求不可见

`network-cdp.ts` 只捕获 HTTP(S) 请求，不捕获 WebSocket frame 和 Service Worker 发起的请求。现代 SPA 大量使用 WebSocket 做实时通信，LLM 无法观测这些交互。

### 18. [P3] 缺少 `<select multiple>` 和日期选择器支持

`fill.ts` 对 `<select>` 只做 `.value` 赋值，不支持多选；对 `input[type=date/time/color]` 用直接赋值而非触发原生选择器。

### 19. [P3] cdp_click_at 在 schema.ts 中存在但在 CONTROLLER_DISPATCH 中无实现

**文件**: `src/mcp/schema.ts:64-71`, `src/mcp/tools.ts`

schema.ts 有 `cdp_click_at` 命令的 schema 定义，但 `CONTROLLER_DISPATCH` 中没有对应条目，也没有对应的 Controller 实现文件。`assertSchemaRegistryMatchesProtocol()` 应该会发现 drift 并抛出错误。

---

## 四、代码逻辑实现问题

### 20. [P0] contracts.ts 与 protocol.ts 定义不一致

| 字段 | contracts.ts | protocol.ts | 状态 |
|------|-------------|-------------|------|
| `click.after` | 已定义 `ClickAfter` 类型 | **未验证**，会被拒绝为未知参数 | 不一致 |
| `click.baseline` | 已定义 | **未验证**，会被拒绝为未知参数 | 不一致 |
| `snapshot.baseline` | 参数名 `baseline` | 参数名 `diff_to` | **命名冲突** |
| `cdp_click_at` | **未定义** | 有验证规则 | 不一致 |

contracts.ts 定义了 `click.after` 和 `click.baseline`，但 protocol.ts 验证时会拒绝它们为未知参数（line 226 报错 "click now accepts only args.target and optional args.tabId"）。

### 21. [P0] Extension CommandAction 与 contracts CommandName 词汇不同

**文件**: `src/extension/shared/types.ts`, `contracts.ts`

Extension 内部使用 `observe_capture`、`network`（聚合）、`attach_tab` 等命令名，与 contracts.ts 公开的 `observe_start`/`observe_diff`、`network_start`/`network_list` 等不对应。`attach_tab` 在 `protocol.ts:153` 有特殊处理但未列入公开命令列表。

### 22. [P0] Daemon HTTP 请求体无大小限制

**文件**: `src/daemon/server.ts:281-293`

`parseJsonBody` 无 body size limit，攻击者可发送超大 payload 导致内存耗尽。

**修复**：增加 `if (bodySize > MAX_BODY_SIZE) reject()`。

### 23. [P0] fill.ts validate 没有过滤未知键，静默透传风险

**文件**: `src/controller/commands/fill.ts`

snapshot.ts、observe.ts 等都有显式的 `validKeys` 检查，fill.ts 没有：
```typescript
validate: (args) => {
  // 只检查 target 和 value，其余未知键被透传给 daemon
  return args as unknown as FillInput;
},
```

LLM 传入拼写错误的参数（如 `comit` 而非 `commit`），不会报错，参数被静默忽略，行为不符合预期。

### 24. [P0] fill.ts toResult 依赖 daemon 回显 target/value，回显缺失时 summary 为空

**文件**: `src/controller/commands/fill.ts`

```typescript
const target = String(rawData.target || '');  // 依赖 daemon 回显
const value = String(rawData.value || '');    // 依赖 daemon 回显
```

如果 daemon 不回显这两个字段，summary 会变为 `"已填写元素  | 输入内容: "`（两个空字符串），且无法确认实际填入了什么。

### 25. [P1] Session 内存永不清理

**文件**: `src/daemon/server.ts:71`

`sessions` Map 只增不减。即使 session 关闭，也只清理其 observation baselines，不删除 session 条目。长时间运行的 daemon 会内存泄漏。

### 26. [P1] WebSocket 重连后 pending requests 未清理

**文件**: `src/daemon/server.ts:1140-1144`

新 WebSocket 连接到来时关闭旧连接，但旧连接上的 `pendingRequests` 未被 reject，这些请求会永远挂起直到超时。

`transport.ts:146-169` 中 pending request 也存在泄漏风险——超时清理后如果回调还是触发了，会操作已删除的条目。`pendingRequests` Map 无内存上限，可无界增长。

### 27. [P1] WebSocket ensureConnected 虚假成功

**文件**: `src/extension/service-worker/transport.ts:120-123`

在 10s 超时后 resolve（而非 reject），即使连接未建立。调用方误认为已连接，后续 send 静默失败（line 139）。

### 28. [P1] observe_start 返回值未校验即使用

**文件**: `src/daemon/server.ts:776-797`

`runActionWithObservation` 直接使用 `start.data.baselineId` 而不检查 `observe_start` 是否成功。如果 baseline 保存失败，后续 diff 会用不存在的 ID，产生误导性错误。

### 29. [P1] Daemon 启动锁竞争导致双进程启动

**文件**: `src/daemon/process-manager.ts:91-100`

启动锁机制有 TOCTOU 竞争：两个进程同时启动时，锁等待超时后递归调用 `startDaemonProcess`，可能同时在同端口启动两个 daemon 导致 EADDRINUSE。

### 30. [P1] Daemon 崩溃后 MCP 会话内不自动重启

**文件**: `src/mcp/daemon-lifecycle.ts:69-107`

如果 daemon 在 MCP tool 首次调用成功后崩溃，后续命令不会重新调用 `ensureDaemon()`，而是直接报 "Extension not connected" 错误。

**修复**：在每次命令执行前增加 daemon 健康检查或在连接错误时自动触发重启。

### 31. [P2] isSensitiveField 正则误报导致内容被 [redacted]

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:849`

```
/pass(word)?|token|secret|api[-_\s]?key|auth|credential|session|cookie|csrf|jwt|bearer|private|access[-_\s]?key/i
```

`auth` 这个短字符串会匹配所有包含 "auth" 的字段，包括 `author`、`authorName`、`authentication_method`、`oauth` 等正常文本输入框。这些字段的值被脱敏为 `[redacted]`，LLM 看不到内容，可能错误判断页面状态。

### 32. [P2] structuralPath 最大深度为 10，深层 DOM 中 structureId 可能碰撞

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:1075`

```typescript
while (current && ... && depth < 10) {
```

深层嵌套 DOM（如多层 `<div>` 容器下的表单元素），超出深度 10 的不同元素会生成相同路径前缀，`hashString` 结果相同，`structureId` 碰撞，可能导致两个不同元素被分配同一个 `@e` ref，click 时行为不可预期。

### 33. [P2] allReachableElements 在每次 ref 解析时做全 DOM 线性扫描

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:1158-1179`

```typescript
function allReachableElements(): Element[] {
  // 每次扫描最多 10000 个 DOM 节点
}
function findByAttribute(name, value) {
  for (const el of allReachableElements()) { ... }
}
```

`resolve(ref)` 调用 `findByAttribute('data-agent-id', ref)`，即每次 click/fill/press 都需要线性扫描最多 10000 个节点。应改用 `document.querySelector('[data-agent-id="..."]')` 利用浏览器属性索引优化。

### 34. [P2] snapshot Controller validate 没有验证布尔参数类型

**文件**: `src/controller/commands/snapshot.ts:114-137`

有完整的 `validKeys` 检查和部分类型检查，但 `boxes`、`hasVisibleText`、`viewportOnly` 没有 `typeof` 验证。LLM 传入 `boxes: "true"` 或 `viewportOnly: 1` 会通过 validate，但 extension 端使用严格相等 `options?.boxes === true` 时可能不匹配。

### 35. [P2] press 命令缺少未知参数验证

**文件**: `src/controller/commands/press.ts:50-56`

与 snapshot、wait-for 等命令不同，press 没有 `validKeys` 检查。LLM 传入拼写错误的参数（如 `modifyers` 而非 `modifiers`）会被静默忽略。

### 36. [P2] wait_for 未验证至少提供 selector 或 text 之一

**文件**: `src/controller/commands/wait-for.ts:47-74`

`selector` 和 `text` 都是可选的，但逻辑上至少需要提供一个。两者都不传时会发送无意义请求到 daemon。

### 37. [P2] scroll 未验证至少提供 deltaX 或 deltaY 之一

**文件**: `src/controller/commands/scroll.ts:62-73`

两者都不传时命令会到达 daemon 但不产生任何效果，浪费一次往返。也没有滚动距离的范围校验。

### 38. [P2] tabs.ts 中 tabId === 0 的类型强转问题

**文件**: `src/controller/commands/tabs.ts:194, 250`

```typescript
const tabId = Number(rawData.tabId) || undefined;  // Line 194: tabId=0 → undefined
const tabId = Number(rawData.tabId) || 0;           // Line 250: tabId=0 → 0 (正确)
```

Line 194 对 `tabId === 0` 的处理错误：`Number(0) || undefined` 返回 `undefined`。

### 39. [P2] network 命令错误处理不一致

**文件**: `src/controller/commands/network.ts:144, 352`

```typescript
// network_start: undefined 视为成功
const started = rawData.started === true || rawData.started === undefined;
// network_stop: undefined 视为成功
const stopped = rawData.stopped !== false;
```

对 daemon 默认值的假设不一致，可能掩盖真实失败。

### 40. [P2] Artifact 文件写入非原子操作

**文件**: `src/daemon/artifact-store.ts:54-66`

使用 `fs.writeFileSync` 直接写目标路径。写入过程中 daemon 崩溃会留下不完整文件，且无清理机制。应使用 write-to-temp + rename 原子写入。

### 41. [P2] snapshot-diff 只比较 text，忽略 state 变化

**文件**: `src/shared/snapshot-diff.ts`

只比较节点的 `text` 属性，忽略 `state`（checkbox 选中状态、input 值）和 `attributes` 变化。checkbox 从未选中变为选中不会被检测为变化。深度限制 20 层，超出后静默截断，不通知调用方。

### 42. [P2] WebSocket 重连策略不健壮

**文件**: `src/extension/service-worker/transport.ts:97-104`

- 指数退避在连接成功后未正确重置
- 无 jitter，多实例同时重连会造成 thundering herd
- Keep-alive 间隔固定 30s，无 ping 超时检测服务端不可达

### 43. [P2] Runner toResult 异常时丢失原始数据

**文件**: `src/controller/runner.ts:108-117`

```typescript
catch (err: unknown) {
  return {
    ok: false,
    summary: `结果转换失败: ${message}`,
    nextSteps: ['这是一个内部错误，请联系开发者'],
  };
}
```

不包含命令名，也不保留原始 `raw` 数据，LLM 失去调试信息。

### 44. [P3] normalizeGenericRoles 展开条件过于激进

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:333`

```typescript
const removeSelf = node.role === 'generic' && !node.name && children.length <= 1
  && children.every(child => typeof child !== 'string' && Boolean(child.ref));
```

对某些嵌套了多个具名容器层的复杂组件（如 Ant Design Form.Item），这种展开可能破坏快照的层级结构。

### 45. [P3] strategy 和枚举字段无运行时校验

**文件**: `src/protocol.ts:168-198`

`validateRequest()` 只检查参数的存在性和基本类型，不校验枚举值。`fill { strategy: 'invalid' }` 会通过验证，到执行时才报错。

### 46. [P3] 字符串强转模式不一致

多个命令使用 `String(value || '')` 的模式：
- `String(undefined)` 返回 `"undefined"` 字符串（非预期）
- `String(value || '')` 更安全但各命令用法不一致
- 应统一使用 `String(rawData.title ?? '')`

---

## 五、安全问题

### 47. [P0] evaluate 命令无限制执行任意 JS

**文件**: `src/controller/commands/evaluate.ts:41-54`

只验证 code 是非空字符串，无：
- 代码长度限制（可构造 DoS）
- 执行超时（死循环会阻塞 extension service worker）
- 沙箱隔离（可访问所有页面全局变量、cookies、localStorage）
- `risk-notes.ts:6` 有风险提示文本，但无实际技术防护

### 48. [P0] navigate 未拦截危险 URL 协议

**文件**: `src/controller/commands/navigate.ts:50-59`

使用 Zod schema 验证但不检查 URL 协议：
- `javascript:` — 执行任意代码
- `data:` — 可构造 XSS payload
- `file:///` — 暴露本地文件系统

**修复**：增加 protocol whitelist（http、https）。

### 49. [P1] upload 未验证路径安全

**文件**: `src/controller/commands/upload.ts:68-93`

不验证文件路径是否为绝对路径（尽管注释说"文件绝对路径"），也不检查路径遍历（`../../../etc/passwd`），不检查文件是否存在，无文件大小限制。

### 50. [P1] 网络捕获中的敏感数据持久化未加密

**文件**: `src/extension/service-worker/handlers/network-cdp.ts:114-158`

将捕获的网络请求（可能包含 auth token、cookies）通过 `chrome.storage.local` 持久化，无加密、无过期清理。

### 51. [P1] Debugger 会话未隔离

**文件**: `src/extension/service-worker/handlers/network-cdp.ts:399-442`

`acquireActionDebugger()` 无身份验证，多客户端可共享 debugger 会话，无 origin/extension ID 验证。

### 52. [P2] browser_control_safety 缺少 navigate 的风险说明

**文件**: `src/mcp/risk-notes.ts`

`RISK_NOTES` 没有 navigate 条目，但 navigate 会销毁所有当前页面的 @e refs、可能触发 beforeunload 事件、导航到用户不期望的 URL。对 agent 自主执行的任务（如自动化填表），不经确认的 navigate 是高风险操作。

### 53. [P2] 网络请求敏感头部脱敏不完整

**文件**: `src/extension/service-worker/handlers/network-cdp.ts:497-528`

`SENSITIVE_FIELD_PATTERN` 检查字段名但不检查值。自定义 header 可能包含敏感数据。URL 中的 query parameter（如 API key）也未脱敏。

### 54. [P3] Element ref 正则过于宽松

**文件**: `src/controller/commands/click.ts:41`

```typescript
const ELEMENT_REF_RE = /^@e[^\s_]+_\d+$/;
```

`[^\s_]+` 允许几乎任何字符。应限制为 `[a-z0-9]+`，避免 malformed ref 导致意外行为。

### 55. [P3] risk-notes 信息重复冗余

**文件**: `src/mcp/risk-notes.ts`

每个条目都重复 "The MCP server does not perform user confirmation"，增加 token 消耗但无新增信息。应提取为一次性说明。

---

## 六、提示词问题

### 56. [P1] @e ref "prefer the highest revision" 表述容易被误解

**文件**: `src/mcp/prompts.ts:38`

```
The _<revision> suffix increments to indicate staleness — prefer the highest revision.
```

本意是"如果同一元素有多个版本，用最新的"，但 LLM 可能理解为"在当前快照的所有 @e ref 中，优先选 revision 数字最大的"。ref 是每个元素独立的，不同元素之间的 revision 数字没有可比性。

### 57. [P1] 提示词示例中的 includeNetworkMarker 参数实际无效

**文件**: `src/mcp/prompts.ts:102`

```json
{"command":"observe_start","args":{"includeNetworkMarker":true}}
```

Controller 的 validKeys 中没有 `includeNetworkMarker`（Bug #12），这个示例调用会报错"未知参数"。LLM 会反复尝试该调用并困惑于错误原因。

### 58. [P1] element ref 生命周期说明不充分

**文件**: `src/mcp/prompts.ts:38`

说 "references become stale when the page navigates or the DOM updates"，但：
- 没有说明什么程度的 DOM 更新会导致失效（checkbox 勾选？文本变化？）
- `_revision` 后缀的含义和递增规则不明确
- 没有告诉 LLM ref 失效后会返回什么错误码（`STALE_ELEMENT_REFERENCE`）、应该如何恢复
- snapshot.ts 中 ref fingerprint 包含 `aria-checked` 和 `aria-selected`（volatile 状态，line 1108-1109），导致 quick DOM mutation 也会使 ref 失效

### 59. [P2] 使用指引缺乏错误恢复策略

**文件**: `src/mcp/prompts.ts:19-41`

`browser_control_usage` prompt 只描述成功路径，未覆盖：
- ref 失效时如何恢复
- 命令超时后应该做什么
- 扩展断连时如何诊断
- fill 后值未填入时的替代策略

### 60. [P2] 观察机制缺少场景对照

`browser_control_usage` 提到 3 种观察方式但没有场景对照：

| 需求 | 推荐方式 | 提示词中是否说明 |
|------|---------|----------------|
| 检测 DOM 新增元素（如弹窗） | snapshot diff_to | 否 |
| 检测内容文字变化（如状态更新） | observe_start/diff | 否 |
| 验证 API 是否被调用 | click_probe 或 network_* | 否 |

LLM 必须自行推断，容易选错工具。

### 61. [P2] get_text 的 scope 区别说明不够直观

**文件**: `src/mcp/prompts.ts:81`

```
"viewport" (default, viewport visible text), "document" (legacy body.innerText),
"full" (rendered layout text, filters hidden/zero-size/off-layout)
```

viewport 和 full 的区别描述对 LLM 不够清晰。LLM 通常会默认选 full 认为它最完整，但 full 实际过滤掉 hidden/zero-size 元素，可能遗漏动态隐藏内容。

### 62. [P2] click_probe filter 参数是 URL substring 还是正则不明确

**文件**: `src/mcp/prompts.ts:86`

```
click_probe "filter": URL substring to capture matching network requests
```

prompt 说是 "URL substring"，但 LLM 不确定能否用通配符或正则。需要明确说明。

### 63. [P3] 工具描述使用 `\n\n` 分隔的一致性问题

**文件**: `src/mcp/tools.ts:98-106`

`browser_control_command` 有 6 行用 `\n\n` 分隔，而 `browser_control_close_session` 只有 2 行。不同 MCP client 对 `\n\n` 显示效果不一致，有些用于向量检索时多余空行增加噪声。

---

## 七、Extension 页面运行时问题

### 64. [P2] Snapshot 文本截断无溢出标记

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:149, 528`

accessible name 规范化到 900 字符，`nodeSearchText()` 累计到 1000 字符后截断，但无任何溢出标记。LLM 不知道内容被截断。

### 65. [P2] Portal/overlay 元素检测不完整

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:199-209`

代码注释承认 `elementFromPoint` 对 Portal 渲染元素（Ant Design 等）不可靠。`receivesPointerEvents` 检查不完整，某些覆盖层但可交互的元素可能被遗漏。

### 66. [P2] Shadow DOM 点击解析缺失

**文件**: `src/extension/service-worker/page-runtime/click.ts:133-140`

只用 `elementFromPoint`，忽略 `composed: true` 元素。Shadow DOM slot fallback content 不可点击，无 `getComputedStyle()` 检查 `pointer-events: none`。

### 67. [P2] Fill 的 React/Vue 框架兼容性问题

**文件**: `src/extension/service-worker/page-runtime/fill.ts:116-127`

native setter fallback 对 React 16+（onInput handlers）和 Vue 3（v-model）可能不触发框架的响应式更新。`document.execCommand('insertText')` 已弃用且不可靠。

### 68. [P2] click probe 中 Fetch.enable 与 action() 之间的竞争

**文件**: `src/extension/service-worker/handlers/network-cdp.ts:598-603`

`Fetch.enable` 完成后立即执行 `action()`，但 listener 可能尚未就绪。即时请求可能不被拦截。

### 69. [P3] iframe 支持不完整

**文件**: `src/extension/service-worker/page-runtime/snapshot.ts:114-122`, click.ts:69-107

- 跨域 iframe 静默失败，只计数不提供替代方案
- 深层嵌套 iframe 无深度限制，可能导致性能下降
- 带 `sandbox` 属性的 iframe 点击穿越可能静默失败

### 70. [P3] wait-for 轮询无退避策略

**文件**: `src/extension/service-worker/page-runtime/wait-for.ts:143-146`

固定 100ms 轮询间隔，无指数退避。长时间等待时 CPU 密集。`timeoutMs` 未做范围验证，可能为负或过大。

### 71. [P3] evaluate 错误恢复信息不足

**文件**: `src/extension/service-worker/page-runtime/evaluate.ts:8-20`

表达式失败回退到语句体执行，但不区分 SyntaxError（可修复）和 ReferenceError（变量不存在）。Stack trace 截断至 8 行。

---

## 八、优先级总览

### P0 — 立即修复

| # | 分类 | 问题 |
|---|------|------|
| 1 | MCP 架构 | args schema 对 LLM 不可见（黑盒 `z.record`） |
| 2 | MCP 架构 | 工具描述未列出可用命令 |
| 3 | MCP 架构 | Prompts 被动触发，关键指南无法送达 |
| 11 | 安全 | fill summary 明文暴露敏感输入内容 |
| 12 | 功能 Bug | observe validKeys 与 schema 不同步 |
| 20 | 协议 | contracts.ts 与 protocol.ts 定义不一致 |
| 21 | 协议 | Extension 与 contracts 命令词汇不同 |
| 22 | 安全 | HTTP 请求体无大小限制 |
| 23 | 代码 | fill validate 未过滤未知键 |
| 24 | 代码 | fill toResult 依赖 daemon 回显 |
| 47 | 安全 | evaluate 无超时/沙箱/长度限制 |
| 48 | 安全 | navigate 未拦截 javascript:/data:/file: 协议 |

### P1 — 尽快修复

| # | 分类 | 问题 |
|---|------|------|
| 4 | MCP 架构 | 缺少用户确认拦截机制 |
| 5 | MCP 架构 | 建议按功能域拆分工具 |
| 6 | 命令设计 | click + click_probe 应合并 |
| 7 | 命令设计 | observe 与 snapshot diff_to 应合并 |
| 13 | 功能 | click 行为过载 |
| 14 | 功能 | 缺少统一 settle 策略 |
| 25 | 代码 | Session 内存泄漏 |
| 26 | 代码 | WebSocket pending requests 泄漏 |
| 27 | 代码 | WebSocket ensureConnected 虚假成功 |
| 28 | 代码 | observe_start 返回值未校验 |
| 29 | 代码 | Daemon 启动锁竞争 |
| 30 | 代码 | Daemon 崩溃后不自动重启 |
| 49 | 安全 | upload 路径未验证 |
| 50 | 安全 | 网络捕获敏感数据持久化未加密 |
| 51 | 安全 | Debugger 会话未隔离 |
| 56 | 提示词 | @e ref revision 表述误导 |
| 57 | 提示词 | 示例中 includeNetworkMarker 无效 |
| 58 | 提示词 | element ref 生命周期说明不充分 |

### P2 — 中期改进

| # | 分类 | 问题 |
|---|------|------|
| 8-10 | 命令设计 | tabs/capture/network 命令精简 |
| 15-17 | 功能 | stats 不一致、字段命名混乱、WebSocket 不可见 |
| 31-34 | 代码 | 正则误报、structureId 碰撞、DOM 线性扫描、类型校验 |
| 35-43 | 代码 | 参数校验、tabId 强转、网络处理、artifact 写入等 |
| 52-53 | 安全 | navigate 风险说明、header 脱敏不完整 |
| 59-62 | 提示词 | 错误恢复、场景对照、scope 说明、filter 语义 |
| 64-68 | Extension | 文本截断、Portal 检测、Shadow DOM、框架兼容性、竞争条件 |

### P3 — 低优先级

| # | 分类 | 问题 |
|---|------|------|
| 18-19 | 功能 | select multiple/日期选择器、cdp_click_at 未实现 |
| 44-46 | 代码 | generic 展开、枚举校验、字符串强转 |
| 54-55 | 安全 | ref 正则宽松、risk-notes 冗余 |
| 63 | 提示词 | 工具描述格式一致性 |
| 69-71 | Extension | iframe 支持、wait-for 退避、evaluate 错误恢复 |

---

## 九、最优先处理建议（Top 5）

1. **MCP Schema 可见性**（#1-3）：将 `args` 从 `z.record` 改为 typed schema（或拆分工具），并在工具描述中嵌入核心命令列表。这是影响面最大的单一改进——解决后 LLM 的命令调用成功率会显著提升。

2. **observe validKeys 与 schema 不同步**（#12, #57）：直接导致 prompt 示例失效，修复成本最低（只需在 validKeys 数组中补齐字段）。

3. **fill 安全问题**（#11, #23, #24）：summary 明文暴露输入内容 + validate 不过滤未知键 + toResult 依赖回显。三个问题集中在同一个命令，可一起修复。

4. **contracts.ts 与 protocol.ts 对齐**（#20, #21）：协议层面的不一致会导致各层行为不可预测，是架构级技术债。

5. **navigate/evaluate 安全防护**（#47, #48）：URL 协议白名单和 JS 执行超时/长度限制是基本安全底线。
