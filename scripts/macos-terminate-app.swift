// Ask a test-owned app to quit through AppKit's standard request, the same path
// as the Dock's Quit item. It never force-terminates or targets another app.
import AppKit

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid) else {
    exit(2)
}
exit(app.terminate() ? 0 : 1)
