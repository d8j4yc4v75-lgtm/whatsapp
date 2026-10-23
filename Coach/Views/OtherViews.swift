import SwiftUI
import SwiftData
import UniformTypeIdentifiers

struct HistoryView: View {
    @Query(sort: \DailyReview.day, order: .reverse) private var reviews: [DailyReview]

    var body: some View {
        NavigationStack {
            List(reviews) { r in
                NavigationLink {
                    List { ReviewSections(review: r) }
                        .navigationTitle(r.day.formatted(date: .abbreviated, time: .omitted))
                } label: {
                    HStack {
                        Text("\(r.score)").font(.title2.bold()).frame(width: 40)
                            .foregroundStyle(r.score >= 7 ? .green : r.score >= 5 ? .orange : .red)
                        VStack(alignment: .leading) {
                            Text(r.day.formatted(date: .complete, time: .omitted)).font(.subheadline.bold())
                            Text(r.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
            .overlay {
                if reviews.isEmpty {
                    ContentUnavailableView("Sin evaluaciones", systemImage: "calendar",
                                           description: Text("Analiza tu día en la pestaña Hoy."))
                }
            }
            .navigationTitle("Historial")
        }
    }
}

struct PlanView: View {
    @State private var plan = PlanStore.load()
    @State private var importing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $plan)
                        .frame(minHeight: 400)
                        .font(.body.monospaced())
                } header: {
                    Text("Tu plan de entrenamiento")
                } footer: {
                    Text("Pega aquí tu plan (rutina, objetivos, calorías y macros meta, horas de sueño) o impórtalo desde un archivo .txt, .md o .pdf. El coach lo usa cada día para evaluarte.")
                }
            }
            .navigationTitle("Plan")
            .toolbar {
                Button { importing = true } label: { Label("Importar", systemImage: "square.and.arrow.down") }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, .text, .pdf, UTType(filenameExtension: "md") ?? .text]) { result in
                if case .success(let url) = result, let text = PlanStore.text(fromFile: url) {
                    plan = text
                }
            }
            .onChange(of: plan) { _, new in PlanStore.save(new) }
        }
    }
}

struct SettingsView: View {
    @State private var apiKey = Keychain.get(ClaudeService.apiKeyName) ?? ""
    @State private var notes = Profile.notes

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-ant-...", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: apiKey) { _, new in
                            Keychain.set(new.trimmingCharacters(in: .whitespacesAndNewlines), for: ClaudeService.apiKeyName)
                        }
                } header: {
                    Text("API key de Anthropic")
                } footer: {
                    Text("Se guarda en el llavero del iPhone. Créala en platform.claude.com.")
                }
                Section {
                    TextField("Edad, altura, objetivo, lesiones…", text: $notes, axis: .vertical)
                        .lineLimit(3...6)
                        .onChange(of: notes) { _, new in Profile.notes = new }
                } header: {
                    Text("Sobre ti")
                }
                Section {
                    Button("Volver a pedir permisos de Salud") {
                        Task { await HealthKitManager.shared.requestAuthorization() }
                    }
                }
            }
            .navigationTitle("Ajustes")
        }
    }
}
