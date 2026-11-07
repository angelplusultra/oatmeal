// oatmeal-audio: Oatmeal's macOS audio helper.
//
//   oatmeal-audio detect [--interval-ms 500]
//       Prints a JSON line to stdout whenever the set of processes using the mic or playing audio changes:
//       {"type":"audio-users","processes":[{"pid":123,"bundleId":"us.zoom.xos","name":"zoom.us","input":true,"output":true}]}
//       Needs no permissions.
//
//   oatmeal-audio capture [--no-mic] [--no-system] [--exclude-pid N]...
//       Streams 16 kHz mono signed 16-bit PCM to stdout as binary frames:
//         [u8 channel (0 = mic, 1 = system)][u32 LE sample count][i16 LE samples...]
//       Status events are JSON lines on stderr. Stops on SIGTERM/SIGINT or when stdin closes.
//       Needs the Microphone and System Audio Recording permissions (attributed to the parent app).
//
//   oatmeal-audio permissions [--request mic|system]
//       Prints {"microphone": "...", "systemAudio": "..."} to stdout.

import AVFoundation
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOFBF, 1 << 16)

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    FileHandle.standardError.write("usage: oatmeal-audio detect|capture|permissions [options]\n".data(using: .utf8)!)
    exit(64)
}

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func options(_ name: String) -> [String] {
    var out: [String] = []
    var i = 0
    while i < args.count {
        if args[i] == name, i + 1 < args.count {
            out.append(args[i + 1])
            i += 2
        } else {
            i += 1
        }
    }
    return out
}

/// Exits when the parent closes our stdin (or dies), so the helper never outlives the app.
func exitWhenStdinCloses(_ cleanup: @escaping () -> Void) {
    Thread.detachNewThread {
        var buffer = [UInt8](repeating: 0, count: 256)
        while read(STDIN_FILENO, &buffer, buffer.count) > 0 {}
        cleanup()
        exit(0)
    }
}

func installSignalHandlers(_ cleanup: @escaping () -> Void) {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            cleanup()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
}

var signalSources: [DispatchSourceSignal] = []

switch command {
case "detect":
    let interval = Double(option("--interval-ms") ?? "500") ?? 500
    let detector = MicUsageDetector(intervalMs: interval)
    installSignalHandlers {}
    exitWhenStdinCloses {}
    detector.start()
    dispatchMain()

case "capture":
    let excluded = options("--exclude-pid").compactMap { pid_t($0) } + [getpid()]
    let session = CaptureSession(mic: !args.contains("--no-mic"), system: !args.contains("--no-system"), excludePIDs: excluded)
    installSignalHandlers { session.stop() }
    exitWhenStdinCloses { session.stop() }
    session.start()
    dispatchMain()

case "permissions":
    if let what = option("--request") {
        Permissions.request(what)
    }
    Events.stdout(Permissions.status())
    exit(0)

default:
    FileHandle.standardError.write("unknown command: \(command)\n".data(using: .utf8)!)
    exit(64)
}
