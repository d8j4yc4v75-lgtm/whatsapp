import SwiftUI
import SwiftData

@main
struct CoachApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(for: [FoodEntry.self, DailyReview.self])
    }
}

struct RootView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Hoy", systemImage: "heart.text.square") }
            FoodLogView()
                .tabItem { Label("Comidas", systemImage: "fork.knife") }
            HistoryView()
                .tabItem { Label("Historial", systemImage: "calendar") }
            PlanView()
                .tabItem { Label("Plan", systemImage: "figure.strengthtraining.traditional") }
            SettingsView()
                .tabItem { Label("Ajustes", systemImage: "gear") }
        }
        .task {
            await HealthKitManager.shared.requestAuthorization()
            await NotificationScheduler.scheduleDailyReminder()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await AutoReviewer.reviewYesterdayIfNeeded(context: context) }
            }
        }
    }
}
