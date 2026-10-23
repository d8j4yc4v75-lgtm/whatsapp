import Foundation
import SwiftData
import UserNotifications

enum DayReviewer {
    /// Construye el informe del día (Salud + comidas), lo envía a Claude y guarda la evaluación.
    @MainActor
    @discardableResult
    static func review(day: Date, context: ModelContext) async throws -> DailyReview {
        let start = Calendar.current.startOfDay(for: day)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: start)!
        let health = await HealthKitManager.shared.fetchDay(start)
        let foods = try context.fetch(FetchDescriptor<FoodEntry>(
            predicate: #Predicate { $0.date >= start && $0.date < end },
            sortBy: [SortDescriptor(\.date)]))

        let report = buildReport(day: start, health: health, foods: foods)
        let verdict = try await ClaudeService.review(report: report, plan: PlanStore.load())

        let existing = try context.fetch(FetchDescriptor<DailyReview>(predicate: #Predicate { $0.day == start }))
        for old in existing { context.delete(old) }
        let review = DailyReview(day: start, score: verdict.puntuacion, summary: verdict.resumen,
                                 good: verdict.bien, bad: verdict.mal, tomorrow: verdict.manana)
        context.insert(review)
        try context.save()
        return review
    }

    static func buildReport(day: Date, health h: HealthDay, foods: [FoodEntry]) -> String {
        let dateFmt = Date.FormatStyle(date: .complete, time: .omitted).locale(Locale(identifier: "es"))
        let time = Date.FormatStyle(date: .omitted, time: .shortened)
        func n(_ v: Double?, _ unit: String, digits: Int = 0) -> String {
            guard let v else { return "sin datos" }
            return String(format: "%.\(digits)f %@", v, unit)
        }

        var lines = ["DÍA: \(day.formatted(dateFmt))", ""]
        if !Profile.notes.isEmpty {
            lines += ["SOBRE MÍ: \(Profile.notes)", ""]
        }

        lines.append("SUEÑO (noche anterior):")
        if let s = h.sleep {
            lines.append("- Dormido: \(n(s.asleepMinutes / 60, "h", digits: 1)) · En cama: \(n(s.inBedMinutes / 60, "h", digits: 1))")
            lines.append("- Profundo \(Int(s.deepMinutes)) min · REM \(Int(s.remMinutes)) min · Core \(Int(s.coreMinutes)) min · Despierto \(Int(s.awakeMinutes)) min")
            if let b = s.bedtime, let w = s.wakeTime {
                lines.append("- Se durmió \(b.formatted(time)) · Despertó \(w.formatted(time))")
            }
        } else {
            lines.append("- sin datos")
        }

        lines += [
            "",
            "ACTIVIDAD:",
            "- Pasos: \(n(h.steps, ""))",
            "- Distancia caminando/corriendo: \(n(h.distanceKm, "km", digits: 1))",
            "- Calorías activas: \(n(h.activeKcal, "kcal"))",
            "- Calorías en reposo: \(n(h.basalKcal, "kcal"))",
            "- Gasto total estimado: \(n(h.activeKcal.flatMap { a in h.basalKcal.map { a + $0 } }, "kcal"))",
            "- Minutos de ejercicio: \(n(h.exerciseMinutes, "min"))",
            "- FC en reposo: \(n(h.restingHR, "lpm"))",
            "- VFC (HRV): \(n(h.hrvMs, "ms"))",
            "- Peso más reciente: \(n(h.weightKg, "kg", digits: 1))",
            "",
            "ENTRENAMIENTOS:",
        ]
        if h.workouts.isEmpty { lines.append("- ninguno registrado") }
        for w in h.workouts {
            var l = "- \(w.start.formatted(time)) \(w.name): \(Int(w.minutes)) min"
            if let k = w.kcal { l += ", \(Int(k)) kcal" }
            if let d = w.distanceKm, d > 0 { l += String(format: ", %.1f km", d) }
            lines.append(l)
        }

        lines += ["", "LO QUE COMÍ:"]
        if foods.isEmpty { lines.append("- no registré comidas") }
        for f in foods {
            var l = "- \(f.date.formatted(time)) [\(f.meal.rawValue)] \(f.text)"
            if let k = f.kcal { l += " (\(k) kcal)" }
            if let p = f.proteinGrams { l += " (\(p) g proteína)" }
            lines.append(l)
        }
        let kcal = foods.compactMap(\.kcal).reduce(0, +)
        let protein = foods.compactMap(\.proteinGrams).reduce(0, +)
        if kcal > 0 || protein > 0 {
            lines.append("- Total anotado: \(kcal) kcal, \(protein) g proteína (solo de las comidas con cantidades)")
        }

        lines += ["", "Evalúa este día frente a mi plan de entrenamiento."]
        return lines.joined(separator: "\n")
    }
}

enum AutoReviewer {
    /// Al abrir la app, si ayer no tiene evaluación, la genera automáticamente.
    @MainActor
    static func reviewYesterdayIfNeeded(context: ModelContext) async {
        guard Keychain.get(ClaudeService.apiKeyName) != nil else { return }
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Calendar.current.startOfDay(for: .now))!
        let existing = (try? context.fetchCount(FetchDescriptor<DailyReview>(predicate: #Predicate { $0.day == yesterday }))) ?? 0
        guard existing == 0 else { return }
        _ = try? await DayReviewer.review(day: yesterday, context: context)
    }
}

enum NotificationScheduler {
    static func scheduleDailyReminder() async {
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }

        let content = UNMutableNotificationContent()
        content.title = "Coach"
        content.body = "Anota lo que comiste hoy y revisa cómo vas con tu plan."
        let trigger = UNCalendarNotificationTrigger(dateMatching: DateComponents(hour: 21, minute: 0), repeats: true)
        try? await center.add(UNNotificationRequest(identifier: "daily-review", content: content, trigger: trigger))
    }
}
