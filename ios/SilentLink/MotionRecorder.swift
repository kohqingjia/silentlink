import Foundation
import CoreMotion
import UIKit

@MainActor final class MotionRecorder: NSObject, ObservableObject, CMHeadphoneMotionManagerDelegate {
    @Published var available = false
    @Published var authorization = "Not requested"
    @Published var connection = "Waiting for headphones"
    @Published var isRecording = false
    @Published var countdown = 0
    @Published var remaining = 0
    @Published var samples: [MotionSample] = []
    @Published var sampleCount = 0
    @Published var rate = 0.0
    @Published var error: String?
    private let manager = CMHeadphoneMotionManager()
    private var timer: Timer?
    private var countdownTask: Task<Void, Never>?
    private var active: SavedRecording?
    private var firstTimestamp: Double?
    private var lastReceived = Date()
    private var startTime = Date()
    private var store: RecordingStore?
    private var runID = UUID()

    override init() {
        super.init()
        manager.delegate = self
        // Connection-status monitoring was added in iOS 18; iOS 17 refreshes
        // availability on foreground/Refresh and receives recording callbacks.
        if #available(iOS 18.0, *) { manager.startConnectionStatusUpdates() }
        refresh()
    }
    func refresh() {
        available = manager.isDeviceMotionAvailable
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .notDetermined: authorization = "Not requested"
        case .restricted: authorization = "Restricted"
        case .denied: authorization = "Denied — enable Motion & Fitness in Settings"
        case .authorized: authorization = "Authorized"
        @unknown default: authorization = "Unknown"
        }
        if !isRecording { connection = available ? "Headphone motion available" : "Connect compatible AirPods to this iPhone" }
    }
    func begin(session: ResearchSession, label: String, duration: Int, store: RecordingStore) {
        guard !isRecording, countdown == 0 else { return }
        refresh(); error = nil
        guard available else { error = "Headphone motion is unavailable. Pair and wear compatible AirPods, then refresh."; return }
        let status = CMHeadphoneMotionManager.authorizationStatus()
        guard status != .denied && status != .restricted else { error = authorization; return }
        guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "Enter a label"; return }
        self.store = store
        countdown = 3
        countdownTask = Task {
            for value in (1...3).reversed() {
                countdown = value
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { countdown = 0; return }
            }
            countdown = 0
            start(session: session, label: label, duration: duration)
        }
    }
    private func start(session: ResearchSession, label: String, duration: Int) {
        let id = UUID(); runID = id
        active = SavedRecording(session: session, recording: Recording(session_id: session.id, label: label, device: session.device, os_version: UIDevice.current.systemVersion, requested_duration_s: duration))
        firstTimestamp = nil; samples = []; sampleCount = 0; rate = 0
        remaining = duration; startTime = Date(); lastReceived = Date(); isRecording = true
        UIApplication.shared.isIdleTimerDisabled = true
        manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, failure in
            Task { @MainActor in
                guard let self, self.isRecording, self.runID == id else { return }
                self.refreshAuthorization()
                if let failure { self.error = failure.localizedDescription; self.stop(reason: "Motion error: \(failure.localizedDescription)"); return }
                guard let motion else { return }
                self.connection = "Receiving headphone motion"
                if self.firstTimestamp == nil {
                    self.firstTimestamp = motion.timestamp
                    self.startTime = Date()
                    self.active?.recording.started_at = Date().addingTimeInterval(-(ProcessInfo.processInfo.systemUptime - motion.timestamp))
                }
                let t = motion.timestamp - (self.firstTimestamp ?? motion.timestamp)
                if let previous = self.active?.recording.samples.last, motion.timestamp <= previous.sensor_timestamp { return }
                if t > Double(duration) { self.stop(); return }
                let a = motion.userAcceleration, r = motion.rotationRate, g = motion.gravity, q = motion.attitude.quaternion
                let sample = MotionSample(t: t, sensor_timestamp: motion.timestamp,
                    user_acceleration: Vector3(x: a.x, y: a.y, z: a.z), rotation_rate: Vector3(x: r.x, y: r.y, z: r.z),
                    gravity: Vector3(x: g.x, y: g.y, z: g.z), attitude: Quaternion(x: q.x, y: q.y, z: q.z, w: q.w))
                self.active?.recording.samples.append(sample)
                self.samples.append(sample)
                if self.samples.count > 150 { self.samples.removeFirst() }
                self.sampleCount += 1
                self.rate = t > 0 ? Double(self.sampleCount - 1) / t : 0
                self.lastReceived = Date()
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick(duration: duration) }
        }
    }
    private func refreshAuthorization() {
        if CMHeadphoneMotionManager.authorizationStatus() == .authorized { authorization = "Authorized" }
    }
    private func tick(duration: Int) {
        guard isRecording else { return }
        remaining = max(0, duration - Int(Date().timeIntervalSince(startTime)))
        // Permission prompts can take time; use a longer timeout before first data.
        if Date().timeIntervalSince(lastReceived) > (firstTimestamp == nil ? 30 : 3) {
            error = "No motion updates. Check connection and Motion & Fitness permission."
            stop(reason: "Motion update timeout"); return
        }
        if firstTimestamp != nil, remaining == 0 { stop(); return }
        if let active, active.recording.samples.count >= 2 {
            do { try store?.checkpoint(active) } catch { self.error = "Local save failed: \(error.localizedDescription)"; stop(reason: "Local persistence failed") }
        }
    }
    func stop(reason: String? = nil) {
        countdownTask?.cancel(); countdownTask = nil; countdown = 0
        guard isRecording else { return }
        isRecording = false; timer?.invalidate(); timer = nil
        manager.stopDeviceMotionUpdates(); UIApplication.shared.isIdleTimerDisabled = false
        if var item = active {
            if let reason { item.recording.interruptions.append(Interruption(t: item.recording.samples.last?.t ?? 0, reason: reason)) }
            if item.recording.samples.count >= 2 {
                do { try store?.save(item); store?.uploadPending() } catch { error = "Save failed: \(error.localizedDescription). A recovery draft may remain." }
            } else { store?.clearDraft(); error = error ?? "No usable samples received; nothing saved." }
        }
        active = nil; refresh()
    }
    nonisolated func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        Task { @MainActor in self.refresh() }
    }
    nonisolated func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        Task { @MainActor in self.connection = "Headphones disconnected"; self.stop(reason: "Headphones disconnected"); self.refresh() }
    }
}
