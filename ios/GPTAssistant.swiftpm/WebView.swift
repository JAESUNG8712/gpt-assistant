import SwiftUI
@preconcurrency import WebKit

/// GPT Assistant 웹앱(FastAPI + Turso, Render 배포)을 감싸는 얇은 네이티브 셸.
/// 실제 채팅·페르소나·예산관리 기능은 전부 서버에서 그대로 제공되고,
/// 이 뷰는 WKWebView + 로딩/에러 상태 표시만 담당한다.
struct WebView: UIViewRepresentable {
    let url: URL
    @Binding var isLoading: Bool
    @Binding var loadError: String?
    @Binding var reloadTrigger: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // 채팅 스트리밍 응답이 즉시 화면에 반영되도록 인라인 미디어 재생 등 기본값 유지
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        // 웹앱 자체가 반응형 UI이므로 기본 확대/축소는 막아 네이티브 앱처럼 보이게 함
        webView.scrollView.bounces = true

        // 당겨서 새로고침 — Render 콜드스타트 후 재시도 용도로 유용
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.handleRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        context.coordinator.webView = webView
        webView.load(URLRequest(url: url, timeoutInterval: 30))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastReloadTrigger != reloadTrigger {
            context.coordinator.lastReloadTrigger = reloadTrigger
            isLoading = true
            loadError = nil
            webView.load(URLRequest(url: url, timeoutInterval: 30))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let parent: WebView
        weak var webView: WKWebView?
        var lastReloadTrigger = 0

        init(_ parent: WebView) {
            self.parent = parent
        }

        @objc func handleRefresh() {
            webView?.reload()
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.isLoading = true
            parent.loadError = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
            webView.scrollView.refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            finishWithError(error, webView: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            finishWithError(error, webView: webView)
        }

        private func finishWithError(_ error: Error, webView: WKWebView) {
            parent.isLoading = false
            webView.scrollView.refreshControl?.endRefreshing()
            let nsError = error as NSError
            // 네비게이션 취소(사용자가 다른 링크로 이동 등)는 실제 오류가 아니므로 무시
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                return
            }
            // Render 무료 티어는 15분 비활성 후 절전 — 첫 접속 시 콜드스타트로
            // 타임아웃/연결거부가 흔히 발생하므로 사용자에게 자연스럽게 안내
            parent.loadError = "서버에 연결하지 못했습니다.\n서버가 대기 상태에서 깨어나는 중일 수 있습니다 (최대 1분). 아래에서 다시 시도해 주세요."
        }

        // target="_blank" 링크(예: 참고자료 출처 링크)도 같은 웹뷰에서 열리도록 처리
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
        }
    }
}
