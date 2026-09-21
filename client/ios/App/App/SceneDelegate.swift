import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()

        // Overscroll/background fix (paired with capacitor.config.ts's
        // backgroundColor): Capacitor's own backgroundColor config sets the
        // WKWebView and its scrollView, but not this window or the root
        // view controller's own view — see CAPBridgeViewController.swift's
        // prepareWebView. Left unset, whichever of these is briefly
        // revealed during a rubber-band overscroll past the top/bottom (or
        // behind the status bar / home indicator safe areas) defaults to
        // black. #f7f9f8 matches GrowLink Mobile's page background exactly
        // (.mobile-layout / :root in src/index.css) — not a separately
        // invented colour.
        let mobileBackground = UIColor(red: 0xF7 / 255.0, green: 0xF9 / 255.0, blue: 0xF8 / 255.0, alpha: 1.0)
        window?.backgroundColor = mobileBackground
        window?.rootViewController?.view.backgroundColor = mobileBackground

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
