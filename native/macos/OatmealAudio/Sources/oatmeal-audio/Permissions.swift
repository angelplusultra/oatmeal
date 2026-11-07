import AVFoundation
import Foundation

/// Microphone permission uses the public AVFoundation API. macOS has no public API to check or request
/// "System Audio Recording", so (like AudioCap and Chrome) we ask TCC directly, and fall back to
/// "unknown" if that private symbol is ever unavailable.
enum Permissions {
    private typealias PreflightFn = @convention(c) (CFString, CFDictionary?) -> Int
    private typealias RequestFn = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
    private static let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
    private static let audioCaptureService = "kTCCServiceAudioCapture" as CFString

    static func status() -> [String: Any] {
        ["microphone": microphone(), "systemAudio": systemAudio()]
    }

    static func microphone() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unknown"
        }
    }

    static func systemAudio() -> String {
        guard let tcc, let symbol = dlsym(tcc, "TCCAccessPreflight") else { return "unknown" }
        let preflight = unsafeBitCast(symbol, to: PreflightFn.self)
        switch preflight(audioCaptureService, nil) {
        case 0: return "granted"
        case 1: return "denied"
        default: return "not-determined"
        }
    }

    static func request(_ what: String) {
        let done = DispatchSemaphore(value: 0)
        switch what {
        case "mic", "microphone":
            AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }
        case "system", "systemAudio":
            guard let tcc, let symbol = dlsym(tcc, "TCCAccessRequest") else { return }
            let request = unsafeBitCast(symbol, to: RequestFn.self)
            request(audioCaptureService, nil) { _ in done.signal() }
        default:
            return
        }
        _ = done.wait(timeout: .now() + 120)
    }
}
