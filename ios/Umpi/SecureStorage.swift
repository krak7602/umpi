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

/// Atomic replacement protects drafts and the outbox together. Credentials never enter this file.
struct CompanionPersistence {
    let directory: URL
    var file: URL { directory.appendingPathComponent("companion-state.json") }

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
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var protectedDirectory = directory
        var properties = URLResourceValues()
        properties.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(properties)
        let data = try JSONEncoder().encode(value)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var protectedFile = file
        try protectedFile.setResourceValues(properties)
    }

    func clear() throws {
        if FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.removeItem(at: file)
        }
    }
}
