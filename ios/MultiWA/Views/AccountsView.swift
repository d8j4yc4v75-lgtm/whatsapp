import SwiftUI

struct AccountsView: View {
    @Environment(AppStore.self) private var store
    @State private var showAdd = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.accounts) { acc in
                    NavigationLink {
                        AccountDetailView(accountId: acc.id)
                    } label: {
                        HStack(spacing: 12) {
                            Circle().fill(Color(hex: acc.color)).frame(width: 14, height: 14)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(acc.name).font(.headline)
                                Text(acc.phone.map { "+" + $0 } ?? "Sin vincular")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(acc.statusText).font(.caption).foregroundStyle(acc.statusColor)
                        }
                    }
                }
            }
            .overlay {
                if store.accounts.isEmpty {
                    ContentUnavailableView("Sin cuentas", systemImage: "person.crop.circle.badge.plus",
                                           description: Text("Toca + para vincular un WhatsApp con su código QR."))
                }
            }
            .refreshable { await store.reloadAccounts() }
            .navigationTitle("Cuentas")
            .toolbar {
                Button { showAdd = true } label: { Image(systemName: "plus") }
            }
            .sheet(isPresented: $showAdd) { AddAccountView() }
        }
    }
}

struct AddAccountView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color = Color(hex: "#25D366")
    @State private var created: Account?

    private let presets = ["#25D366", "#007AFF", "#FF9500", "#AF52DE", "#FF2D55", "#5AC8FA", "#FFCC00", "#8E8E93"]

    var body: some View {
        NavigationStack {
            if let created {
                AccountDetailView(accountId: created.id)
                    .toolbar { Button("Listo") { dismiss() } }
            } else {
                Form {
                    Section("Nombre") {
                        TextField("Ej. Ventas, Personal, Soporte", text: $name)
                    }
                    Section("Color") {
                        HStack {
                            ForEach(presets, id: \.self) { hex in
                                Circle()
                                    .fill(Color(hex: hex))
                                    .frame(width: 28, height: 28)
                                    .overlay(Circle().stroke(Color.primary, lineWidth: color.hexString == hex ? 2 : 0))
                                    .onTapGesture { color = Color(hex: hex) }
                            }
                        }
                        ColorPicker("Personalizado", selection: $color, supportsOpacity: false)
                    }
                }
                .navigationTitle("Nueva cuenta")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Crear") {
                            Task {
                                let n = name.trimmingCharacters(in: .whitespaces)
                                created = await store.addAccount(name: n.isEmpty ? "WhatsApp \(store.accounts.count + 1)" : n,
                                                                 color: color.hexString)
                            }
                        }
                    }
                }
            }
        }
    }
}

struct AccountDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let accountId: Int

    @State private var name = ""
    @State private var color = Color.green
    @State private var confirmDelete = false
    @State private var confirmLogout = false
    @State private var pairPhone = ""
    @State private var pairCode: String?

    private var account: Account? { store.account(accountId) }

    var body: some View {
        Form {
            if let account {
                Section {
                    HStack {
                        Text("Estado")
                        Spacer()
                        Text(account.statusText).foregroundStyle(account.statusColor)
                    }
                    if let phone = account.phone {
                        LabeledContent("Número", value: "+" + phone)
                    }
                }

                if account.status == "qr", let qr = account.qr, let image = qrImage(qr) {
                    Section {
                        VStack(spacing: 12) {
                            Image(uiImage: image)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 260)
                            Text("En el teléfono de esta cuenta abre WhatsApp › Ajustes › Dispositivos vinculados › Vincular un dispositivo y escanea este código.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                    } header: {
                        Text("Escanea el código QR")
                    } footer: {
                        Text("También puedes ver los QR en la computadora abriendo la dirección del servidor con ?token=TU_TOKEN.")
                    }

                    Section {
                        TextField("Número de esta cuenta, ej. 5215512345678", text: $pairPhone)
                            .keyboardType(.phonePad)
                        Button("Obtener código") { Task { await requestCode() } }
                            .disabled(pairPhone.filter(\.isNumber).count < 8)
                        if let pairCode {
                            Text(pairCode)
                                .font(.system(.largeTitle, design: .monospaced).bold())
                                .frame(maxWidth: .infinity)
                                .textSelection(.enabled)
                        }
                    } header: {
                        Text("O vincula con número (sin escanear)")
                    } footer: {
                        Text("Útil si ese WhatsApp está en este mismo iPhone: en WhatsApp › Ajustes › Dispositivos vinculados › Vincular un dispositivo › Vincular con número de teléfono, escribe este código.")
                    }
                } else if account.status == "connecting" || account.status == "reconnecting" {
                    Section { HStack { ProgressView(); Text("Conectando…") } }
                }

                Section("Personalizar") {
                    TextField("Nombre", text: $name)
                    ColorPicker("Color", selection: $color, supportsOpacity: false)
                    Button("Guardar") {
                        Task { await store.updateAccount(accountId, name: name, color: color.hexString) }
                    }
                }

                Section {
                    if account.status == "logged_out" || account.status == "disconnected" {
                        Button("Vincular con QR") { Task { await store.connectAccount(accountId) } }
                    }
                    if account.isConnected {
                        Button("Cerrar sesión", role: .destructive) { confirmLogout = true }
                    }
                    Button("Eliminar cuenta", role: .destructive) { confirmDelete = true }
                }
            } else {
                Text("Cuenta eliminada")
            }
        }
        .navigationTitle(account?.name ?? "Cuenta")
        .onAppear {
            if let account {
                name = account.name
                color = Color(hex: account.color)
            }
        }
        .confirmationDialog("¿Cerrar la sesión de WhatsApp en este servidor?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Cerrar sesión", role: .destructive) { Task { await store.logoutAccount(accountId) } }
        }
        .confirmationDialog("Se borrarán la sesión y los mensajes guardados de esta cuenta.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Eliminar", role: .destructive) {
                Task {
                    await store.deleteAccount(accountId)
                    dismiss()
                }
            }
        }
    }

    private func requestCode() async {
        guard let api = store.api else { return }
        do {
            let res: PairingCode = try await api.call("POST", "/accounts/\(accountId)/pairing-code", body: ["phone": pairPhone])
            pairCode = res.code.count == 8 ? "\(res.code.prefix(4))-\(res.code.suffix(4))" : res.code
        } catch {
            store.lastError = error.localizedDescription
        }
    }

    private func qrImage(_ dataURL: String) -> UIImage? {
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}
