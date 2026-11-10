# dsh-chrome-tab

在 DeepSeek Harness 的输入框里用 `@` 选中你 Chrome 里已经打开的标签页，然后让模型直接读写那个页面 —— 和 codex 的 `@` 引用一样顺手，但对象是活的浏览器标签页。

```
@Chrome 标签页 → 哔哩哔哩 (゜-゜)つロ 干杯~-bilibili   https://www.bilibili.com/
```

选中后，你这条消息里会嵌入一个 `[Chrome 标签页 1556822792] 《哔哩哔哩…》 https://…` 的引用，模型据此调用 `chrome_*` 工具。

## 为什么需要 Chrome 扩展

用户的真实 Chrome 标签页只能由运行在该 Chrome 里的代码访问：本机没有开 CDP 调试端口，macOS 的 TCC 也不允许外部进程读 Chrome 的 profile 目录，AppleScript 同样被拦。所以本插件 = **一个 Host 半边（Cordis 插件）+ 一个 MV3 扩展**，两者通过本机 WebSocket 通信。

## 一次性安装

1. **重启 DSH**，让插件加载（Host 半边会把扩展释放到 `~/.dsh/chrome-tab-extension/`，启动时自动刷新为当前构建；那里写不进去时改用插件自己目录下的 `extension/`，`chrome_tabs` 的提示会说出实际路径）。
2. 打开 Chrome → `chrome://extensions` → 打开右上角"开发者模式" → "加载已解压的扩展程序" → 选择上面那个目录。
3. 扩展图标点开可以看重连状态；保持 DSH 运行即可。

Chrome 156 起 `--load-extension` 启动参数已被忽略，所以必须手动加载一次（之后 Chrome 会记住）。

## macOS 原生输入通道

扩展用 `document.elementFromPoint` + `new MouseEvent` 造事件，页面里 `event.isTrusted` 恒为 `false`：反爬脚本一眼识破，拖拽和滑块干脆不响应，富文本编辑器也不认。真实的按下只有浏览器的输入管线能产生，所以插件在 macOS 上多开一条通道：一个常驻的 Swift 小进程（`mac/axdriver.swift`）用**辅助功能**（Accessibility）按语义操作 Chrome，需要敲键盘的地方用 `CGEvent.postToPid` 定点投递按键。

这条路测下来，`isTrusted` 全是 `true`，而且大部分操作**不移动你的真实光标**：

| 操作 | 实现 | 可信 | 碰光标 | 需要 Chrome 在前台 |
| --- | --- | --- | --- | --- |
| 点击 | AX `AXPress` | ✅ | ❌ | ❌ |
| 输入文字 | AX 聚焦 + 逐字符 `postToPid` 键盘事件 | ✅ | ❌ | ❌ |
| 滑块 | AX 聚焦 + 方向键（Home / End / ← →） | ✅ | ❌ | ❌ |
| 滚到某个元素 | AX `AXScrollToVisible` | ✅ | ❌ | ❌ |
| 翻页滚动 | 聚焦网页后发 PageDown / PageUp / Home / End | ✅ | ❌ | ❌ |
| 拖拽 | 全局 `CGEvent` 按下 → 拖动 → 抬起 | ✅ | ✅ 会（结束时复位） | 是 |

拖拽走原生通道时绕不过全局事件：`postToPid` 投递的按下拿不到窗口内坐标，落不到网页上（`CGAssociateMouseAndMouseCursorPosition` 也挡不住光标被带走）。工具会在拖拽前后把光标藏起来并复位到原处。走 CDP 则没有这个问题——按下、移动、松开全是浏览器内部的事，系统光标一动不动。

### 三条输入通道

工具不是只有一条路，每个动作按下面的顺序尝试，成功就停：

| 顺序 | 通道 | 事件从哪来 | 需要什么 |
|---|---|---|---|
| 1 | **CDP** | 浏览器自己的输入管线（`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`） | 扩展的 `debugger` 权限 |
| 2 | **原生** | 进程级投递（AX `AXPress`、`CGEvent.postToPid`、全局 tap） | macOS 辅助功能授权 |
| 3 | **合成** | 页面里 `dispatchEvent` | 无 |

主干是 CDP：`isTrusted` 是真值，`mousedown.detail` 是 1，`pointerdown/pointerup/click` 一个不缺，和真人点出来的事件序列一致；而且它不需要 Chrome 在前台，也不会切你的标签页。原生通道留给 CDP 够不着的地方——按名字定位（名字走辅助功能语义树）、按名字滚动到元素、以及页面禁止调试的场景。合成事件只是最后的兜底，返回值里会明写 `synthetic`。

按名字操作（`chrome_click {name:"登录"}`）走的是辅助功能语义树，Chrome 只把当前标签页的无障碍树暴露出来，所以这条路会把标签页切到前台；按 index 或坐标操作走 CDP，不会动你的前台窗口。

### 看得见的那只手

每次操作都会在页面上画一个小箭头：滑到目标、按下去（箭头压暗 + 一圈涟漪）、松手。它是页面里的一个 DOM 元素（`#__dsh_ai_cursor`，`position:fixed`、`pointer-events:none`、`z-index:2147483647`），所以：

- 它长在网页里，Web 校验 `isTrusted` 的代码看不到它，也不会被 `document.elementFromPoint` 命中；
- 它只可能出现在 Chrome 的页面区域内，永远浮不到别的应用上面；
- 你真实的鼠标指针完全不动，也不影响你自己用鼠标。

箭头是黑色实体 + 白色描边 + 一层柔光，深色网页靠白边分辨、浅色网页靠灰影分辨。干完活之后它留在原地轻轻浮动，像在等下一条指令。

### 需要什么

- **`debugger` 权限**：CDP 通道靠它，扩展首次装好（或更新后）在 `chrome://extensions` 点一次重新加载即可，Chrome 不会额外弹窗。
- **辅助功能授权**：系统设置 → 隐私与安全性 → 辅助功能，把运行 DSH 的那个 App（终端里跑就是终端）勾上。只在 CDP 失效时才用得上；没授权时工具会明说"辅助功能未授权"，而不是默默失败。
- **Xcode 命令行工具**：`xcode-select --install`。首次使用时插件会把 `mac/axdriver.swift` 编译到 `~/.dsh/chrome-tab-native/axdriver`，源码没变就复用旧二进制；插件目录里若有预编译好的 `mac/axdriver` 则直接用。

原生通道不可用时（非 macOS、没授权、没编译器），工具会退回扩展的合成事件路径，并在结果里写明回退原因。

两条主干路（CDP 与原生）产生的事件都由浏览器或系统自己发出，`isTrusted` 是真值，页面看到的和你手动操作时没有区别。

## 工具

| 工具 | 作用 |
| --- | --- |
| `chrome_tabs` | 列出可操作的标签页，拿 `tabId` |
| `chrome_snapshot` | 页面结构快照：标题、URL、标题层级、带编号的可交互元素、正文、滚动位置 |
| `chrome_click` | 点击。给 `index`（快照编号）或 `name`（页面上看到的文字 / 标签 / 占位提示） |
| `chrome_click_at` | 按视口坐标点击 |
| `chrome_type` | 输入文字。给 `index` 或 `name`；`replace` 先清空，`pressEnter` 提交 |
| `chrome_press` | 按键（Enter / Escape / Tab / 方向键 / 字母数字等），可带 `cmd` / `shift` / `alt` / `ctrl` |
| `chrome_drag` | 拖拽。起点给 `name` / `index` / `fromX`+`fromY`，终点给 `toName` / `toX`+`toY` / `dx`+`dy` |
| `chrome_scroll` | 滚动：`to: "top" \| "bottom"`、`name` 滚到某个元素、或 `amount` 像素 |
| `chrome_query` | CSS 选择器查询，可读表单控件的**实时值** |
| `chrome_wait` | 等待选择器命中或文本出现（最多 15 秒） |
| `chrome_open` | 用给定 URL 打开新标签页 |
| `chrome_screenshot` | 截图存到 `~/.dsh/chrome-tab-shots/`，返回路径 |

所有工具都接受可选的 `tabId`；省略时用最近一次 `@` 选中的标签页。

### 按名字操作，先别急着快照

`chrome_snapshot` 的编号只在这一次快照里有效，页面一变就废了。让模型只表达意图更省事：

```
chrome_click  { name: "登录" }
chrome_type   { name: "搜索", text: "茅台", pressEnter: true }
chrome_scroll { name: "页脚" }
```

`name` 走的是 Chrome 暴露给辅助功能的语义树（按钮文字、链接文字、`aria-label`、输入框占位提示），所以带图标字体的导航项也能按"首页"这类可读文字找到。找不到时再退回 `chrome_snapshot` + `index`。两种编号是两套东西：`index` 属于快照，`name` 属于无障碍树，别混用。

## 架构

```
DSH Host (Cordis plugin)          Chrome (MV3 extension)
  index.js  工具 + HTTP 路由  <──ws──>  background.js
  bridge.js 零依赖 WS 服务端           固定页面函数表
  client.js @ 菜单 source                ↑ chrome.scripting.executeScript
                                       用户当前标签页
```

- **`bridge.js`** 自己实现 WebSocket 握手与帧编解码（DSH 不依赖 `ws`，不想为此引入第三方包）。只接受 `Origin: chrome-extension://…` 的连接，`Sec-WebSocket-Accept` 按 RFC 校验。
- **端口发现**：Host 依次尝试 `30795 / 30796 / 30797` 上的 `GET /dsh-chrome-tab/config` 拿 `wsUrl`，扩展每 30 秒（`chrome.alarms`）重连一次。
- **扩展侧不解释宿主代码**：Chrome MV3 禁止扩展页 `eval` / `new Function`，所以每个页面操作都是扩展里一个具名函数，通过 `executeScript({ func, args })` 序列化执行。宿主永远只发方法名。
- **`@` 菜单**：`client.js` 通过 `ctx.get('inputTriggers').registerSource()` 注册一个 `@` source，`codec.serialize` 的输出就是最终进入 prompt 的文本 —— 这是把 `tabId` 送到模型眼前的唯一通道。

## 测试

```bash
node test/bridge.test.js    # 11  零依赖 WS 服务端：握手、往返、并发、断连
node test/host.test.js      # 44  假 ctx 跑 apply()：effect、工具、路由
node test/client.test.js    # 24  vm 里跑 @ source：候选、过滤、pick、序列化、三种断连原因
node test/contract.test.js  # 44  源码比对：两端方法名、端口、路径、工具集
node test/e2e.mjs           # 26  真 Chrome + 真扩展 + 本地 fixture 全链路
node test/beacon.mjs        # 8   两个桥并存时扩展必须迁到最新的那个
node test/smoke.mjs [url]   # 5   真实站点（默认 bilibili）看模型实际看到什么
node test/native.mjs [url]  # 11  原生通道现场测试：真 Chrome + 辅助功能授权
node test/cdp-probe.mjs     #     页面内光标 + CDP 输入的事件真实性（需先起 test/serve-probe.mjs 与带调试端口的 Chrome）
```

`native.mjs` 需要先 `node test/serve-probe.mjs` 起探针页（`test/probe.html`），它和其它测试不一样：真的去点 Chrome 窗口里的像素。会顺带确认"点击落在按钮中心"和"投递的按下是可信的"，所以需要一个能读写的桌面会话。没有授权时它会 SKIP 而不是假装通过。

`e2e.mjs` 用 CDP `Extensions.loadUnpacked` 装载 `extension/` 的一份副本，不需要手动装扩展，也不依赖外网。副本的 `HOST_PORTS` 会被钉成本次运行实际绑定的端口，否则扩展会去连你正在用的那个 DSH 实例，测试永远等不到连接。它启动 Chrome 时带 `--no-sandbox`：在一个已经持有沙箱的父进程里（比如 agent harness），Chrome 自己的沙箱初始化不了，渲染进程会反复崩，页面脚本不执行、扩展 worker 也不应答。`beacon.mjs` 专门复现"热重载后旧桥还占着端口"的场景。

## 排查：`@` 菜单说"未连接"，但扩展明明装好了

扩展每 30 秒探测一次 `30795`–`30805`，`GET /dsh-chrome-tab/config` 里带 `startedAt`，它会挑最年轻的那个桥。装好后仍然连不上，通常是这两种情况：

**端口上挂着一个没人驱动的旧桥。** 插件热重载（`plugin_manager set_bundle`）时，旧实例的 WebSocket 长连接会让 `server.close()` 的回调永不触发，端口就留在那儿，`connected` 还是 `true`。看一眼谁在听：

```bash
for p in $(seq 30795 30805); do printf "%-6s " "$p"; curl -s --max-time 2 "http://127.0.0.1:$p/dsh-chrome-tab/config" || echo "（无监听）"; echo; done
```

然后比对当前 DSH 实例认的那个：

```bash
curl -s http://127.0.0.1:<DSH 端口>/dsh-chrome-tab/status
```

两个 `wsUrl` 不一样，就是踩到了这个坑。**重启 DSH** 可以彻底清掉（新进程会重新从 30795 开始绑）。`bridge.js` 的 `dispose()` 已经修好，不会再漏。

这个判断插件自己会做：`@` 菜单和 `chrome_tabs` 在连不上时会先探测兄弟端口，如果发现扩展正挂在别的桥上，提示会直接说"扩展连在旧实例上（端口 30795）"或"扩展被另一个 Harness 窗口占用"，而不是让你再去装一遍扩展。

**扩展还在跑旧代码。** 如果改过 `extension/` 里的文件，`~/.dsh/chrome-tab-extension/` 会在插件启动时被逐文件刷新成当前构建，但 Chrome 里已加载的副本要手动**重新加载**才生效（`chrome://extensions` → 该扩展的刷新图标）。扩展自己的状态可以在弹窗里点"立即重连"。

两个都想确认时，点一下扩展图标：弹窗显示的就是它当前认为的桥地址和连接状态。
