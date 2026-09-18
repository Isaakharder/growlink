import { Capacitor } from "@capacitor/core";

// Toggles a body class while the keyboard is open so layout (e.g. the
// bottom nav in MobileLayout) can get out of the keyboard's way via CSS
// alone, rather than every form screen wiring its own keyboard listener.
export async function configureKeyboardHandling(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    Keyboard.addListener("keyboardWillShow", () => {
      document.body.classList.add("keyboard-open");
    });
    Keyboard.addListener("keyboardWillHide", () => {
      document.body.classList.remove("keyboard-open");
    });
  } catch {
    // Non-fatal: forms remain usable without the body-class hook.
  }
}
