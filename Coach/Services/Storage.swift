import Foundation
import Security
import PDFKit

enum Keychain {
    private static let service = "com.personal.coach"

    static func set(_ value: String, for key: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Plan de entrenamiento guardado como texto en Documentos.
enum PlanStore {
    private static var url: URL {
        URL.documentsDirectory.appending(path: "plan_entrenamiento.txt")
    }

    static func load() -> String {
        (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    static func save(_ text: String) {
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    /// Extrae texto de un archivo importado (.txt, .md o .pdf).
    static func text(fromFile fileURL: URL) -> String? {
        let access = fileURL.startAccessingSecurityScopedResource()
        defer { if access { fileURL.stopAccessingSecurityScopedResource() } }
        if fileURL.pathExtension.lowercased() == "pdf" {
            return PDFDocument(url: fileURL)?.string
        }
        return try? String(contentsOf: fileURL, encoding: .utf8)
    }
}

enum Profile {
    static var notes: String {
        get { UserDefaults.standard.string(forKey: "profileNotes") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "profileNotes") }
    }
}
