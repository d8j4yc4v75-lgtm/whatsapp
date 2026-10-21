import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct ErrorBody: Decodable { let error: String }

/// Cliente HTTP del servidor MultiWA
struct APIClient {
    var baseURL: URL
    var token: String

    init?(server: String, token: String) {
        var s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty || token.isEmpty { return nil }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s) else { return nil }
        baseURL = url
        self.token = token
    }

    static func encode(_ segment: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return segment.addingPercentEncoding(withAllowedCharacters: allowed) ?? segment
    }

    func url(_ path: String, query: [String: String] = [:]) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api"), resolvingAgainstBaseURL: false)!
        comps.percentEncodedPath += path
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return comps.url!
    }

    var webSocketURL: URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        comps.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url!
    }

    func mediaURL(_ message: Message) -> URL {
        var query = ["token": token]
        if message.type == "audio" { query["format"] = "m4a" }
        return url("/media/\(message.accountId)/\(APIClient.encode(message.id))", query: query)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        var request = request
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 60
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Error \(code)"
            throw APIError(message: msg)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send(URLRequest(url: url(path, query: query)))
    }

    @discardableResult
    func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await send(req)
    }

    func upload(fields: [String: String], file: Data, fileName: String, mime: String) async throws -> Message {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url("/send-media"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        for (k, v) in fields {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".data(using: .utf8)!)
        }
        let safeName = fileName.replacingOccurrences(of: "\"", with: "")
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(file)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        return try await send(req)
    }

    func download(_ message: Message) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(from: mediaURL(message))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw APIError(message: "No se pudo descargar el archivo")
        }
        return data
    }
}

struct OK: Decodable { let ok: Bool? }
struct ResolveResult: Decodable { let jid: String }
struct ServerInfo: Decodable { let push: Bool; let unread: Int }
struct PairingCode: Decodable { let code: String }
