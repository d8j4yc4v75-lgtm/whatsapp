import Foundation

struct CoachVerdict: Decodable {
    let puntuacion: Int
    let resumen: String
    let bien: [String]
    let mal: [String]
    let manana: [String]
}

enum ClaudeError: LocalizedError {
    case missingKey
    case http(Int, String)
    case refusal
    case badResponse

    var errorDescription: String? {
        switch self {
        case .missingKey: "Agrega tu API key de Anthropic en Ajustes."
        case .http(let code, let body): "Error \(code) de la API: \(body)"
        case .refusal: "Claude no pudo analizar este día. Intenta de nuevo."
        case .badResponse: "Respuesta inesperada de la API."
        }
    }
}

/// Llama a la API de Claude (HTTP directo, no hay SDK oficial para Swift).
enum ClaudeService {
    static let apiKeyName = "anthropicApiKey"
    private static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!

    private static let systemPrompt = """
    Eres mi entrenador personal y nutricionista. Cada día recibes mis datos de Apple Health \
    (sueño, pasos, calorías, entrenamientos, frecuencia cardiaca) y lo que comí, y los comparas \
    con mi plan de entrenamiento. Sé directo y concreto: di qué hice bien, qué hice mal y qué \
    debo hacer mañana, con números cuando sea posible (horas de sueño, proteína, calorías, pasos). \
    Si faltan datos, dilo en lugar de inventarlos. Si estimas calorías o macros de comidas sin \
    cantidades, indica que es una estimación. Responde en español.
    """

    private static let schema: [String: Any] = [
        "type": "object",
        "properties": [
            "puntuacion": ["type": "integer", "description": "Nota del día de 1 a 10 respecto al plan"],
            "resumen": ["type": "string", "description": "2-3 frases sobre el día"],
            "bien": ["type": "array", "items": ["type": "string"]],
            "mal": ["type": "array", "items": ["type": "string"]],
            "manana": ["type": "array", "items": ["type": "string"], "description": "Acciones concretas para mañana"],
        ],
        "required": ["puntuacion", "resumen", "bien", "mal", "manana"],
        "additionalProperties": false,
    ]

    static func review(report: String, plan: String) async throws -> CoachVerdict {
        guard let key = Keychain.get(apiKeyName), !key.isEmpty else { throw ClaudeError.missingKey }

        let planText = plan.isEmpty ? "(Todavía no he cargado mi plan de entrenamiento.)" : plan
        let body: [String: Any] = [
            "model": "claude-opus-5-5",
            "max_tokens": 16000,
            "output_config": [
                "effort": "medium",
                "format": ["type": "json_schema", "schema": schema],
            ],
            // Si la petición es rechazada por un clasificador, la API reintenta con otro modelo.
            "fallbacks": "default",
            "system": [
                ["type": "text", "text": systemPrompt],
                ["type": "text", "text": "MI PLAN DE ENTRENAMIENTO:\n\n\(planText)",
                 "cache_control": ["type": "ephemeral"]],
            ],
            "messages": [["role": "user", "content": report]],
        ]

        var request = URLRequest(url: endpoint, timeoutInterval: 300)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        request.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw ClaudeError.http(status, String(data: data, encoding: .utf8) ?? "")
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ClaudeError.badResponse
        }
        if json["stop_reason"] as? String == "refusal" { throw ClaudeError.refusal }

        let text = (json["content"] as? [[String: Any]] ?? [])
            .filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }
            .joined()
        guard let verdictData = text.data(using: .utf8) else { throw ClaudeError.badResponse }
        return try JSONDecoder().decode(CoachVerdict.self, from: verdictData)
    }
}
