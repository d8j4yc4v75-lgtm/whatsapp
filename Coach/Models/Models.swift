import Foundation
import SwiftData

enum MealType: String, CaseIterable, Codable, Identifiable {
    case desayuno = "Desayuno"
    case almuerzo = "Almuerzo"
    case cena = "Cena"
    case snack = "Snack"
    case preEntreno = "Pre-entreno"
    case postEntreno = "Post-entreno"

    var id: String { rawValue }
}

@Model
final class FoodEntry {
    var date: Date
    var mealRaw: String
    var text: String
    var kcal: Int?
    var proteinGrams: Int?

    init(date: Date = .now, meal: MealType, text: String, kcal: Int? = nil, proteinGrams: Int? = nil) {
        self.date = date
        self.mealRaw = meal.rawValue
        self.text = text
        self.kcal = kcal
        self.proteinGrams = proteinGrams
    }

    var meal: MealType { MealType(rawValue: mealRaw) ?? .snack }
}

@Model
final class DailyReview {
    @Attribute(.unique) var day: Date
    var score: Int
    var summary: String
    var good: [String]
    var bad: [String]
    var tomorrow: [String]
    var createdAt: Date

    init(day: Date, score: Int, summary: String, good: [String], bad: [String], tomorrow: [String]) {
        self.day = Calendar.current.startOfDay(for: day)
        self.score = score
        self.summary = summary
        self.good = good
        self.bad = bad
        self.tomorrow = tomorrow
        self.createdAt = .now
    }
}

/// Datos de Apple Health de un día.
struct HealthDay {
    var steps: Double?
    var activeKcal: Double?
    var basalKcal: Double?
    var exerciseMinutes: Double?
    var distanceKm: Double?
    var restingHR: Double?
    var hrvMs: Double?
    var weightKg: Double?
    var sleep: SleepSummary?
    var workouts: [WorkoutSummary] = []
}

struct SleepSummary {
    var asleepMinutes: Double
    var inBedMinutes: Double
    var deepMinutes: Double
    var remMinutes: Double
    var coreMinutes: Double
    var awakeMinutes: Double
    var bedtime: Date?
    var wakeTime: Date?
}

struct WorkoutSummary: Identifiable {
    let id = UUID()
    var name: String
    var start: Date
    var minutes: Double
    var kcal: Double?
    var distanceKm: Double?
}
