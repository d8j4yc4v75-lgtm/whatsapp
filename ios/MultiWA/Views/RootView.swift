import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            if store.isConfigured {
                TabView {
                    InboxView()
                        .tabItem { Label("Bandeja", systemImage: "tray.full") }
                        .badge(store.totalUnread)
                    AccountsView()
                        .tabItem { Label("Cuentas", systemImage: "person.2.circle") }
                    SettingsView()
                        .tabItem { Label("Ajustes", systemImage: "gearshape") }
                }
            } else {
                NavigationStack { SettingsView(initialSetup: true) }
            }
        }
        .alert("Error", isPresented: Binding(
            get: { store.lastError != nil },
            set: { if !$0 { store.lastError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.lastError ?? "")
        }
    }
}

/// Insignia de color con el nombre de la cuenta
struct AccountTag: View {
    let account: Account?

    var body: some View {
        Text(account?.name ?? "?")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(hex: account?.color ?? "#8E8E93").opacity(0.18), in: Capsule())
            .foregroundStyle(Color(hex: account?.color ?? "#8E8E93"))
    }
}

struct LabelChip: View {
    let label: ChatLabel

    var body: some View {
        Text(label.name)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(hex: label.color), in: Capsule())
            .foregroundStyle(.white)
    }
}

struct Avatar: View {
    let name: String
    let isGroup: Bool
    var size: CGFloat = 48

    var body: some View {
        ZStack {
            Circle().fill(Color.gray.opacity(0.25))
            if isGroup {
                Image(systemName: "person.3.fill").foregroundStyle(.secondary).font(.system(size: size * 0.32))
            } else {
                Text(initials).font(.system(size: size * 0.38, weight: .medium)).foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
    }

    private var initials: String {
        let letters = name.split(separator: " ").prefix(2).compactMap { $0.first(where: \.isLetter) }
        return letters.isEmpty ? "#" : String(letters).uppercased()
    }
}
