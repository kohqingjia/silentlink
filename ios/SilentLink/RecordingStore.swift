import Foundation
import Security
import Network

@MainActor final class RecordingStore: ObservableObject {
    @Published var recordings: [SavedRecording] = []
    @Published var message = ""
    @Published var progress: Double = 0
    @Published var uploading = false
    @Published var localOnly: Bool { didSet {
        UserDefaults.standard.set(localOnly, forKey: "localOnly")
        if localOnly { uploadTask?.cancel() }
    } }
    @Published var serverURL: String { didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") } }
    @Published var token: String { didSet { saveToken(token) } }
    private let directory: URL
    private let monitor = NWPathMonitor()
    private var uploadTask: Task<Void, Never>?
    var deviceID: String {
        if let id = UserDefaults.standard.string(forKey: "deviceID") { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "deviceID")
        return id
    }

    init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SilentLink", isDirectory: true)
        localOnly = UserDefaults.standard.object(forKey: "localOnly") as? Bool ?? true
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        token = Self.readToken()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var protected = directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try protected.setResourceValues(values)
            try recoverDraft()
            try reload()
        } catch { message = "Local storage error: \(error.localizedDescription)" }
        monitor.pathUpdateHandler = { [weak self] path in
            if path.status == .satisfied { Task { @MainActor in self?.uploadPending() } }
        }
        monitor.start(queue: DispatchQueue(label: "SilentLink.network"))
    }
    private func file(_ id: UUID) -> URL { directory.appendingPathComponent("\(id.uuidString).json") }
    private var draft: URL { directory.appendingPathComponent("draft.json") }
    func checkpoint(_ item: SavedRecording) throws { try Codec.encoder.encode(item).write(to: draft, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    func save(_ item: SavedRecording) throws {
        try Codec.encoder.encode(item).write(to: file(item.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if let data = try? Data(contentsOf: draft), let pending = try? Codec.decoder.decode(SavedRecording.self, from: data), pending.id == item.id { try? FileManager.default.removeItem(at: draft) }
        try reload()
    }
    func clearDraft() { try? FileManager.default.removeItem(at: draft) }
    private func recoverDraft() throws {
        guard FileManager.default.fileExists(atPath: draft.path) else { return }
        var item = try Codec.decoder.decode(SavedRecording.self, from: Data(contentsOf: draft))
        if item.recording.samples.count >= 2 {
            item.recording.interruptions.append(Interruption(t: item.recording.samples.last?.t ?? 0, reason: "Recovered after app interruption; recording incomplete"))
            try Codec.encoder.encode(item).write(to: file(item.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        try FileManager.default.removeItem(at: draft)
    }
    private func reload() throws {
        recordings = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" && $0.lastPathComponent != "draft.json" }
            .map { try Codec.decoder.decode(SavedRecording.self, from: Data(contentsOf: $0)) }
            .sorted { $0.recording.started_at > $1.recording.started_at }
    }
    func export(_ item: SavedRecording, csv: Bool) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(item.id.uuidString).\(csv ? "csv" : "json")")
        let data = csv ? Data(item.recording.csv.utf8) : try Codec.encoder.encode(item.recording)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }
    func deleteLocal(_ item: SavedRecording) throws {
        guard !uploading else { throw UploadError.message("Wait for the current upload to finish") }
        try FileManager.default.removeItem(at: file(item.id)); try reload()
    }
    func uploadPending() {
        guard !localOnly, !uploading, !token.isEmpty else { return }
        guard let base = URL(string: serverURL), base.scheme == "https", base.host != nil, base.user == nil, base.password == nil, base.query == nil, base.fragment == nil, base.path.isEmpty || base.path == "/" else {
            message = "Enter an HTTPS server origin, without a path."; return
        }
        uploading = true
        uploadTask = Task {
            defer { uploading = false }
            for original in recordings.filter({ $0.status != "Uploaded" }) {
                if Task.isCancelled || localOnly { return }
                var item = original
                do {
                    progress = 0
                    try await post(item.session, path: "api/v1/sessions", base: base)
                    try Task.checkCancellation()
                    try await post(item.recording, path: "api/v1/recordings", base: base)
                    item.status = "Uploaded"; item.error = nil; progress = 1
                    message = "Recording uploaded"
                } catch {
                    item.status = "Queued"; item.error = error.localizedDescription
                    message = "Upload paused: \(error.localizedDescription)"
                }
                do { try save(item) } catch { message = "Could not save upload status: \(error.localizedDescription)"; return }
                if item.status != "Uploaded" { return }
            }
        }
    }
    private func post<T: Encodable>(_ value: T, path: String, base: URL) async throws {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"; request.timeoutInterval = 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let delegate = UploadDelegate { [weak self] value in Task { @MainActor in self?.progress = value } }
        let (data, response) = try await URLSession.shared.upload(for: request, from: Codec.encoder.encode(value), delegate: delegate)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw UploadError.message("HTTP \(code): \(String(decoding: data.prefix(300), as: UTF8.self))")
        }
    }
    private static let keychainQuery: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "SilentLink", kSecAttrAccount as String: "device-token"]
    private static func readToken() -> String {
        var query = keychainQuery; query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
    private func saveToken(_ value: String) {
        var query = Self.keychainQuery
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty else { return }
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        if SecItemAdd(query as CFDictionary, nil) != errSecSuccess { message = "Could not save API key in Keychain" }
    }
}
enum UploadError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
final class UploadDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let progress: @Sendable (Double) -> Void
    init(progress: @escaping @Sendable (Double) -> Void) { self.progress = progress }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if totalBytesExpectedToSend > 0 { progress(Double(totalBytesSent) / Double(totalBytesExpectedToSend)) }
    }
    // Never forward a device credential through a redirect.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
