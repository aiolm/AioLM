// Device availability is evidence for whether a hosted runner can run the live
// Metal suite, not evidence that model inference itself passed.
import Metal
import Foundation

let device = MTLCreateSystemDefaultDevice()
print("available=\(device != nil)")
if let device {
    fputs("Metal device available: \(device.name)\n", stderr)
} else {
    fputs("No Metal device is exposed by this runner; GPU inference remains unverified.\n", stderr)
}
