import SwiftUI
import SwiftData

struct TodayView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \DailyReview.day, order: .reverse) private var reviews: [DailyReview]

    @State private var day = Date.now
    @State private var health: HealthDay?
    @State private var analyzing = false
    @State private var error: String?

    private var review: DailyReview? {
        reviews.first { Calendar.current.isDate($0.day, inSameDayAs: day) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    DatePicker("Día", selection: $day, in: ...Date.now, displayedComponents: .date)
                }

                if let h = health {
                    Section("Sueño") {
                        if let s = h.sleep {
                            MetricRow("Dormido", hours(s.asleepMinutes), "bed.double.fill")
                            MetricRow("Profundo / REM", "\(Int(s.deepMinutes)) / \(Int(s.remMinutes)) min", "moon.zzz.fill")
                        } else {
                            Text("Sin datos de sueño").foregroundStyle(.secondary)
                        }
                    }
                    Section("Actividad") {
                        MetricRow("Pasos", fmt(h.steps), "figure.walk")
                        MetricRow("Calorías activas", fmt(h.activeKcal, " kcal"), "flame.fill")
                        MetricRow("Calorías totales", fmt(h.activeKcal.flatMap { a in h.basalKcal.map { a + $0 } }, " kcal"), "bolt.heart.fill")
                        MetricRow("Ejercicio", fmt(h.exerciseMinutes, " min"), "stopwatch.fill")
                        MetricRow("FC reposo", fmt(h.restingHR, " lpm"), "heart.fill")
                        ForEach(h.workouts) { w in
                            MetricRow(w.name, "\(Int(w.minutes)) min" + (w.kcal.map { " · \(Int($0)) kcal" } ?? ""), "dumbbell.fill")
                        }
                    }
                } else {
                    Section { ProgressView() }
                }

                Section {
                    Button {
                        Task { await analyze() }
                    } label: {
                        HStack {
                            Label(review == nil ? "Analizar mi día" : "Volver a analizar", systemImage: "sparkles")
                            Spacer()
                            if analyzing { ProgressView() }
                        }
                    }
                    .disabled(analyzing)
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }

                if let review {
                    ReviewSections(review: review)
                }
            }
            .navigationTitle("Hoy")
            .task(id: Calendar.current.startOfDay(for: day)) {
                health = nil
                health = await HealthKitManager.shared.fetchDay(day)
            }
            .refreshable { health = await HealthKitManager.shared.fetchDay(day) }
        }
    }

    private func analyze() async {
        analyzing = true
        error = nil
        defer { analyzing = false }
        do {
            try await DayReviewer.review(day: day, context: context)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func fmt(_ v: Double?, _ unit: String = "") -> String {
        v.map { "\(Int($0.rounded()))\(unit)" } ?? "—"
    }

    private func hours(_ minutes: Double) -> String {
        "\(Int(minutes) / 60) h \(Int(minutes) % 60) min"
    }
}

struct MetricRow: View {
    let title: String, value: String, icon: String
    init(_ title: String, _ value: String, _ icon: String) {
        self.title = title; self.value = value; self.icon = icon
    }
    var body: some View {
        LabeledContent { Text(value).monospacedDigit() } label: { Label(title, systemImage: icon) }
    }
}

struct ReviewSections: View {
    let review: DailyReview

    var body: some View {
        Section("Evaluación del coach") {
            HStack(alignment: .firstTextBaseline) {
                Text("\(review.score)").font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(review.score >= 7 ? .green : review.score >= 5 ? .orange : .red)
                Text("/ 10").foregroundStyle(.secondary)
            }
            Text(review.summary)
        }
        bullets("Lo que hiciste bien", review.good, "checkmark.circle.fill", .green)
        bullets("Lo que debes mejorar", review.bad, "exclamationmark.triangle.fill", .orange)
        bullets("Para mañana", review.tomorrow, "arrow.forward.circle.fill", .blue)
    }

    @ViewBuilder
    private func bullets(_ title: String, _ items: [String], _ icon: String, _ color: Color) -> some View {
        if !items.isEmpty {
            Section(title) {
                ForEach(items, id: \.self) { item in
                    Label { Text(item) } icon: { Image(systemName: icon).foregroundStyle(color) }
                }
            }
        }
    }
}
