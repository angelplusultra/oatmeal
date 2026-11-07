// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OatmealAudio",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(
            name: "oatmeal-audio",
            path: "Sources/oatmeal-audio",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AppKit"),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
