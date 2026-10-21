import SwiftUI

struct InboxView: View {
    @Environment(AppStore.self) private var store
    @State private var showNewChat = false

    var body: some View {
        @Bindable var store = store
        NavigationStack(path: $store.navigationPath) {
            List {
                if store.accounts.count > 1 || !store.labels.isEmpty {
                    filters
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        .listRowSeparator(.hidden)
                }
                ForEach(store.filteredConversations) { conv in
                    NavigationLink(value: conv.jid) {
                        ConversationRow(conversation: conv)
                    }
                    .swipeActions(edge: .leading) {
                        if conv.unread > 0 {
                            Button("Leído") { Task { await store.markRead(conv.jid) } }.tint(.blue)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if store.filteredConversations.isEmpty {
                    ContentUnavailableView(
                        store.accounts.isEmpty ? "Agrega una cuenta" : "Sin conversaciones",
                        systemImage: store.accounts.isEmpty ? "qrcode.viewfinder" : "tray",
                        description: Text(store.accounts.isEmpty
                            ? "Ve a la pestaña Cuentas y vincula tu primer WhatsApp."
                            : "Los mensajes de todas tus cuentas aparecerán aquí.")
                    )
                }
            }
            .searchable(text: $store.search, prompt: "Buscar nombre, número o mensaje")
            .refreshable { await store.reloadConversations() }
            .navigationTitle("Bandeja")
            .navigationDestination(for: String.self) { jid in
                ChatView(jid: jid)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Circle()
                        .fill(store.socketConnected ? Color.green : Color.red)
                        .frame(width: 10, height: 10)
                        .accessibilityLabel(store.socketConnected ? "Servidor conectado" : "Servidor desconectado")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNewChat = true } label: { Image(systemName: "square.and.pencil") }
                        .disabled(store.accounts.allSatisfy { !$0.isConnected })
                }
            }
            .sheet(isPresented: $showNewChat) {
                NewChatView { jid in store.open(jid: jid) }
            }
        }
    }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                FilterChip(title: "Todos", color: .accentColor, selected: store.accountFilter == nil && store.labelFilter == nil && !store.unreadOnly) {
                    store.accountFilter = nil
                    store.labelFilter = nil
                    store.unreadOnly = false
                }
                FilterChip(title: "No leídos", color: .accentColor, selected: store.unreadOnly) {
                    store.unreadOnly.toggle()
                }
                ForEach(store.accounts) { acc in
                    FilterChip(title: acc.name, color: Color(hex: acc.color), selected: store.accountFilter == acc.id) {
                        store.accountFilter = store.accountFilter == acc.id ? nil : acc.id
                    }
                }
                ForEach(store.labels) { label in
                    FilterChip(title: "# " + label.name, color: Color(hex: label.color), selected: store.labelFilter == label.id) {
                        store.labelFilter = store.labelFilter == label.id ? nil : label.id
                    }
                }
            }
            .padding(.horizontal)
        }
    }
}

struct FilterChip: View {
    let title: String
    let color: Color
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? color : color.opacity(0.12), in: Capsule())
                .foregroundStyle(selected ? Color.white : color)
        }
        .buttonStyle(.plain)
    }
}

struct ConversationRow: View {
    @Environment(AppStore.self) private var store
    let conversation: Conversation

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(name: conversation.displayName, isGroup: conversation.isGroup)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(conversation.displayName).font(.headline).lineLimit(1)
                    Spacer()
                    Text(Date(timeIntervalSince1970: conversation.lastTs / 1000).chatListText)
                        .font(.caption)
                        .foregroundStyle(conversation.unread > 0 ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
                }
                HStack(alignment: .top) {
                    Text((conversation.lastFromMe ? "Tú: " : "") + conversation.lastText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer()
                    if conversation.unread > 0 {
                        Text("\(conversation.unread)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.accentColor, in: Capsule())
                    }
                }
                HStack(spacing: 4) {
                    ForEach(conversation.accountIds, id: \.self) { id in
                        AccountTag(account: store.account(id))
                    }
                    ForEach(conversation.labelIds.compactMap { store.label($0) }) { label in
                        LabelChip(label: label)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
