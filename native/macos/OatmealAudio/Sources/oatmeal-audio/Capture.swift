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
/// The aggregate holds the tap and nothing else. Apple's sample also adds the output device as its clock, but
/// then the tap is resampled to that device's rate while still reporting its own format (48 kHz), so audio
/// arrives at the wrong speed whenever the two differ: about 9% fast at 44.1 kHz, and 3x fast once a
/// Bluetooth headset drops to its 16 kHz call profile. On its own the tap runs at the rate it reports, and
/// output devices can switch or change profile under it.
final class SystemAudioCapture {
    private let excludePIDs: [pid_t]
    private let onSamples: ([Int16]) -> Void
    private let onFormatChange: () -> Void
    private let queue = DispatchQueue(label: "oatmeal.system-tap", qos: .userInitiated)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var asbd = AudioStreamBasicDescription()
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

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Oatmeal Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [] as [Any],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        var aggregateDevice = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateDevice), "create aggregate device")
        aggregateID = aggregateDevice

        asbd = tapFormat()
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError(status: -1, action: "interpret tap format")
        }
        let converter = try PCMConverter(from: format)
        var rateCheck = RateCheck(channel: "system", expected: format.sampleRate)

        try check(
            AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, inputData, _, _, _ in
                // The aggregate's only input is the mono tap: one buffer.
                let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
                guard let self, let tapBuffer = buffers.first, tapBuffer.mNumberChannels == format.channelCount else { return }
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: tapBuffer)
                let samples: [Int16] = withUnsafePointer(to: &list) { ptr in
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: ptr, deallocator: nil) else { return [] }
                    rateCheck.add(frames: Int(buffer.frameLength))
                    return converter.convert(buffer)
                }
                if !samples.isEmpty { self.onSamples(samples) }
            },
            "create IO proc")

        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.checkFormat() }
        self.listener = listener
        var tapFormatAddr = address(kAudioTapPropertyFormat)
        AudioObjectAddPropertyListenerBlock(tapID, &tapFormatAddr, DispatchQueue.main, listener)

        try check(AudioDeviceStart(aggregateID, procID), "start aggregate device")
    }

    private func tapFormat() -> AudioStreamBasicDescription {
        readScalar(tapID, kAudioTapPropertyFormat, as: AudioStreamBasicDescription.self, default: AudioStreamBasicDescription())
    }

    private func checkFormat() {
        let now = tapFormat()
        if now.mSampleRate != asbd.mSampleRate || now.mChannelsPerFrame != asbd.mChannelsPerFrame
            || now.mFormatFlags != asbd.mFormatFlags || now.mBitsPerChannel != asbd.mBitsPerChannel
        {
            Events.stderr(["type": "format-changed", "channel": "system", "from": asbd.mSampleRate, "to": now.mSampleRate])
            onFormatChange()
        }
    }

    func stop() {
        if let listener {
            var tapFormatAddr = address(kAudioTapPropertyFormat)
            AudioObjectRemovePropertyListenerBlock(tapID, &tapFormatAddr, DispatchQueue.main, listener)
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

/// Compares how fast frames actually arrive with the rate the format claims, and warns once if they disagree.
/// A mislabelled rate (see SystemAudioCapture) garbles the transcript without failing anywhere else.
struct RateCheck {
    let channel: String
    let expected: Double
    private var frames = 0
    private var since: UInt64 = 0
    private var warned = false

    init(channel: String, expected: Double) {
        self.channel = channel
        self.expected = expected
    }

    mutating func add(frames count: Int) {
        let now = DispatchTime.now().uptimeNanoseconds
        if since == 0 {
            since = now // the first callback starts the clock; its frames don't count
            return
        }
        frames += count
        let elapsed = Double(now - since) / 1e9
        guard elapsed >= 10 else { return }
        let measured = Double(frames) / elapsed
        if !warned, abs(measured / expected - 1) > 0.05 {
            warned = true
            Events.stderr(["type": "warning", "code": "rate-mismatch", "channel": channel, "expected": expected, "measured": measured.rounded()])
        }
        frames = 0
        since = now
    }
}

/// Captures the microphone (see `microphoneToRecord`) with an IO proc on the device itself, and rebuilds when
/// the device, its format, or the default input changes. Not AVAudioEngine: its input node opens the default
/// input before it can be pointed elsewhere, which is exactly the Bluetooth mic we mean to leave closed.
final class MicCapture {
    private let onSamples: ([Int16]) -> Void
    private let queue = DispatchQueue(label: "oatmeal.mic", qos: .userInitiated)
    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var listeners: [(object: AudioObjectID, address: AudioObjectPropertyAddress, block: AudioObjectPropertyListenerBlock)] = []
    private var restartPending = false // main queue only

    init(onSamples: @escaping ([Int16]) -> Void) {
        self.onSamples = onSamples
    }

    func start() throws {
        guard let mic = microphoneToRecord() else { throw CoreAudioError(status: -1, action: "find a microphone") }
        var event: [String: Any] = ["type": "mic-device", "name": mic.name]
        if let instead = mic.insteadOf { event["insteadOf"] = instead }
        Events.stderr(event)

        guard let stream = readObjectList(mic.id, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput).first else {
            throw CoreAudioError(status: -1, action: "find an input stream on \(mic.name)")
        }
        var asbd = readScalar(stream, kAudioStreamPropertyVirtualFormat, as: AudioStreamBasicDescription.self, default: AudioStreamBasicDescription())
        guard asbd.mSampleRate > 0, let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CoreAudioError(status: -1, action: "read the format of \(mic.name)")
        }
        let converter = try PCMConverter(from: format)
        var rateCheck = RateCheck(channel: "mic", expected: format.sampleRate)

        deviceID = mic.id
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&procID, mic.id, queue) { [weak self] _, inputData, _, _, _ in
                // One buffer per input stream; HAL streams are interleaved, so the first is all of `stream`.
                let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
                guard let self, let first = buffers.first, first.mNumberChannels == asbd.mChannelsPerFrame else { return }
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: first)
                let samples: [Int16] = withUnsafePointer(to: &list) { ptr in
                    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: ptr, deallocator: nil) else { return [] }
                    rateCheck.add(frames: Int(buffer.frameLength))
                    return converter.convert(buffer)
                }
                if !samples.isEmpty { self.onSamples(samples) }
            },
            "create mic IO proc")

        listen(mic.id, kAudioDevicePropertyDeviceIsAlive)
        listen(mic.id, kAudioDevicePropertyNominalSampleRate)
        listen(stream, kAudioStreamPropertyVirtualFormat)
        listen(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)

        try check(AudioDeviceStart(mic.id, procID), "start \(mic.name)")
    }

    private func listen(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) {
        var addr = address(selector)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.scheduleRestart() }
        if AudioObjectAddPropertyListenerBlock(object, &addr, DispatchQueue.main, block) == noErr {
            listeners.append((object, addr, block))
        }
    }

    /// A device switch posts several notifications; restart once they settle. Main queue only.
    private func scheduleRestart() {
        guard !restartPending else { return }
        restartPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.restartPending = false
            self?.restart()
        }
    }

    /// Mid-switch (e.g. a Bluetooth headset changing profile) the new device can briefly report no format, so
    /// a failed restart is retried rather than leaving the mic dead for the rest of the call.
    private func restart(attempt: Int = 0) {
        if attempt == 0 { Events.stderr(["type": "device-changed", "channel": "mic"]) }
        stop()
        do {
            try start()
        } catch {
            stop()
            if attempt < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.restart(attempt: attempt + 1) }
            } else {
                Events.stderr(["type": "error", "channel": "mic", "message": "\(error)"])
            }
        }
    }

    func stop() {
        for var listener in listeners {
            AudioObjectRemovePropertyListenerBlock(listener.object, &listener.address, DispatchQueue.main, listener.block)
        }
        listeners = []
        if let procID {
            AudioDeviceStop(deviceID, procID)
            AudioDeviceDestroyIOProcID(deviceID, procID)
        }
        procID = nil
        deviceID = AudioObjectID(kAudioObjectUnknown)
    }
}

/// The mic to record: the default input, unless that is a Bluetooth mic nothing else has open. Opening one
/// switches the headset to its call profile (phone-quality sound for everything you hear, 16 kHz), so take the
/// built-in mic instead. A call app already using the headset mic has made that switch, and then we use it too.
func microphoneToRecord() -> (id: AudioObjectID, name: String, insteadOf: String?)? {
    let system = AudioObjectID(kAudioObjectSystemObject)
    let preferred = readScalar(system, kAudioHardwarePropertyDefaultInputDevice, as: AudioObjectID.self, default: kAudioObjectUnknown)
    guard preferred != kAudioObjectUnknown else { return nil }
    let name = { (device: AudioObjectID) in readString(device, kAudioObjectPropertyName) ?? "device \(device)" }
    let transport = readScalar(preferred, kAudioDevicePropertyTransportType, as: UInt32.self, default: 0)
    let bluetooth = transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
    let inUse = readScalar(preferred, kAudioDevicePropertyDeviceIsRunningSomewhere, as: UInt32.self, default: 0) != 0
    guard bluetooth, !inUse else { return (preferred, name(preferred), nil) }
    let builtIn = readObjectList(system, kAudioHardwarePropertyDevices).first { device in
        readScalar(device, kAudioDevicePropertyTransportType, as: UInt32.self, default: 0) == kAudioDeviceTransportTypeBuiltIn
            && !readObjectList(device, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput).isEmpty
    }
    guard let builtIn else { return (preferred, name(preferred), nil) }
    return (builtIn, name(builtIn), name(preferred))
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

    /// Rebuild the tap when the user switches output (e.g. connects headphones). The tap-only aggregate
    /// shouldn't depend on the output device, but that's untested across a switch, and a rebuild costs ~0.5 s.
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
