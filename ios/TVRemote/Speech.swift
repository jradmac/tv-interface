import AVFoundation
import Speech
import SwiftUI

/// The phone's own speech-to-text (Apple's SFSpeechRecognizer). Words stream to the TV as you
/// speak ({t:'voice', phase:'partial'}) and the full sentence goes when you let go ('final').
final class Listener: ObservableObject {
    enum Problem: Equatable { case micDenied, speechDenied, unavailable }

    @Published private(set) var listening = false
    @Published private(set) var text = ""
    @Published var problem: Problem?

    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var onPartial: ((String) -> Void)?
    private var onFinish: ((String) -> Void)?
    private var finishTimer: Timer?
    private var silenceTimer: Timer?
    private var maxTimer: Timer?
    private var handsFree = false
    private var session = 0

    /// Ask for the microphone and speech permissions (once). Calls back on the main thread.
    func authorize(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { s in
            DispatchQueue.main.async {
                guard s == .authorized else { self.problem = .speechDenied; return done(false) }
                AVAudioApplication.requestRecordPermission { ok in
                    DispatchQueue.main.async {
                        if !ok { self.problem = .micDenied }
                        done(ok)
                    }
                }
            }
        }
    }

    /// Start listening. With handsFree, it stops by itself after a pause (used when opened from
    /// Control Center, Siri or the Action button, where there is no button to hold).
    func start(handsFree: Bool = false, partial: @escaping (String) -> Void, finish: @escaping (String) -> Void) {
        guard !listening else { return }
        guard let recognizer, recognizer.isAvailable else { problem = .unavailable; return }
        session += 1
        let mine = session
        self.handsFree = handsFree
        onPartial = partial
        onFinish = finish
        text = ""
        listening = true
        authorize { [weak self] ok in
            guard let self, ok, self.listening, self.session == mine else {
                self?.reset()
                return
            }
            do { try self.begin(recognizer) } catch { self.problem = .unavailable; self.reset() }
        }
    }

    private func begin(_ recognizer: SFSpeechRecognizer) throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try s.setActive(true, options: .notifyOthersOnDeactivation)
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .search
        // TV words the recognizer might not expect.
        req.contextualStrings = ["Netflix", "YouTube", "Prime Video", "Disney Plus", "Max", "Apple Music", "Spotify", "Claude", "Claude Code"]
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = false }
        request = req
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buf, _ in req?.append(buf) }
        engine.prepare()
        try engine.start()
        let mine = session
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.session == mine else { return }
                if let result {
                    let t = result.bestTranscription.formattedString
                    if t != self.text, !t.isEmpty {
                        self.text = t
                        self.onPartial?(t)
                        if self.handsFree { self.armSilence() }
                    }
                    if result.isFinal { self.complete() }
                } else if error != nil, self.request == nil {
                    self.complete()
                }
            }
        }
        if handsFree {
            maxTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in self?.stop() }
            silenceTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.stop() }   // nothing said
        }
    }

    private func armSilence() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { [weak self] _ in self?.stop() }
    }

    /// Finger lifted: stop the mic and wait (briefly) for the recognizer's final words.
    func stop() {
        guard listening else { return }
        listening = false
        silenceTimer?.invalidate(); maxTimer?.invalidate()
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
        finishTimer?.invalidate()
        finishTimer = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: false) { [weak self] _ in self?.complete() }
    }

    private func complete() {
        guard let finish = onFinish else { return }
        onFinish = nil
        onPartial = nil
        finishTimer?.invalidate()
        task?.cancel()
        task = nil
        listening = false
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        NotificationCenter.default.post(name: .listenerDidFinish, object: nil)
        finish(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func reset() {
        listening = false
        onPartial = nil
        let f = onFinish
        onFinish = nil
        f?("")
    }
}

extension Notification.Name {
    static let listenerDidFinish = Notification.Name("listenerDidFinish")
}
