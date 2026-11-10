// axdriver — macOS 侧输入执行器，供 DSH Chrome 插件通过 stdin/stdout 的 JSON Lines 协议调用。
//
// 设计要点（均经实测确认）：
//  * 点击走 AX kAXPressAction：浏览器内部生成完整事件链，isTrusted=true，不动真实光标，不抢前台。
//  * 输入走「AX 聚焦 + CGEvent.postToPid 逐字符 unicode」，同样 isTrusted=true 且不动光标。
//  * 滚动走「AX 聚焦 WebArea + postToPid PageDown/Home/End」，或对具体元素 AXScrollToVisible。
//  * 拖拽必须用 CGEvent.post(tap:.cghidEventTap)：实测 postToPid 的 leftMouseDown/Up 永远不会被路由到窗口。
//    全局 tap 会把真实光标移到目标点，因此执行前隐藏光标、执行后复位，视觉上无感。
//
// 协议：每行一个 JSON 请求 {"id":N,"cmd":"click","params":{...}}，回复每行一个 {"id":N,"ok":true,"result":{...}}。

import AppKit
import ApplicationServices
import Foundation

let VERBOSE = ProcessInfo.processInfo.environment["AXDRIVER_VERBOSE"] == "1"

// MARK: - 输出

let stdoutHandle = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    outLock.lock()
    stdoutHandle.write(line.data(using: .utf8)!)
    outLock.unlock()
}

func reply(_ id: Any?, _ result: [String: Any]) {
    var body = result
    body["id"] = id ?? NSNull()
    body["ok"] = true
    emit(body)
}

func fail(_ id: Any?, _ message: String, code: String = "error") {
    emit(["id": id ?? NSNull(), "ok": false, "code": code, "error": message])
}

func log(_ s: String) {
    guard VERBOSE else { return }
    FileHandle.standardError.write(("[axdriver] " + s + "\n").data(using: .utf8)!)
}

// MARK: - AX 基础

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
    return v
}

func strAttr(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name) as? String
}

func role(_ el: AXUIElement) -> String {
    strAttr(el, kAXRoleAttribute as String) ?? ""
}

func subrole(_ el: AXUIElement) -> String {
    strAttr(el, kAXSubroleAttribute as String) ?? ""
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var b: DarwinBoolean = false
    let err = AXUIElementIsAttributeSettable(el, name as CFString, &b)
    return err == .success && b.boolValue
}

func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func hasAction(_ el: AXUIElement, _ name: String) -> Bool {
    actions(el).contains(name)
}

/// AX 元素的全局屏幕矩形（左上原点，与 CGEvent 同坐标系）。
func frameOf(_ el: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success
    else { return nil }
    var pos = CGPoint.zero
    var size = CGSize.zero
    guard let pv = posRef, CFGetTypeID(pv) == AXValueGetTypeID(),
          let sv = sizeRef, CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sv as! AXValue, .cgSize, &size)
    return CGRect(origin: pos, size: size)
}

// MARK: - 应用与窗口

func chromeApp() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier == "com.google.Chrome" || $0.bundleIdentifier == "com.google.Chrome.beta"
    }
}

func appElement(_ pid: pid_t) -> AXUIElement {
    let el = AXUIElementCreateApplication(pid)
    // Chrome 只有在这个属性打开时才会把网页内容暴露给 AX。
    AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    return el
}

struct WebContext {
    var app: NSRunningApplication
    var appEl: AXUIElement
    var window: AXUIElement
    var webArea: AXUIElement
    var origin: CGPoint        // AXWebArea 的全局原点（已是屏幕坐标）
    var size: CGSize
    var scrollArea: AXUIElement?
}

/// 找到目标 WebArea。titleHint 用于在多个标签页/窗口里挑一个（按标题子串匹配）。
/// Bring this window to the front of Chrome's own window stack.
///
/// Keyboard events posted to the process land in the key window, not in whichever
/// window the accessibility call named, so a second Chrome window sitting in front
/// would swallow the typing. Raising is a no-op when the target is already main.
func ensureMain(_ ctx: WebContext) {
    let main = attr(ctx.appEl, kAXMainWindowAttribute as String).map { $0 as! AXUIElement }
    if let current = main, CFEqual(current, ctx.window) { return }
    AXUIElementPerformAction(ctx.window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(ctx.window, kAXMainAttribute as CFString, kCFBooleanTrue)
    usleep(140_000)
}

func findWebContext(titleHint: String? = nil) -> WebContext? {
    guard let app = chromeApp() else { return nil }
    let appEl = appElement(app.processIdentifier)
    guard let windows = attr(appEl, kAXWindowsAttribute as String) as? [AXUIElement] else { return nil }
    var fallback: WebContext?
    var mainWindow: WebContext?
    // With several Chrome windows open the first one in AX order is arbitrary; the
    // window the user is actually looking at is the main one, so prefer it when no
    // title narrows the choice.
    let mainEl = attr(appEl, kAXMainWindowAttribute as String).map { $0 as! AXUIElement }
    for w in windows {
        // 深搜这个窗口里的 AXWebArea
        var webArea: AXUIElement?
        var scrollArea: AXUIElement?
        func walk(_ el: AXUIElement, _ depth: Int) {
            if webArea != nil || depth > 40 { return }
            let r = role(el)
            if r == "AXWebArea" { webArea = el; return }
            if r == "AXScrollArea" && scrollArea == nil { scrollArea = el }
            for k in children(el) { walk(k, depth + 1) }
        }
        walk(w, 0)
        guard let wa = webArea, let f = frameOf(wa) else { continue }
        let title = strAttr(w, kAXTitleAttribute as String)
            ?? strAttr(wa, kAXTitleAttribute as String)
            ?? ""
        let ctx = WebContext(app: app, appEl: appEl, window: w, webArea: wa,
                             origin: f.origin, size: f.size, scrollArea: scrollArea)
        if let main = mainEl, CFEqual(main, w), mainWindow == nil { mainWindow = ctx }
        if let hint = titleHint, !hint.isEmpty {
            if title.localizedCaseInsensitiveContains(hint) { return ctx }
            if fallback == nil { fallback = ctx }
        } else {
            fallback = mainWindow ?? ctx
        }
    }
    return mainWindow ?? fallback
}

// MARK: - 元素收集

struct AXNode {
    var el: AXUIElement
    var role: String
    var title: String
    var value: String
    var desc: String
    var placeholder: String
    var frame: CGRect
    var actions: [String]
    var index: Int
}

let interactiveRoles: Set<String> = [
    "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXComboBox", "AXSlider", "AXMenuButton", "AXMenuItem",
    "AXTabGroup", "AXDisclosureTriangle", "AXSearchField", "AXSwitch", "AXToggle",
]

/// 图标字体在 AX 里是私用区字符（U+E000…U+F8FF），对模型毫无意义，一律当作空文本。
func isPrivateUse(_ s: String) -> Bool {
    guard !s.isEmpty else { return true }
    for u in s.unicodeScalars where !(u.value >= 0xE000 && u.value <= 0xF8FF) {
        if u.properties.isWhitespace { continue }
        return false
    }
    return true
}

/// 剥掉夹杂在文字里的图标字符，再把两端空白收紧。
func readable(_ s: String) -> String {
    guard !s.isEmpty else { return "" }
    let stripped = String(String.UnicodeScalarView(s.unicodeScalars.filter { !($0.value >= 0xE000 && $0.value <= 0xF8FF) }))
    return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
}

func textOf(_ n: AXNode) -> String {
    [n.title, n.value, n.desc, n.placeholder]
        .filter { !$0.isEmpty }
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func framesClose(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x - b.origin.x) <= 4 && abs(a.origin.y - b.origin.y) <= 4
        && abs(a.width - b.width) <= 8 && abs(a.height - b.height) <= 8
}

func collectNodes(_ wa: AXUIElement, maxNodes: Int = 3000) -> [AXNode] {
    var nodes: [AXNode] = []
    var counter = 0
    // Chrome 会把自己的悬浮按钮（切换页面翻译、设置、发送反馈…）挂进 AXWebArea 的子树里，
    // 它们的坐标在网页可视区之外。按可视区裁一刀，把这些与页面无关的节点挡在外面。
    let viewport = (frameOf(wa) ?? .zero).insetBy(dx: -8, dy: -8)
    func walk(_ el: AXUIElement, _ depth: Int) {
        if nodes.count >= maxNodes || depth > 60 { return }
        let r = role(el)
        let acts = actions(el)
        let f = frameOf(el) ?? .zero
        let title = readable(strAttr(el, kAXTitleAttribute as String) ?? "")
        let value = readable((attr(el, kAXValueAttribute as String) as? String)
            ?? (attr(el, kAXValueAttribute as String).map { "\($0)" } ?? ""))
        let desc = readable(strAttr(el, kAXDescriptionAttribute as String) ?? "")
        let placeholder = readable(strAttr(el, "AXPlaceholderValue") ?? "")
        let hasText = !(title.isEmpty && value.isEmpty && desc.isEmpty && placeholder.isEmpty)
        let looksInteractive = interactiveRoles.contains(r)
            || acts.contains("AXPress") || acts.contains("AXIncrement")
            || (r == "AXStaticText" && acts.contains("AXScrollToVisible"))
            || isSettable(el, kAXValueAttribute as String)
        // 去掉两类噪声：与相邻可交互元素同框同文的静态文本、完全无文本的静态文本。
        var duplicate = false
        if r == "AXStaticText" {
            if !hasText { duplicate = true }
            else {
                let mine = [title, value].filter { !$0.isEmpty }.joined(separator: " ")
                if mine.isEmpty { duplicate = true }
                else {
                    // 与最近的某个可交互节点同文、且被它框住（或几乎同框）时，这条静态文本只是它的影子。
                    for prev in nodes.suffix(6).reversed() where prev.role != "AXStaticText" {
                        let overlaps = framesClose(prev.frame, f) || prev.frame.insetBy(dx: -6, dy: -6).contains(f)
                        if overlaps {
                            let theirs = textOf(prev)
                            if !theirs.isEmpty && (theirs.contains(mine) || mine.contains(theirs)) { duplicate = true }
                            break
                        }
                    }
                }
            }
        }
        let bigEnough = f.width >= 2 && f.height >= 2
        let inViewport = viewport.isEmpty || viewport.contains(CGPoint(x: f.midX, y: f.midY))
        if looksInteractive && !duplicate && bigEnough && inViewport {
            counter += 1
            nodes.append(AXNode(el: el, role: r, title: title, value: value, desc: desc,
                                placeholder: placeholder, frame: f, actions: acts, index: counter))
        }
        for k in children(el) { walk(k, depth + 1) }
    }
    walk(wa, 0)
    return nodes
}

/// JSON 数字可能是 Int 也可能是 Double，统一取成 CGFloat。
func num(_ v: Any?) -> CGFloat? {
    if let d = v as? Double { return CGFloat(d) }
    if let i = v as? Int { return CGFloat(i) }
    if let n = v as? NSNumber { return CGFloat(n.doubleValue) }
    return nil
}

func looksLikeLabel(_ s: String) -> String {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count > 120 { return String(trimmed.prefix(120)) + "…" }
    return trimmed
}

func describe(_ n: AXNode) -> String {
    var parts = [n.role]
    if !n.title.isEmpty { parts.append("«\(looksLikeLabel(n.title))»") }
    if !n.value.isEmpty && n.value != n.title { parts.append("值=\(looksLikeLabel(n.value))") }
    if !n.placeholder.isEmpty && n.placeholder != n.title { parts.append("提示=\(looksLikeLabel(n.placeholder))") }
    if n.actions.contains("AXPress") { parts.append("可点") }
    if n.actions.contains("AXIncrement") || n.role == "AXSlider" { parts.append("可调") }
    return parts.joined(separator: " ")
}

/// 按「编号 | 名称」挑元素。name 做大小写不敏感包含匹配，命中多个时用 role 消歧。
func resolve(_ nodes: [AXNode], params: [String: Any]) -> AXNode? {
    if let idx = params["index"] as? Int {
        return nodes.first { $0.index == idx }
    }
    guard let raw = params["name"] as? String else { return nil }
    let needle = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return nil }
    let wantRole = (params["role"] as? String)?.uppercased()

    func roleMatches(_ n: AXNode) -> Bool {
        guard let w = wantRole, !w.isEmpty else { return true }
        let r = n.role.uppercased()
        if r.contains(w) { return true }
        // button / textbox / link 这类简称
        switch w {
        case "BUTTON": return r.contains("BUTTON")
        case "TEXT", "TEXTBOX", "INPUT": return r.contains("TEXT")
        case "LINK": return r.contains("LINK")
        case "SLIDER", "RANGE": return r.contains("SLIDER")
        default: return false
        }
    }

    let pool = nodes.filter(roleMatches)
    func score(_ n: AXNode) -> Int {
        let t = n.title
        let v = n.value
        let d = n.desc
        if t == needle { return 100 }
        if t.localizedCaseInsensitiveCompare(needle) == .orderedSame { return 95 }
        if t.localizedCaseInsensitiveContains(needle) { return 80 }
        let ph = n.placeholder
        if ph.localizedCaseInsensitiveContains(needle) { return 70 }
        if v.localizedCaseInsensitiveContains(needle) { return 50 }
        if d.localizedCaseInsensitiveContains(needle) { return 45 }
        return 0
    }
    let scored = pool.map { (n: $0, s: score($0)) }.filter { $0.s > 0 }
    return scored.max { $0.s < $1.s }?.n
}

// MARK: - 坐标命中

/// 从全局屏幕坐标取最深的 AX 元素。
func elementAt(_ appEl: AXUIElement, _ x: CGFloat, _ y: CGFloat) -> AXUIElement? {
    var hit: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(appEl, Float(x), Float(y), &hit)
    guard err == .success else { return nil }
    return hit
}

func nodeFor(_ el: AXUIElement, index: Int = 0) -> AXNode {
    let value = (attr(el, kAXValueAttribute as String) as? String)
        ?? (attr(el, kAXValueAttribute as String).map { "\($0)" } ?? "")
    return AXNode(el: el, role: role(el),
                  title: strAttr(el, kAXTitleAttribute as String) ?? "",
                  value: value,
                  desc: strAttr(el, kAXDescriptionAttribute as String) ?? "",
                  placeholder: strAttr(el, "AXPlaceholderValue") ?? "",
                  frame: frameOf(el) ?? .zero,
                  actions: actions(el), index: index)
}

/// 命中点后向上爬，找第一个满足条件的祖先（含自己）。
func climb(_ el: AXUIElement, limit: Int = 12, until test: (AXUIElement) -> Bool) -> AXUIElement? {
    var cur: AXUIElement? = el
    var steps = 0
    while let node = cur, steps < limit {
        if test(node) { return node }
        cur = attr(node, kAXParentAttribute as String).map { $0 as! AXUIElement }
        steps += 1
    }
    return nil
}

func pressable(_ el: AXUIElement) -> Bool {
    hasAction(el, "AXPress")
}

func focusableTarget(_ el: AXUIElement) -> Bool {
    isSettable(el, kAXFocusedAttribute as String)
}

func isTexty(_ el: AXUIElement) -> Bool {
    let r = role(el)
    if r == "AXTextField" || r == "AXTextArea" || r == "AXSearchField" || r == "AXComboBox" { return true }
    return isSettable(el, kAXValueAttribute as String) && !hasAction(el, "AXIncrement")
        && r != "AXSlider" && r != "AXCheckBox" && r != "AXRadioButton"
}

/// 从节点池里按坐标挑元素：命中点的候选按面积从小到大排序（最深的优先）。
/// 这比 AXUIElementCopyElementAtPosition 稳定：不依赖 Chrome 的 AX 树预热状态，
/// 而且与 tree 命令共享同一套编号，便于“编号/坐标”两种寻址方式彼此校验。
func candidates(_ nodes: [AXNode], _ p: CGPoint) -> [AXNode] {
    nodes
        .filter { $0.frame.contains(p) && $0.frame.width > 0 && $0.frame.height > 0 }
        .sorted { ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height) }
}

func pressTarget(in nodes: [AXNode], at p: CGPoint) -> (AXNode, String)? {
    for node in candidates(nodes, p) where node.actions.contains("AXPress") {
        return (node, "frame")
    }
    if let deepest = candidates(nodes, p).first { return (deepest, "frame-no-press") }
    return nil
}

func focusTarget(in nodes: [AXNode], at p: CGPoint) -> (AXNode, String)? {
    for node in candidates(nodes, p) where isSettable(node.el, kAXFocusedAttribute as String) || isTexty(node.el) {
        return (node, "frame")
    }
    if let deepest = candidates(nodes, p).first { return (deepest, "frame-no-focus") }
    return nil
}

// MARK: - 输入执行

final class Driver {
    let src = CGEventSource(stateID: .hidSystemState)

    // --- 点击 ---
    func press(_ node: AXNode) -> (Bool, String) {
        if hasAction(node.el, "AXPress") {
            let err = AXUIElementPerformAction(node.el, "AXPress" as CFString)
            return (err == .success, "AXPress err=\(err.rawValue)")
        }
        // 没有 AXPress 的控件（如 part 内的可点区域），退化为 AX 焦点 + 空格
        if isSettable(node.el, kAXFocusedAttribute as String) {
            _ = AXUIElementSetAttributeValue(node.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            return (true, "focused+space")
        }
        return (false, "元素既无 AXPress 也不可聚焦")
    }

    /// 只把焦点交给元素，不做任何输入。
    func focusOnly(_ node: AXNode) -> (Bool, String) {
        guard isSettable(node.el, kAXFocusedAttribute as String) else {
            return (false, "元素不可聚焦：\(node.role)")
        }
        let err = AXUIElementSetAttributeValue(node.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(40_000)
        return (err == .success, "focus err=\(err.rawValue)")
    }

    // --- 键盘 ---
    /// AX 的文本节点把字符数和选区都暴露成属性，可以直接设定。不要用 Cmd+A / End 代替：
    /// 那些按键在浏览器里走快捷键与 key handling 通道，Chrome 不在前台时会被直接丢掉，
    /// 于是「先清空再输入」会悄悄退化成追加。
    func characterCount(_ node: AXNode) -> Int {
        var value: AnyObject?
        if AXUIElementCopyAttributeValue(node.el, kAXNumberOfCharactersAttribute as CFString, &value) == .success,
           let number = value as? Int, number >= 0 {
            return number
        }
        return strAttr(node.el, kAXValueAttribute)?.utf16.count ?? 0
    }

    @discardableResult
    func select(_ node: AXNode, from location: Int, length: Int) -> Bool {
        var range = CFRange(location: location, length: length)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        return AXUIElementSetAttributeValue(node.el, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }

    /// 键入文字。append 为真时先把光标推到内容末尾，让新输入的字符接在已有内容之后，
    /// 而不是落在 AX 聚焦默认给出的起始位置（contenteditable 尤其如此）。
    func typeText(_ text: String, to node: AXNode? = nil, append: Bool = true) -> (Bool, String) {
        if let n = node {
            guard isSettable(n.el, kAXFocusedAttribute as String) else {
                return (false, "元素不可聚焦：\(n.role)")
            }
            let err = AXUIElementSetAttributeValue(n.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard err == .success else { return (false, "聚焦失败 err=\(err.rawValue)") }
            usleep(60_000)
            if append {
                // 光标落到内容末尾：设一个末尾的空选区，比发 End 键可靠。
                _ = select(n, from: characterCount(n), length: 0)
            }
        }
        guard let pid = currentPid else { return (false, "Chrome 未运行") }
        var typed = 0
        for ch in text {
            let s = String(ch)
            var units = Array(s.utf16)
            if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                down.postToPid(pid)
            }
            usleep(8_000)
            if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                up.postToPid(pid)
            }
            usleep(12_000)
            typed += 1
        }
        return (true, "投递 \(typed) 个字符")
    }

    func tapKey(_ code: CGKeyCode, flags: CGEventFlags = []) -> (Bool, String) {
        guard let pid = currentPid else { return (false, "Chrome 未运行") }
        if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
            down.flags = flags
            down.postToPid(pid)
        }
        usleep(25_000)
        if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
            up.flags = flags
            up.postToPid(pid)
        }
        usleep(35_000)
        return (true, "key \(code)")
    }

    // --- 拖拽：全局 tap（会移动光标，故全程隐藏光标并在结束时复位）---
    func drag(from: CGPoint, to: CGPoint, steps: Int = 14, onStep: ((CGPoint, Int) -> Void)? = nil) -> (Bool, String) {
        let home = CGEvent(source: nil)?.location ?? .zero
        // 全局 tap 的按下只落在最前面的窗口上：Chrome 在后台时事件会被别人吃掉。
        // 拖拽期间把 Chrome 提到前面，结束后把用户原来的应用还回去。
        let previous = NSWorkspace.shared.frontmostApplication
        var borrowed = false
        if let pid = currentPid, previous?.processIdentifier != pid,
           let chrome = NSRunningApplication(processIdentifier: pid),
           chrome.activate(options: [.activateAllWindows]) {
            borrowed = true
            usleep(260_000)
        }
        CGDisplayHideCursor(CGMainDisplayID())
        defer {
            CGWarpMouseCursorPosition(home)
            CGDisplayShowCursor(CGMainDisplayID())
            if borrowed { previous?.activate() }
        }
        func post(_ type: CGEventType, _ p: CGPoint, pressure: Int64) {
            guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
            e.setIntegerValueField(.mouseEventPressure, value: pressure)
            e.setIntegerValueField(.mouseEventClickState, value: 1)
            e.setIntegerValueField(.mouseEventButtonNumber, value: 0)
            e.post(tap: .cghidEventTap)
        }
        CGWarpMouseCursorPosition(from)
        usleep(60_000)
        post(.mouseMoved, from, pressure: 0)
        onStep?(from, 0)
        usleep(30_000)
        post(.leftMouseDown, from, pressure: 1)
        usleep(60_000)
        let n = max(2, steps)
        for i in 1...n {
            let f = Double(i) / Double(n)
            let p = CGPoint(x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f)
            post(.leftMouseDragged, p, pressure: 1)
            onStep?(p, i)
            usleep(16_000)
        }
        usleep(40_000)
        post(.leftMouseUp, to, pressure: 0)
        usleep(120_000)
        return (true, "拖拽 \(Int(from.x)),\(Int(from.y)) → \(Int(to.x)),\(Int(to.y))，\(n) 步")
    }

    // --- 滚动 ---
    func scrollToVisible(_ node: AXNode) -> (Bool, String) {
        let err = AXUIElementPerformAction(node.el, "AXScrollToVisible" as CFString)
        return (err == .success, "AXScrollToVisible err=\(err.rawValue)")
    }

    func scrollBy(lines: Int) -> (Bool, String) {
        // 用键盘滚动：聚焦 WebArea 后 PageDown/PageUp，Home/End 到头尾。
        guard let ctx = findWebContext() else { return (false, "找不到 WebArea") }
        _ = AXUIElementSetAttributeValue(ctx.webArea, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(50_000)
        let page = 121 as CGKeyCode  // PageDown
        let pageUp = 116 as CGKeyCode
        let home = 115 as CGKeyCode
        let end = 119 as CGKeyCode
        if lines == Int.min { _ = tapKey(home); return (true, "到顶") }
        if lines == Int.max { _ = tapKey(end); return (true, "到底") }
        let count = max(1, abs(lines))
        let code = lines >= 0 ? page : pageUp
        for _ in 0..<count { _ = tapKey(code) }
        return (true, "滚动 \(lines) 屏")
    }

    var currentPid: pid_t? { chromeApp()?.processIdentifier }
}

let driver = Driver()

// MARK: - 命令分派

func handle(_ req: [String: Any]) {
    let id = req["id"]
    guard let cmd = req["cmd"] as? String else { fail(id, "缺少 cmd"); return }
    let p = (req["params"] as? [String: Any]) ?? [:]

    switch cmd {
    case "ping":
        let trusted = AXIsProcessTrusted()
        let app = chromeApp()
        reply(id, ["axTrusted": trusted,
                   "chrome": app.map { ["pid": Int($0.processIdentifier), "name": $0.localizedName ?? ""] } as Any,
                   "version": "0.1.0"])

    case "windows":
        guard let app = chromeApp() else { fail(id, "Chrome 未运行", code: "no-chrome"); return }
        let appEl = appElement(app.processIdentifier)
        let wins = (attr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        var out: [[String: Any]] = []
        for w in wins {
            var webArea: AXUIElement?
            func walk(_ el: AXUIElement, _ d: Int) {
                if webArea != nil || d > 40 { return }
                if role(el) == "AXWebArea" { webArea = el; return }
                for k in children(el) { walk(k, d + 1) }
            }
            walk(w, 0)
            var info: [String: Any] = ["title": strAttr(w, kAXTitleAttribute as String) ?? ""]
            if let f = frameOf(w) { info["frame"] = [f.origin.x, f.origin.y, f.width, f.height] }
            if let wa = webArea {
                info["url"] = strAttr(wa, kAXURLAttribute as String) ?? ""
                info["webTitle"] = strAttr(wa, kAXTitleAttribute as String) ?? ""
                if let f = frameOf(wa) { info["webFrame"] = [f.origin.x, f.origin.y, f.width, f.height] }
            }
            out.append(info)
        }
        reply(id, ["windows": out])

    case "tree":
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
        }
        let nodes = collectNodes(ctx.webArea, maxNodes: (p["max"] as? Int) ?? 3000)
        let maxOut = (p["limit"] as? Int) ?? 200
        let list: [[String: Any]] = nodes.prefix(maxOut).map { n in
            var d: [String: Any] = [
                "index": n.index, "role": n.role,
                "title": looksLikeLabel(n.title),
                "actions": n.actions,
                "frame": [n.frame.origin.x, n.frame.origin.y, n.frame.width, n.frame.height],
            ]
            if !n.value.isEmpty { d["value"] = looksLikeLabel(n.value) }
            if !n.placeholder.isEmpty { d["placeholder"] = looksLikeLabel(n.placeholder) }
            return d
        }
        reply(id, ["origin": [ctx.origin.x, ctx.origin.y],
                   "size": [ctx.size.width, ctx.size.height],
                   "count": nodes.count,
                   "nodes": list])

    case "click":
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
        }
        let nodes = collectNodes(ctx.webArea)
        guard let node = resolve(nodes, params: p) else {
            fail(id, "没有匹配的元素：\(p["name"] ?? p["index"] ?? "?")", code: "no-match"); return
        }
        let (ok, detail) = driver.press(node)
        if ok {
            reply(id, ["element": describe(node), "detail": detail,
                       "frame": [node.frame.origin.x, node.frame.origin.y, node.frame.width, node.frame.height]])
        } else {
            fail(id, detail, code: "action-failed")
        }

    case "type":
        guard let text = p["text"] as? String else { fail(id, "缺少 text"); return }
        var node: AXNode?
        if p["name"] != nil || p["index"] != nil {
            guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
                fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
            }
            ensureMain(ctx)
            let nodes = collectNodes(ctx.webArea)
            guard let n = resolve(nodes, params: p) else {
                fail(id, "没有匹配的输入元素：\(p["name"] ?? "?")", code: "no-match"); return
            }
            node = n
        }
        var steps: [String] = []
        if p["replace"] as? Bool == true, let target = node {
            let (fok, fdetail) = driver.focusOnly(target)
            if fok {
                let length = driver.characterCount(target)
                _ = driver.select(target, from: 0, length: length)
            }
            steps.append(fdetail)
            usleep(40_000)
        }
        let (ok, detail) = driver.typeText(text, to: node, append: p["replace"] as? Bool != true)
        if ok {
            var out: [String: Any] = ["detail": detail, "chars": text.count, "target": node.map { describe($0) } as Any]
            if !steps.isEmpty { out["pre"] = steps }
            reply(id, out)
        } else { fail(id, detail, code: "type-failed") }

    /// 在全局屏幕坐标处命中元素并真实点击：DOM 侧给出视口坐标 + webArea 原点，这里完成投递。
    case "clickAt":
        guard let gx = num(p["x"]), let gy = num(p["y"]) else { fail(id, "缺少 x/y"); return }
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
        }
        let point = CGPoint(x: gx, y: gy)
        let nodes = collectNodes(ctx.webArea)
        guard let (node, how) = pressTarget(in: nodes, at: point) else {
            fail(id, "坐标 (\(gx),\(gy)) 处没有 AX 元素", code: "no-hit"); return
        }
        guard how == "frame" else {
            fail(id, "命中 \(describe(node))，但该元素没有 AXPress 能力", code: "no-press"); return
        }
        // 指针落到用户点的那个位置：clickAt 里命中元素可能是个大容器，滑到容器中心会很怪。
        let (pressed, detail) = driver.press(node)
        if pressed {
            reply(id, ["element": describe(node), "how": how, "detail": detail, "index": node.index,
                       "frame": [node.frame.origin.x, node.frame.origin.y, node.frame.width, node.frame.height]])
        } else {
            fail(id, detail, code: "action-failed")
        }

    /// 在全局坐标处聚焦元素并逐字符投递 unicode 键盘事件。
    case "typeAt":
        guard let gx = num(p["x"]), let gy = num(p["y"]) else { fail(id, "缺少 x/y"); return }
        guard let text = p["text"] as? String else { fail(id, "缺少 text"); return }
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
        }
        ensureMain(ctx)
        let nodes = collectNodes(ctx.webArea)
        guard let (node, how) = focusTarget(in: nodes, at: CGPoint(x: gx, y: gy)) else {
            fail(id, "坐标 (\(gx),\(gy)) 处没有可聚焦的 AX 元素", code: "no-hit"); return
        }
        var steps: [String] = []
        if p["replace"] as? Bool == true {
            let (fok, fdetail) = driver.focusOnly(node)
            if fok {
                let length = driver.characterCount(node)
                _ = driver.select(node, from: 0, length: length)
            }
            steps.append(fdetail)
            usleep(40_000)
        }
        let (ok, detail) = driver.typeText(text, to: node, append: p["replace"] as? Bool != true)
        if ok {
            var out: [String: Any] = ["detail": detail, "chars": text.count, "target": describe(node), "how": how]
            if !steps.isEmpty { out["pre"] = steps }
            reply(id, out)
        } else {
            fail(id, detail, code: "type-failed")
        }

    case "key":
        guard let keyName = p["key"] as? String else { fail(id, "缺少 key"); return }
        guard let code = keyCodes[keyName.lowercased()] else {
            fail(id, "不认识的按键：\(keyName)", code: "bad-key"); return
        }
        var flags: CGEventFlags = []
        if p["cmd"] as? Bool == true { flags.insert(.maskCommand) }
        if p["shift"] as? Bool == true { flags.insert(.maskShift) }
        if p["alt"] as? Bool == true { flags.insert(.maskAlternate) }
        if p["ctrl"] as? Bool == true { flags.insert(.maskControl) }
        if p["name"] != nil || p["index"] != nil {
            if let ctx = findWebContext(titleHint: p["title"] as? String) {
                ensureMain(ctx)
                let nodes = collectNodes(ctx.webArea)
                if let n = resolve(nodes, params: p) {
                    _ = driver.focusOnly(n)
                    usleep(50_000)
                }
            }
        }
        let (ok, detail) = driver.tapKey(code, flags: flags)
        ok ? reply(id, ["detail": detail]) : fail(id, detail)

    case "drag":
        // 端点可以是绝对坐标 [x,y]、元素名/编号，或相对位移 dx/dy。
        var from: CGPoint?
        var to: CGPoint?
        if let f = p["from"] as? [Double], f.count == 2 { from = CGPoint(x: f[0], y: f[1]) }
        if let t = p["to"] as? [Double], t.count == 2 { to = CGPoint(x: t[0], y: t[1]) }
        let needsNodes = p["fromName"] != nil || p["toName"] != nil || p["index"] != nil
        if needsNodes {
            guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
                fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
            }
            ensureMain(ctx)
            let nodes = collectNodes(ctx.webArea)
            var anchorParams: [String: Any] = [:]
            if let name = p["fromName"] as? String { anchorParams["name"] = name }
            if let idx = p["index"] as? Int { anchorParams["index"] = idx }
            if let roleHint = p["role"] as? String { anchorParams["role"] = roleHint }
            if from == nil, !anchorParams.isEmpty {
                guard let n = resolve(nodes, params: anchorParams) else {
                    fail(id, "拖拽起点没有匹配的元素", code: "no-match"); return
                }
                from = CGPoint(x: n.frame.midX, y: n.frame.midY)
            }
            if to == nil, let name = p["toName"] as? String {
                guard let n = resolve(nodes, params: ["name": name]) else {
                    fail(id, "拖拽终点没有匹配的元素", code: "no-match"); return
                }
                to = CGPoint(x: n.frame.midX, y: n.frame.midY)
            }
        }
        guard var start = from else {
            fail(id, "缺少拖拽起点：用 from=[x,y]、fromName 或 index", code: "bad-param"); return
        }
        var end = to ?? start
        if let dx = p["dx"] as? Double { end.x = start.x + dx }
        if let dy = p["dy"] as? Double { end.y = start.y + dy }
        if to == nil && p["dx"] == nil && p["dy"] == nil {
            fail(id, "缺少拖拽终点：用 to=[x,y]、toName 或 dx/dy", code: "bad-param"); return
        }
        start = CGPoint(x: start.x.rounded(), y: start.y.rounded())
        end = CGPoint(x: end.x.rounded(), y: end.y.rounded())
        let steps = (p["steps"] as? Int) ?? 14
        let (ok, detail) = driver.drag(from: start, to: end, steps: steps)
        ok ? reply(id, ["detail": detail, "from": [start.x, start.y], "to": [end.x, end.y]])
           : fail(id, detail)

    case "scroll":
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
        }
        if let name = p["name"] as? String {
            let nodes = collectNodes(ctx.webArea)
            guard let n = resolve(nodes, params: ["name": name]) else {
                fail(id, "没有匹配的元素：\(name)", code: "no-match"); return
            }
            let (ok, d) = driver.scrollToVisible(n)
            ok ? reply(id, ["detail": d, "element": describe(n)]) : fail(id, d)
        } else if let to = p["to"] as? String {
            switch to.lowercased() {
            case "top": reply(id, ["detail": driver.scrollBy(lines: Int.min).1])
            case "bottom", "end": reply(id, ["detail": driver.scrollBy(lines: Int.max).1])
            default: fail(id, "to 只能是 top/bottom")
            }
        } else {
            let pages = (p["pages"] as? Int) ?? ((p["deltaY"] as? Int).map { $0 > 0 ? 1 : -1 } ?? 1)
            let (ok, d) = driver.scrollBy(lines: pages)
            ok ? reply(id, ["detail": d]) : fail(id, d)
        }

    case "geometry":
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到 Chrome 网页窗口", code: "no-window"); return
        }
        reply(id, ["origin": [ctx.origin.x, ctx.origin.y],
                   "size": [ctx.size.width, ctx.size.height],
                   "windowFrame": frameOf(ctx.window).map { [$0.origin.x, $0.origin.y, $0.width, $0.height] } as Any])

    case "focus":
        guard let node = (p["name"] as? String ?? p["index"].map { "\($0)" }) else {
            fail(id, "缺少 name/index"); return
        }
        guard let ctx = findWebContext(titleHint: p["title"] as? String) else {
            fail(id, "找不到窗口", code: "no-window"); return
        }
        let nodes = collectNodes(ctx.webArea)
        var params = p
        if p["name"] == nil, let idx = p["index"] as? Int { params["index"] = idx } else { params["name"] = node }
        guard let n = resolve(nodes, params: params) else { fail(id, "没有匹配的元素：\(node)", code: "no-match"); return }
        let err = AXUIElementSetAttributeValue(n.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        reply(id, ["detail": "focus err=\(err.rawValue)", "element": describe(n)])

    default:
        fail(id, "未知命令：\(cmd)", code: "bad-cmd")
    }
}

// macOS 虚拟键码（用于方向键、翻页键等无法用 unicode 表达的按键）
let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pagedown": 121, "pageup": 116,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "forwarddelete": 117, "help": 114,
    // 字母与数字：CGKeyCode 走 ANSI 布局，与键盘上的字母一一对应。
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]

// MARK: - 主循环

setvbuf(stdout, nil, _IOLBF, 0)
emit(["ready": true, "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "axTrusted": AXIsProcessTrusted(), "version": "0.1.0"])

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail(nil, "无法解析的 JSON", code: "bad-json")
        continue
    }
    handle(obj)
}
exit(0)
