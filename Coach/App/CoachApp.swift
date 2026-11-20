import SwiftUI
import UIKit
import WebKit

@main
struct CoachApp: App {
    var body: some Scene {
        WindowGroup {
            ShellView()
        }
    }
}

struct ShellView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ShellViewController { ShellViewController() }
    func updateUIViewController(_ controller: ShellViewController, context: Context) {}
}

/// Muestra Coach Diario (la página de Claude) y le pasa lo que lee de Salud.
/// La primera vez va en el #ancla; después, la página avisa que está lista y se le mandan
/// las lecturas nuevas sin recargarla, para no perder lo que estés escribiendo.
final class ShellViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let artifactURL = URL(string: "https://claude.ai/artifact/34AjknhRPw9qqUJG6UMnpb")!

    private var webView: WKWebView!
    private var popup: UIViewController?
    private var pageFrame: WKFrameInfo?
    private var backgroundedAt: Date?
    private var reloading = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"
        config.userContentController.add(WeakMessageHandler(self), name: "coachHealth")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        let pull = UIRefreshControl()
        pull.addTarget(self, action: #selector(pulled), for: .valueChanged)
        webView.scrollView.refreshControl = pull

        // Al volver de otra app (no con avisos del sistema, como el de la cámara)
        NotificationCenter.default.addObserver(self, selector: #selector(enteredBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)

        Task {
            await HealthReader.shared.requestAccess()
            await reload()
        }
    }

    @objc private func enteredBackground() {
        backgroundedAt = Date()
    }

    @objc private func willEnterForeground() {
        let away = backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
        Task {
            if await push() { return }
            // Sin canal directo con la página solo se recarga tras un buen rato fuera
            if away >= 600 || !onArtifact { await reload() }
        }
    }

    @objc private func pulled() {
        Task {
            if !(await push()) { await reload() }
            webView.scrollView.refreshControl?.endRefreshing()
        }
    }

    private var onArtifact: Bool {
        guard let url = webView.url else { return false }
        return url.host == "claude.ai" && url.path.hasPrefix(Self.artifactURL.path)
    }

    /// Manda la lectura de Salud a la página abierta. Devuelve false si la página no ha avisado que está lista.
    @MainActor
    private func push() async -> Bool {
        guard let frame = pageFrame else { return false }
        guard let anchor = HealthReader.anchor(await HealthReader.shared.readings()) else { return true }
        webView.evaluateJavaScript("window.__coachReceive && window.__coachReceive('\(anchor)')", in: frame, in: .page) { [weak self] result in
            if case .failure = result { self?.pageFrame = nil }
        }
        return true
    }

    @MainActor
    private func reload() async {
        guard !reloading else { return }
        reloading = true
        defer { reloading = false }

        let anchor = HealthReader.anchor(await HealthReader.shared.readings())
        if onArtifact, let anchor {
            // Cambiar solo el ancla no recarga la página; se cambia y se recarga para que la lea al arrancar
            webView.evaluateJavaScript("history.replaceState(null, '', '#\(anchor)'); location.reload();", completionHandler: nil)
        } else {
            var parts = URLComponents(url: Self.artifactURL, resolvingAgainstBaseURL: false)!
            parts.fragment = anchor
            webView.load(URLRequest(url: parts.url ?? Self.artifactURL))
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "coachHealth", (message.body as? String) == "ready" else { return }
        pageFrame = message.frameInfo
        Task { _ = await push() }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === self.webView { pageFrame = nil }
    }

    // MARK: - Navegación

    private static let internalHosts = ["claude.ai", "anthropic.com", "claudeusercontent.com", "apple.com", "icloud.com", "google.com", "gstatic.com", "googleusercontent.com"]

    private static func isInternal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return true }
        return internalHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if !["http", "https", "about", "blob", "data"].contains(scheme) {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        if navigationAction.navigationType == .linkActivated, navigationAction.targetFrame?.isMainFrame == true, !Self.isInternal(url) {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    private func showOffline(_ error: Error) {
        let code = (error as NSError).code
        guard code != NSURLErrorCancelled, code != 102 else { return }
        let html = """
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font:17px -apple-system;display:grid;place-items:center;height:90vh;margin:0;text-align:center;color:#555">
        <div><p>No hay conexión con Claude.</p><p><a href="\(Self.artifactURL.absoluteString)" style="color:#2f5bea">Reintentar</a></p></div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - Ventanas (inicio de sesión) y avisos de la página

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.host != nil, !Self.isInternal(url) {
            UIApplication.shared.open(url)
            return nil
        }
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        let controller = UIViewController()
        controller.view = child
        present(controller, animated: true)
        popup = controller
        return child
    }

    func webViewDidClose(_ webView: WKWebView) {
        guard webView !== self.webView else { return }
        popup?.dismiss(animated: true)
        popup = nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topController.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completionHandler(true) })
        topController.present(alert, animated: true)
    }

    private var topController: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        return top
    }
}

/// Evita que el controlador de mensajes retenga a la pantalla (WKUserContentController lo retiene fuerte).
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
