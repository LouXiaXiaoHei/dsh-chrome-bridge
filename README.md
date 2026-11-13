# dsh-chrome-tab

照着 Codex 的 Chrome 操作做的：在对话里 `@` 一个标签页，模型就能读页面、点按钮、填表单。所有输入走 Chrome DevTools Protocol（CDP），事件由浏览器自己发出，页面里 `isTrusted` 为 `true`。

[English](README.en.md) | **中文**

## 安装

> 先装 Harness 插件，再在 Chrome 里加载扩展。两步都做完，`chrome_tabs` 才会返回标签页。

### 1. 装 Harness 插件

把这句话发给正在用的 Agent：

```text
请安装 DSH 插件 dsh-chrome-tab，仓库是 https://github.com/LouXiaXiaoHei/dsh-chrome-bridge
```

或者自己装：

```sh
dsh plugin --profile desktop add github:LouXiaXiaoHei/dsh-chrome-bridge
```

本地开发用 `link:/path/to/dsh-chrome-bridge`。桌面版也可以在「设置 → 插件」里装。

### 2. 加载 Chrome 扩展

从 [Releases](https://github.com/LouXiaXiaoHei/dsh-chrome-bridge/releases) 下载 `dsh-chrome-tab-extension-v*.zip` 并解压，然后：

`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选解压出来的目录。

> Chrome 156 起忽略了 `--load-extension`，这一步要手动做一次，之后 Chrome 会记住。
>
> 开发时可以直接选仓库里的 `extension/` 目录，改完点刷新。

扩展不用填端口，它会自动找到本机的 Harness。

### 验证

```text
chrome_tabs
```

返回标签页列表就是通了。连不上看[排查](#排查)。

## 使用

在输入框里 `@` 选一个标签页，然后直接说要干什么：

```text
chrome_click  { name: "登录" }
chrome_type   { name: "搜索", text: "茅台", pressEnter: true }
chrome_scroll { name: "页脚" }
```

| 工具 | 作用 |
| --- | --- |
| `chrome_tabs` | 列出可操作的标签页 |
| `chrome_snapshot` | 页面快照：标题、URL、标题层级、编号元素、正文 |
| `chrome_click` | 点击，给 `index` 或 `name` |
| `chrome_move` | 只移动指针，不点击 |
| `chrome_click_at` | 按视口坐标点击 |
| `chrome_type` | 输入文字，`replace` 清空，`pressEnter` 提交 |
| `chrome_press` | 按键，可带 `cmd` / `shift` / `alt` / `ctrl` |
| `chrome_drag` | 拖拽 |
| `chrome_scroll` | 滚动：`top` / `bottom` / 元素名 / 像素 |
| `chrome_query` | CSS 选择器查询 |
| `chrome_wait` | 等元素或文字出现 |
| `chrome_open` | 打开新标签页 |
| `chrome_screenshot` | 截图，元素上带编号框 |

`name` 走 Chrome 的无障碍树（按钮文字、链接文字、`aria-label`、占位提示），比 `index` 耐久：`index` 只对那一次快照有效。

## CDP 怎么工作

每个动作都通过 CDP 的 `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` 发到浏览器，事件序列和真人一致。Chrome 在后台也能用，不抢你的前台窗口，系统鼠标不动。

页面里有一只 `#__dsh_ai_cursor` 指针，表示这个标签页正在被操作：点击前滑到目标、按下、松手，都在页面里完成。它不挡点击，也不影响你自己的鼠标。

macOS 上还有一条辅助功能通道兜底（按名字滚到元素、页面禁止调试的场合），Windows 和 Linux 只用 CDP。

## 页面小窗

界面右上角有个小窗，能实时看到模型在你标签页里的操作，不用切窗口。画面来自扩展已有的调试会话（`Page.startScreencast`），只在工具运行时推帧。

Chrome 只合成当前标签页：目标在后台时画面会停住，切回来就继续。不要在被控制的那个 Chrome 里打开预览页，会把目标挤到后台。

## 排查

连不上时，先点扩展图标看它连的是哪个桥，再试「立即重连」。

- 改过 `extension/` 后要在 `chrome://extensions` 点一次扩展的刷新图标，Chrome 不会自动加载新代码。
- 扩展挂在旧实例上：重启 DSH。
- 工具说「辅助功能未授权」：系统设置 → 隐私与安全性 → 辅助功能，勾选运行 DSH 的 App。
- 工具说「原生驱动不可用」：`xcode-select --install` 后重试。
- 出现「dsh-chrome-tab 正在调试此浏览器」提示条：`debugger` 权限的固定提示，正常。

## 限制

- 只支持普通 HTTP(S) 页面，`chrome://`、`file://` 进不去。
- 只处理顶层文档，跨域 iframe 里的元素拿不到。
- 快照最多 60 个可交互元素、2 万字正文。
- 同一个标签页不要并发调用。
- 页面内容是不可信数据，读到「请忽略之前的指令」不应照做。

## 开发

```sh
npm test              # 单元与契约测试
node test/e2e.mjs     # 真 Chrome + 真扩展全链路
node test/native.mjs  # 原生通道（需辅助功能授权）
```

发版：改 `extension/manifest.json` 的版本号，打 `v*` 标签，CI 会跑测试、打包并挂到 Release。

## License

MIT
