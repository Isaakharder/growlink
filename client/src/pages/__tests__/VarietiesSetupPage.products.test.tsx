import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Setup → Varieties with Bell Peppers and Cucumbers enabled: the variety's
// product comes from the organization's enabled products; Bell Peppers need a
// colour, Cucumbers have none (no placeholder is stored or shown).
type Call = { path: string; method: string; body?: string };
const calls: Call[] = [];

const PRODUCTS = [
  { code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active" },
  { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active" }
];
const VARIETIES = [
  { id: "v-cad", name: "Cadalora", area_m2: 1000, case_kg: 5, planting_date: null, pull_out_date: null, status: "active", color: "red", product_code: "bell_pepper", created_at: "", updated_at: "" },
  { id: "v-bon", name: "Bonbon", area_m2: 400, case_kg: 12, planting_date: null, pull_out_date: null, status: "active", color: null, product_code: "cucumber", created_at: "", updated_at: "" }
];

vi.mock("../../lib/api", () => ({
  apiUrl: (path: string) => path,
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    let body: unknown = [];
    if (method === "GET" && path === "/api/products") body = { products: PRODUCTS, available: [] };
    else if (method === "GET" && path === "/api/varieties") body = VARIETIES;
    else if (method !== "GET") body = {};
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }
}));

import { VarietiesSetupPage } from "../VarietiesSetupPage";

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => vi.clearAllMocks());

const saves = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/varieties"));
const varietyTable = () => screen.getByRole("heading", { name: "Existing Varieties" }).parentElement!.querySelector("table")!;

async function openAdd() {
  const user = userEvent.setup();
  render(<VarietiesSetupPage />);
  await screen.findByRole("cell", { name: "Bonbon" });
  await user.click(screen.getByRole("button", { name: "+ Add Variety" }));
  const dialog = await screen.findByRole("dialog", { name: "Add Variety" });
  return { user, dialog };
}

describe("Varieties Setup — products", () => {
  it("lists each variety's product; a cucumber shows no colour, never a placeholder", async () => {
    render(<VarietiesSetupPage />);
    await screen.findByRole("cell", { name: "Bonbon" });
    const rows = Array.from(varietyTable().querySelectorAll("tbody tr")).map((row) =>
      Array.from(row.querySelectorAll("td")).slice(0, 3).map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ["Cadalora", "Bell Peppers", "Red"],
      ["Bonbon", "Cucumbers", "—"]
    ]);
  });

  it("a new variety picks from the enabled products and starts on Bell Peppers with a colour", async () => {
    const { dialog } = await openAdd();
    const product = within(dialog).getByLabelText("Product") as HTMLSelectElement;
    expect(within(product).getAllByRole("option").map((o) => o.textContent)).toEqual(["Bell Peppers", "Cucumbers"]);
    expect(product).toHaveValue("bell_pepper");
    expect(within(dialog).getByLabelText("Color")).toBeInTheDocument();
  });

  it("choosing Cucumbers hides the colour and saves the variety with none", async () => {
    const { user, dialog } = await openAdd();
    await user.type(within(dialog).getByLabelText("Variety name"), "Proloog");
    await user.selectOptions(within(dialog).getByLabelText("Product"), "cucumber");
    expect(within(dialog).queryByLabelText("Color")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save variety" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].method).toBe("POST");
    expect(JSON.parse(saves()[0].body!)).toMatchObject({ name: "Proloog", product_code: "cucumber", color: null });
  });

  it("a Bell Pepper variety is saved with its product and colour, as before", async () => {
    const { user, dialog } = await openAdd();
    await user.type(within(dialog).getByLabelText("Variety name"), "Sunny");
    await user.selectOptions(within(dialog).getByLabelText("Color"), "yellow");
    await user.click(within(dialog).getByRole("button", { name: "Save variety" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(JSON.parse(saves()[0].body!)).toMatchObject({ name: "Sunny", product_code: "bell_pepper", color: "yellow" });
  });

  it("editing a cucumber variety keeps it colourless", async () => {
    const user = userEvent.setup();
    render(<VarietiesSetupPage />);
    const row = (await screen.findByRole("cell", { name: "Bonbon" })).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Variety" });
    expect(within(dialog).getByLabelText("Product")).toHaveValue("cucumber");
    expect(within(dialog).queryByLabelText("Color")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save variety" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ path: "/api/varieties/v-bon", method: "PUT" });
    expect(JSON.parse(saves()[0].body!)).toMatchObject({ product_code: "cucumber", color: null });
  });
});
