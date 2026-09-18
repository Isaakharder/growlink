import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const listEquipment = vi.fn();
const lookupEquipmentByQrToken = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, listEquipment: (...a: unknown[]) => listEquipment(...a), lookupEquipmentByQrToken: (...a: unknown[]) => lookupEquipmentByQrToken(...a) };
});

import { QrScannerSheet } from "../QrScannerSheet";
import { MaintenanceApiError } from "../api";

const EQUIPMENT = { id: "eq-1", name: "Boom Sprayer", asset_code: "SPRAY-001" };

describe("QrScannerSheet", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
