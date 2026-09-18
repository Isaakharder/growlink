import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const listEquipment = vi.fn();
const lookupEquipmentByQrToken = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, listEquipment: (...a: unknown[]) => listEquipment(...a), lookupEquipmentByQrToken: (...a: unknown[]) => lookupEquipmentByQrToken(...a) };
});

// Toggled per test — false (the jsdom default, matching what
// Capacitor.isNativePlatform() actually returns outside a native shell)
// for every existing web-path test below; the native-path describe block
// flips it on to exercise QrScannerSheet's ML Kit branch instead.
// vi.hoisted (not a plain top-level `let`) because supabase.ts calls
// Capacitor.isNativePlatform() at MODULE LOAD time (see
// lib/nativeAuthStorage.ts) — a plain `let` would still be in its
// temporal dead zone when vi.mock's hoisted factory runs.
const nativeState = vi.hoisted(() => ({ isNative: false }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => nativeState.isNative } }));

const checkPermissions = vi.fn();
const requestPermissions = vi.fn();
const isSupported = vi.fn();
const scan = vi.fn();
vi.mock("@capacitor-mlkit/barcode-scanning", () => ({
  BarcodeScanner: {
    checkPermissions: (...a: unknown[]) => checkPermissions(...a),
    requestPermissions: (...a: unknown[]) => requestPermissions(...a),
    isSupported: (...a: unknown[]) => isSupported(...a),
    scan: (...a: unknown[]) => scan(...a)
  },
  BarcodeFormat: { QrCode: "QR_CODE" }
}));

import { QrScannerSheet } from "../QrScannerSheet";
import { MaintenanceApiError } from "../api";

const EQUIPMENT = { id: "eq-1", name: "Boom Sprayer", asset_code: "SPRAY-001" };

describe("QrScannerSheet", () => {
  afterEach(() => {
    vi.clearAllMocks();
    nativeState.isNative = false;
    // @ts-expect-error -- test cleanup of a property tests may have defined
    delete navigator.mediaDevices;
  });

  it("falls back to manual entry with a clear message when the camera API is unsupported", async () => {
    // jsdom has no navigator.mediaDevices by default -- this is the
    // "camera unavailable" branch, not "denied".
    const onMatch = vi.fn();
    render(<QrScannerSheet onClose={vi.fn()} onMatch={onMatch} />);

    expect(await screen.findByText(/camera scanning isn't available/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the code manually/i)).toBeInTheDocument();
  });

  it("shows a denied-permission message and still offers manual entry when getUserMedia rejects with NotAllowedError", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) }
    });
    render(<QrScannerSheet onClose={vi.fn()} onMatch={vi.fn()} />);

    expect(await screen.findByText(/camera access was denied/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter code manually instead/i })).toBeInTheDocument();
  });

  it("manual entry: a single matching asset code resolves directly to onMatch", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} }); // no getUserMedia -> unsupported, straight to manual is also reachable via toggle
    const onMatch = vi.fn();
    render(<QrScannerSheet onClose={vi.fn()} onMatch={onMatch} />);

    await userEvent.click(await screen.findByRole("button", { name: /enter code manually/i }));
    listEquipment.mockResolvedValueOnce([EQUIPMENT]);

    await userEvent.type(screen.getByLabelText(/asset code or equipment name/i), "SPRAY-001");
    await userEvent.click(screen.getByRole("button", { name: "Find Equipment" }));

    await waitFor(() => expect(onMatch).toHaveBeenCalledWith(EQUIPMENT));
    expect(listEquipment).toHaveBeenCalledWith({ search: "SPRAY-001" });
  });

  it("manual entry: an unknown code shows a clear not-found message, same wording as a cross-org code would produce", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    render(<QrScannerSheet onClose={vi.fn()} onMatch={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /enter code manually/i }));
    listEquipment.mockResolvedValueOnce([]);

    await userEvent.type(screen.getByLabelText(/asset code or equipment name/i), "NOPE-999");
    await userEvent.click(screen.getByRole("button", { name: "Find Equipment" }));

    expect(await screen.findByText("No equipment found for this code.")).toBeInTheDocument();
  });

  it("manual entry: a UUID-shaped value tries the exact token lookup first, falling back to search only on 404", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    const onMatch = vi.fn();
    render(<QrScannerSheet onClose={vi.fn()} onMatch={onMatch} />);

    await userEvent.click(await screen.findByRole("button", { name: /enter code manually/i }));
    lookupEquipmentByQrToken.mockResolvedValueOnce(EQUIPMENT);

    await userEvent.type(screen.getByLabelText(/asset code or equipment name/i), "3fa85f64-5717-4562-b3fc-2c963f66afa6");
    await userEvent.click(screen.getByRole("button", { name: "Find Equipment" }));

    await waitFor(() => expect(onMatch).toHaveBeenCalledWith(EQUIPMENT));
    expect(listEquipment).not.toHaveBeenCalled();
  });

  it("manual entry: a cross-org or unknown QR token (404 from the token endpoint) is rejected safely, same as any unknown code", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    render(<QrScannerSheet onClose={vi.fn()} onMatch={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /enter code manually/i }));
    lookupEquipmentByQrToken.mockRejectedValueOnce(new MaintenanceApiError(404, "Equipment not found."));
    listEquipment.mockResolvedValueOnce([]);

    await userEvent.type(screen.getByLabelText(/asset code or equipment name/i), "3fa85f64-5717-4562-b3fc-2c963f66afa6");
    await userEvent.click(screen.getByRole("button", { name: "Find Equipment" }));

    expect(await screen.findByText("No equipment found for this code.")).toBeInTheDocument();
  });
});

describe("QrScannerSheet — native iOS (ML Kit) scan path", () => {
  afterEach(() => {
    vi.clearAllMocks();
    nativeState.isNative = false;
  });

  it("a successful native scan resolves through the SAME org-scoped lookupEquipmentByQrToken as the web path", async () => {
    nativeState.isNative = true;
    checkPermissions.mockResolvedValue({ camera: "granted" });
    isSupported.mockResolvedValue({ supported: true });
    scan.mockResolvedValue({ barcodes: [{ displayValue: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }] });
    lookupEquipmentByQrToken.mockResolvedValueOnce(EQUIPMENT);
    const onMatch = vi.fn();

    render(<QrScannerSheet onClose={vi.fn()} onMatch={onMatch} />);

    await waitFor(() => expect(onMatch).toHaveBeenCalledWith(EQUIPMENT));
    expect(lookupEquipmentByQrToken).toHaveBeenCalledWith("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    // Never falls back to the web camera/getUserMedia path.
    expect(scan).toHaveBeenCalledWith({ formats: ["QR_CODE"] });
  });

  it("a native scan of a cross-org or unknown code is rejected safely, same as the web path", async () => {
    nativeState.isNative = true;
    checkPermissions.mockResolvedValue({ camera: "granted" });
    isSupported.mockResolvedValue({ supported: true });
    scan.mockResolvedValue({ barcodes: [{ displayValue: "9c858901-8a57-4791-81fe-4c455b099bc9" }] });
    lookupEquipmentByQrToken.mockRejectedValueOnce(new MaintenanceApiError(404, "Equipment not found."));

    render(<QrScannerSheet onClose={vi.fn()} onMatch={vi.fn()} />);

    expect(await screen.findByText("No equipment found for this code.")).toBeInTheDocument();
  });

  it("requests permission when not yet granted, and shows the denied message if the user declines", async () => {
    nativeState.isNative = true;
    checkPermissions.mockResolvedValue({ camera: "denied" });
    requestPermissions.mockResolvedValue({ camera: "denied" });

    render(<QrScannerSheet onClose={vi.fn()} onMatch={vi.fn()} />);

    expect(await screen.findByText(/camera access was denied/i)).toBeInTheDocument();
    expect(requestPermissions).toHaveBeenCalled();
  });

  it("closes the sheet when the user cancels the native scanner (no barcodes returned) instead of showing an error", async () => {
    nativeState.isNative = true;
    checkPermissions.mockResolvedValue({ camera: "granted" });
    isSupported.mockResolvedValue({ supported: true });
    scan.mockResolvedValue({ barcodes: [] });
    const onClose = vi.fn();

    render(<QrScannerSheet onClose={onClose} onMatch={vi.fn()} />);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
