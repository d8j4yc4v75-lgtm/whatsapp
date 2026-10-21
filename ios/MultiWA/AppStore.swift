import SwiftUI
import UserNotifications

@MainActor
@Observable
final class AppStore {
    // Configuración
    var serverURL: String = UserDefaults.standard.string(forKey: "serverURL") ?? ""
    var token: String = UserDefaults.standard.string(forKey: "token") ?? ""

    // Datos
    var accounts: [Account] = []
    var conversations: [Conversation] = []
    var labels: [ChatLabel] = []
    var messages: [String: [Message]] = [:]
    var hasMoreMessages: [String: Bool] = [:]
    /// Cuenta elegida para responder en cada conversación
    var replyAccount: [String: Int] = [:]

    // Filtros de la bandeja
    var accountFilter: Int?
    var labelFilter: Int?
    var unreadOnly = false
    var search = ""

    // Estado
    var socketConnected = false
    var lastError: String?
    var activeJid: String?
    var navigationPath: [String] = []

    var api: APIClient? { APIClient(server: serverURL, token: token) }
    var isConfigured: Bool { api != nil }

    private var socketTask: URLSessionWebSocketTask?
    private var reconnectWork: Task<Void, Never>?
    private var deviceToken: String?

    var filteredConversations: [Conversation] {
        conversations.filter { c in
            if let accountFilter, !c.accountIds.contains(accountFilter) { return false }
            if let labelFilter, !c.labelIds.contains(labelFilter) { return false }
            if unreadOnly && c.unread == 0 { return false }
            if !search.isEmpty {
                let q = search.lowercased()
                let digits = search.filter(\.isNumber)
                return c.displayName.lowercased().contains(q)
                    || (!digits.isEmpty && (c.phone ?? "").contains(digits))
                    || c.lastText.lowercased().contains(q)
            }
            return true
        }
    }

    var totalUnread: Int { conversations.reduce(0) { $0 + $1.unread } }

    func account(_ id: Int) -> Account? { accounts.first { $0.id == id } }
    func label(_ id: Int) -> ChatLabel? { labels.first { $0.id == id } }
    func conversation(_ jid: String) -> Conversation? { conversations.first { $0.jid == jid } }

    func saveSettings(server: String, token: String) {
        serverURL = server
        self.token = token
        UserDefaults.standard.set(server, forKey: "serverURL")
        UserDefaults.standard.set(token, forKey: "token")
        disconnect()
        Task { await start() }
    }

    // MARK: - Carga

    func start() async {
        guard let api else { return }
        do {
            async let a: [Account] = api.get("/accounts")
            async let c: [Conversation] = api.get("/conversations")
            async let l: [ChatLabel] = api.get("/labels")
            accounts = try await a
            conversations = try await c
            labels = try await l
            lastError = nil
            updateBadge()
            if let deviceToken { await registerDevice(deviceToken) }
        } catch {
            lastError = error.localizedDescription
        }
        connectSocket()
    }

    func reloadConversations() async {
        guard let api else { return }
        if let list: [Conversation] = try? await api.get("/conversations") {
            conversations = list
            updateBadge()
        }
    }

    func reloadAccounts() async {
        guard let api else { return }
        if let list: [Account] = try? await api.get("/accounts") { accounts = list }
    }

    func loadMessages(_ jid: String, older: Bool = false) async {
        guard let api else { return }
        var query = ["limit": "50"]
        if older, let first = messages[jid]?.first { query["before"] = String(Int(first.ts)) }
        do {
            let page: [Message] = try await api.get("/conversations/\(APIClient.encode(jid))/messages", query: query)
            if older {
                messages[jid] = page + (messages[jid] ?? [])
            } else {
                messages[jid] = page
            }
            hasMoreMessages[jid] = page.count == 50
        } catch {
            lastError = error.localizedDescription
        }
    }

    func markRead(_ jid: String) async {
        guard let api, conversation(jid)?.unread ?? 0 > 0 else { return }
        if let i = conversations.firstIndex(where: { $0.jid == jid }) { conversations[i].unread = 0 }
        updateBadge()
        let _: OK? = try? await api.call("POST", "/conversations/\(APIClient.encode(jid))/read")
    }

    /// Cuenta por defecto para responder: la elegida antes, o la del último mensaje si está conectada
    func defaultReplyAccount(for jid: String) -> Int? {
        if let id = replyAccount[jid], account(id) != nil { return id }
        let connected = accounts.filter(\.isConnected)
        if let last = messages[jid]?.last(where: { account($0.accountId)?.isConnected == true }) {
            return last.accountId
        }
        if let conv = conversation(jid), let id = conv.accountIds.first(where: { account($0)?.isConnected == true }) {
            return id
        }
        return connected.first?.id ?? accounts.first?.id
    }

    // MARK: - Envío

    func sendText(_ text: String, jid: String, accountId: Int) async -> Bool {
        guard let api else { return false }
        do {
            let msg: Message = try await api.call("POST", "/send", body: ["accountId": accountId, "jid": jid, "text": text])
            insert(msg)
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func sendMedia(_ data: Data, fileName: String, mime: String, kind: String, caption: String?, ptt: Bool = false,
                   jid: String, accountId: Int) async -> Bool {
        guard let api else { return false }
        var fields = ["accountId": String(accountId), "jid": jid, "kind": kind, "ptt": ptt ? "true" : "false"]
        if let caption, !caption.isEmpty { fields["caption"] = caption }
        do {
            let msg = try await api.upload(fields: fields, file: data, fileName: fileName, mime: mime)
            insert(msg)
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// Inicia una conversación nueva con un número desde la cuenta indicada
    func startChat(phone: String, text: String, accountId: Int) async -> String? {
        guard let api else { return nil }
        do {
            let res: ResolveResult = try await api.call("POST", "/resolve", body: ["accountId": accountId, "phone": phone])
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                _ = await sendText(text, jid: res.jid, accountId: accountId)
            }
            replyAccount[res.jid] = accountId
            await reloadConversations()
            return res.jid
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Cuentas

    func addAccount(name: String, color: String) async -> Account? {
        guard let api else { return nil }
        do {
            let acc: Account = try await api.call("POST", "/accounts", body: ["name": name, "color": color])
            upsert(acc)
            return acc
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func updateAccount(_ id: Int, name: String, color: String) async {
        guard let api else { return }
        if let acc: Account = try? await api.call("PATCH", "/accounts/\(id)", body: ["name": name, "color": color]) {
            upsert(acc)
        }
    }

    func connectAccount(_ id: Int) async {
        guard let api else { return }
        do {
            let acc: Account = try await api.call("POST", "/accounts/\(id)/connect")
            upsert(acc)
        } catch { lastError = error.localizedDescription }
    }

    func logoutAccount(_ id: Int) async {
        guard let api else { return }
        do {
            let acc: Account = try await api.call("POST", "/accounts/\(id)/logout")
            upsert(acc)
        } catch { lastError = error.localizedDescription }
    }

    func deleteAccount(_ id: Int) async {
        guard let api else { return }
        do {
            let _: OK = try await api.call("DELETE", "/accounts/\(id)")
            accounts.removeAll { $0.id == id }
            await reloadConversations()
        } catch { lastError = error.localizedDescription }
    }

    private func upsert(_ acc: Account) {
        if let i = accounts.firstIndex(where: { $0.id == acc.id }) { accounts[i] = acc } else { accounts.append(acc) }
    }

    // MARK: - Etiquetas

    func addLabel(name: String, color: String) async {
        guard let api else { return }
        if let label: ChatLabel = try? await api.call("POST", "/labels", body: ["name": name, "color": color]) {
            labels.append(label)
            labels.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    func deleteLabel(_ id: Int) async {
        guard let api else { return }
        let _: OK? = try? await api.call("DELETE", "/labels/\(id)")
        labels.removeAll { $0.id == id }
        if labelFilter == id { labelFilter = nil }
        for i in conversations.indices { conversations[i].labelIds.removeAll { $0 == id } }
    }

    func toggleLabel(_ labelId: Int, jid: String) async {
        guard let api, let conv = conversation(jid) else { return }
        var ids = conv.labelIds
        if ids.contains(labelId) { ids.removeAll { $0 == labelId } } else { ids.append(labelId) }
        if let updated: Conversation = try? await api.call("PUT", "/conversations/\(APIClient.encode(jid))/labels", body: ["labelIds": ids]) {
            upsert(updated)
        }
    }

    // MARK: - Tiempo real

    func connectSocket() {
        guard let api, socketTask == nil else { return }
        let task = URLSession.shared.webSocketTask(with: api.webSocketURL)
        socketTask = task
        task.resume()
        receive(task)
    }

    func disconnect() {
        reconnectWork?.cancel()
        socketTask?.cancel(with: .goingAway, reason: nil)
        socketTask = nil
        socketConnected = false
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socketTask === task else { return }
                switch result {
                case .success(let message):
                    self.socketConnected = true
                    if case .string(let text) = message, let data = text.data(using: .utf8) {
                        self.handle(data)
                    }
                    self.receive(task)
                case .failure:
                    self.socketTask = nil
                    self.socketConnected = false
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        reconnectWork?.cancel()
        reconnectWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let self else { return }
            await self.start()
        }
    }

    /// Al volver al primer plano se recarga todo, porque iOS corta el WebSocket en segundo plano
    func resume() async {
        if socketTask == nil || !socketConnected {
            disconnect()
            await start()
        } else {
            await reloadConversations()
        }
        if let activeJid { await loadMessages(activeJid) }
    }

    private func handle(_ data: Data) {
        let dec = JSONDecoder()
        guard let head = try? dec.decode(ServerEvent.self, from: data) else { return }
        switch head.type {
        case "hello":
            if let e = try? dec.decode(EventEnvelope<HelloEvent>.self, from: data) { accounts = e.data.accounts }
        case "account.update":
            if let e = try? dec.decode(EventEnvelope<Account>.self, from: data) { upsert(e.data) }
        case "account.removed":
            if let e = try? dec.decode(EventEnvelope<IdEvent>.self, from: data) { accounts.removeAll { $0.id == e.data.id } }
        case "qr":
            if let e = try? dec.decode(EventEnvelope<QREvent>.self, from: data),
               let i = accounts.firstIndex(where: { $0.id == e.data.accountId }) {
                accounts[i].qr = e.data.qr
                accounts[i].status = "qr"
            }
        case "message":
            if let e = try? dec.decode(EventEnvelope<Message>.self, from: data) {
                let isNew = insert(e.data)
                if isNew && !e.data.fromMe && e.data.jid != activeJid { notifyLocally(e.data) }
            }
        case "message.status":
            if let e = try? dec.decode(EventEnvelope<StatusEvent>.self, from: data) {
                for (jid, list) in messages {
                    if let i = list.firstIndex(where: { $0.id == e.data.id && $0.accountId == e.data.accountId }) {
                        messages[jid]?[i].status = max(list[i].status, e.data.status)
                    }
                }
            }
        case "conversation.update":
            if let e = try? dec.decode(EventEnvelope<Conversation>.self, from: data) {
                var conv = e.data
                if conv.jid == activeJid && conv.unread > 0 {
                    conv.unread = 0
                    Task { await self.markReadRemote(conv.jid) }
                }
                upsert(conv)
            }
        case "conversations.changed":
            Task { await reloadConversations() }
        default:
            break
        }
    }

    private func markReadRemote(_ jid: String) async {
        let _: OK? = try? await api?.call("POST", "/conversations/\(APIClient.encode(jid))/read")
    }

    @discardableResult
    private func insert(_ msg: Message) -> Bool {
        guard messages[msg.jid] != nil else { return true }
        if let i = messages[msg.jid]!.firstIndex(where: { $0.uid == msg.uid }) {
            messages[msg.jid]![i] = msg
            return false
        }
        messages[msg.jid]!.append(msg)
        messages[msg.jid]!.sort { $0.ts < $1.ts }
        return true
    }

    private func upsert(_ conv: Conversation) {
        conversations.removeAll { $0.jid == conv.jid }
        let idx = conversations.firstIndex { $0.lastTs < conv.lastTs } ?? conversations.endIndex
        conversations.insert(conv, at: idx)
        updateBadge()
    }

    // MARK: - Notificaciones

    func requestNotifications() async {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func setDeviceToken(_ token: String) {
        deviceToken = token
        Task { await registerDevice(token) }
    }

    private func registerDevice(_ token: String) async {
        let _: OK? = try? await api?.call("POST", "/devices", body: ["token": token])
    }

    private func notifyLocally(_ msg: Message) {
        // Si el servidor tiene APNs configurado, el aviso llega por push
        guard deviceToken == nil else { return }
        let content = UNMutableNotificationContent()
        let conv = conversation(msg.jid)
        content.title = "\(conv?.displayName ?? msg.jid) · \(account(msg.accountId)?.name ?? "")"
        content.body = (msg.senderName.map { conv?.isGroup == true ? "\($0): " : "" } ?? "") + (msg.text ?? previewText(msg))
        content.sound = .default
        content.threadIdentifier = msg.jid
        content.userInfo = ["jid": msg.jid]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: msg.uid, content: content, trigger: nil))
    }

    func previewText(_ msg: Message) -> String {
        switch msg.type {
        case "image": return "📷 Foto"
        case "video": return "🎥 Video"
        case "audio": return "🎤 Audio"
        case "document": return "📄 \(msg.fileName ?? "Documento")"
        case "sticker": return "🏷️ Sticker"
        default: return msg.text ?? ""
        }
    }

    func open(jid: String) {
        navigationPath = [jid]
    }

    private func updateBadge() {
        UNUserNotificationCenter.current().setBadgeCount(totalUnread) { _ in }
    }
}
