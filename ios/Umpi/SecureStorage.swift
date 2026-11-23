import Foundation
import Security

struct PairCredentials: Codable, Equatable, Sendable {
    var server: String
    var deviceID: String
    var label: String
    var token: String
    var pendingCode: String?
    var pendingCapabilities: [Capability]? = nil
}

protocol CredentialVault {
    func load() throws -> PairCredentials?
    func save(_ credentials: PairCredentials) throws
    func clear() throws
}

struct KeychainCredentialVault: CredentialVault {
    private let service = "app.umpi.companion.credentials"
    private let account = "device-session"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load() throws -> PairCredentials? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw SecureStorageError.unavailable
        }
        return try JSONDecoder().decode(PairCredentials.self, from: data)
    }

    func save(_ credentials: PairCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SecureStorageError.unavailable }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecureStorageError.unavailable
        }
    }

    static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SecureStorageError.unavailable
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

enum SecureStorageError: LocalizedError {
    case unavailable
    var errorDescription: String? { "Secure device credentials are unavailable. Unlock the device and try again." }
}

/// The app's copy of the coordinator's state. It is read again from the coordinator at launch, so a lost write costs
/// one read and nothing else.
struct SnapshotCopy: Codable, Sendable {
    var deviceID: String
    var snapshot: DeviceSnapshot
    var lastSyncedAt: Date?
}

/// Local state in two files. Credentials never enter either.
///
/// `companion-state.json` holds what exists only on this device: the outbox, drafts, conflicts, runs, and effect
/// outcomes. It is small, and `save` replaces it atomically before it returns, so drafts and the outbox are saved
/// together and a queued message survives a crash.
///
/// `companion-snapshot.json` holds the copy of the coordinator's state, some hundred kilobytes. `saveSnapshot` encodes
/// and writes it off the caller's thread; when several copies wait, only the newest is written. An earlier build kept
/// the snapshot inside the state file; that file still loads, and the snapshot file takes its place when present.
struct CompanionPersistence {
    let directory: URL
    var file: URL { directory.appendingPathComponent("companion-state.json") }
    var snapshotFile: URL { directory.appendingPathComponent("companion-snapshot.json") }

    init(directory: URL? = nil) throws {
        self.directory = try directory ?? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("Companion", isDirectory: true)
    }

    func load<T: Decodable>(_ type: T.Type) throws -> T? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(type, from: Data(contentsOf: file))
    }

    func save<T: Encodable>(_ value: T) throws {
        try Self.write(JSONEncoder().encode(value), to: file, in: directory)
    }

    /// The saved copy of the coordinator's state, after every write scheduled before this call. An unreadable copy is
    /// no copy: the next read from the coordinator replaces it.
    func loadSnapshot() -> SnapshotCopy? {
        SnapshotWriter.shared.drain()
        guard let data = try? Data(contentsOf: snapshotFile) else { return nil }
        return try? JSONDecoder().decode(SnapshotCopy.self, from: data)
    }

    /// Returns at once. The copy is encoded and written on a background queue.
    func saveSnapshot(_ copy: SnapshotCopy) {
        let file = snapshotFile, directory = directory
        SnapshotWriter.shared.write(copy, key: file) { copy in
            try? Self.write(JSONEncoder().encode(copy), to: file, in: directory)
        }
    }

    /// Returns when every snapshot write scheduled so far is on disk.
    func flush() { SnapshotWriter.shared.drain() }

    func clear() throws {
        // After every write already started, and with none left waiting, so no late write brings the file back.
        try SnapshotWriter.shared.cancel(key: snapshotFile) {
            for url in [file, snapshotFile] where FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    private static func write(_ data: Data, to file: URL, in directory: URL) throws {
        var properties = URLResourceValues()
        properties.isExcludedFromBackup = true
        do {
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // The folder is made on the first write, not checked on every one.
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var protectedDirectory = directory
            try protectedDirectory.setResourceValues(properties)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        var protectedFile = file
        try protectedFile.setResourceValues(properties)
    }
}

/// Writes snapshot copies on one serial background queue for the process. For each file only the newest copy waiting
/// is written, so a burst of changes costs one write.
private final class SnapshotWriter: @unchecked Sendable {
    static let shared = SnapshotWriter()
    private let queue = DispatchQueue(label: "app.umpi.companion.snapshot", qos: .utility)
    private let lock = NSLock()
    private var waiting: [URL: SnapshotCopy] = [:]

    func write(_ copy: SnapshotCopy, key: URL, with write: @escaping @Sendable (SnapshotCopy) -> Void) {
        lock.lock()
        let scheduled = waiting[key] != nil
        waiting[key] = copy
        lock.unlock()
        guard !scheduled else { return }
        queue.async {
            self.lock.lock()
            let newest = self.waiting.removeValue(forKey: key)
            self.lock.unlock()
            if let newest { write(newest) }
        }
    }

    func drain() { queue.sync {} }

    func cancel(key: URL, then work: () throws -> Void) rethrows {
        lock.lock()
        waiting[key] = nil
        lock.unlock()
        try queue.sync(execute: work)
    }
}
