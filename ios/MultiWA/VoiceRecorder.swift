import AVFoundation
import Observation

/// Graba notas de voz en m4a; el servidor las convierte a ogg/opus para WhatsApp
@MainActor
@Observable
final class VoiceRecorder {
    var isRecording = false
    var elapsed: Double = 0

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("nota.m4a")

    func start() async {
        guard await AVAudioApplication.requestRecordPermission() else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
            ]
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.record()
            recorder = rec
            isRecording = true
            elapsed = 0
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let rec = self.recorder else { return }
                    self.elapsed = rec.currentTime
                }
            }
        } catch {
            isRecording = false
        }
    }

    func stop() -> Data? {
        recorder?.stop()
        finish()
        return try? Data(contentsOf: url)
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        finish()
    }

    private func finish() {
        timer?.invalidate()
        timer = nil
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
