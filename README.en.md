# dsh-chrome-tab

Let DeepSeek Harness read and drive the Chrome tab you are actually using. The input events come from the browser itself, so `isTrusted` is `true` on the page.

**English** | [中文](README.md)

## Why this has to be an extension

The DOM of a live tab is only reachable by code running inside that Chrome. All three external routes are closed:

- Chrome is not started with `--remote-debugging-port`, so no outside process can open a CDP connection
- macOS TCC forbids other processes from reading Chrome's profile directory (`~/Library/Application Support/Google/Chrome`)
- AppleScript control of Chrome needs Automation permission, and the call is rejected outright (`-10004`)

So the project is two halves: a **Harness plugin** that provides the `@` menu and the `chrome_*` tools, and an **MV3 extension** that actually touches the page. They talk over a local WebSocket on a port you never have to type.

## Install

> **Install the Harness plugin first, then load the extension in Chrome, then grant permissions.** If one step is missing, `chrome_tabs` tells you which.

### 1. Install the Harness plugin

Pick one.

**Let an agent do it (recommended)** — send this to the agent you are talking to:

```text
Install the DSH plugin dsh-chrome-tab from https://github.com/LouXiaXiaoHei/dsh-chrome-bridge
```

**GitHub (always current)**

```sh
dsh plugin --profile desktop add github:LouXiaXiaoHei/dsh-chrome-bridge
```

**Local development**

```sh
dsh plugin --profile desktop add link:/path/to/dsh-chrome-bridge
```

> `desktop` is the default profile of the desktop app; substitute your profile name if you use another one. You can also install from **Settings → Plugins** without touching the command line.

### 2. Load the extension in Chrome

On startup the plugin unpacks the extension to `~/.dsh/chrome-tab-extension/` and refreshes it file by file to match the current build. If that directory is not writable (sandbox, permissions), it falls back to the `extension/` directory inside the plugin itself — the message returned by `chrome_tabs` names the path it actually used.

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick that directory.

> Chrome 156 and later ignore the `--load-extension` flag, so this manual step is required once. Chrome remembers it afterwards.

The extension needs no port: it probes `30795`–`30805` every 30 seconds and attaches to the bridge with the newest start time, so it follows the newest Harness instance when several are running.

### 3. Grant permissions

The `debugger` permission comes with the extension — Chrome shows no extra prompt. After you edit anything under `extension/`, click the extension's reload icon on `chrome://extensions` for it to take effect.

The native channel exists only on macOS and needs two things:

- **Accessibility permission**: System Settings → Privacy & Security → Accessibility, and tick the app running DSH (the terminal, if you launch it from a shell)
- **Xcode command line tools**: `xcode-select --install`. On first use the plugin compiles `mac/axdriver.swift` to `~/.dsh/chrome-tab-native/axdriver` and reuses it while the source is unchanged; a prebuilt `mac/axdriver` inside the plugin directory is used as is

> These two only affect the native channel. Without them the plugin still works — the CDP channel does not need them — and results state which channel was used instead of pretending otherwise.
>
> **Windows and Linux have no native channel and need neither.** There the CDP channel handles every click, keystroke, drag and scroll.

### Verify

```text
chrome_tabs
```

A list of tabs means you are connected. If not, see [Troubleshooting](#troubleshooting-cannot-connect).

## What it can do

Mention a tab with `@`, then say what you want. The model can read the page structure (title, URL, heading outline, numbered interactive elements, body text, scroll position), find elements by name, `aria-label` or placeholder, then click, double-click, click a coordinate, type, press key combinations, drag, scroll, wait for the page to change, take screenshots, and open tabs.

```
chrome_click  { name: "Sign in" }
chrome_type   { name: "Search", text: "acme", pressEnter: true }
chrome_scroll { name: "Footer" }
```

Names outlive numbers: the indices from `chrome_snapshot` are valid only for that one snapshot and die as soon as the page changes. `name` matches Chrome's accessibility tree — button labels, link text, `aria-label`, input placeholders — and icon-font navigation entries (`\ue619 Home`) are stripped down to readable text.

> `index` belongs to a snapshot, `name` belongs to the accessibility tree. Do not mix them. Fall back to `chrome_snapshot` + `index` only when a name cannot be found.

| Tool | What it does |
| --- | --- |
| `chrome_tabs` | List operable tabs and their `tabId` |
| `chrome_snapshot` | Page snapshot: title, URL, heading outline, numbered interactive elements, body text, scroll position |
| `chrome_click` | Click by `index` (snapshot number) or `name` |
| `chrome_move` | Move the pointer to an `index` or `x`+`y` without clicking — hover, reveal tooltips, make the motion visible |
| `chrome_click_at` | Click a viewport `x`+`y`, or a snapshot `index` directly |
| `chrome_type` | Type text by `index` or `name`; `replace` clears first, `pressEnter` submits |
| `chrome_press` | Press a key: Enter, Escape, Tab, arrows, Home/End/PageUp/PageDown, letters and digits, with `cmd` / `shift` / `alt` / `ctrl` |
| `chrome_drag` | Drag from `name` / `index` / `fromX`+`fromY` to `toName` / `toX`+`toY` / `dx`+`dy` |
| `chrome_scroll` | Scroll with `to: "top" \| "bottom"`, scroll `name` into view, or scroll by `amount` pixels |
| `chrome_query` | CSS selector query that can read live form values |
| `chrome_wait` | Wait for a selector or text to appear (up to 15 seconds) |
| `chrome_open` | Open a URL in a tab |
| `chrome_screenshot` | Screenshot with numbered boxes drawn over the interactive elements (`marks: false` to turn that off); saved under `~/.dsh/chrome-tab-shots/` and handed to the model as an image |

Every tool accepts an optional `tabId` and defaults to the tab you mentioned last with `@`.

## Which channel the input takes

Most browser automation calls `dispatchEvent` inside the page, where `isTrusted` is always `false`: anti-bot scripts spot it in one line, sliders and drags do not respond at all, and rich text editors ignore it.

Each action tries two channels in order and stops at the first success:

| # | Channel | Where the event comes from | Requires |
| --- | --- | --- | --- |
| 1 | CDP | The browser's own input pipeline: `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` | The extension's `debugger` permission |
| 2 | Native | macOS process-level delivery: AX `AXPress`, `CGEvent.postToPid`, a global tap | macOS only + Accessibility permission + a compiler |

**CDP is the main path.** The event sequence matches a real click (`pointerover → pointermove → pointerdown → mousedown(buttons=1, detail=1) → pointerup → mouseup → click`), it works while Chrome is in the background, it never switches your tab, and the system pointer does not move — press, move and release all happen inside the browser.

**The native channel covers** what CDP cannot reach: semantics that only live in the accessibility tree (scrolling an element into view by name) and pages where debugging is blocked. Clicking and typing by name now go through CDP first — the page is scored on `aria-label`, placeholder and visible text, and the resulting point is clicked for real — so they work on Windows too, and the on-page pointer still glides to the target and presses.

| Native operation | Implementation | Trusted | Moves the system pointer | Needs Chrome in front |
| --- | --- | --- | --- | --- |
| Click | AX `AXPress` | Yes | No | No |
| Type text | AX focus + per-character `postToPid` key events | Yes | No | No |
| Slider | AX focus + arrow keys / `AXIncrement` | Yes | No | No |
| Scroll to element | AX `AXScrollToVisible` | Yes | No | No |
| Page scroll | Focus the web area, send PageDown / PageUp / Home / End | Yes | No | No |
| Drag | Global `CGEvent` press → drag → release | Yes | Yes (restored after) | Yes |

Drag is the one case that cannot avoid global events: a press delivered through `postToPid` carries no in-window position and never lands on the page (`CGAssociateMouseAndMouseCursorPosition(false)` does not stop the pointer being pulled along either). The driver hides the cursor for the duration and puts it back afterwards. **Drag over CDP has none of this problem**, which is one more reason CDP is the main path.

The in-page `dispatchEvent` path is gone: it bypasses the pointer, its events have `isTrusted === false`, and it amounts to pretending to work behind your back. When both real channels fail, the tool reports the failure instead of quietly routing around it.

> Name-based actions bring the tab to the front only when CDP cannot find the name either, because Chrome only exposes the accessibility tree of the active tab. Actions by `index` or coordinate go over CDP and leave your front window alone.

## Look first, then act

The tools no longer ask the model to guess what the page looks like. Every step is read the elements, look at the picture, then act.

1. `chrome_snapshot` reads the page and gives each interactive element a number plus its viewport coordinate (`@x,y`, tagged `(above)` / `(below)` / `(partly offscreen)` when it is out of view).
2. `chrome_screenshot` screenshots the tab with those same elements boxed and numbered (the boxes are removed right after the shot), and hands the image to the model directly while also saving it under `~/.dsh/chrome-tab-shots/`.
3. Act: `chrome_click` / `chrome_type` take an index or a name, `chrome_move` / `chrome_click_at` / `chrome_drag` take coordinates. The points you measure on the image and the coordinates in the snapshot are the same space (viewport CSS pixels).

The boxes are red with a number in the top-left corner and match the numbering from `chrome_snapshot`, so "7 on the image" is "7 in the snapshot".
## The pointer on the page

The moment a tab is taken over, the pointer appears on the page: it lands in the middle of the viewport and ripples once. It then stays for the whole takeover — gliding to the target, pressing (darkened, with a ripple), releasing. Navigate to a new page or let a framework replace the DOM, and it is put back; it only leaves when the takeover moves to another tab or the debugger channel drops.

**It is the only hand.** Clicks, typing, keys, drags and scrolls never go around it: every action first glides the pointer to the target point, presses, emits the CDP event at that same coordinate, then releases. The glide is a frame-by-frame animation inside the page (`requestAnimationFrame` + ease-in-out), not a CSS transition, so the host knows when it has actually landed and waits for that before pressing — the arrow you see is where the event happens.

It signals the state "this tab is being driven", not a decoration drawn for one tool call.

It is a DOM element (`#__dsh_ai_cursor`), not the system cursor. The plugin stacks no window on your screen and never moves the real pointer for you:

- `position: fixed`, `pointer-events: none`, `z-index: 2147483647`
- It lives inside the page, so code checking `isTrusted` never sees it and `document.elementFromPoint` never hits it
- It can only appear inside Chrome's page area and never floats above another app
- Your real pointer does not move and you can keep using the mouse yourself

Black fill, white outline, a soft glow: readable on dark pages thanks to the outline, on light pages thanks to the shadow.

## Updating

The extension follows the plugin: on startup the plugin refreshes `extension/` into `~/.dsh/chrome-tab-extension/`, then you click the extension's reload icon on `chrome://extensions` once.

If `mac/axdriver.swift` changes, it is recompiled on next use (mtime comparison), so there is no stale binary to delete by hand.

The Harness plugin itself is updated through plugin management.

## Tests and development

```sh
node test/bridge.test.js    # 11  dependency-free WS server: handshake, round trip, concurrency, disconnect
node test/host.test.js      # 44  apply() against a fake ctx: effects, tools, routes
node test/client.test.js    # 24  the @ source under vm: candidates, filtering, pick, serialization, disconnect reasons
node test/contract.test.js  # 44  source comparison: method names, ports, paths, tool set on both sides
node test/e2e.mjs           # 26  real Chrome + real extension + local fixture, end to end
node test/beacon.mjs        # 8   with two bridges alive, the extension must move to the newest
node test/smoke.mjs [url]   # 5   a real site (bilibili by default) to see what the model actually reads
node test/native.mjs [url]  # 11  native channel against real Chrome + accessibility permission
node test/cdp-probe.mjs         in-page pointer + CDP event trust (needs the probe server and a debug port)
```

`native.mjs` really clicks pixels in a Chrome window, so it needs a desktop session it can read and write. Start the probe page first:

```sh
node test/serve-probe.mjs &
node test/native.mjs
```

Without accessibility permission it SKIPs rather than reporting a fake pass.

`e2e.mjs` loads a copy of `extension/` through CDP `Extensions.loadUnpacked`, so it needs no manual install and no network. The copy's `HOST_PORTS` is pinned to the port this run actually bound — otherwise the extension would connect to the DSH instance you are using and the test would wait forever. It starts Chrome with `--no-sandbox`: inside a parent process that already holds a sandbox (an agent harness, for instance), Chrome's own sandbox fails to initialise, the renderer crash-loops, page scripts never run and the extension worker never answers.

`cdp-probe.mjs` also needs the probe page, plus a separate Chrome with a debug port:

```sh
node test/serve-probe.mjs &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/ct --remote-debugging-port=9334 --no-sandbox about:blank &
node test/cdp-probe.mjs
```

When working on the extension you do not need a store build: enable Developer mode on `chrome://extensions`, load this repository's `extension/` directory, and hit reload after each edit.

## Troubleshooting: cannot connect

The extension probes `30795`–`30805` every 30 seconds and picks the bridge with the newest `startedAt` from `GET /dsh-chrome-tab/config`. If it still will not connect, it is usually one of these two.

**A dead bridge is holding the port.** On plugin hot reload, the old instance's long-lived WebSocket keeps `server.close()`'s callback from ever firing, so the port stays bound and `connected` stays `true`.

```sh
for p in $(seq 30795 30805); do
  printf "%-6s " "$p"
  curl -s --max-time 2 "http://127.0.0.1:$p/dsh-chrome-tab/config" || echo "(no listener)"
  echo
done
```

Compare with the one your DSH instance knows about:

```sh
curl -s http://127.0.0.1:<DSH port>/dsh-chrome-tab/status
```

Different `wsUrl` means you hit it. **Restart DSH** to clear it (a new process binds from 30795 again).

> The plugin checks this itself: when the `@` menu or `chrome_tabs` cannot connect, it probes sibling ports first and says "the extension is attached to an older instance (port 30795)" instead of telling you to install the extension again.

**The extension is running old code.** After editing `extension/`, `~/.dsh/chrome-tab-extension/` is refreshed on plugin startup, but the copy Chrome loaded needs a manual reload (`chrome://extensions` → the extension's reload icon).

To check both at once, click the extension icon: the popup shows the bridge address and connection state it currently believes in, and has a "Reconnect now" button.

Other cases:

- The tool says accessibility is not granted: System Settings → Privacy & Security → Accessibility, tick the app running DSH
- The tool says the native driver is unavailable: install the Xcode command line tools (`xcode-select --install`) and retry; the plugin compiles on demand
- A "dsh-chrome-tab is debugging this browser" bar appears: that is the fixed notice for the `debugger` permission, expected, and harmless

## Current limitations

**Ordinary HTTP(S) pages only.** `chrome://`, `file://` and extension pages cannot be injected, and `chrome_snapshot` says so outright.

**Top-level document only.** Injection does not set `allFrames`, so elements inside cross-origin iframes are out of reach. `chrome_query` can still inspect a same-origin iframe, but click coordinates are relative to the top-level viewport.

**Name-based actions switch tabs only as a fallback.** When CDP cannot find the name either, the lookup falls back to the accessibility tree, and Chrome only exposes that for the tab it is showing — which brings it forward. Actions by `index` or coordinate never do.

**Native drag moves the real pointer.** It is restored afterwards. Drag over CDP does not move it.

**Snapshots are capped.** `chrome_snapshot` lists at most 60 interactive elements and 20,000 characters of body text; the accessibility tree is capped at 3,000 nodes, so very large pages can lose elements at the end.

**Do not drive one tab concurrently.** Tool calls are sequential, but if you fire several `chrome_*` calls at once they interleave on the same tab and the outcome gets hard to predict.

**`chrome_query` reads live values but runs no page script.** It does CSS selection plus attribute/text reads, not arbitrary evaluation — use `chrome_click` to act on what you find.

**Screenshots are the viewport.** Not a full-page capture, and whether the model can understand them depends on the model.

**Page content is untrusted data.** A page saying "ignore your previous instructions" or "visit this address" is not user authorisation, and the model should not act on it.

## Architecture

```
Harness Host (Cordis plugin)            Chrome (MV3 extension)
  index.js   tools + HTTP routes  <──ws──>  background.js
  bridge.js  dependency-free WS server      fixed page-function table
  client.js  @ menu source                    ↑ chrome.scripting.executeScript
                                              the user's active tab
```

- **`bridge.js`** implements the WebSocket handshake and frame codec itself — Harness would rather not pull in a dependency for this one feature. It only accepts `Origin: chrome-extension://…` connections and verifies `Sec-WebSocket-Accept` against RFC 6455.
- **Port discovery**: the host tries `30795`–`30805` in order; the extension reconnects every 30 seconds via `chrome.alarms`.
- **The extension never interprets host code**: MV3 forbids `eval` / `new Function` on extension pages, so every page operation is a named function in the extension, serialised through `executeScript({ func, args })`. The host only ever sends method names.
- **The `@` menu**: `client.js` registers an `@` source through `ctx.get('inputTriggers').registerSource()`, and `codec.serialize` produces the text that lands in the prompt — the only route by which a `tabId` reaches the model.

`mac/axdriver.swift` is a resident process speaking line-delimited JSON in and out, started on demand by `mac/driver.js`. It walks the accessibility tree depth-first, clicks with `AXPress`, types with `CGEvent.postToPid`, and drags with global taps.

## License

MIT
