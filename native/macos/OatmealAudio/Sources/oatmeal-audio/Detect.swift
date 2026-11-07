import AppKit
import CoreAudio
import Darwin
import Foundation

/// Polls Core Audio's per-process objects (macOS 14+) and reports which processes are capturing
/// microphone input and/or playing audio. Unlike the device-level "is running somewhere" property, this
/// names the process and works for Bluetooth devices. Output matters for telling "left the call" (mic and
/// speaker both stop) apart from "muted" (mic may stop, but the call is still playing).
final class MicUsageDetector {
    private let interval: DispatchTimeInterval
    private let queue = DispatchQueue(label: "oatmeal.detect")
    private var timer: DispatchSourceTimer?
    private var last: Set<String> = []
    private var first = true

    init(intervalMs: Double) {
        interval = .milliseconds(max(100, Int(intervalMs)))
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    private func poll() {
        var processes: [[String: Any]] = []
        var keys: Set<String> = []
        for object in readObjectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList) {
            let input = readScalar(object, kAudioProcessPropertyIsRunningInput, as: UInt32.self, default: 0) != 0
            let output = readScalar(object, kAudioProcessPropertyIsRunningOutput, as: UInt32.self, default: 0) != 0
            guard input || output else { continue }
            let pid = readScalar(object, kAudioProcessPropertyPID, as: pid_t.self, default: -1)
            let bundleId = readString(object, kAudioProcessPropertyBundleID) ?? ""
            keys.insert("\(pid)|\(bundleId)|\(input)|\(output)")
            processes.append([
                "pid": Int(pid), "bundleId": bundleId, "name": Self.displayName(pid: pid, bundleId: bundleId),
                "input": input, "output": output,
            ])
        }
        if first || keys != last {
            first = false
            last = keys
            Events.stdout(["type": "audio-users", "processes": processes])
        }
    }

    private static func displayName(pid: pid_t, bundleId: String) -> String {
        if let app = NSRunningApplication(processIdentifier: pid), let name = app.localizedName { return name }
        var buffer = [CChar](repeating: 0, count: 256)
        if pid > 0, proc_name(pid, &buffer, UInt32(buffer.count)) > 0 { return String(cString: buffer) }
        return bundleId
    }
}
