import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    var initialSetup = false

    @State private var server = ""
    @State private var token = ""
    @State private var testResult: String?
    @State private var testing = false
    @State private var newLabel = ""
    @State private var newLabelColor = Color(hex: "#007AFF")
    @State private var pushEnabled: Bool?

    var body: some View {
        let form = Form {
            if initialSetup {
                Section {
                    Text("Inicia el servidor MultiWA en tu computadora y copia aquí la URL y el token que muestra en la terminal.")
                        .font(.footnote)
                }
            }
            Section {
                TextField("http://192.168.1.10:3000", text: $server)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await test() }
                } label: {
                    HStack {
                        Text("Probar conexión")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                if let testResult {
                    Text(testResult).font(.footnote).foregroundStyle(.secondary)
                }
                Button("Guardar") {
                    store.saveSettings(server: server, token: token)
                }
                .disabled(APIClient(server: server, token: token) == nil)
            } header: {
                Text("Servidor")
            } footer: {
                Text("El iPhone debe estar en la misma red Wi‑Fi que la computadora, o usar una VPN como Tailscale para acceder desde fuera.")
            }

            if !initialSetup {
                Section {
                    ForEach(store.labels) { label in
                        HStack {
                            Circle().fill(Color(hex: label.color)).frame(width: 12, height: 12)
                            Text(label.name)
                        }
                    }
                    .onDelete { idx in
                        let ids = idx.map { store.labels[$0].id }
                        Task { for id in ids { await store.deleteLabel(id) } }
                    }
                    HStack {
                        TextField("Nueva etiqueta", text: $newLabel)
                        ColorPicker("", selection: $newLabelColor, supportsOpacity: false).labelsHidden()
                        Button("Agregar") {
                            let name = newLabel.trimmingCharacters(in: .whitespaces)
                            newLabel = ""
                            Task { await store.addLabel(name: name, color: newLabelColor.hexString) }
                        }
                        .disabled(newLabel.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } header: {
                    Text("Etiquetas")
                } footer: {
                    Text("Asigna etiquetas desde el ícono de etiqueta dentro de cada chat y filtra por ellas en la bandeja.")
                }

                Section("Notificaciones") {
                    Button("Permitir notificaciones") { Task { await store.requestNotifications() } }
                    if let pushEnabled {
                        Text(pushEnabled
                             ? "Push activado en el servidor: recibirás avisos aunque la app esté cerrada."
                             : "Push no configurado en el servidor: solo recibirás avisos mientras la app esté abierta o recién en segundo plano. Consulta el README para activar APNs.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(initialSetup ? "Configurar MultiWA" : "Ajustes")
        .onAppear {
            server = store.serverURL
            token = store.token
        }
        .task {
            if !initialSetup, let api = store.api, let info: ServerInfo = try? await api.get("/info") {
                pushEnabled = info.push
            }
        }

        if initialSetup {
            form
        } else {
            NavigationStack { form }
        }
    }

    private func test() async {
        guard let api = APIClient(server: server, token: token) else {
            testResult = "Completa la URL y el token."
            return
        }
        testing = true
        defer { testing = false }
        do {
            let accounts: [Account] = try await api.get("/accounts")
            testResult = "✅ Conectado. \(accounts.count) cuenta(s) en el servidor."
        } catch {
            testResult = "❌ \(error.localizedDescription)"
        }
    }
}
