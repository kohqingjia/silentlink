import SwiftUI
import Charts

@main struct SilentLinkApp: App {
    @StateObject private var store = RecordingStore()
    @StateObject private var recorder = MotionRecorder()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(store).environmentObject(recorder)
                .tint(.mint)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { recorder.stop(reason: "App moved to background") }
                    if phase == .active { recorder.refresh(); store.uploadPending() }
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var store: RecordingStore
    @EnvironmentObject var recorder: MotionRecorder
    @State private var session: ResearchSession?
    @State private var experiment = "First feasibility study"
    @State private var label = "Rest"
    @State private var custom = ""
    @State private var duration = 15
    @State private var shareURL: URL?
    @State private var localError: String?
    @State private var deleting: SavedRecording?
    let labels = ["Rest", "Silent articulation: Hello", "Silent articulation: Thank you", "Silent articulation: How are you?", "Normal speaking", "Chewing", "Smiling", "Walking", "Head turning", "Custom phrase"]

    var body: some View {
        TabView {
            NavigationStack {
                Form {
                    Section {
                        Label("SILENTLINK / RESEARCH", systemImage: "waveform.path")
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                        Text("Listen to the signal.").font(.largeTitle.bold())
                        Text("Processed headphone motion. Silent-speech recognition is unproven.").foregroundStyle(.secondary)
                    }
                    Section("Headphones") {
                        Label(recorder.connection, systemImage: recorder.available ? "airpodspro" : "headphones")
                        LabeledContent("Motion permission", value: recorder.authorization)
                        Button("Refresh availability") { recorder.refresh() }
                    }
                    Section("Experimental session") {
                        TextField("Experiment name", text: $experiment).disabled(recorder.isRecording)
                        if let session {
                            Text("Session \(session.id.uuidString.prefix(8)) · \(session.started_at.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                            Text(session.experiment).font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Start a new session") { newSession() }.disabled(recorder.isRecording || recorder.countdown > 0 || experiment.trimmingCharacters(in: .whitespaces).isEmpty)
                        Picker("Label", selection: $label) { ForEach(labels, id: \.self) { Text($0) } }.disabled(recorder.isRecording || recorder.countdown > 0)
                        if label == "Custom phrase" { TextField("Phrase", text: $custom).disabled(recorder.isRecording) }
                        Picker("Duration", selection: $duration) { ForEach([10, 15, 30, 60], id: \.self) { Text("\($0) seconds").tag($0) } }.disabled(recorder.isRecording || recorder.countdown > 0)
                        Text("Sit still, keep the same AirPods fit, and follow the assigned label. Collect negative controls as well as phrases.").font(.caption).foregroundStyle(.secondary)
                    }
                    Section("Capture") {
                        if recorder.countdown > 0 { Text("Ready in \(recorder.countdown)").font(.largeTitle.monospacedDigit()) }
                        if recorder.isRecording {
                            Text("\(recorder.remaining)s remaining").font(.title.monospacedDigit())
                            Button("Stop and save", role: .destructive) { recorder.stop(reason: "Stopped by user") }
                        } else if recorder.countdown > 0 {
                            Button("Cancel countdown", role: .cancel) { recorder.stop() }
                        } else {
                            Button { begin() } label: { Label("Record motion", systemImage: "record.circle") }
                        }
                        LabeledContent("Samples", value: "\(recorder.sampleCount)")
                        LabeledContent("Observed rate", value: String(format: "%.1f Hz", recorder.rate))
                        if let error = recorder.error { Text(error).foregroundStyle(.red) }
                    }
                    Section("Live acceleration · g") { MotionChart(samples: recorder.samples, rotation: false) }
                    Section("Live rotation rate · rad/s") { MotionChart(samples: recorder.samples, rotation: true) }
                }
                .navigationTitle("Recorder")
                .onAppear { if session == nil { newSession() } }
            }.tabItem { Label("Record", systemImage: "waveform") }
            NavigationStack {
                List {
                    if store.recordings.isEmpty { ContentUnavailableView("No recordings yet", systemImage: "waveform.path", description: Text("Real measurements from your AirPods will appear here after a recording.")) }
                    ForEach(store.recordings) { item in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(item.recording.label).font(.headline)
                            Text(item.recording.started_at.formatted()).font(.caption).foregroundStyle(.secondary)
                            Text("\(item.recording.samples.count) samples · \(item.recording.observedRate, specifier: "%.1f") Hz · max gap \(item.recording.maxGap, specifier: "%.3f")s").font(.caption.monospaced())
                            Text("\(item.status) · \(item.recording.interruptions.count) interruptions").font(.caption)
                            if let error = item.error { Text(error).font(.caption).foregroundStyle(.red) }
                            HStack {
                                Button("CSV") { export(item, csv: true) }.buttonStyle(.bordered)
                                Button("JSON") { export(item, csv: false) }.buttonStyle(.bordered)
                                Spacer()
                                Button("Delete local", role: .destructive) { deleting = item }.buttonStyle(.borderless)
                            }
                        }.padding(.vertical, 6)
                    }
                }.navigationTitle("Recordings")
                    .toolbar { Button("Upload queued") { store.uploadPending() }.disabled(store.localOnly || store.uploading) }
                    .sheet(isPresented: Binding(get: { shareURL != nil }, set: { if !$0 { shareURL = nil } })) { if let shareURL { ShareSheet(url: shareURL) } }
                    .confirmationDialog("Delete this local recording? Server copies and backups are separate.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                        Button("Delete local recording", role: .destructive) {
                            if let deleting { do { try store.deleteLocal(deleting) } catch { localError = error.localizedDescription } }
                            deleting = nil
                        }
                    }
            }.tabItem { Label("Library", systemImage: "tray.full") }
            NavigationStack {
                Form {
                    Section("Privacy") {
                        Toggle("Keep all recordings local", isOn: $store.localOnly)
                        Text("Enabled by default. Turning this off allows saved recordings to upload to your configured server while the app is open. Existing server copies are unaffected.").font(.caption).foregroundStyle(.secondary)
                        Label("Audio capture is not enabled in this milestone", systemImage: "mic.slash")
                    }
                    Section("Your server") {
                        TextField("https://your-server.example", text: $store.serverURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        SecureField("Device API key", text: $store.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("The API key is stored in this iPhone’s Keychain. Uploads require HTTPS.").font(.caption).foregroundStyle(.secondary)
                        Button("Upload saved recordings") { store.uploadPending() }.disabled(store.localOnly || store.uploading)
                        if store.uploading { ProgressView(value: store.progress) }
                        if !store.message.isEmpty { Text(store.message).font(.caption) }
                    }
                    Section("Protocol") {
                        Text("Collect at least 10–20 repetitions per class, randomize class order, and repeat across multiple sessions on different days. Include rest, chewing, head turns and walking. Keep entire sessions and days separate for evaluation.")
                        Text("No transcription, AI prompting, or model accuracy is available yet. This is a sensor feasibility study.").foregroundStyle(.secondary)
                    }
                }.navigationTitle("Settings")
            }.tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
        }.alert("SilentLink", isPresented: Binding(get: { localError != nil }, set: { if !$0 { localError = nil } })) { Button("OK") { localError = nil } } message: { Text(localError ?? "") }
    }
    func newSession() { session = ResearchSession(experiment: String(experiment.prefix(120)), device: store.deviceID) }
    func begin() {
        if session == nil || !Calendar.current.isDateInToday(session!.started_at) { newSession() }
        guard let session else { return }
        let chosen = label == "Custom phrase" ? "Silent articulation: \(custom.trimmingCharacters(in: .whitespacesAndNewlines))" : label
        if label == "Custom phrase", custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { localError = "Enter a custom phrase."; return }
        recorder.begin(session: session, label: String(chosen.prefix(160)), duration: duration, store: store)
    }
    func export(_ item: SavedRecording, csv: Bool) {
        do { shareURL = try store.export(item, csv: csv) } catch { localError = error.localizedDescription }
    }
}
struct MotionChart: View {
    let samples: [MotionSample]
    let rotation: Bool
    var body: some View {
        if samples.isEmpty { Text("Waiting for real sensor data").foregroundStyle(.secondary).frame(height: 130) }
        else {
            Chart {
                ForEach(samples) { sample in
                    let vector = rotation ? sample.rotation_rate : sample.user_acceleration
                    LineMark(x: .value("Time", sample.t), y: .value("Value", vector.x)).foregroundStyle(by: .value("Axis", "X"))
                    LineMark(x: .value("Time", sample.t), y: .value("Value", vector.y)).foregroundStyle(by: .value("Axis", "Y"))
                    LineMark(x: .value("Time", sample.t), y: .value("Value", vector.z)).foregroundStyle(by: .value("Axis", "Z"))
                }
            }.chartXAxisLabel("Seconds from first sample").frame(height: 160)
        }
    }
}
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
