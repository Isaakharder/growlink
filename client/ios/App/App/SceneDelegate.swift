import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()

        // Overscroll/background fix — the UIWindow fallback half. Kept
        // deliberately minimal: CAPBridgeViewController.loadView() does
        // `view = webView` (see @capacitor/ios's
        // CAPBridgeViewController.swift), so the view controller's own
        // .view IS the WKWebView — there is no separate container view
        // here to also color; capacitor.config.ts's top-level
        // backgroundColor already covers it (and its scrollView). What
        // capacitor.config.ts genuinely cannot reach is this UIWindow
        // itself, a real distinct layer one level further out — set here
        // as a fallback in case anything is ever briefly visible behind
        // both the webview and (for the status-bar strip specifically)
        // @capacitor/status-bar's own background view, whose color is
        // set separately via capacitor.config.ts's plugins.StatusBar
        // .backgroundColor. #f7f9f8 matches GrowLink Mobile's page
        // background exactly (.mobile-layout / :root in src/index.css) —
        // not a separately invented colour.
        window?.backgroundColor = UIColor(red: 0xF7 / 255.0, green: 0xF9 / 255.0, blue: 0xF8 / 255.0, alpha: 1.0)

        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
