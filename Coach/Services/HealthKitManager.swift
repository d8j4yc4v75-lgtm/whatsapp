import Foundation
import HealthKit

final class HealthKitManager {
    static let shared = HealthKitManager()
    private let store = HKHealthStore()

    private let quantityIDs: [HKQuantityTypeIdentifier] = [
        .stepCount, .activeEnergyBurned, .basalEnergyBurned, .appleExerciseTime,
        .distanceWalkingRunning, .restingHeartRate, .heartRateVariabilitySDNN, .bodyMass,
    ]

    func requestAuthorization() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        var types: Set<HKObjectType> = Set(quantityIDs.map { HKQuantityType($0) })
        types.insert(HKCategoryType(.sleepAnalysis))
        types.insert(HKObjectType.workoutType())
        try? await store.requestAuthorization(toShare: [], read: types)
    }

    func fetchDay(_ day: Date) async -> HealthDay {
        let cal = Calendar.current
        let start = cal.startOfDay(for: day)
        let end = cal.date(byAdding: .day, value: 1, to: start)!

        async let steps = sum(.stepCount, .count(), start, end)
        async let active = sum(.activeEnergyBurned, .kilocalorie(), start, end)
        async let basal = sum(.basalEnergyBurned, .kilocalorie(), start, end)
        async let exercise = sum(.appleExerciseTime, .minute(), start, end)
        async let distance = sum(.distanceWalkingRunning, .meterUnit(with: .kilo), start, end)
        async let resting = average(.restingHeartRate, HKUnit.count().unitDivided(by: .minute()), start, end)
        async let hrv = average(.heartRateVariabilitySDNN, .secondUnit(with: .milli), start, end)
        async let weight = latest(.bodyMass, .gramUnit(with: .kilo), before: end)
        async let sleep = sleepSummary(endingOn: start)
        async let workouts = workouts(start, end)

        return await HealthDay(
            steps: steps, activeKcal: active, basalKcal: basal, exerciseMinutes: exercise,
            distanceKm: distance, restingHR: resting, hrvMs: hrv, weightKg: weight,
            sleep: sleep, workouts: workouts
        )
    }

    // MARK: - Consultas

    private func sum(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let query = HKStatisticsQueryDescriptor(
            predicate: .quantitySample(type: HKQuantityType(id), predicate: predicate),
            options: .cumulativeSum)
        return try? await query.result(for: store)?.sumQuantity()?.doubleValue(for: unit)
    }

    private func average(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let query = HKStatisticsQueryDescriptor(
            predicate: .quantitySample(type: HKQuantityType(id), predicate: predicate),
            options: .discreteAverage)
        return try? await query.result(for: store)?.averageQuantity()?.doubleValue(for: unit)
    }

    private func latest(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit, before end: Date) async -> Double? {
        let predicate = HKQuery.predicateForSamples(withStart: nil, end: end)
        let query = HKSampleQueryDescriptor(
            predicates: [.quantitySample(type: HKQuantityType(id), predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)],
            limit: 1)
        return try? await query.result(for: store).first?.quantity.doubleValue(for: unit)
    }

    /// Sueño de la noche que termina en `day` (de 18:00 del día anterior a 14:00 del día).
    private func sleepSummary(endingOn day: Date) async -> SleepSummary? {
        let cal = Calendar.current
        let windowStart = cal.date(byAdding: .hour, value: -6, to: day)!
        let windowEnd = cal.date(byAdding: .hour, value: 14, to: day)!
        let predicate = HKQuery.predicateForSamples(withStart: windowStart, end: windowEnd)
        let query = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)])
        guard let samples = try? await query.result(for: store), !samples.isEmpty else { return nil }

        var asleep: [DateInterval] = []
        var inBed: [DateInterval] = []
        var deep = 0.0, rem = 0.0, core = 0.0, awake = 0.0

        for s in samples {
            let interval = DateInterval(start: s.startDate, end: s.endDate)
            let minutes = interval.duration / 60
            guard let value = HKCategoryValueSleepAnalysis(rawValue: s.value) else { continue }
            switch value {
            case .inBed: inBed.append(interval)
            case .awake: awake += minutes
            case .asleepDeep: deep += minutes; asleep.append(interval)
            case .asleepREM: rem += minutes; asleep.append(interval)
            case .asleepCore: core += minutes; asleep.append(interval)
            case .asleepUnspecified: asleep.append(interval)
            default: break
            }
        }
        // iPhone y Apple Watch pueden registrar el mismo sueño: se unen los intervalos para no duplicar.
        let asleepMerged = merge(asleep)
        let inBedMerged = merge(inBed + asleep)
        guard !asleepMerged.isEmpty else { return nil }

        return SleepSummary(
            asleepMinutes: asleepMerged.reduce(0) { $0 + $1.duration } / 60,
            inBedMinutes: inBedMerged.reduce(0) { $0 + $1.duration } / 60,
            deepMinutes: deep, remMinutes: rem, coreMinutes: core, awakeMinutes: awake,
            bedtime: asleepMerged.first?.start, wakeTime: asleepMerged.last?.end)
    }

    private func merge(_ intervals: [DateInterval]) -> [DateInterval] {
        var result: [DateInterval] = []
        for i in intervals.sorted(by: { $0.start < $1.start }) {
            if let last = result.last, i.start <= last.end {
                result[result.count - 1] = DateInterval(start: last.start, end: max(last.end, i.end))
            } else {
                result.append(i)
            }
        }
        return result
    }

    private func workouts(_ start: Date, _ end: Date) async -> [WorkoutSummary] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let query = HKSampleQueryDescriptor(
            predicates: [.workout(predicate)],
            sortDescriptors: [SortDescriptor(\.startDate)])
        guard let items = try? await query.result(for: store) else { return [] }
        return items.map { w in
            WorkoutSummary(
                name: w.workoutActivityType.spanishName,
                start: w.startDate,
                minutes: w.duration / 60,
                kcal: w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie()),
                distanceKm: w.totalDistance?.doubleValue(for: .meterUnit(with: .kilo)))
        }
    }
}

extension HKWorkoutActivityType {
    var spanishName: String {
        switch self {
        case .running: "Correr"
        case .walking: "Caminar"
        case .cycling: "Ciclismo"
        case .swimming: "Natación"
        case .traditionalStrengthTraining: "Fuerza (pesas)"
        case .functionalStrengthTraining: "Fuerza funcional"
        case .highIntensityIntervalTraining: "HIIT"
        case .crossTraining: "Cross training"
        case .yoga: "Yoga"
        case .elliptical: "Elíptica"
        case .rowing: "Remo"
        case .coreTraining: "Core"
        case .flexibility: "Flexibilidad"
        case .soccer: "Fútbol"
        case .basketball: "Baloncesto"
        case .boxing, .kickboxing: "Boxeo"
        case .hiking: "Senderismo"
        case .stairClimbing: "Escaleras"
        case .dance: "Baile"
        case .pilates: "Pilates"
        case .mixedCardio: "Cardio mixto"
        default: "Entrenamiento"
        }
    }
}
