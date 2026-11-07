import AVFoundation
import CoreAudio
import Foundation

/// Converts any PCM format to 16 kHz mono Int16, keeping resampler state across calls.
final class PCMConverter {
    static let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    let inputFormat: AVAudioFormat
    private let converter: AVAudioConverter

    init(from format: AVAudioFormat) throws {
        guard let converter = AVAudioConverter(from: format, to: PCMConverter.outputFormat) else {
            throw CoreAudioError(status: -1, action: "create converter from \(format)")
        }
        converter.downmix = true
        inputFormat = format
        self.converter = converter
    }

    func convert(_ input: AVAudioPCMBuffer) -> [Int16] {
        let ratio = PCMConverter.outputFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: PCMConverter.outputFormat, frameCapacity: capacity) else { return [] }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, output.frameLength > 0, let channel = output.int16ChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength)))
    }
}

/// Captures everything the Mac plays (except excluded processes) through a Core Audio process tap
/// wrapped in a private aggregate device. Needs only the "System Audio Recording" permission.
final class SystemAudioCapture {
    private let excludePIDs: [pid_t]
    private let onSamples: ([Int16]) -> Void
    private let queue = DispatchQueue(label: "oatmeal.system-tap", qos: .userInitiated)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var converter: PCMConverter?

    init(excludePIDs: [pid_t], onSamples: @escaping ([Int16]) -> Void) {
        self.excludePIDs = excludePIDs
        self.onSamples = onSamples
    }

    func start() throws {
        let excluded = excludePIDs.compactMap(processObject(for:))
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
        description.uuid = UUID()
        description.name = "Oatmeal system audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tap), "create process tap")
        tapID = tap

        var addr = address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd), "read tap format")
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError(status: -1, action: "interpret tap format")
        }
        let converter = try PCMConverter(from: format)
        self.converter = converter

        let outputDevice = try defaultOutputDevice()
        guard let outputUID = readString(outputDevice, kAudioDevicePropertyDeviceUID) else {
            throw CoreAudioError(status: -1, action: "read output device UID")
        }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Oatmeal Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        var aggregateDevice = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateDevice), "create aggregate device")
        aggregateID = aggregateDevice

        try check(
            AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, inputData, _, _, _ in
                guard let self,
                      let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: inputData, deallocator: nil)
                else { return }
                let samples = converter.convert(buffer)
                if !samples.isEmpty { self.onSamples(samples) }
            },
            "create IO proc")
        try check(AudioDeviceStart(aggregateID, procID), "start aggregate device")
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            if let procID { AudioDeviceDestroyIOProcID(aggregateID, procID) }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = kAudioObjectUnknown
            procID = nil
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }
}

/// Captures the default input device with AVAudioEngine and follows input-device changes.
final class MicCapture {
    private var engine = AVAudioEngine()
    private let onSamples: ([Int16]) -> Void
    private var observer: NSObjectProtocol?

    init(onSamples: @escaping ([Int16]) -> Void) {
        self.onSamples = onSamples
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CoreAudioError(status: -1, action: "find a microphone")
        }
        let converter = try PCMConverter(from: format)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            let samples = converter.convert(buffer)
            if !samples.isEmpty { self?.onSamples(samples) }
        }
        engine.prepare()
        try engine.start()

        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            self?.restart()
        }
    }

    private func restart() {
        Events.stderr(["type": "device-changed", "channel": "mic"])
        stop()
        engine = AVAudioEngine()
        do {
            try start()
        } catch {
            Events.stderr(["type": "error", "channel": "mic", "message": "\(error)"])
        }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

final class CaptureSession {
    private let writer = FrameWriter()
    private var mic: MicCapture?
    private var system: SystemAudioCapture?
    private let wantMic: Bool
    private let wantSystem: Bool
    private let excludePIDs: [pid_t]
    private var outputListener: AudioObjectPropertyListenerBlock?
    private let lock = NSLock()
    private var stopped = false

    init(mic: Bool, system: Bool, excludePIDs: [pid_t]) {
        wantMic = mic
        wantSystem = system
        self.excludePIDs = excludePIDs
    }

    func start() {
        var started: [String: Any] = ["type": "started", "sampleRate": 16000]
        if wantMic {
            let capture = MicCapture { [writer] in writer.append(channel: 0, samples: $0) }
            do {
                try capture.start()
                mic = capture
                started["mic"] = true
            } catch {
                started["mic"] = false
                Events.stderr(["type": "error", "channel": "mic", "message": "\(error)"])
            }
        }
        if wantSystem {
            started["system"] = startSystem()
            watchOutputDevice()
        }
        Events.stderr(started)
    }

    @discardableResult
    private func startSystem() -> Bool {
        let capture = SystemAudioCapture(excludePIDs: excludePIDs) { [writer] in writer.append(channel: 1, samples: $0) }
        do {
            try capture.start()
            system = capture
            return true
        } catch {
            Events.stderr(["type": "error", "channel": "system", "message": "\(error)"])
            return false
        }
    }

    /// The tap's aggregate device is clocked by the output device, so rebuild it when the user switches
    /// output (e.g. connects headphones).
    private func watchOutputDevice() {
        var addr = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard !self.stopped else { return }
            Events.stderr(["type": "device-changed", "channel": "system"])
            self.system?.stop()
            self.system = nil
            self.startSystem()
        }
        outputListener = listener
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, listener)
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        stopped = true
        if let outputListener {
            var addr = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, outputListener)
        }
        mic?.stop()
        system?.stop()
        Events.stderr(["type": "stopped"])
    }
}
