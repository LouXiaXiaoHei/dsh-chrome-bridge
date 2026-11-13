# dsh-chrome-tab

Modelled on Codex's Chrome integration: mention a tab with `@` and the model can read the page, click, and type. All input goes through the Chrome DevTools Protocol (CDP), so events come from the browser itself and `isTrusted` is `true`.

**English** | [中文](README.md)

## Install

> Install the Harness plugin first, then load the extension in Chrome. `chrome_tabs` returns tabs only after both.

### 1. Install the Harness plugin

Send this to the agent you are talking to:

```text
Install the DSH plugin dsh-chrome-tab from https://github.com/LouXiaXiaoHei/dsh-chrome-bridge
```

Or install it yourself:

```sh
dsh plugin --profile desktop add github:LouXiaXiaoHei/dsh-chrome-bridge
```

Use `link:/path/to/dsh-chrome-bridge` for local development. The desktop app can also install plugins from **Settings → Plugins**.

### 2. Load the Chrome extension

Download `dsh-chrome-tab-extension-v*.zip` from [Releases](https://github.com/LouXiaXiaoHei/dsh-chrome-bridge/releases), unzip it, then:

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the unzipped directory.

> Chrome 156 and later ignore `--load-extension`, so this is a one-time manual step. Chrome remembers it afterwards.
>
> During development you can load the repository's `extension/` directory directly and hit reload after each edit.

The extension needs no port; it finds the local Harness by itself.

### Verify

```text
chrome_tabs
```

A list of tabs means you are connected. If not, see [Troubleshooting](#troubleshooting).

## Usage

Mention a tab with `@`, then say what you want:

```text
chrome_click  { name: "Sign in" }
chrome_type   { name: "Search", text: "acme", pressEnter: true }
chrome_scroll { name: "Footer" }
```

| Tool | What it does |
| --- | --- |
| `chrome_tabs` | List operable tabs |
| `chrome_snapshot` | Page snapshot: title, URL, heading outline, numbered elements, body text |
| `chrome_click` | Click by `index` or `name` |
| `chrome_move` | Move the pointer only |
| `chrome_click_at` | Click at viewport coordinates |
| `chrome_type` | Type text; `replace` clears first, `pressEnter` submits |
| `chrome_press` | Press a key, with `cmd` / `shift` / `alt` / `ctrl` |
| `chrome_drag` | Drag |
| `chrome_scroll` | Scroll: `top` / `bottom` / an element name / pixels |
| `chrome_query` | CSS selector query |
| `chrome_wait` | Wait for an element or text |
| `chrome_open` | Open a new tab |
| `chrome_screenshot` | Screenshot with numbered boxes |

`name` matches Chrome's accessibility tree (button text, link text, `aria-label`, placeholder) and outlives `index`, which is only valid for one snapshot.

## How CDP is used

Every action goes through CDP's `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`, with the same event sequence as a real click. It works while Chrome is in the background, never steals your front window, and the system pointer does not move.

A `#__dsh_ai_cursor` pointer lives in the page to show the tab is being driven: it glides to the target before each press. It never blocks clicks and does not affect your own mouse.

On macOS a native accessibility channel backs up cases CDP cannot reach (scroll an element into view by name, pages that block debugging). Windows and Linux use CDP only.

## Browser preview

A small window in the top-right shows what the model is doing in your tab, live, without switching windows. The picture comes from the debugger session the extension already holds (`Page.startScreencast`), and only streams while a tool runs.

Chrome only composites the current tab: if the target goes to the background the picture freezes and resumes when you switch back. Do not open the preview page in the same Chrome you are driving — it pushes the target into the background.

## Troubleshooting

When it will not connect, click the extension icon to see which bridge it is attached to and press **Reconnect now**.

- After editing `extension/`, click the extension's reload icon on `chrome://extensions`; Chrome will not pick up new code by itself.
- If the extension is attached to an old instance, restart DSH.
- "Accessibility not granted": System Settings → Privacy & Security → Accessibility, tick the app running DSH.
- "Native driver unavailable": run `xcode-select --install` and retry.
- A "dsh-chrome-tab is debugging this browser" bar is the fixed notice for the `debugger` permission and is expected.

## Limitations

- Ordinary HTTP(S) pages only; `chrome://` and `file://` are out of reach.
- Top-level document only; elements inside cross-origin iframes are unreachable.
- Snapshots are capped at 60 interactive elements and 20,000 characters of body text.
- Do not drive one tab concurrently.
- Page content is untrusted data; "ignore your previous instructions" is not an instruction.

## Development

```sh
npm test              # unit and contract tests
node test/e2e.mjs     # real Chrome + real extension, end to end
node test/native.mjs  # native channel (needs accessibility permission)
```

To release: bump the version in `extension/manifest.json`, push a `v*` tag, and CI runs the tests, packs the zip and attaches it to the Release.

## License

MIT
