import UIKit
import WebKit

/// Muestra la app web a pantalla completa, dibujada también detrás de la hora y la batería.
/// La hora y la batería cambian solas a negro (modo claro) o blanco (modo oscuro).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private static let appURL = URL(string: "https://d8j4yc4v75-lgtm.github.io/whatsapp/")!

    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // conserva los chats (localStorage) entre aperturas
        config.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        // La página maneja los márgenes con env(safe-area-inset-*); sin esto iOS la empujaría hacia abajo.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: Self.appURL))
    }

    // Hora y batería en negro sobre fondo claro y en blanco sobre fondo oscuro.
    override var preferredStatusBarStyle: UIStatusBarStyle { .default }
    override var prefersHomeIndicatorAutoHidden: Bool { false }

    // Enlaces que abren otra pestaña (por ejemplo «Ver perfil»): se abren en Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // Todo lo que no sea la propia app (otros sitios, tel:, mailto:) se abre fuera.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        let isApp = url.host == Self.appURL.host && url.path.hasPrefix(Self.appURL.path)
        if navigationAction.navigationType == .linkActivated && !isApp {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        if let scheme = url.scheme, !["http", "https", "about", "blob", "data"].contains(scheme) {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // Sin internet: aviso sencillo con opción de reintentar.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let alert = UIAlertController(title: "Sin conexión",
                                      message: "No se pudo abrir la app. Revisa tu internet.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Reintentar", style: .default) { [weak self] _ in
            self?.webView.load(URLRequest(url: Self.appURL))
        })
        present(alert, animated: true)
    }

    // Diálogos de la página (alert/confirm), por si se usan.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
