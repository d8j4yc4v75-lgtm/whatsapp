import SwiftUI

struct NewChatView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var onCreated: (String) -> Void

    @State private var accountId: Int?
    @State private var phone = ""
    @State private var text = ""
    @State private var working = false

    private var connected: [Account] { store.accounts.filter(\.isConnected) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Enviar desde") {
                    Picker("Cuenta", selection: $accountId) {
                        ForEach(connected) { acc in
                            Text(acc.name + (acc.phone.map { " (+" + $0 + ")" } ?? "")).tag(Optional(acc.id))
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section {
                    TextField("Número con código de país, ej. 5215512345678", text: $phone)
                        .keyboardType(.phonePad)
                } header: {
                    Text("Destinatario")
                } footer: {
                    Text("Incluye el código de país sin el signo +.")
                }
                Section("Mensaje (opcional)") {
                    TextField("Escribe un mensaje", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                }
            }
            .navigationTitle("Nuevo chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button(text.isEmpty ? "Abrir" : "Enviar") { Task { await submit() } }
                            .disabled(accountId == nil || phone.filter(\.isNumber).count < 8)
                    }
                }
            }
            .onAppear { accountId = accountId ?? connected.first?.id }
        }
    }

    private func submit() async {
        guard let accountId else { return }
        working = true
        defer { working = false }
        if let jid = await store.startChat(phone: phone, text: text, accountId: accountId) {
            dismiss()
            onCreated(jid)
        }
    }
}
