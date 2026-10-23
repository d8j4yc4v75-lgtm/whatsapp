import SwiftUI
import SwiftData

struct FoodLogView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \FoodEntry.date, order: .reverse) private var entries: [FoodEntry]

    @State private var day = Date.now
    @State private var showingAdd = false

    private var dayEntries: [FoodEntry] {
        entries.filter { Calendar.current.isDate($0.date, inSameDayAs: day) }.reversed()
    }

    var body: some View {
        NavigationStack {
            List {
                DatePicker("Día", selection: $day, in: ...Date.now, displayedComponents: .date)

                if dayEntries.isEmpty {
                    ContentUnavailableView("Sin comidas", systemImage: "fork.knife",
                                           description: Text("Anota lo que comes para que tu coach lo revise."))
                }
                ForEach(dayEntries) { e in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(e.meal.rawValue).font(.caption.bold()).foregroundStyle(.tint)
                            Spacer()
                            Text(e.date, style: .time).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(e.text)
                        let extras = [e.kcal.map { "\($0) kcal" }, e.proteinGrams.map { "\($0) g proteína" }].compactMap { $0 }
                        if !extras.isEmpty {
                            Text(extras.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { idx in
                    for i in idx { context.delete(dayEntries[i]) }
                }
            }
            .navigationTitle("Comidas")
            .toolbar {
                Button { showingAdd = true } label: { Image(systemName: "plus") }
            }
            .sheet(isPresented: $showingAdd) {
                AddFoodView(day: day)
            }
        }
    }
}

struct AddFoodView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let day: Date
    @State private var meal = MealType.desayuno
    @State private var text = ""
    @State private var time = Date.now
    @State private var kcal = ""
    @State private var protein = ""

    var body: some View {
        NavigationStack {
            Form {
                Picker("Comida", selection: $meal) {
                    ForEach(MealType.allCases) { Text($0.rawValue).tag($0) }
                }
                DatePicker("Hora", selection: $time, displayedComponents: .hourAndMinute)
                Section("¿Qué comiste?") {
                    TextField("Ej: 3 huevos, 2 tostadas integrales, un café", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                }
                Section("Opcional") {
                    TextField("Calorías", text: $kcal).keyboardType(.numberPad)
                    TextField("Proteína (g)", text: $protein).keyboardType(.numberPad)
                }
            }
            .navigationTitle("Nueva comida")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Guardar") { save() }
                        .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func save() {
        let cal = Calendar.current
        let t = cal.dateComponents([.hour, .minute], from: time)
        let date = cal.date(bySettingHour: t.hour ?? 12, minute: t.minute ?? 0, second: 0, of: day) ?? day
        context.insert(FoodEntry(date: date, meal: meal, text: text, kcal: Int(kcal), proteinGrams: Int(protein)))
        dismiss()
    }
}
