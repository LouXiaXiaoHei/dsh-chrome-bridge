# dsh-chrome-tab

把 Chrome 里已经打开的标签页交给 agent。

在 DeepSeek Harness 的输入框输入 `@`，选一个标签页，模型就能读它的内容、点它的按钮、在它的输入框里打字：

```
@Chrome 标签页 → 雪球 - 我的首页    https://xueqiu.com/
```

选中后这条消息里会嵌入 `[Chrome 标签页 1412422840] 《雪球…》 https://…`，模型据此调用 `chrome_*` 工具。

关键在于**输入怎么进去**。绝大多数浏览器自动化是在页面里 `dispatchEvent`，事件 `isTrusted` 恒为 `false`，反爬脚本一行代码就识破，滑块、拖拽、富文本编辑器干脆不响应。这个插件让事件由浏览器自己发出：页面检查 `isTrusted`、检查 `mousedown.detail`、检查 `pointerdown` 有没有配对的 `pointerup`，看到的和真人操作没有区别。

---

## 为什么必须是一个扩展

真实标签页里的 DOM 只能由跑在那个 Chrome 里的代码访问。三条外部通道都被堵死：

- 本机 Chrome 没开 `--remote-debugging-port`，外部进程连不上 CDP
- macOS 的 TCC 不允许别的进程读 Chrome 的 profile 目录（`~/Library/Application Support/Google/Chrome`）
- AppleScript 控制 Chrome 需要「自动化」权限，调用直接被系统拦下（`-10004`）

所以要装进 Chrome 里。这个项目是两半：一个 **DSH 插件**（本进程，提供工具与 `@` 菜单）和一个 **MV3 扩展**（在 Chrome 里，真正碰页面）。中间走本机 WebSocket。

---

## 快速开始

**1. 装插件，重启 DSH**

插件启动时会把扩展释放到 `~/.dsh/chrome-tab-extension/`，并逐文件刷新成当前构建。那个目录写不进去时（沙箱、权限）自动改用插件自己目录下的 `extension/` —— `chrome_tabs` 的提示会告诉你实际用了哪个。

**2. 在 Chrome 里加载扩展**

打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选上一步那个目录。

Chrome 156 起 `--load-extension` 启动参数已被忽略，这一步必须手动做一次，之后 Chrome 会记住。

**3. 验证**

```
chrome_tabs
```

返回标签页列表就是通了。连不上看[排障](#排障连不上)。

---

## 需要什么

| 依赖 | 用于 | 不满足时 |
| --- | --- | --- |
| `debugger` 扩展权限 | CDP 通道（主干） | 退回原生/合成通道；重载一次扩展即可获得权限，Chrome 不会额外弹窗 |
| macOS 辅助功能授权 | 原生通道（按名字定位） | 回退到 CDP；工具会明说「辅助功能未授权」，不会静默失败 |
| Xcode 命令行工具 | 编译 `mac/axdriver.swift` | 同上 |

辅助功能授权在 **系统设置 → 隐私与安全性 → 辅助功能**，勾选运行 DSH 的那个 App（终端里跑就是终端）。首次使用时插件把 `mac/axdriver.swift` 编译到 `~/.dsh/chrome-tab-native/axdriver`，源码没变就复用；插件目录里若有预编译好的 `mac/axdriver` 则直接用。

原生通道只在 macOS 上可用。非 macOS 环境下插件照常工作，只是少了按名字寻址。

---

## 输入通道

每个动作按顺序尝试，成功即停：

| 顺序 | 通道 | 事件由谁产生 | 前提 |
| --- | --- | --- | --- |
| 1 | **CDP** | 浏览器输入管线：`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` | 扩展的 `debugger` 权限 |
| 2 | **原生** | macOS：AX `AXPress`、`CGEvent.postToPid`、全局 tap | 辅助功能授权 + 编译器 |
| 3 | **合成** | 页面内 `dispatchEvent` | 无 |

**CDP 是主干。** 事件序列与真人一致（`pointerover → pointermove → pointerdown → mousedown(buttons=1, detail=1) → pointerup → mouseup → click`），不需要 Chrome 在前台，也不会切换你的标签页。系统鼠标一动不动 —— 按下、移动、抬起全在浏览器内部完成。

**原生通道补位**那些 CDP 够不着的：按名字定位元素（走辅助功能语义树）、按名字滚动到某个元素、以及页面禁止调试的场合。

**合成通道是兜底。** 返回值里会明写 `synthetic`，不会假装成功。

### 原生通道的能力与代价

| 操作 | 实现 | 可信 | 碰系统光标 | 需要 Chrome 在前台 |
| --- | --- | --- | --- | --- |
| 点击 | AX `AXPress` | ✅ | 不会 | 否 |
| 输入文字 | AX 聚焦 + 逐字符 `postToPid` 键盘事件 | ✅ | 不会 | 否 |
| 滑块 | AX 聚焦 + 方向键 / `AXIncrement` | ✅ | 不会 | 否 |
| 滚到某个元素 | AX `AXScrollToVisible` | ✅ | 不会 | 否 |
| 翻页滚动 | 聚焦网页后发 PageDown / PageUp / Home / End | ✅ | 不会 | 否 |
| 拖拽 | 全局 `CGEvent` 按下 → 拖动 → 抬起 | ✅ | 会（结束复位） | 是 |

拖拽是唯一绕不过全局事件的：`postToPid` 投递的按下拿不到窗口内坐标，落不到网页上（试过 `CGAssociateMouseAndMouseCursorPosition(false)`，光标照样被带走）。工具会在拖拽前后隐藏光标并复位到原处。

**走 CDP 没有这个问题。** 拖拽的按下、移动、松开全在浏览器里，系统光标一动不动 —— 这是把 CDP 做主干的原因之一。

按名字操作会把标签页切到前台（Chrome 只对当前标签页暴露无障碍树）；按 `index` 或坐标走 CDP，不动你的前台窗口。

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `chrome_tabs` | 列出可操作的标签页，拿 `tabId` |
| `chrome_snapshot` | 页面快照：标题、URL、标题层级、编号的可交互元素、正文、滚动位置 |
| `chrome_click` | 点击。给 `index`（快照编号）或 `name`（页面上的文字 / 标签 / 占位提示） |
| `chrome_click_at` | 按视口坐标点击 |
| `chrome_type` | 输入文字。给 `index` 或 `name`；`replace` 先清空，`pressEnter` 提交 |
| `chrome_press` | 按键：Enter、Escape、Tab、方向键、Home/End/PageUp/PageDown、字母与数字，可带 `cmd` / `shift` / `alt` / `ctrl` |
| `chrome_drag` | 拖拽。起点 `name` / `index` / `fromX`+`fromY`，终点 `toName` / `toX`+`toY` / `dx`+`dy` |
| `chrome_scroll` | 滚动：`to: "top" \| "bottom"`、`name` 滚到某个元素、或 `amount` 像素 |
| `chrome_query` | CSS 选择器查询，可读表单控件的**实时值** |
| `chrome_wait` | 等选择器命中或文本出现（最多 15 秒） |
| `chrome_open` | 用给定 URL 打开标签页 |
| `chrome_screenshot` | 截图存到 `~/.dsh/chrome-tab-shots/`，返回路径 |

所有工具都接受可选的 `tabId`，省略时用最近一次 `@` 选中的标签页。

### 按名字操作，不用先数编号

`chrome_snapshot` 的编号只在那一次快照里有效，页面一变就废了。多数时候让模型直接表达意图更省事：

```
chrome_click  { name: "登录" }
chrome_type   { name: "搜索", text: "茅台", pressEnter: true }
chrome_scroll { name: "页脚" }
```

`name` 匹配的是 Chrome 暴露给辅助功能的那棵语义树：按钮文字、链接文字、`aria-label`、输入框占位提示。带图标字体的导航项（`\ue619 首页`）会被剥成可读文字，按「首页」就能找到。

`index` 属于快照，`name` 属于无障碍树，两套编号不要混用。找不到名字时再退回 `chrome_snapshot` + `index`。

---

## 可见指针

每次操作都会在页面上画一个指针：滑到目标、按下（压暗 + 涟漪）、松手，松开后留在原地轻轻浮动。

它是页面里的一个 DOM 元素（`#__dsh_ai_cursor`），不是系统光标：

- `position: fixed`、`pointer-events: none`、`z-index: 2147483647`
- 长在网页里，所以：校验 `isTrusted` 的代码看不到它，`document.elementFromPoint` 也不会命中它
- 只可能出现在 Chrome 的页面区域内，浮不到别的应用上面
- 你真实的鼠标不动，也不影响你自己用鼠标

黑色实体 + 白色描边 + 一层柔光：深色网页靠白边分辨，浅色网页靠灰影分辨。

---

## 架构

```
DSH Host (Cordis plugin)                Chrome (MV3 extension)
  index.js   工具 + HTTP 路由   <──ws──>  background.js
  bridge.js  零依赖 WebSocket 服务端      固定页面函数表
  client.js  @ 菜单 source                  ↑ chrome.scripting.executeScript
                                          用户当前标签页
```

- **`bridge.js`** 自己实现 WebSocket 握手与帧编解码。DSH 不想为这个功能引入第三方依赖。只接受 `Origin: chrome-extension://…` 的连接，`Sec-WebSocket-Accept` 按 RFC 校验。
- **端口**：Host 依次尝试 `30795`–`30805`，扩展每 30 秒（`chrome.alarms`）重连一次。多个 Harness 并存时，扩展挑 `startedAt` 最新的那个桥。
- **扩展侧不解释宿主代码**：MV3 禁止扩展页 `eval` / `new Function`，所以每个页面操作都是扩展里的一个具名函数，通过 `executeScript({ func, args })` 序列化执行。宿主永远只发方法名。
- **`@` 菜单**：`client.js` 通过 `ctx.get('inputTriggers').registerSource()` 注册一个 `@` source，`codec.serialize` 的输出就是进入 prompt 的文本 —— 把 `tabId` 送到模型眼前的唯一通道。

---

## 测试

```bash
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

`native.mjs` 会真的去点 Chrome 窗口里的像素，需要能读写的桌面会话，跑之前先起探针页：

```bash
node test/serve-probe.mjs &
node test/native.mjs
```

没有辅助功能授权时它会 SKIP，而不是假装通过。

`e2e.mjs` 用 CDP `Extensions.loadUnpacked` 装载 `extension/` 的一份副本，不需要手动装扩展，也不依赖外网。副本的 `HOST_PORTS` 会被钉成本次运行实际绑定的端口 —— 否则扩展会去连你正在用的那个 DSH 实例，测试永远等不到连接。启动 Chrome 时带 `--no-sandbox`：在已经持有沙箱的父进程里，Chrome 自己的沙箱初始化不了，渲染进程会反复崩，页面脚本不执行、扩展 worker 也不应答。

---

## 排障：连不上

扩展每 30 秒探测一次 `30795`–`30805`，`GET /dsh-chrome-tab/config` 返回的 `startedAt` 决定它挑哪个桥。装好了还连不上，通常是这两件事：

**端口上挂着没人驱动的旧桥。** 插件热重载时，旧实例的 WebSocket 长连接让 `server.close()` 的回调永不触发，端口留在那儿，`connected` 还是 `true`。

```bash
for p in $(seq 30795 30805); do
  printf "%-6s " "$p"
  curl -s --max-time 2 "http://127.0.0.1:$p/dsh-chrome-tab/config" || echo "（无监听）"
  echo
done
```

再对比当前 DSH 实例认的那个：

```bash
curl -s http://127.0.0.1:<DSH 端口>/dsh-chrome-tab/status
```

两个 `wsUrl` 不一样就是踩到了。**重启 DSH** 能彻底清掉（新进程从 30795 重新绑）。插件自己也会判断：`@` 菜单和 `chrome_tabs` 连不上时会先探兄弟端口，发现扩展挂在别的桥上会直说「扩展连在旧实例上（端口 30795）」，而不是让你再装一遍扩展。

**扩展还在跑旧代码。** 改过 `extension/` 之后，`~/.dsh/chrome-tab-extension/` 会在插件启动时刷新，但 Chrome 里已加载的副本要手动重载才生效（`chrome://extensions` → 该扩展的刷新图标）。

两件都想确认，点扩展图标：弹窗里就是它当前认为的桥地址和连接状态，也可以点「立即重连」。

---

## License

MIT
