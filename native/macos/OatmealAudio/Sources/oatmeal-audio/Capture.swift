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
///
/// The aggregate's clock is the output device, so its input streams are that device's own inputs (a
/// Bluetooth headset's mic) followed by the tap. We read only the tap, keep the headset's mic closed (opening
/// it drops the headset into its low-quality call profile and changes the sample rate mid-call), and report
/// any format change so the session can rebuild us with the new format.
final class SystemAudioCapture {
    private let excludePIDs: [pid_t]
    private let onSamples: ([Int16]) -> Void
    private let onFormatChange: () -> Void
    private let queue = DispatchQueue(label: "oatmeal.system-tap", qos: .userInitiated)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var asbd = AudioStreamBasicDescription()
    private var deviceInputs = 0
    private var listener: AudioObjectPropertyListenerBlock?

    init(excludePIDs: [pid_t], onSamples: @escaping ([Int16]) -> Void, onFormatChange: @escaping () -> Void) {
        self.excludePIDs = excludePIDs
        self.onSamples = onSamples
        self.onFormatChange = onFormatChange
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

        let outputDevice = try defaultOutputDevice()
        guard let outputUID = readString(outputDevice, kAudioDevicePropertyDeviceUID) else {
            throw CoreAudioError(status: -1, action: "read output device UID")
        }
        deviceInputs = readObjectList(outputDevice, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput).count
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

        asbd = tapStreamFormat()
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError(status: -1, action: "interpret tap format")
        }
        let converter = try PCMConverter(from: format)

        try check(
            AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, inputData, _, _, _ in
                // The tap is mono, so it is exactly one buffer: the last one.
                let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
                guard let self, let tapBuffer = buffers.last, tapBuffer.mNumberChannels == format.channelCount else { return }
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: tapBuffer)
                let samples: [Int16] = withUnsafePointer(to: &list) { ptr in
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: ptr, deallocator: nil) else { return [] }
                    return converter.convert(buffer)
                }
                if !samples.isEmpty { self.onSamples(samples) }
            },
            "create IO proc")
        disableInputStreams(count: deviceInputs)

        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.checkFormat() }
        self.listener = listener
        var tapFormatAddr = address(kAudioTapPropertyFormat)
        AudioObjectAddPropertyListenerBlock(tapID, &tapFormatAddr, DispatchQueue.main, listener)
        var rateAddr = address(kAudioDevicePropertyNominalSampleRate)
        AudioObjectAddPropertyListenerBlock(aggregateID, &rateAddr, DispatchQueue.main, listener)

        try check(AudioDeviceStart(aggregateID, procID), "start aggregate device")
    }

    /// The format the IO proc gets the tap in: its stream's format in the aggregate (the input stream after the
    /// output device's own), falling back to the tap's own format while that stream isn't there.
    private func tapStreamFormat() -> AudioStreamBasicDescription {
        let tapFormat = readScalar(tapID, kAudioTapPropertyFormat, as: AudioStreamBasicDescription.self, default: AudioStreamBasicDescription())
        let streams = readObjectList(aggregateID, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput)
        guard streams.count > deviceInputs, let stream = streams.last else { return tapFormat }
        return readScalar(stream, kAudioStreamPropertyVirtualFormat, as: AudioStreamBasicDescription.self, default: tapFormat)
    }

    private func checkFormat() {
        let now = tapStreamFormat()
        if now.mSampleRate != asbd.mSampleRate || now.mChannelsPerFrame != asbd.mChannelsPerFrame
            || now.mFormatFlags != asbd.mFormatFlags || now.mBitsPerChannel != asbd.mBitsPerChannel
        {
            Events.stderr(["type": "format-changed", "channel": "system", "from": asbd.mSampleRate, "to": now.mSampleRate])
            onFormatChange()
        }
    }

    /// Turns off the aggregate's first `count` input streams (the output device's own inputs, e.g. a headset
    /// mic) for our IO proc, so Core Audio doesn't open them. Best effort: reading the last buffer is what
    /// keeps the transcript right if this fails.
    private func disableInputStreams(count: Int) {
        guard count > 0, let procID else { return }
        var addr = address(kAudioDevicePropertyIOProcStreamUsage, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(aggregateID, &addr, 0, nil, &size) == noErr, size >= 16 else { return }
        // AudioHardwareIOProcStreamUsage: { void *mIOProc; UInt32 mNumberStreams; UInt32 mStreamIsOn[]; }
        let usage = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 8)
        defer { usage.deallocate() }
        usage.initializeMemory(as: UInt8.self, repeating: 0, count: Int(size))
        usage.storeBytes(of: unsafeBitCast(procID, to: UnsafeMutableRawPointer.self), as: UnsafeMutableRawPointer.self)
        guard AudioObjectGetPropertyData(aggregateID, &addr, 0, nil, &size, usage) == noErr else { return }
        let streams = Int(usage.load(fromByteOffset: 8, as: UInt32.self))
        for i in 0..<max(0, min(count, streams - 1)) {
            usage.storeBytes(of: UInt32(0), toByteOffset: 12 + i * 4, as: UInt32.self)
        }
        let status = AudioObjectSetPropertyData(aggregateID, &addr, 0, nil, size, usage)
        if status != noErr { Events.stderr(["type": "warning", "code": "stream-usage", "status": Int(status)]) }
    }

    func stop() {
        if let listener {
            var tapFormatAddr = address(kAudioTapPropertyFormat)
            AudioObjectRemovePropertyListenerBlock(tapID, &tapFormatAddr, DispatchQueue.main, listener)
            var rateAddr = address(kAudioDevicePropertyNominalSampleRate)
            AudioObjectRemovePropertyListenerBlock(aggregateID, &rateAddr, DispatchQueue.main, listener)
            self.listener = nil
        }
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

    /// Mid-switch (e.g. a Bluetooth headset changing profile) the new device can briefly report no format, so
    /// a failed restart is retried rather than leaving the mic dead for the rest of the call.
    private func restart(attempt: Int = 0) {
        if attempt == 0 { Events.stderr(["type": "device-changed", "channel": "mic"]) }
        stop()
        engine = AVAudioEngine()
        do {
            try start()
        } catch {
            if attempt < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.restart(attempt: attempt + 1) }
            } else {
                Events.stderr(["type": "error", "channel": "mic", "message": "\(error)"])
            }
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
    private var restartScheduled = false // main queue only

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
        let capture = SystemAudioCapture(
            excludePIDs: excludePIDs,
            onSamples: { [writer] in writer.append(channel: 1, samples: $0) },
            onFormatChange: { [weak self] in self?.scheduleSystemRestart() })
        do {
            try capture.start()
            system = capture
            return true
        } catch {
            capture.stop()
            Events.stderr(["type": "error", "channel": "system", "message": "\(error)"])
            return false
        }
    }

    /// Rebuilds the tap after a burst of device notifications settles. Main queue only.
    private func scheduleSystemRestart() {
        guard !restartScheduled else { return }
        restartScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.restartScheduled = false
            self?.restartSystem()
        }
    }

    private func restartSystem(attempt: Int = 0) {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        system?.stop()
        system = nil
        if !startSystem(), attempt < 5 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.restartSystem(attempt: attempt + 1) }
        }
    }

    /// The tap's aggregate device is clocked by the output device, so rebuild it when the user switches
    /// output (e.g. connects headphones).
    private func watchOutputDevice() {
        var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            Events.stderr(["type": "device-changed", "channel": "system"])
            self?.scheduleSystemRestart()
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
            var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, outputListener)
        }
        mic?.stop()
        system?.stop()
        Events.stderr(["type": "stopped"])
    }
}
