import Foundation

struct Vector3: Codable { var x: Double; var y: Double; var z: Double }
struct Quaternion: Codable { var x: Double; var y: Double; var z: Double; var w: Double }
struct MotionSample: Codable, Identifiable {
    var id: Double { t }
    var t: Double
    var sensor_timestamp: Double
    var user_acceleration: Vector3
    var rotation_rate: Vector3
    var gravity: Vector3
    var attitude: Quaternion
}
struct Interruption: Codable { var t: Double; var reason: String }
struct ResearchSession: Codable, Identifiable {
    var id = UUID()
    var experiment: String
    var device: String
    var started_at = Date()
    var notes = ""
    var protocol_version = "motion-v1"
}
struct Recording: Codable, Identifiable {
    var schema_version = 1
    var id = UUID()
    var session_id: UUID
    var label: String
    var recording_type = "motion"
    var source = "cmheadphonemotionmanager"
    var synthetic = false
    var started_at = Date()
    var device: String
    var os_version: String
    var requested_duration_s: Int
    var interruptions: [Interruption] = []
    var samples: [MotionSample] = []

    var observedRate: Double {
        guard let last = samples.last, last.t > 0 else { return 0 }
        return Double(samples.count - 1) / last.t
    }
    var maxGap: Double { zip(samples, samples.dropFirst()).map { $1.t - $0.t }.max() ?? 0 }
    var csv: String {
        let header = "t,sensor_timestamp,user_acceleration_x,user_acceleration_y,user_acceleration_z,rotation_rate_x,rotation_rate_y,rotation_rate_z,gravity_x,gravity_y,gravity_z,attitude_x,attitude_y,attitude_z,attitude_w"
        return header + "\n" + samples.map { s in
            [s.t, s.sensor_timestamp, s.user_acceleration.x, s.user_acceleration.y, s.user_acceleration.z,
             s.rotation_rate.x, s.rotation_rate.y, s.rotation_rate.z, s.gravity.x, s.gravity.y, s.gravity.z,
             s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w].map { String($0) }.joined(separator: ",")
        }.joined(separator: "\n") + "\n"
    }
}
struct SavedRecording: Codable, Identifiable {
    var id: UUID { recording.id }
    var session: ResearchSession
    var recording: Recording
    var status = "Local only"
    var error: String?
}
enum Codec {
    static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.sortedKeys]; return e }()
    static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()
}
