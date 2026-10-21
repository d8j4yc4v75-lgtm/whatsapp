import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ChatView: View {
    @Environment(AppStore.self) private var store
    let jid: String

    @State private var text = ""
    @State private var sending = false
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var recorder = VoiceRecorder()
    @State private var loadingOlder = false

    private var conversation: Conversation? { store.conversation(jid) }
    private var list: [Message] { store.messages[jid] ?? [] }

    private var selectedAccountId: Int? { store.defaultReplyAccount(for: jid) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if store.hasMoreMessages[jid] == true {
                            Button {
                                Task {
                                    loadingOlder = true
                                    let anchor = list.first?.uid
                                    await store.loadMessages(jid, older: true)
                                    loadingOlder = false
                                    if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            } label: {
                                if loadingOlder { ProgressView() } else { Text("Cargar mensajes anteriores").font(.footnote) }
                            }
                            .padding(.vertical, 8)
                        }
                        ForEach(Array(list.enumerated()), id: \.element.uid) { index, msg in
                            if index == 0 || !Calendar.current.isDate(list[index - 1].date, inSameDayAs: msg.date) {
                                Text(msg.date.formatted(date: .abbreviated, time: .omitted))
                                    .font(.caption)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(.thinMaterial, in: Capsule())
                                    .padding(.vertical, 6)
                            }
                            MessageBubble(message: msg, isGroup: conversation?.isGroup ?? false)
                                .id(msg.uid)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(.bottom)
                .onChange(of: list.last?.uid) { _, uid in
                    guard let uid, !loadingOlder else { return }
                    withAnimation { proxy.scrollTo(uid, anchor: .bottom) }
                }
            }
            .background(Color(.systemGroupedBackground))

            composer
        }
        .navigationTitle(conversation?.displayName ?? jid)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { labelsMenu }
        }
        .task(id: jid) {
            store.activeJid = jid
            await store.loadMessages(jid)
            await store.markRead(jid)
        }
        .onDisappear {
            if store.activeJid == jid { store.activeJid = nil }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task { await sendPhoto(item) }
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await sendFile(url) } }
        }
    }

    // MARK: - Barra de escritura

    private var composer: some View {
        VStack(spacing: 6) {
            accountPicker
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button { showPhotoPicker = true } label: { Label("Foto o video", systemImage: "photo") }
                    Button { showFileImporter = true } label: { Label("Documento", systemImage: "doc") }
                } label: {
                    Image(systemName: "plus.circle.fill").font(.title2)
                }
                .disabled(sending)

                if recorder.isRecording {
                    HStack {
                        Image(systemName: "record.circle").foregroundStyle(.red)
                        Text(Duration.seconds(recorder.elapsed).formatted(.time(pattern: .minuteSecond)))
                            .monospacedDigit()
                        Spacer()
                        Button("Cancelar", role: .destructive) { recorder.cancel() }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                } else {
                    TextField("Mensaje", text: $text, axis: .vertical)
                        .lineLimit(1...6)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                }

                if sending {
                    ProgressView().frame(width: 32, height: 32)
                } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        Task { await toggleRecording() }
                    } label: {
                        Image(systemName: recorder.isRecording ? "arrow.up.circle.fill" : "mic.circle.fill").font(.title)
                    }
                } else {
                    Button {
                        Task { await sendText() }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.bar)
        .disabled(selectedAccountId == nil)
    }

    private var accountPicker: some View {
        HStack(spacing: 6) {
            Text("Enviar desde").font(.caption).foregroundStyle(.secondary)
            Menu {
                ForEach(store.accounts) { acc in
                    Button {
                        store.replyAccount[jid] = acc.id
                    } label: {
                        Label(menuTitle(acc), systemImage: acc.id == selectedAccountId ? "checkmark.circle.fill" : "circle")
                    }
                    .disabled(!acc.isConnected)
                }
            } label: {
                HStack(spacing: 4) {
                    let acc = selectedAccountId.flatMap { store.account($0) }
                    Circle().fill(Color(hex: acc?.color ?? "#8E8E93")).frame(width: 8, height: 8)
                    Text(acc?.name ?? "Sin cuentas conectadas").font(.caption.weight(.semibold))
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color(hex: selectedAccountId.flatMap { store.account($0)?.color } ?? "#8E8E93").opacity(0.15), in: Capsule())
            }
            Spacer()
        }
    }

    private var labelsMenu: some View {
        Menu {
            if store.labels.isEmpty {
                Text("Crea etiquetas en Ajustes")
            }
            ForEach(store.labels) { label in
                Button {
                    Task { await store.toggleLabel(label.id, jid: jid) }
                } label: {
                    Label(label.name, systemImage: conversation?.labelIds.contains(label.id) == true ? "checkmark.circle.fill" : "circle")
                }
            }
        } label: {
            Image(systemName: "tag")
        }
    }

    private func menuTitle(_ acc: Account) -> String {
        var title = acc.name
        if let phone = acc.phone { title += " (+" + phone + ")" }
        if !acc.isConnected { title += " · " + acc.statusText }
        return title
    }

    // MARK: - Acciones

    private func sendText() async {
        guard let accountId = selectedAccountId else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        sending = true
        text = ""
        if !(await store.sendText(body, jid: jid, accountId: accountId)) { text = body }
        sending = false
    }

    private func sendPhoto(_ item: PhotosPickerItem) async {
        guard let accountId = selectedAccountId else { return }
        sending = true
        defer { sending = false }
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            store.lastError = "No se pudo leer el archivo"
            return
        }
        let videoType = item.supportedContentTypes.first { $0.conforms(to: .movie) }
        let caption = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let videoType {
            // El servidor convierte a MP4 (H.264) si el video viene en otro formato
            let mime = videoType.preferredMIMEType ?? "video/quicktime"
            let ext = videoType.preferredFilenameExtension ?? "mov"
            if await store.sendMedia(data, fileName: "video." + ext, mime: mime, kind: "video", caption: caption, jid: jid, accountId: accountId) { text = "" }
        } else {
            // Se convierte a JPEG para que WhatsApp lo acepte (las fotos del iPhone suelen ser HEIC)
            let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
            if await store.sendMedia(jpeg, fileName: "foto.jpg", mime: "image/jpeg", kind: "image", caption: caption, jid: jid, accountId: accountId) { text = "" }
        }
    }

    private func sendFile(_ url: URL) async {
        guard let accountId = selectedAccountId else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            store.lastError = "No se pudo leer el archivo"
            return
        }
        let type = UTType(filenameExtension: url.pathExtension)
        let mime = type?.preferredMIMEType ?? "application/octet-stream"
        sending = true
        _ = await store.sendMedia(data, fileName: url.lastPathComponent, mime: mime, kind: "document", caption: nil, jid: jid, accountId: accountId)
        sending = false
    }

    private func toggleRecording() async {
        if recorder.isRecording {
            guard let accountId = selectedAccountId, let data = recorder.stop() else { return }
            sending = true
            _ = await store.sendMedia(data, fileName: "nota.m4a", mime: "audio/mp4", kind: "audio", caption: nil, ptt: true, jid: jid, accountId: accountId)
            sending = false
        } else {
            await recorder.start()
        }
    }
}
