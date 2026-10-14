import Foundation

protocol CompanionTransport: Sendable {
    func send(path: String, method: String, body: Data?) async throws -> Data
}

enum CompanionClientError: Error, LocalizedError {
    case invalidServer
    case invalidResponse
    case http(status: Int, message: String, current: Workflow?)

    var errorDescription: String? {
        switch self {
        case .invalidServer: "Enter an HTTPS server origin without credentials, a path, query, or fragment."
        case .invalidResponse: "The server returned an unsupported response."
        case .http(_, let message, _): message
        }
    }
    var retryable: Bool {
        if case .http(let status, _, _) = self { return status == 429 || status >= 500 }
        return false
    }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class CompanionClient: CompanionTransport, @unchecked Sendable {
    private let origin: URL
    private let token: String?
    private let session: URLSession

    static func validateServer(_ input: String) throws -> URL {
        guard let parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let url = parts.url else { throw CompanionClientError.invalidServer }
        var allowed = parts.scheme?.lowercased() == "https"
        #if DEBUG
        if parts.scheme?.lowercased() == "http", ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased()) {
            allowed = true
        }
        #endif
        guard allowed else { throw CompanionClientError.invalidServer }
        return url
    }

    init(server: URL, token: String?, configuration: URLSessionConfiguration? = nil) {
        origin = server
        self.token = token
        let config = configuration ?? .ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        session = URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func send(path: String, method: String, body: Data?) async throws -> Data {
        guard path.hasPrefix("/api/device/"), !path.contains("?"), !path.contains("#"),
              !path.contains(".."),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port else {
            throw CompanionClientError.invalidServer
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw CompanionClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            struct Failure: Decodable { var error: String; var current: Workflow? }
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            let message: String
            switch response.statusCode {
            case 300..<400: message = "Server redirects are refused. Check the paired server origin."
            case 401, 403: message = "Device authorization was rejected. Pair again if this device was revoked."
            default: message = String((failure?.error ?? "Server request failed (\(response.statusCode)).").prefix(512))
            }
            throw CompanionClientError.http(status: response.statusCode, message: message, current: failure?.current)
        }
        return data
    }
}
