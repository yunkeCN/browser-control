# Browser Control

[![skills.sh](https://skills.sh/b/yunkeCN/browser-control)](https://skills.sh/yunkeCN/browser-control)

Browser Control 是一个本地 Chrome 自动化桥接工具，供 AI Agent 在用户授权下操作真实的 Chrome 浏览器。

它通过本地 Skill 脚本启动 localhost daemon，再由 daemon 通过 WebSocket 连接 Chrome Manifest V3 扩展。这样 Agent 可以导航页面、读取 DOM、点击和填写表单、截图、下载文件，并查看网络请求，相关通信默认只发生在本机。

```text
AI Agent -> Browser Control skill scripts -> localhost HTTP daemon -> WebSocket -> Chrome extension -> Chrome DOM
```

发布给用户使用的 Skill 位于 `skills/browser-control/`。这个目录是自包含的，里面包括 `SKILL.md`、命令行脚本、参考文档、可直接加载的 Chrome 扩展构建产物，以及内置 WebSocket runtime 的 daemon bundle。

## 能做什么

- 打开、检查和操作真实 Chrome 标签页。
- 获取 DOM snapshot 和页面可见文本。
- 点击、填写输入框、按键、选择下拉项、切换 checkbox/radio。
- 保存截图、PDF、下载文件等本地产物（artifacts）。
- 查看当前浏览器会话里的网络请求。
- 复用用户已经登录的 Chrome 会话，同时通信只走 localhost。

## 前置要求

- Chrome 或 Chromium 系浏览器。
- Node.js 18 或更新版本。
- 可以加载已解压 Chrome 扩展程序的环境。

## 安装为 Skill

可以通过 skills CLI 安装：

```bash
npx skills add yunkeCN/browser-control --skill browser-control
```

这也是 skills.sh 收录和排行社区 Skill 的主要方式：用户通过 `skills` CLI 安装后，会产生匿名安装统计；如果用户关闭 telemetry，则不会计入排行。

本地开发时，也可以从当前仓库安装：

```bash
npx skills add . --skill browser-control
```

## 安装 Chrome 扩展

Browser Control 需要在 Chrome 中加载随 Skill 附带的扩展。

1. 在已安装的 Skill 目录中启动 daemon：

   ```bash
   node scripts/browser-control.js start --json
   node scripts/browser-control.js doctor --json
   ```

2. 打开 `chrome://extensions`。
3. 开启 **开发者模式**。
4. 点击 **加载已解压的扩展程序**。
5. 选择已安装 `browser-control` Skill 里的 `extension/` 目录。
6. 再运行一次：

   ```bash
   node scripts/browser-control.js doctor --json
   ```

   确认输出里的 `extension_connected` 为 `true`。

如果不方便找到 Skill 里的 `extension/` 目录，可以从 <https://github.com/yunkeCN/browser-control/releases> 下载 `browser-control-extension-<tag>.zip`，解压后加载其中的 `extension/` 目录。

从源码仓库开发时，可加载的扩展目录是 `skills/browser-control/extension/`。

## CLI 快速使用

除非 `browser-control` 已经在 `PATH` 中，否则请在 `skills/browser-control/` 目录下运行：

```bash
node scripts/browser-control.js status --json
node scripts/browser-control.js doctor --json
node scripts/health-check.js --json
node scripts/browser-control.js snapshot --args '{"session":"demo"}'
node scripts/browser-control.js get_text --args '{"session":"demo","scope":"viewport","maxChars":4000}'
```

默认本地端点：

- Daemon HTTP：`http://127.0.0.1:10087`
- Extension WebSocket：`ws://127.0.0.1:10087/ws`
- Artifact 目录：`~/.browser-control/artifacts`

可用环境变量：

- `BROWSER_CONTROL_HOST`
- `BROWSER_CONTROL_PORT`
- `BROWSER_CONTROL_ARTIFACT_DIR`
- `BROWSER_CONTROL_EXTENSION_DIR`

## Command API

命令通过 `POST /command` 发送，使用 typed envelope：

```json
{
  "id": "req-1",
  "version": "2026-05-19",
  "session": "demo",
  "command": "navigate",
  "args": { "url": "https://example.com" },
  "timeoutMs": 30000
}
```

支持的浏览器命令包括 `navigate`、`tabs`、`snapshot`、`get_text`、`scroll`、`click`、`fill`、`press`、`wait_for`、`evaluate`、`capture`、`network`、`upload`、`download` 和 `close_session`。

完整 CLI 和 API 参考见 `skills/browser-control/references/api.md`。

## 安全模型

Browser Control 默认只在本机通信。daemon 监听 `127.0.0.1`，Chrome 扩展连接本地 daemon WebSocket，截图、PDF、下载文件等本地产物也写入用户本地机器。

由于 Browser Control 需要完成真实浏览器自动化，Chrome 扩展会请求访问网页、下载、截图和基于 debugger 的浏览器操作等权限。Agent 在执行高风险操作前仍应向用户确认，例如提交表单、修改账号设置、上传本地文件、处理凭据、购买、删除或其他不可逆操作。具体确认边界写在 `skills/browser-control/SKILL.md`。

`snapshot` 和 observation 相关命令会对疑似敏感字段值做脱敏，例如 password、token、cookie、session、API key 等字段。

## Release 下载

每次 GitHub tag release 会发布两个压缩包：

- `browser-control-skill-<tag>.zip`：完整的 `browser-control/` Skill 目录，包含 `SKILL.md`、`scripts/`、`references/`、`extension/`、已打包的 daemon runtime，以及 `scripts/browser-control-mcp.mjs`。
- `browser-control-extension-<tag>.zip`：只包含 Chrome `extension/` 目录，适合只想下载安装浏览器扩展的用户。

下载地址：<https://github.com/yunkeCN/browser-control/releases>

## 仓库结构

```text
browser-control/
├── src/protocol.ts            # 可编辑的协议 contract 和校验源码
├── src/daemon/                # 可编辑的 daemon server 和进程管理源码
├── src/extension/             # 可编辑的 Chrome MV3 扩展 TypeScript 源码
├── src/mcp/                   # 可编辑的 MCP server 源码
├── bin/                       # 生成后的 MCP 单文件 runtime
├── skills/browser-control/    # 自包含的发布版 Skill 包
├── .github/workflows/         # tag 触发的 release 打包流程
├── tests/                     # 单元、集成和 fixture e2e 测试
├── docs/                      # 维护者文档和架构说明
├── contracts.ts               # 维护者和测试使用的协议 contract
└── package.json               # 开发脚本和依赖
```

生成后的 Skill 产物会提交在 `skills/browser-control/`：可加载的扩展位于 `extension/`，生成后的 protocol/daemon/MCP runtime 位于 `scripts/`。根目录下也会生成一份 MCP runtime：`bin/browser-control-mcp.mjs`。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run e2e:fixture
```

真实浏览器 smoke test 需要先在 Chrome 中加载生成后的扩展：

```bash
npm run e2e:live
```

完整验证流程和扩展 reload 矩阵见 `docs/testing.md`。

## 文档索引

- Skill 指令：`skills/browser-control/SKILL.md`
- API 参考：`skills/browser-control/references/api.md`
- 使用示例：`skills/browser-control/references/recipes.md`
- 故障排查：`skills/browser-control/references/troubleshooting.md`
- Chrome 扩展安装：`skills/browser-control/references/chrome-extension-setup.md`
- 维护者架构说明：`docs/maintainer-architecture.md`
- MCP server：`docs/mcp.md`
- 测试和发布检查：`docs/testing.md`
