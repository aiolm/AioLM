// Inspect only a test-owned process's visible windows. No screenshots, titles,
// Accessibility permission, or other applications' window data are collected.
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
    exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
let visible = windows.contains { window in
    guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let bounds = window[kCGWindowBounds as String] as? [String: NSNumber] else { return false }
    return (bounds["Width"]?.doubleValue ?? 0) > 100 && (bounds["Height"]?.doubleValue ?? 0) > 50
}
print(visible ? "visible" : "absent")
