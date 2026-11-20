import Foundation
import HealthKit

/// Lo que Salud registró en un día, listo para mandarse a la página en el #ancla.
struct DayReading {
    let day: Date
    let readAt: Date
    var steps: Double?
    var activeKcal: Double?
    var restingKcal: Double?
    var exerciseMin: Double?
    var restingHR: Double?
    var sleepMin: Double?
    var weightKg: Double?
    var workoutMin: Double?

    var isEmpty: Bool {
        [steps, activeKcal, restingKcal, exerciseMin, restingHR, sleepMin, weightKg, workoutMin].allSatisfy { $0 == nil }
    }
}

final class HealthReader {
    static let shared = HealthReader()
    private let store = HKHealthStore()
    private let cal = Calendar.current

    private let quantityIDs: [HKQuantityTypeIdentifier] = [
        .stepCount, .activeEnergyBurned, .basalEnergyBurned, .appleExerciseTime, .restingHeartRate, .bodyMass,
    ]

    func requestAccess() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        var read: Set<HKObjectType> = Set(quantityIDs.map { HKQuantityType($0) })
        read.insert(HKCategoryType(.sleepAnalysis))
        read.insert(HKObjectType.workoutType())
        try? await store.requestAuthorization(toShare: [], read: read)
    }

    /// Hoy y los días anteriores. Los totales los calcula Salud, que ya quita lo repetido entre iPhone y Apple Watch.
    func readings(days: Int = 2, now: Date = .now) async -> [DayReading] {
        guard HKHealthStore.isHealthDataAvailable() else { return [] }
        let today = cal.startOfDay(for: now)
        var out: [DayReading] = []
        for offset in 0..<days {
            guard let start = cal.date(byAdding: .day, value: -offset, to: today),
                  let end = cal.date(byAdding: .day, value: 1, to: start) else { continue }
            let until = min(end, now)
            let readAt = offset == 0 ? now : end.addingTimeInterval(-60)

            async let steps = sum(.stepCount, .count(), start, until)
            async let active = sum(.activeEnergyBurned, .kilocalorie(), start, until)
            async let resting = sum(.basalEnergyBurned, .kilocalorie(), start, until)
            async let exercise = sum(.appleExerciseTime, .minute(), start, until)
            async let heart = average(.restingHeartRate, HKUnit.count().unitDivided(by: .minute()), start, until)
            async let weight = latest(.bodyMass, .gramUnit(with: .kilo), start, until)
            async let sleep = sleepMinutes(nightBefore: start, until: until)
            async let workouts = workoutMinutes(start, until)

            let reading = await DayReading(
                day: start, readAt: readAt, steps: steps, activeKcal: active, restingKcal: resting,
                exerciseMin: exercise, restingHR: heart, sleepMin: sleep, weightKg: weight, workoutMin: workouts)
            if !reading.isEmpty { out.append(reading) }
        }
        return out
    }

    /// `salud~d20261120_t1415_p6240_a410.5_r1320_z452_c61_e18_k102.8_w0~d20261119_t2359_…`
    /// Solo letras, dígitos, «.», «_» y «~», que es lo que el visor de Claude deja pasar a la página.
    static func anchor(_ readings: [DayReading]) -> String? {
        guard !readings.isEmpty else { return nil }
        let posix = Locale(identifier: "en_US_POSIX")
        let dayFmt = DateFormatter()
        dayFmt.locale = posix
        dayFmt.calendar = Calendar(identifier: .gregorian)
        dayFmt.dateFormat = "yyyyMMdd"
        let timeFmt = DateFormatter()
        timeFmt.locale = posix
        timeFmt.dateFormat = "HHmm"

        let parts = readings.map { r -> String in
            var fields = ["d" + dayFmt.string(from: r.day), "t" + timeFmt.string(from: r.readAt)]
            func add(_ key: String, _ value: Double?, decimals: Int = 0) {
                guard let value, value.isFinite, value >= 0 else { return }
                fields.append(key + (decimals == 0 ? String(Int(value.rounded())) : String(format: "%.\(decimals)f", value)))
            }
            add("p", r.steps)
            add("a", r.activeKcal, decimals: 1)
            add("r", r.restingKcal, decimals: 1)
            add("z", r.sleepMin)
            add("c", r.restingHR)
            add("e", r.exerciseMin)
            add("k", r.weightKg, decimals: 1)
            add("w", r.workoutMin)
            return fields.joined(separator: "_")
        }
        return "salud~" + parts.joined(separator: "~")
    }

    // MARK: - Consultas

    private func dayPredicate(_ start: Date, _ end: Date) -> NSPredicate {
        HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    }

    private func sum(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        let query = HKStatisticsQueryDescriptor(
            predicate: .quantitySample(type: HKQuantityType(id), predicate: dayPredicate(start, end)),
            options: .cumulativeSum)
        return try? await query.result(for: store)?.sumQuantity()?.doubleValue(for: unit)
    }

    private func average(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        let query = HKStatisticsQueryDescriptor(
            predicate: .quantitySample(type: HKQuantityType(id), predicate: dayPredicate(start, end)),
            options: .discreteAverage)
        return try? await query.result(for: store)?.averageQuantity()?.doubleValue(for: unit)
    }

    private func latest(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        let query = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(id), predicate: dayPredicate(start, end))],
            sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)],
            limit: 1)
        return try? await query.result(for: store).first?.quantity.doubleValue(for: unit)
    }

    private func workoutMinutes(_ start: Date, _ end: Date) async -> Double? {
        let query = HKSampleQueryDescriptor(predicates: [.workout(dayPredicate(start, end))], sortDescriptors: [])
        guard let workouts = try? await query.result(for: store) else { return nil }
        return workouts.reduce(0) { $0 + $1.duration } / 60
    }

    /// Sueño de la noche que termina en ese día (de las 18:00 anteriores a las 14:00).
    /// Se toma una sola fuente, la que registra fases (el reloj) si la hay, para no contar doble.
    private func sleepMinutes(nightBefore dayStart: Date, until: Date) async -> Double? {
        let from = dayStart.addingTimeInterval(-6 * 3600)
        let to = min(dayStart.addingTimeInterval(14 * 3600), until)
        guard to > from else { return nil }
        let query = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: HKQuery.predicateForSamples(withStart: from, end: to))],
            sortDescriptors: [SortDescriptor(\.startDate)])
        guard let samples = try? await query.result(for: store), !samples.isEmpty else { return nil }

        let staged: Set<Int> = [
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue,
        ]
        let asleep = staged.union([HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue])

        struct SourceSleep { var intervals: [DateInterval] = []; var hasStages = false }
        var bySource: [String: SourceSleep] = [:]
        for sample in samples where asleep.contains(sample.value) {
            let a = max(sample.startDate, from), b = min(sample.endDate, to)
            guard b > a else { continue }
            let key = sample.sourceRevision.source.bundleIdentifier
            var entry = bySource[key, default: SourceSleep()]
            entry.intervals.append(DateInterval(start: a, end: b))
            if staged.contains(sample.value) { entry.hasStages = true }
            bySource[key] = entry
        }
        let totals = bySource.values.map { (minutes: Self.mergedSeconds($0.intervals) / 60, hasStages: $0.hasStages) }
        let pick = totals.filter { $0.hasStages }.max { $0.minutes < $1.minutes } ?? totals.max { $0.minutes < $1.minutes }
        guard let minutes = pick?.minutes, minutes > 0 else { return nil }
        return minutes
    }

    private static func mergedSeconds(_ intervals: [DateInterval]) -> TimeInterval {
        var total: TimeInterval = 0
        var current: DateInterval?
        for interval in intervals.sorted(by: { $0.start < $1.start }) {
            if let c = current, interval.start <= c.end {
                current = DateInterval(start: c.start, end: max(c.end, interval.end))
            } else {
                if let c = current { total += c.duration }
                current = interval
            }
        }
        if let c = current { total += c.duration }
        return total
    }
}
