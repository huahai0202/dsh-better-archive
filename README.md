# DSH Better Archive

> 为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供完整、可管理的已归档会话视图。

`dsh-better-archive` 会在 DSH 侧边栏的设置区域新增「已归档」入口。你可以查找和筛选归档会话、恢复会话，或按需永久删除不再需要的归档记录。

## 界面

| 深色模式 | 浅色模式 |
| :---: | :---: |
| <img src="./assets/screenshot-dark.png" alt="深色模式下的已归档会话页面" width="420" /> | <img src="./assets/screenshot-light.png" alt="浅色模式下的已归档会话页面" width="420" /> |

## 功能

- 在 DSH 设置区提供独立的「已归档」页面。
- 按项目查看归档会话；支持关键词搜索、项目筛选，以及按更新时间或名称排序。
- 一键取消归档。恢复后会话会立即回到 DSH 的正常会话列表。
- 支持删除单个会话、某个项目下的全部归档会话，或清空全部归档会话；仍在使用的会话会在重启 DSH 后自动删除。永久删除走 DSH 自己的风险确认：需要先勾选「我已了解」才能按下确认按钮。
- 页面文案跟随 DSH 的语言设置，中英文切换无需刷新页面。
- 界面直接使用 DSH 自身的 UI 组件：弹出菜单是 DSH 的 `Menu`，永久删除确认是 DSH 的 `RiskConfirmation`，按钮、图标与卡片沿用同一套基础组件，因此外观、交互、键盘行为与明暗主题都和 DSH 保持一致。

## 界面实现

浏览器端不自己实现弹层与对话框，而是 `require('@deepseek-ai/dsh-client-ui-primitives')` 并直接渲染 DSH 自己的组件：

| 界面元素 | 使用组件 |
| --- | --- |
| 排序 / 项目筛选下拉、项目行「⋯」菜单 | `Menu`（锚点定位、点击外部关闭、Esc 关闭、选中打勾） |
| 永久删除确认（单个 / 整个项目 / 全部） | `RiskConfirmation`（基于 `Modal`，自带警告图标、勾选确认与「确认按钮在勾选前保持禁用」的门禁） |
| 全部删除、取消归档、图标按钮 | `Button`（`toolbar` / `outline` / `ghost` 变体与 `sm` / `md` 尺寸） |
| 图标 | `IconArchiveOutline20`、`IconTrashOutline16`、`IconSearchOutline16`、`IconChevronDownOutline14`、`IconEllipsisOutline16`、`IconFolderOpen16` |

`@deepseek-ai/dsh-client-ui-primitives` 是 DSH 内核在启动时注入浏览器模块表的基础模块，因此无需在 `dsh.client.external` 中声明。插件自己的样式只剩下组件无法表达的布局、一个破坏性强调色和滚动条皮肤。

## 安装

需要 dsh 0.1.5-alpha.1+、Node.js 22.19+ 和 pnpm。

```sh
dsh plugin --profile web add github:huahai0202/dsh-better-archive
```

安装完成后重启 `dsh web`。插件会自动加入该 profile 的 `dsh.profile.bundles`；若未自动加入，请在该数组中添加 `"dsh-better-archive"`，然后重启 DSH Web。

> 0.5.0 起适配 dsh 0.1.5-alpha.1：客户端模块系统改为 `dsh-client-modules`（旧版 `dsh-client-runtime` 已移除），Host 侧会话存储读取适配 `stat(id)` / 快照形 `list()`（仍兼容旧版的 `inspect(id)` / 表头形 `list()`）。旧版 dsh 请使用 0.4.x。
>
> 0.6.0 起界面改为直接调用 DSH 内部 UI 组件（`@deepseek-ai/dsh-client-ui-primitives` 的 `Menu` / `RiskConfirmation` / `Button` 与图标），替换掉此前手写的下拉菜单、对话框与按钮；永久删除改为 DSH 的风险确认流程，需勾选确认后才可执行。同时修复了 0.5.1 中下拉菜单引用了已删除的 `ScrollingLabel` 导致「已归档」页面渲染失败的问题。这些组件需要 dsh 0.1.5-alpha.1+ 的浏览器模块表，旧版 dsh 请使用 0.5.x。

## 更新

通过上述 GitHub 方式安装的插件可使用以下命令更新：

```sh
dsh plugin --profile web update dsh-better-archive
```

更新完成后重启 `dsh web`，使正在运行的 Host 和客户端加载新版本。

## 本地开发

```sh
dsh plugin --profile web add link:<path-to-this-checkout>
```

本地修改后重启 `dsh web`，以加载最新的插件代码。

提交前可运行以下检查：

```sh
node --check lib/index.js
node --check lib/client.js
npm pack --dry-run
```

## 删除行为

永久删除只作用于已归档会话，操作前会要求确认。针对 DSH `0.1.5-alpha.1`（兼容 `0.1.2-alpha.1` 与 `0.1.1-rc.2`）的默认 JSONL 会话存储，插件会删除会话专属目录，并同步移除对应的工作区与归档记账。

DSH 的归档操作只会将会话从常规列表中隐藏，并不等于终止会话。删除行为取决于会话当前是否仍由 DSH 进程持有：

| 会话状态 | 点击删除后的行为 | 页面状态 |
| --- | --- | --- |
| 冷会话 | 立即永久删除会话目录，并同步移除工作区和归档记录 | 从界面中立即移除不再显示 |
| 当前仍存活的会话 | 写入待删除标记，下次 DSH 启动时自动完成物理删除 | 从界面中立即移除不再显示（物理删除在下次启动时自动完成） |

对于存活中的会话，插件已记录待删除标记，会在下次 DSH 重启启动时自动执行物理清理。

批量删除可以同时处理冷会话和仍存活的会话；若中途失败，接口会报告已立即删除和已安排重启后删除的会话，并刷新页面状态。

DSH 的内容寻址附件由 DSH 独立管理，因此不会随会话记录一起删除。

## 开发接口

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/archived/pending` | `GET` | 查询标记为重启后删除的会话 |
| `/archived/unarchive` | `POST` | 取消归档一个会话 |
| `/archived/delete` | `POST` | 立即删除或安排重启后删除一个归档会话 |
| `/archived/delete-project` | `POST` | 删除或安排删除一个项目的全部归档会话 |
| `/archived/delete-all` | `POST` | 删除或安排删除全部归档会话 |

## 目录

```text
dsh-better-archive/
├── lib/
│   ├── index.js        # DSH Host 路由与会话操作
│   └── client.js       # 归档页面与侧边栏入口
├── cordis.patch.yml    # Host 挂载配置
├── package.json        # 插件声明
└── assets/             # README 截图
```

## License

[MIT](./LICENSE)
