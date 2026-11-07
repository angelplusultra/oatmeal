import Foundation

/// JSON line output. Events go to stderr during capture (stdout carries audio) and to stdout otherwise.
enum Events {
    private static let lock = NSLock()

    static func stdout(_ object: [String: Any]) { write(object, to: FileHandle.standardOutput) }
    static func stderr(_ object: [String: Any]) { write(object, to: FileHandle.standardError) }

    private static func write(_ object: [String: Any], to handle: FileHandle) {
        guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        do {
            try handle.write(contentsOf: data)
        } catch {
            // Parent went away.
            exit(0)
        }
    }
}

/// Writes PCM frames to stdout off the audio threads, batching small buffers into ~100 ms frames.
/// If the reader stalls, frames queue up to a cap and are then dropped (and reported) rather than
/// blocking Core Audio.
final class FrameWriter {
    static let samplesPerFrame = 1600 // 100 ms at 16 kHz
    private static let maxPendingBytes = 16 * 1024 * 1024

    private let queue = DispatchQueue(label: "oatmeal.frame-writer")
    private let lock = NSLock()
    private var pending: [UInt8: [Int16]] = [:]
    private var pendingBytes = 0
    private var droppedSamples = 0

    func append(channel: UInt8, samples: [Int16]) {
        lock.lock()
        var buffer = pending[channel, default: []]
        buffer.append(contentsOf: samples)
        if buffer.count < FrameWriter.samplesPerFrame {
            pending[channel] = buffer
            lock.unlock()
            return
        }
        pending[channel] = []
        let bytes = 5 + buffer.count * 2
        if pendingBytes + bytes > FrameWriter.maxPendingBytes {
            droppedSamples += buffer.count
            let dropped = droppedSamples
            lock.unlock()
            if dropped % (16000 * 10) < buffer.count {
                Events.stderr(["type": "warning", "code": "dropping-audio", "droppedSeconds": dropped / 16000])
            }
            return
        }
        pendingBytes += bytes
        lock.unlock()

        var data = Data(capacity: bytes)
        data.append(channel)
        var count = UInt32(buffer.count).littleEndian
        withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
        buffer.withUnsafeBufferPointer { ptr in
            data.append(UnsafeBufferPointer(start: UnsafeRawPointer(ptr.baseAddress!).assumingMemoryBound(to: UInt8.self), count: ptr.count * 2))
        }
        queue.async {
            do {
                try FileHandle.standardOutput.write(contentsOf: data)
            } catch {
                exit(0)
            }
            self.lock.lock()
            self.pendingBytes -= bytes
            self.lock.unlock()
        }
    }
}
