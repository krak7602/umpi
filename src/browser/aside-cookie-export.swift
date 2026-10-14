import Foundation
import Security
import CryptoKit
import AsideExportSystem

// Build a stable, dedicated executable, then ad-hoc sign it. Only the explicit
// authorize command permits UI. Never alter a Keychain ACL or persist its secret.
#if SYNTHETIC_FIXTURE
let storageService = "umpi.synthetic.AsideSafeStorage"
let storageAccount = "umpi.synthetic.Aside"
#else
let storageService = "Aside Safe Storage"
let storageAccount = "Aside"
#endif

struct ExportFailure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw ExportFailure(code: code) }
func sha(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) }
func textJSON(_ value: Any) throws -> String { String(decoding: try json(value), as: UTF8.self) }

struct Site: Decodable {
    let siteId: String
    let title: String
    let origins: [String]
    let cookieHosts: [String]
    let cookieNames: [String]
    let resourceHosts: [String]
    let domain: String?
    let resources: String?
    func canonical() throws -> Data {
        var fields: [(String, Any)] = [("siteId", siteId), ("title", title), ("origins", origins), ("cookieHosts", cookieHosts), ("cookieNames", cookieNames), ("resourceHosts", resourceHosts)]
        if let domain { fields.append(("domain", domain)) }
        if let resources { fields.append(("resources", resources)) }
        return Data(try ("{" + fields.map { try "\"" + $0.0 + "\":" + textJSON($0.1) }.joined(separator: ",") + "}").utf8)
    }
    func validate() throws {
        guard resources == nil || resources == "public" else { try fail("invalid-cookie-scope") }
        if let domain {
            guard domain.withCString({ aside_export_public_domain($0) }) != 0,
                  cookieHosts.isEmpty, cookieNames.isEmpty,
                  !origins.isEmpty, origins.count <= 16 else { try fail("invalid-cookie-scope") }
            for origin in origins {
                guard let url = URLComponents(string: origin), let host = url.host,
                      url.scheme == "https", url.user == nil, url.password == nil,
                      url.port == nil, origin == "https://" + host,
                      host.withCString({ h in domain.withCString { d in aside_export_cookie_domain(h, d) } }) != 0 else { try fail("invalid-cookie-scope") }
            }
        } else {
            guard cookieHosts.count <= 32, cookieNames.count <= 128,
                  Set(cookieHosts).count == cookieHosts.count,
                  Set(cookieNames).count == cookieNames.count else { try fail("invalid-cookie-scope") }
            for host in cookieHosts {
                let bare = host.hasPrefix(".") ? String(host.dropFirst()) : host
                guard bare.withCString({ aside_export_dns_host($0) }) != 0 else { try fail("invalid-cookie-scope") }
            }
            for name in cookieNames { guard validCookieName(name) else { try fail("invalid-cookie-scope") } }
        }
    }
    func allows(host: String, name: String) -> Bool {
        if let domain {
            return host.withCString({ h in domain.withCString { d in aside_export_cookie_domain(h, d) } }) != 0 && validCookieName(name)
        }
        return cookieHosts.contains(host) && cookieNames.contains(name)
    }
}
func validCookieName(_ name: String) -> Bool {
    !name.isEmpty && name.utf16.count <= 256 && name.unicodeScalars.allSatisfy {
        $0.value > 0x20 && $0.value != 0x7f && $0.value != 0x3b && $0.value != 0x2c && $0.value != 0x3d
    }
}
func validateRequestJSON(_ data: Data) throws {
    guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(request.keys) == Set(["sourceCookieDb", "site", "policyDigest", "snapshotId", "key"]),
          let site = request["site"] as? [String: Any],
          Set(["siteId", "title", "origins", "cookieHosts", "cookieNames", "resourceHosts"]).isSubset(of: Set(site.keys)),
          Set(site.keys).isSubset(of: Set(["siteId", "title", "origins", "cookieHosts", "cookieNames", "resourceHosts", "domain", "resources"])),
          !site.keys.contains("domain") || site["domain"] is String,
          !site.keys.contains("resources") || site["resources"] is String,
          let key = request["key"] as? [String: Any],
          Set(key.keys) == Set(["keyId", "publicKey"]),
          let jwk = key["publicKey"] as? [String: Any],
          Set(["kty", "n", "e"]).isSubset(of: Set(jwk.keys)),
          Set(jwk.keys).isSubset(of: Set(["kty", "n", "e", "alg", "ext", "key_ops"])) else { try fail("invalid-export-scope") }
}
struct PublicJWK: Decodable { let kty: String; let n: String; let e: String }
struct SnapshotKey: Decodable { let keyId: String; let publicKey: PublicJWK }
struct Request: Decodable {
    let sourceCookieDb: String
    let site: Site
    let policyDigest: String
    let snapshotId: String
    let key: SnapshotKey
}
struct Cookie: Encodable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let expires: Double
    let secure: Bool
    let httpOnly: Bool
    let sameSite: String?
}
struct Authentication: Encodable { let version = 1; let cookies: [Cookie] }

func storageSecret(allowUI: Bool) throws -> Data {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: storageService,
        kSecAttrAccount as String: storageAccount,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
        kSecUseAuthenticationUI as String: allowUI ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled { try fail("keychain-locked-or-not-authorized") }
    if status == errSecItemNotFound { try fail("aside-safe-storage-not-found") }
    guard status == errSecSuccess, let secret = result as? Data, !secret.isEmpty, secret.count <= 4096 else { try fail("keychain-access-failed") }
    return secret
}
func deriveKey(_ secret: Data) throws -> Data {
    var key = Data(count: 16)
    let salt = Data("saltysalt".utf8)
    let status = key.withUnsafeMutableBytes { out in secret.withUnsafeBytes { password in salt.withUnsafeBytes { saltBytes in
        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password.baseAddress!.assumingMemoryBound(to: Int8.self), secret.count, saltBytes.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, out.baseAddress!.assumingMemoryBound(to: UInt8.self), 16)
    } } }
    guard status == kCCSuccess else { try fail("key-derivation-failed") }
    return key
}
func decrypt(_ encrypted: Data, host: String, key: Data) throws -> String {
    guard encrypted.count >= 19, encrypted.prefix(3) == Data("v10".utf8), (encrypted.count - 3) % 16 == 0 else { try fail("unsupported-cookie-encryption") }
    let cipher = encrypted.dropFirst(3)
    var plain = Data(count: cipher.count + 16)
    defer { plain.resetBytes(in: 0..<plain.count) }
    let iv = Data(repeating: 0x20, count: 16)
    var size = 0
    let capacity = plain.count
    let status = plain.withUnsafeMutableBytes { out in key.withUnsafeBytes { keyBytes in iv.withUnsafeBytes { ivBytes in cipher.withUnsafeBytes { input in
        CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding), keyBytes.baseAddress, key.count, ivBytes.baseAddress, input.baseAddress, cipher.count, out.baseAddress, capacity, &size)
    } } } }
    guard status == kCCSuccess, size >= 32 else { try fail("cookie-decryption-failed") }
    guard plain.prefix(32) == sha(Data(host.utf8)) else { try fail("cookie-domain-hash-mismatch") }
    guard let value = String(data: plain.subdata(in: 32..<size), encoding: .utf8) else { try fail("unsupported-cookie-value") }
    return value
}

final class Database {
    let handle: OpaquePointer
    init(path: String, writable: Bool = false) throws {
        var connection: OpaquePointer?
        let flags = writable ? SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE : SQLITE_OPEN_READONLY
        let status = sqlite3_open_v2(path, &connection, flags | SQLITE_OPEN_NOMUTEX, nil)
        guard status == SQLITE_OK, let connection else { if let connection { sqlite3_close(connection) }; try fail("cookie-database-unavailable") }
        handle = connection
        sqlite3_busy_timeout(handle, 2000)
    }
    deinit { sqlite3_close(handle) }
    func execute(_ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { try fail("cookie-database-read-failed") }
    }
    func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { try fail("unsupported-cookie-schema") }
        return statement
    }
}
let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
func columnText(_ statement: OpaquePointer, _ column: Int32) throws -> String {
    guard sqlite3_column_type(statement, column) == SQLITE_TEXT, let bytes = sqlite3_column_text(statement, column) else { try fail("unsupported-cookie-field") }
    let size = Int(sqlite3_column_bytes(statement, column))
    guard size <= 65536, let result = String(data: Data(bytes: bytes, count: size), encoding: .utf8), !result.contains("\0") else { try fail("unsupported-cookie-field") }
    return result
}
func columnInt(_ statement: OpaquePointer, _ column: Int32) throws -> Int64 {
    guard sqlite3_column_type(statement, column) == SQLITE_INTEGER else { try fail("unsupported-cookie-field") }
    return sqlite3_column_int64(statement, column)
}
func cookieExpiry(_ micros: Int64, persistent: Bool, hasExpires: Bool) throws -> Double {
    guard persistent == hasExpires else { try fail("unsupported-cookie-expiration") }
    if !persistent { guard micros == 0 else { try fail("unsupported-cookie-expiration") }; return -1 }
    // Subtract as Int64 BEFORE conversion: Chromium epoch microseconds exceed JS
    // integer precision. Fractional Unix seconds are preserved only afterward.
    let epoch: Int64 = 11_644_473_600_000_000
    guard micros >= epoch, micros <= 265_046_774_399_999_999 else { try fail("unsupported-cookie-expiration") }
    let unix = micros - epoch
    return Double(unix / 1_000_000) + Double(unix % 1_000_000) / 1_000_000
}
func sample(_ request: Request, key: Data) throws -> ([Cookie], Date) {
    guard request.sourceCookieDb.hasPrefix("/"), !request.sourceCookieDb.contains("\0") else { try fail("invalid-cookie-database-path") }
    guard let canonical = realpath(request.sourceCookieDb, nil) else { try fail("invalid-cookie-database-path") }
    defer { free(canonical) }
    let attributes = try FileManager.default.attributesOfItem(atPath: request.sourceCookieDb)
    guard String(cString: canonical) == request.sourceCookieDb,
          attributes[.type] as? FileAttributeType == .typeRegular,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else { try fail("invalid-cookie-database-path") }
    // No immutable=1: the read transaction must observe current committed WAL.
    let db = try Database(path: request.sourceCookieDb)
    try db.execute("PRAGMA query_only=ON; BEGIN")
    defer { try? db.execute("ROLLBACK") }
    let metadata = try db.prepare("SELECT key,value FROM meta WHERE key IN ('version','last_compatible_version')")
    defer { sqlite3_finalize(metadata) }
    var versions: [String: Int] = [:]
    var status = sqlite3_step(metadata)
    while status == SQLITE_ROW {
        let name = try columnText(metadata, 0)
        let value = try columnText(metadata, 1)
        guard let version = Int(value) else { try fail("unsupported-cookie-schema") }
        versions[name] = version
        status = sqlite3_step(metadata)
    }
    guard status == SQLITE_DONE, versions["version"] == 24, let compatible = versions["last_compatible_version"], compatible <= 24, compatible > 0 else { try fail("unsupported-cookie-schema") }
    let hosts = request.site.cookieHosts, names = request.site.cookieNames
    let selection: String
    let values: [String]
    if let domain = request.site.domain {
        // GLOB metacharacters cannot occur in a validated DNS domain. These
        // boundary-aware predicates never select sibling/parent/suffix domains.
        selection = "host_key COLLATE BINARY IN (?,?) OR host_key GLOB ?"
        values = [domain, "." + domain, "*." + domain]
    } else {
        if hosts.isEmpty || names.isEmpty { return ([], Date()) }
        let hostSlots = Array(repeating: "?", count: hosts.count).joined(separator: ",")
        let nameSlots = Array(repeating: "?", count: names.count).joined(separator: ",")
        selection = "host_key COLLATE BINARY IN (\(hostSlots)) AND name COLLATE BINARY IN (\(nameSlots))"
        values = hosts + names
    }
    let statement = try db.prepare("SELECT host_key,name,path,expires_utc,is_secure,is_httponly,samesite,has_expires,is_persistent,top_frame_site_key,has_cross_site_ancestor,encrypted_value,value FROM cookies WHERE \(selection) ORDER BY host_key,name,path")
    defer { sqlite3_finalize(statement) }
    for (index, value) in values.enumerated() {
        guard sqlite3_bind_text(statement, Int32(index + 1), value, -1, transient) == SQLITE_OK else { try fail("cookie-database-read-failed") }
    }
    var cookies: [Cookie] = []
    let sampledAt = Date()
    status = sqlite3_step(statement)
    while status == SQLITE_ROW {
        let host = try columnText(statement, 0), name = try columnText(statement, 1), path = try columnText(statement, 2)
        guard request.site.allows(host: host, name: name), path.hasPrefix("/") else { try fail("cookie-scope-mismatch") }
        let hasExpires = try columnInt(statement, 7), persistent = try columnInt(statement, 8)
        guard (0...1).contains(hasExpires), (0...1).contains(persistent) else { try fail("unsupported-cookie-expiration") }
        let expires = try cookieExpiry(columnInt(statement, 3), persistent: persistent == 1, hasExpires: hasExpires == 1)
        if expires != -1 && expires <= sampledAt.timeIntervalSince1970 { status = sqlite3_step(statement); continue }
        guard try columnText(statement, 9).isEmpty, try columnInt(statement, 10) == 0 else { try fail("unsupported-partitioned-cookie") }
        let secure = try columnInt(statement, 4), httpOnly = try columnInt(statement, 5), sameSite = try columnInt(statement, 6)
        guard (0...1).contains(secure), (0...1).contains(httpOnly), (-1...2).contains(sameSite), sameSite != 0 || secure == 1 else { try fail("unsupported-cookie-attributes") }
        guard try columnText(statement, 12).isEmpty, sqlite3_column_type(statement, 11) == SQLITE_BLOB else { try fail("unsupported-cookie-encryption") }
        let size = Int(sqlite3_column_bytes(statement, 11))
        guard size <= 65536, let bytes = sqlite3_column_blob(statement, 11) else { try fail("unsupported-cookie-encryption") }
        let value = try decrypt(Data(bytes: bytes, count: size), host: host, key: key)
        cookies.append(Cookie(name: name, value: value, domain: host, path: path, expires: expires, secure: secure == 1, httpOnly: httpOnly == 1, sameSite: sameSite == -1 ? nil : ["None", "Lax", "Strict"][Int(sameSite)]))
        guard cookies.count <= 4096 else { try fail("cookie-snapshot-too-large") }
        status = sqlite3_step(statement)
    }
    guard status == SQLITE_DONE else { try fail("cookie-database-read-failed") }
    return (cookies, Date())
}

func base64url(_ value: String) throws -> Data {
    guard !value.isEmpty, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { try fail("invalid-snapshot-public-key") }
    let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
    guard let bytes = Data(base64Encoded: padded), bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value else { try fail("invalid-snapshot-public-key") }
    return bytes
}
func derLength(_ count: Int) -> Data {
    if count < 128 { return Data([UInt8(count)]) }
    var remaining = count, bytes: [UInt8] = []
    while remaining > 0 { bytes.insert(UInt8(remaining & 255), at: 0); remaining >>= 8 }
    return Data([0x80 | UInt8(bytes.count)] + bytes)
}
func derInteger(_ input: Data) -> Data {
    var value = input
    if value.first! & 0x80 != 0 { value.insert(0, at: 0) }
    return Data([2]) + derLength(value.count) + value
}
func rsaKey(_ jwk: PublicJWK) throws -> SecKey {
    guard jwk.kty == "RSA" else { try fail("invalid-snapshot-public-key") }
    let modulus = try base64url(jwk.n), exponent = try base64url(jwk.e)
    guard (256...512).contains(modulus.count), modulus.first! >= 0x80, exponent == Data([1, 0, 1]) else { try fail("invalid-snapshot-public-key") }
    let payload = derInteger(modulus) + derInteger(exponent)
    let der = Data([0x30]) + derLength(payload.count) + payload
    let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA, kSecAttrKeyClass as String: kSecAttrKeyClassPublic, kSecAttrKeySizeInBits as String: modulus.count * 8]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(der as CFData, attributes as CFDictionary, &error), SecKeyIsAlgorithmSupported(key, .encrypt, .rsaEncryptionOAEPSHA256) else { try fail("invalid-snapshot-public-key") }
    return key
}
func exportEnvelope(_ request: Request) throws -> Data {
    try request.site.validate()
    guard hex(sha(try request.site.canonical())) == request.policyDigest, request.policyDigest.count == 64, !request.snapshotId.isEmpty, request.snapshotId.count <= 128, !request.key.keyId.isEmpty, request.key.keyId.count <= 128 else { try fail("invalid-export-scope") }
    let publicKey = try rsaKey(request.key.publicKey)
    var secret = try storageSecret(allowUI: false)
    defer { secret.resetBytes(in: 0..<secret.count) }
    var key = try deriveKey(secret)
    defer { key.resetBytes(in: 0..<key.count) }
    let (cookies, capturedAt) = try sample(request, key: key)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let captured = formatter.string(from: capturedAt), expires = formatter.string(from: capturedAt.addingTimeInterval(30 * 86400))
    let aad = try json([request.snapshotId, request.site.siteId, request.policyDigest, request.key.keyId, captured, expires])
    let encoder = JSONEncoder()
    var plaintext = try encoder.encode(Authentication(cookies: cookies))
    defer { plaintext.resetBytes(in: 0..<plaintext.count) }
    guard plaintext.count <= 2 * 1024 * 1024 else { try fail("cookie-snapshot-too-large") }
    let aes = SymmetricKey(size: .bits256)
    let sealed = try AES.GCM.seal(plaintext, using: aes, authenticating: aad)
    var rawKey = aes.withUnsafeBytes { Data($0) }
    defer { rawKey.resetBytes(in: 0..<rawKey.count) }
    var error: Unmanaged<CFError>?
    guard let wrapped = SecKeyCreateEncryptedData(publicKey, .rsaEncryptionOAEPSHA256, rawKey as CFData, &error) else { try fail("snapshot-key-wrap-failed") }
    let envelope = try json(["version": 1, "snapshotId": request.snapshotId, "siteId": request.site.siteId, "policyDigest": request.policyDigest, "keyId": request.key.keyId, "capturedAt": captured, "expiresAt": expires, "wrappedKey": (wrapped as Data).base64EncodedString(), "nonce": sealed.nonce.withUnsafeBytes { Data($0).base64EncodedString() }, "ciphertext": (sealed.ciphertext + sealed.tag).base64EncodedString()])
    guard envelope.count <= 2 * 1024 * 1024 else { try fail("cookie-snapshot-too-large") }
    return envelope
}

#if SYNTHETIC_FIXTURE
// This variant cannot access Aside's Keychain item. Fixture actions exist only
// under an explicit compile-time flag and never modify an existing cookie DB.
func fixtureCreate(_ path: String) throws {
    guard path.hasPrefix("/"), !FileManager.default.fileExists(atPath: path) else { try fail("fixture-path-must-be-new") }
    let secret = Data("synthetic-test-secret-not-a-credential".utf8)
    let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: storageService, kSecAttrAccount as String: storageAccount, kSecValueData as String: secret]
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { try fail("synthetic-keychain-fixture-already-exists") }
    do {
        let db = try Database(path: path, writable: true)
        try db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','24'),('last_compatible_version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER,is_persistent INTEGER,top_frame_site_key TEXT,has_cross_site_ancestor INTEGER,encrypted_value BLOB,value TEXT);")
        let key = try deriveKey(secret)
        for (host, name, value, expired) in [
            (".example.test", "session", "synthetic-session", false),
            (".example.test", "other", "unapproved-cookie", false),
            (".unrelated.test", "session", "unrelated-domain", false),
            (".example.test", "expired", "expired-cookie", true),
            (".example.com", "session", "requested-domain-session", false),
            ("example.com", "other", "requested-host-cookie", false),
            (".www.example.com", "other", "requested-subdomain-cookie", false),
            (".example.com", "expired", "expired-domain-cookie", true),
            (".notexample.com", "session", "unsafe-sibling-cookie", false),
            (".com", "session", "unsafe-parent-cookie", false),
            (".example.com.attacker.org", "session", "unsafe-suffix-cookie", false),
            (".tenant.github.io", "session", "requested-private-domain-cookie", false),
            (".github.io", "session", "unsafe-private-suffix-cookie", false),
            (".other.github.io", "session", "unsafe-private-sibling-cookie", false)
        ] {
            let plain = sha(Data(host.utf8)) + Data(value.utf8)
            var encrypted = Data(count: plain.count + 16), size = 0
            let capacity = encrypted.count, iv = Data(repeating: 0x20, count: 16)
            let status = encrypted.withUnsafeMutableBytes { out in key.withUnsafeBytes { kb in iv.withUnsafeBytes { ib in plain.withUnsafeBytes { pb in CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding), kb.baseAddress, key.count, ib.baseAddress, pb.baseAddress, plain.count, out.baseAddress, capacity, &size) } } } }
            guard status == kCCSuccess else { try fail("fixture-encryption-failed") }
            encrypted = Data("v10".utf8) + encrypted.prefix(size)
            let statement = try db.prepare("INSERT INTO cookies VALUES(?,?, '/',?,1,1,1,?,?,'',0,?,'')")
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, host, -1, transient)
            sqlite3_bind_text(statement, 2, name, -1, transient)
            sqlite3_bind_int64(statement, 3, expired ? 11_644_473_601_000_000 : 0)
            sqlite3_bind_int(statement, 4, expired ? 1 : 0)
            sqlite3_bind_int(statement, 5, expired ? 1 : 0)
            _ = encrypted.withUnsafeBytes { sqlite3_bind_blob(statement, 6, $0.baseAddress, Int32(encrypted.count), transient) }
            guard sqlite3_step(statement) == SQLITE_DONE else { try fail("fixture-database-failed") }
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: storageService, kSecAttrAccount as String: storageAccount] as CFDictionary)
        throw error
    }
}
#endif

func main() throws {
    guard CommandLine.arguments.count == 2 else { try fail("invalid-command") }
    switch CommandLine.arguments[1] {
    case "authorize":
        var secret = try storageSecret(allowUI: true)
        secret.resetBytes(in: 0..<secret.count)
        FileHandle.standardOutput.write(Data("{\"authorized\":true}\n".utf8))
    case "export":
        // Bound stdin without reading unbounded data; never use command-line secrets.
        var input = Data()
        while true {
            let part = FileHandle.standardInput.readData(ofLength: 8192)
            if part.isEmpty { break }
            input.append(part)
            guard input.count <= 65536 else { try fail("export-request-too-large") }
        }
        try validateRequestJSON(input)
        let request = try JSONDecoder().decode(Request.self, from: input)
        let envelope = try exportEnvelope(request)
        FileHandle.standardOutput.write(envelope)
    #if SYNTHETIC_FIXTURE
    case "fixture-create":
        let input = FileHandle.standardInput.readData(ofLength: 4097)
        guard input.count <= 4096, let path = String(data: input, encoding: .utf8) else { try fail("invalid-fixture-path") }
        try fixtureCreate(path)
        FileHandle.standardOutput.write(Data("{\"fixtureCreated\":true}\n".utf8))
    case "fixture-delete":
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: storageService, kSecAttrAccount as String: storageAccount] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { try fail("synthetic-keychain-cleanup-failed") }
        FileHandle.standardOutput.write(Data("{\"fixtureDeleted\":true}\n".utf8))
    #endif
    default: try fail("invalid-command")
    }
}
do { try main() }
catch let error as ExportFailure { FileHandle.standardError.write(Data((error.code + "\n").utf8)); exit(1) }
catch { FileHandle.standardError.write(Data("cookie-export-failed\n".utf8)); exit(1) }
