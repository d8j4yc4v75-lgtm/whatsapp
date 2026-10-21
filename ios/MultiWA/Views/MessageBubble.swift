import SwiftUI
import AVKit
import QuickLook

struct MessageBubble: View {
    @Environment(AppStore.self) private var store
    let message: Message
    let isGroup: Bool

    private var account: Account? { store.account(message.accountId) }

    var body: some View {
        HStack {
            if message.fromMe { Spacer(minLength: 50) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    AccountTag(account: account)
                    if isGroup && !message.fromMe {
                        Text(message.senderName ?? message.sender?.components(separatedBy: "@").first ?? "")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                content
                HStack(spacing: 3) {
                    Spacer(minLength: 0)
                    Text(message.date.formatted(date: .omitted, time: .shortened))
                    if message.fromMe { StatusTicks(status: message.status) }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                message.fromMe ? Color(red: 0.85, green: 0.97, blue: 0.80) : Color(.systemBackground),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .overlay(alignment: message.fromMe ? .trailing : .leading) {
                // Franja del color de la cuenta para distinguir de un vistazo
                Capsule()
                    .fill(Color(hex: account?.color ?? "#8E8E93"))
                    .frame(width: 3)
                    .padding(.vertical, 8)
                    .offset(x: message.fromMe ? 4 : -4)
            }
            .environment(\.colorScheme, .light)
            if !message.fromMe { Spacer(minLength: 50) }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch message.type {
        case "image", "sticker":
            RemoteImage(message: message)
            caption
        case "video":
            VideoAttachment(message: message)
            caption
        case "audio":
            AudioAttachment(message: message)
        case "document":
            DocumentAttachment(message: message)
            caption
        default:
            Text(linkified(message.text ?? ""))
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private var caption: some View {
        if let text = message.text, !text.isEmpty {
            Text(linkified(text)).textSelection(.enabled)
        }
    }
}

/// Convierte las URL del texto en enlaces tocables
func linkified(_ text: String) -> AttributedString {
    var result = AttributedString(text)
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return result }
    for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let url = match.url,
              let range = Range(match.range, in: text),
              let lower = AttributedString.Index(range.lowerBound, within: result),
              let upper = AttributedString.Index(range.upperBound, within: result) else { continue }
        result[lower..<upper].link = url
    }
    return result
}

struct StatusTicks: View {
    let status: Int

    var body: some View {
        switch status {
        case 0: Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
        case 1: Image(systemName: "clock")
        case 2: Image(systemName: "checkmark")
        case 3: Image(systemName: "checkmark.circle")
        default: Image(systemName: "checkmark.circle.fill").foregroundStyle(.blue)
        }
    }
}

/// Imagen que se descarga del servidor con autenticación y se guarda en memoria
struct RemoteImage: View {
    @Environment(AppStore.self) private var store
    let message: Message
    @State private var image: UIImage?
    @State private var failed = false
    @State private var showFull = false

    private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: message.type == "sticker" ? 140 : 240, maxHeight: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .onTapGesture { showFull = true }
            } else if failed {
                Label("Imagen no disponible", systemImage: "photo").foregroundStyle(.secondary)
            } else {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.gray.opacity(0.2))
                    .frame(width: 200, height: 150)
                    .overlay(ProgressView())
            }
        }
        .task(id: message.uid) { await load() }
        .fullScreenCover(isPresented: $showFull) {
            if let image {
                ZStack(alignment: .topTrailing) {
                    Color.black.ignoresSafeArea()
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                    HStack {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("Imagen", image: Image(uiImage: image)))
                        Button { showFull = false } label: { Image(systemName: "xmark.circle.fill").font(.title) }
                    }
                    .padding()
                    .foregroundStyle(.white)
                }
            }
        }
    }

    private func load() async {
        if let cached = Self.cache.object(forKey: message.uid as NSString) {
            image = cached
            return
        }
        guard let api = store.api, let data = try? await api.download(message), let img = UIImage(data: data) else {
            failed = true
            return
        }
        Self.cache.setObject(img, forKey: message.uid as NSString)
        image = img
    }
}

struct VideoAttachment: View {
    @Environment(AppStore.self) private var store
    let message: Message
    @State private var player: AVPlayer?

    var body: some View {
        Button {
            if let api = store.api { player = AVPlayer(url: api.mediaURL(message)) }
        } label: {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.black.opacity(0.8))
                .frame(width: 220, height: 140)
                .overlay(Image(systemName: "play.circle.fill").font(.system(size: 44)).foregroundStyle(.white))
        }
        .buttonStyle(.plain)
        .fullScreenCover(isPresented: Binding(get: { player != nil }, set: { if !$0 { player = nil } })) {
            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
                    .onAppear { player.play() }
                    .overlay(alignment: .topTrailing) {
                        Button { self.player = nil } label: {
                            Image(systemName: "xmark.circle.fill").font(.title).foregroundStyle(.white)
                        }
                        .padding()
                    }
            }
        }
    }
}

struct AudioAttachment: View {
    @Environment(AppStore.self) private var store
    let message: Message
    @State private var player: AVPlayer?
    @State private var playing = false
    @State private var progress: Double = 0
    @State private var observer: Any?

    var body: some View {
        HStack(spacing: 10) {
            Button {
                toggle()
            } label: {
                Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 34))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            ProgressView(value: progress).frame(width: 140)
        }
        .onDisappear {
            player?.pause()
            playing = false
        }
    }

    private func toggle() {
        if player == nil, let api = store.api {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            let p = AVPlayer(url: api.mediaURL(message))
            observer = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.2, preferredTimescale: 600), queue: .main) { t in
                let total = p.currentItem?.duration.seconds ?? 0
                progress = total.isFinite && total > 0 ? t.seconds / total : 0
                if progress >= 0.999 {
                    playing = false
                    p.seek(to: .zero)
                }
            }
            player = p
        }
        if playing { player?.pause() } else { player?.play() }
        playing.toggle()
    }
}

struct DocumentAttachment: View {
    @Environment(AppStore.self) private var store
    let message: Message
    @State private var fileURL: URL?
    @State private var loading = false

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.fill").font(.title2)
                Text(message.fileName ?? "Documento").lineLimit(2).multilineTextAlignment(.leading)
                if loading { ProgressView() }
            }
            .padding(8)
            .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .quickLookPreview($fileURL)
    }

    private func open() async {
        guard let api = store.api else { return }
        loading = true
        defer { loading = false }
        do {
            let data = try await api.download(message)
            let name = message.fileName ?? "\(message.id).\(message.mime?.components(separatedBy: "/").last ?? "bin")"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try data.write(to: url)
            fileURL = url
        } catch {
            store.lastError = error.localizedDescription
        }
    }
}
