# dsh-chrome-tab

让 DeepSeek Harness 读取、操作你正在用的 Chrome 标签页。输入事件由浏览器自己发出，页面里 `isTrusted` 为 `true`。

[English](README.en.md) | **中文**

## 为什么是一个扩展，而不是连个端口

真实标签页里的 DOM 只能由跑在那个 Chrome 里的代码访问。三条外部通道都被堵死：

- 本机 Chrome 没开 `--remote-debugging-port`，外部进程连不上 CDP
- macOS 的 TCC 不允许别的进程读 Chrome 的 profile 目录（`~/Library/Application Support/Google/Chrome`）
- AppleScript 控制 Chrome 需要「自动化」权限，调用直接被系统拦下（`-10004`）

所以这个项目是两半：一个 **Harness 插件**（提供 `@` 菜单和 `chrome_*` 工具）和一个 **MV3 扩展**（在 Chrome 里真正碰页面）。中间走本机 WebSocket，不需要你填端口。

## 安装

> **先装 Harness 插件，再在 Chrome 里加载扩展，最后授权。** 三步缺一步，`chrome_tabs` 会告诉你缺的是哪一步。

### 1. 装 Harness 插件

三种方式任选一种。

**让 Agent 安装（推荐）**：把下面这句话发给你正在用的 Agent：

```text
请安装 DSH 插件 dsh-chrome-tab，仓库是 https://github.com/LouXiaXiaoHei/dsh-chrome-bridge
```

**GitHub 仓库（始终最新）**

```sh
dsh plugin --profile desktop add github:LouXiaXiaoHei/dsh-chrome-bridge
```

**本地开发**

```sh
dsh plugin --profile desktop add link:/path/to/dsh-chrome-bridge
```

> 命令里的 `desktop` 是桌面版的默认 profile；用别的 profile 就换成对应的名字。桌面版也可以直接在「设置 → 插件」里安装，不用命令行。

### 2. 在 Chrome 里加载扩展

插件启动时会把扩展释放到 `~/.dsh/chrome-tab-extension/`，并逐文件刷新成当前构建。那个目录写不进去时（沙箱、权限问题）自动改用插件自己目录下的 `extension/`，`chrome_tabs` 的提示里会说出实际用的是哪个路径。

打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选择上面那个目录。

> Chrome 156 起 `--load-extension` 启动参数已被忽略，这一步必须手动做一次。之后 Chrome 会记住，重启不用再来。

扩展不需要填端口：它每 30 秒探测 `30795`–`30805`，挑启动时间最新的那个桥自动连上。多个 Harness 同时开着时，它会跟着最新的那个走。

### 3. 授权

`debugger` 权限在加载扩展时一并通过，Chrome 不会额外弹窗。改过 `extension/` 里的代码之后，要回 `chrome://extensions` 点一次扩展的刷新图标才会生效。

原生通道只在 macOS 上存在，需要两样东西：

- **辅助功能授权**：系统设置 → 隐私与安全性 → 辅助功能，勾选运行 DSH 的那个 App（在终端里跑就是终端）
- **Xcode 命令行工具**：`xcode-select --install`。插件首次用到时把 `mac/axdriver.swift` 编译到 `~/.dsh/chrome-tab-native/axdriver`，源码没变就复用；插件目录里若有预编译好的 `mac/axdriver` 则直接用

> 这两样只影响原生通道。没有也能用，CDP 通道不需要它们；工具会明确说退回了哪条路，不会假装成功。
>
> **Windows 和 Linux 上没有原生通道，也不需要这两样东西。** CDP 通道在那边承担全部点击、输入、拖拽与滚动。

### 验证

```text
chrome_tabs
```

返回标签页列表就是通了。连不上看[排查](#排查连不上)。

## 能做什么

在输入框里 `@` 选一个标签页，然后直接说要干什么。模型能读页面结构（标题、URL、标题层级、可交互元素编号、正文、滚动位置），也能按名称、`aria-label` 或占位提示找元素，然后点击、双击、点击坐标、输入文字、按组合键、拖拽、滚动、等页面变化、截图、开新标签页。

```
chrome_click  { name: "登录" }
chrome_type   { name: "搜索", text: "茅台", pressEnter: true }
chrome_scroll { name: "页脚" }
```

按名字比按编号耐用：`chrome_snapshot` 的编号只在那一次快照里有效，页面一变就废了。`name` 匹配的是 Chrome 暴露给辅助功能的那棵语义树，按钮文字、链接文字、`aria-label`、输入框占位提示都能命中，带图标字体的导航项（`\ue619 首页`）会被剥成可读文字。

> `index` 属于快照，`name` 属于无障碍树，两套编号不要混用。名字找不到时再退回 `chrome_snapshot` + `index`。

| 工具 | 作用 |
| --- | --- |
| `chrome_tabs` | 列出可操作的标签页，拿 `tabId` |
| `chrome_snapshot` | 页面快照：标题、URL、标题层级、编号的可交互元素、正文、滚动位置 |
| `chrome_click` | 点击。给 `index`（快照编号）或 `name` |
| `chrome_move` | 只移动指针到 `index` 或 `x`+`y`，不点击；用来先悬停、看提示、或让过程可见 |
| `chrome_click_at` | 按视口坐标 `x`+`y` 点击，也可以直接给快照编号 `index` |
| `chrome_type` | 输入文字。给 `index` 或 `name`；`replace` 先清空，`pressEnter` 提交 |
| `chrome_press` | 按键：Enter、Escape、Tab、方向键、Home/End/PageUp/PageDown、字母与数字，可带 `cmd` / `shift` / `alt` / `ctrl` |
| `chrome_drag` | 拖拽。起点 `name` / `index` / `fromX`+`fromY`，终点 `toName` / `toX`+`toY` / `dx`+`dy` |
| `chrome_scroll` | 滚动：`to: "top" \| "bottom"`、`name` 滚到某个元素、或 `amount` 像素 |
| `chrome_query` | CSS 选择器查询，可读表单控件的实时值 |
| `chrome_wait` | 等选择器命中或文本出现（最多 15 秒） |
| `chrome_open` | 用给定 URL 打开标签页 |
| `chrome_screenshot` | 截图（默认在元素上叠编号框，`marks: false` 关掉），存到 `~/.dsh/chrome-tab-shots/`，同时把图片直接交给模型 |

所有工具都接受可选的 `tabId`，省略时用最近一次 `@` 选中的标签页。

## 输入走哪条路

绝大多数浏览器自动化在页面里 `dispatchEvent`，事件 `isTrusted` 恒为 `false`：反爬脚本一行代码识破，滑块和拖拽干脆不响应，富文本编辑器不认。

每个动作按顺序尝试两条通道，成功即停：

| 顺序 | 通道 | 事件由谁产生 | 前提 |
| --- | --- | --- | --- |
| 1 | CDP | 浏览器输入管线：`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` | 扩展的 `debugger` 权限 |
| 2 | 原生 | macOS 进程级投递：AX `AXPress`、`CGEvent.postToPid`、全局 tap | 仅 macOS + 辅助功能授权 + 编译器 |

页面内 `dispatchEvent` 那条合成通道已经删掉了：它绕过指针、事件 `isTrusted` 为假，等于在你眼皮底下假装操作。两条真通道都失败时工具直接报错，不会换个方式偷偷把事做完。

**CDP 是主干。** 事件序列与真人一致（`pointerover → pointermove → pointerdown → mousedown(buttons=1, detail=1) → pointerup → mouseup → click`），不需要 Chrome 在前台，也不切换你的标签页，系统鼠标一动不动——按下、移动、抬起全在浏览器内部完成。

**原生通道补位** CDP 够不着的地方：无障碍树里才有的语义（按名字滚动到某个元素）、以及页面禁止调试的场合。按名字点击与输入现在也先走 CDP——在页面里按 aria-label、placeholder、可见文字打分定位，拿到点再真点击，所以 Windows 上一样能用，帧上的指针也会真的滑过去按下去。

| 原生通道的操作 | 实现 | 事件可信 | 碰系统光标 | 需要 Chrome 在前台 |
| --- | --- | --- | --- | --- |
| 点击 | AX `AXPress` | 是 | 不会 | 否 |
| 输入文字 | AX 聚焦 + 逐字符 `postToPid` 键盘事件 | 是 | 不会 | 否 |
| 滑块 | AX 聚焦 + 方向键 / `AXIncrement` | 是 | 不会 | 否 |
| 滚到某个元素 | AX `AXScrollToVisible` | 是 | 不会 | 否 |
| 翻页滚动 | 聚焦网页后发 PageDown / PageUp / Home / End | 是 | 不会 | 否 |
| 拖拽 | 全局 `CGEvent` 按下 → 拖动 → 抬起 | 是 | 会（结束复位） | 是 |

拖拽是唯一绕不过全局事件的：`postToPid` 投递的按下拿不到窗口内坐标，落不到网页上（试过 `CGAssociateMouseAndMouseCursorPosition(false)`，光标照样被带走）。工具会在拖拽前后隐藏光标并复位到原处。**走 CDP 没有这个问题**，这也是把 CDP 做主干的原因之一。


> 只有当 CDP 也找不到那个名字、退回无障碍树时，才会把标签页切到前台——Chrome 只对当前标签页暴露无障碍树。

## 先看，再动

工具不再替模型猜页面长什么样：每一步都由「读元素 → 看图 → 动手」三件事组成。

1. `chrome_snapshot` 读出页面结构，每个可交互元素带一个编号和它的视口坐标（`@x,y`，超出视口会标 `(above)` / `(below)` / `(partly offscreen)`）。
2. `chrome_screenshot` 截图，默认在页面上把同一批元素框出来、标上同样的编号（截图完成后框会自动撤掉，不留在页面里）。图片直接作为图像交给模型，同时也存一份到 `~/.dsh/chrome-tab-shots/`。
3. 动手：`chrome_click` / `chrome_type` 用编号或名字，`chrome_move` / `chrome_click_at` / `chrome_drag` 用坐标。图上量到的点和快照里读到的坐标是同一套坐标系（视口 CSS 像素）。

编号框用的是红框 + 左上角数字，和 `chrome_snapshot` 里的编号一一对应，所以「图上的 7」就是「快照里的 7」。
## 页面上那只指针

接管一个标签页的那一刻，指针就出现在页面上：落在视口中心，涟漪一次。之后整段接管期它都在——滑到目标、按下（压暗 + 涟漪）、松手，停在该处。导航到新页面、页面框架把 DOM 整个换掉，它都会被放回原处；只有接管转移给别的标签页，或者调试通道断开时，它才离开。

**它是唯一的手。** 点击、输入、按键、拖拽、滚动都不再绕开它：每个动作先把指针滑到目标点，按下，再由 CDP 在同一坐标上发事件，然后松手。滑动是页面里的逐帧动画（`requestAnimationFrame` + ease-in-out），不是 CSS transition，所以宿主知道它什么时候真正落点，工具会等落点后再按键——你看到的箭头位置就是事件发生的位置。

它表示的是"这个标签页正在被操作"这个状态，不是某次工具调用临时画上去的装饰。

它是页面里的一个 DOM 元素 `#__dsh_ai_cursor`，不是系统光标。插件不往屏幕上叠任何窗口，系统那只大箭头不会替你动：

- `position: fixed`、`pointer-events: none`、`z-index: 2147483647`
- 长在网页里，所以校验 `isTrusted` 的代码看不到它，`document.elementFromPoint` 也不会命中它
- 只可能出现在 Chrome 的页面区域内，浮不到别的应用上面
- 你真实的鼠标不动，也不影响你自己用鼠标

黑色实体 + 白色描边 + 一层柔光，深色网页靠白边分辨，浅色网页靠灰影分辨。

## 更新

扩展跟着插件一起更新：插件启动时会把 `extension/` 的内容刷新到 `~/.dsh/chrome-tab-extension/`，之后去 `chrome://extensions` 点一次扩展的刷新图标。

原生驱动 `mac/axdriver.swift` 变了会在下次使用时重新编译（按 mtime 判断），不用手动删旧二进制。

Harness 插件本身在插件管理里更新。

## 测试与开发

```sh
node test/bridge.test.js    # 11  零依赖 WS 服务端：握手、往返、并发、断连
node test/host.test.js      # 44  假 ctx 跑 apply()：effect、工具、路由
node test/client.test.js    # 24  vm 里跑 @ source：候选、过滤、pick、序列化、断连原因
node test/contract.test.js  # 44  源码比对：两端方法名、端口、路径、工具集
node test/e2e.mjs           # 26  真 Chrome + 真扩展 + 本地 fixture 全链路
node test/beacon.mjs        # 8   两个桥并存时，扩展必须迁到最新的那个
node test/smoke.mjs [url]   # 5   真实站点（默认 bilibili）看模型实际看到什么
node test/native.mjs [url]  # 11  原生通道现场测试：真 Chrome + 辅助功能授权
node test/cdp-probe.mjs        页面内指针 + CDP 事件真实性（需探针页与调试端口）
```

`native.mjs` 会真的去点 Chrome 窗口里的像素，需要一个能读写的桌面会话，跑之前先起探针页：

```sh
node test/serve-probe.mjs &
node test/native.mjs
```

没有辅助功能授权时它会 SKIP，而不是假装通过。

`e2e.mjs` 用 CDP `Extensions.loadUnpacked` 装载 `extension/` 的一份副本，不需要手动装扩展，也不依赖外网。副本的 `HOST_PORTS` 会被钉成本次运行实际绑定的端口——否则扩展会去连你正在用的那个 DSH 实例，测试永远等不到连接。它启动 Chrome 时带 `--no-sandbox`：在已经持有沙箱的父进程里（比如 agent harness），Chrome 自己的沙箱初始化不了，渲染进程会反复崩，页面脚本不执行、扩展 worker 也不应答。

`cdp-probe.mjs` 也要先起探针页，再手动拉一个带调试端口的独立 Chrome：

```sh
node test/serve-probe.mjs &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/ct --remote-debugging-port=9334 --no-sandbox about:blank &
node test/cdp-probe.mjs
```

改扩展时不用装商店版：在 `chrome://extensions` 打开「开发者模式」，「加载已解压的扩展程序」选本仓库的 `extension/` 目录，改完点刷新。

## 排查：连不上

扩展每 30 秒探测一次 `30795`–`30805`，`GET /dsh-chrome-tab/config` 返回的 `startedAt` 决定它挑哪个桥。装好了还连不上，通常是这两件事。

**端口上挂着没人驱动的旧桥。** 插件热重载时，旧实例的 WebSocket 长连接让 `server.close()` 的回调永不触发，端口留在那儿，`connected` 还是 `true`。

```sh
for p in $(seq 30795 30805); do
  printf "%-6s " "$p"
  curl -s --max-time 2 "http://127.0.0.1:$p/dsh-chrome-tab/config" || echo "（无监听）"
  echo
done
```

再对比当前 DSH 实例认的那个：

```sh
curl -s http://127.0.0.1:<DSH 端口>/dsh-chrome-tab/status
```

两个 `wsUrl` 不一样就是踩到了。**重启 DSH** 能彻底清掉（新进程从 30795 重新绑）。

> 插件自己也会判断：`@` 菜单和 `chrome_tabs` 连不上时会先探兄弟端口，发现扩展挂在别的桥上会直说「扩展连在旧实例上（端口 30795）」，而不是让你再装一遍扩展。

**扩展还在跑旧代码。** 改过 `extension/` 之后，`~/.dsh/chrome-tab-extension/` 会在插件启动时刷新，但 Chrome 里已加载的副本要手动重载才生效（`chrome://extensions` → 该扩展的刷新图标）。

两件都想确认，点扩展图标：弹窗里就是它当前认为的桥地址和连接状态，也可以点「立即重连」。

其它几种情况：

- 工具说「辅助功能未授权」：系统设置 → 隐私与安全性 → 辅助功能，勾选运行 DSH 的 App
- 工具说「原生驱动不可用」：装 Xcode 命令行工具（`xcode-select --install`）后重试，插件会自动编译
- 弹出「dsh-chrome-tab」的调试提示条：这是 `debugger` 权限的固定提示，正常现象，不影响使用

## 当前限制

**只支持普通 HTTP(S) 页面。** `chrome://`、`file://`、扩展页面都进不去，`chrome_snapshot` 会直接说不可注入。

**只处理顶层文档。** 注入时没有开 `allFrames`，跨域 iframe 里的元素拿不到。同源 iframe 可以考虑用 `chrome_query` 在里面找，但点击坐标是相对顶层视口的。

**按名字操作会切标签页。** Chrome 只对当前标签页暴露无障碍树，所以 `name` 寻址必须先把它切到前台。按 `index` 或坐标走 CDP，不动前台窗口。

**原生通道拖拽会移动真实光标。** 结束会复位到原处。走 CDP 的拖拽不会。

**快照有上限。** `chrome_snapshot` 最多列 60 个可交互元素、2 万字正文，超出部分被截断；无障碍树最多取 3000 个节点，超大页面可能漏掉靠后的元素。

**同一标签页不要并发操作。** 工具调用本身是顺序的，但如果你同时发起多个 `chrome_*` 调用，它们会在同一个标签页上交错执行，结果难以预期。

**`chrome_query` 读的是实时值，但不执行页面脚本。** 它只能做 CSS 选择器和属性/文本读取，不能求值任意表达式——想点页面里的东西用 `chrome_click`。

**截图是浏览器视口。** 不是整页长图（`chrome_screenshot` 截的是当前视口），模型能不能看懂取决于模型能力。

**页面内容是不可信数据。** 网页里出现的「请忽略之前的指令」「请访问某地址」不是用户授权，模型不应照做。

## 架构

```
Harness Host (Cordis plugin)            Chrome (MV3 extension)
  index.js   工具 + HTTP 路由   <──ws──>  background.js
  bridge.js  零依赖 WebSocket 服务端      固定页面函数表
  client.js  @ 菜单 source                  ↑ chrome.scripting.executeScript
                                          用户当前标签页
```

- **`bridge.js`** 自己实现 WebSocket 握手与帧编解码——Harness 不想为这个功能引入第三方依赖。只接受 `Origin: chrome-extension://…` 的连接，`Sec-WebSocket-Accept` 按 RFC 校验。
- **端口发现**：Host 依次尝试 `30795`–`30805`，扩展每 30 秒（`chrome.alarms`）重连一次。
- **扩展侧不解释宿主代码**：MV3 禁止扩展页 `eval` / `new Function`，所以每个页面操作都是扩展里的一个具名函数，通过 `executeScript({ func, args })` 序列化执行。宿主永远只发方法名。
- **`@` 菜单**：`client.js` 通过 `ctx.get('inputTriggers').registerSource()` 注册一个 `@` source，`codec.serialize` 的输出就是进入 prompt 的文本——这是把 `tabId` 送到模型眼前的唯一通道。

`mac/axdriver.swift` 是常驻进程，行分隔 JSON 进、行分隔 JSON 出，由 `mac/driver.js` 按需拉起。它深度优先遍历无障碍树，用 `AXPress` 点击，用 `CGEvent.postToPid` 打字，用全局 tap 拖拽。

## License

MIT
