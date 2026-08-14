# dsh-better-archive

DSH 网页 GUI 的「已归档会话」面板插件：在侧边栏设置区新增「已归档」入口，列出所有已归档会话，支持**取消归档**、单个/批量**永久删除**（按项目删除 / 全部删除）。

> A DeepSeek Harness (DSH) web-GUI plugin that adds an "Archived" panel to the sidebar settings area — list archived sessions, **unarchive** them, or **permanently delete** them (per project / all).

## 截图 / Screenshots

| 深色 / Dark | 浅色 / Light |
| --- | --- |
| <img src="./assets/screenshot-dark.png" alt="Dark theme" width="360"/> | <img src="./assets/screenshot-light.png" alt="Light theme" width="360"/> |

## 特性 / Features

- 侧边栏设置区新增「已归档」入口（挂载到 `settings.section` slot）。
- 按项目分组列出已归档会话，支持搜索、按更新时间/字母排序、按项目筛选。
- **取消归档**：补齐 DSH `WorkspaceRegistry` 缺失的 unarchive 能力。它与 `archiveSession` 走完全相同的持久化路径；取消归档后 api-proxy 自动推送 `host/archived-sessions-changed`，浏览器会话列表即时刷新。
- **永久删除**：单个删除、按项目删除、全部删除（带确认弹窗，删除会话日志与工作区/归档记账）。

## 安装 / Install

> 需要 Node.js 22.19+ 与 pnpm（`dsh plugin` 底层通过 pnpm 安装）。

```sh
# 从 GitHub 直接安装（无需 npm 发布）
dsh plugin --profile web add github:huahai0202/dsh-better-archive
```

安装后重启 `dsh web`。安装会自动把本包加入 profile 的 `dsh.profile.bundles`：

```json
"bundles": [ "...", "dsh-better-archive" ]
```

若未自动加入，手动追加该数组项，然后重启 `dsh web`。

本地开发时可用路径安装：

```sh
dsh plugin --profile web add <path-to-this-checkout>
```

## 结构 / Structure

```
dsh-better-archive/
  package.json         # 包清单 + dsh.bundle.patch / dsh.client 声明
  cordis.patch.yml     # host 半挂载行（profile bundle 机制自动应用）
  lib/
    index.js           # Host 半：/archived/* HTTP 路由
    client.js          # 浏览器半：侧边栏入口 + 归档面板（React，零构建）
  LICENSE
  README.md
```

## Host 路由 / Routes

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/archived/list` | GET | 返回 `{ archived: [{ id, title, createdAt }] }` |
| `/archived/unarchive` | POST | body `{ sessionId }`，取消归档 |
| `/archived/delete` | POST | body `{ sessionId }`，永久删除单个会话 |
| `/archived/delete-project` | POST | body `{ cwd }`，删除某项目全部归档会话 |
| `/archived/delete-all` | POST | body `{ confirm: true }`，删除全部归档会话 |

## 配置 / Configuration

无。插件零配置挂载。

## 开发 / Development

```sh
node --check lib/index.js
node --check lib/client.js
npm pack --dry-run   # 发布前的打包校验
```

## License

[MIT](./LICENSE)
