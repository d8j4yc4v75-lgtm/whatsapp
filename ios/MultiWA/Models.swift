import SwiftUI

struct Account: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var color: String
    var phone: String?
    var status: String
    var qr: String?

    var isConnected: Bool { status == "connected" }

    var statusText: String {
        switch status {
        case "connected": return "Conectado"
        case "connecting": return "Conectando…"
        case "reconnecting": return "Reconectando…"
        case "qr": return "Esperando escaneo de QR"
        case "logged_out": return "Sesión cerrada"
        default: return "Desconectado"
        }
    }

    var statusColor: Color {
        switch status {
        case "connected": return .green
        case "qr", "connecting", "reconnecting": return .orange
        default: return .red
        }
    }
}

struct Conversation: Codable, Identifiable, Hashable {
    let jid: String
    var name: String?
    var phone: String?
    var isGroup: Bool
    var lastTs: Double
    var lastText: String
    var lastFromMe: Bool
    var lastAccountId: Int
    var unread: Int
    var accountIds: [Int]
    var labelIds: [Int]

    var id: String { jid }

    var displayName: String {
        if let name, !name.isEmpty { return name }
        if let phone { return "+" + phone }
        return jid
    }
}

struct Message: Codable, Identifiable, Hashable {
    let id: String
    let accountId: Int
    let jid: String
    var fromMe: Bool
    var sender: String?
    var senderName: String?
    var ts: Double
    var type: String
    var text: String?
    var mime: String?
    var fileName: String?
    var hasMedia: Bool
    var status: Int

    /// Los IDs de WhatsApp solo son únicos dentro de cada cuenta
    var uid: String { "\(accountId)-\(id)" }

    var date: Date { Date(timeIntervalSince1970: ts / 1000) }
}

struct ChatLabel: Codable, Identifiable, Hashable {
    let id: Int
    var name: String
    var color: String
}

struct ServerEvent: Decodable {
    let type: String
}

struct EventEnvelope<T: Decodable>: Decodable {
    let type: String
    let data: T
}

struct QREvent: Decodable {
    let accountId: Int
    let qr: String
}

struct StatusEvent: Decodable {
    let accountId: Int
    let id: String
    let status: Int
}

struct IdEvent: Decodable {
    let id: Int
}

struct HelloEvent: Decodable {
    let accounts: [Account]
}

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }

    var hexString: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        let clamp = { (x: CGFloat) in Int((min(max(x, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", clamp(r), clamp(g), clamp(b))
    }
}

extension Date {
    var chatListText: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(self) { return "Ayer" }
        if let days = cal.dateComponents([.day], from: self, to: .now).day, days < 7 {
            return formatted(.dateTime.weekday(.wide))
        }
        return formatted(date: .numeric, time: .omitted)
    }
}
