import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Setup → Varieties organized by crop: a Crop dropdown of the organization's
// enabled crops filters Existing Varieties and Yield Sizes, and Add Variety /
// Add Size join the selected crop. Bell Peppers need a colour, Cucumbers have
// none (no placeholder is stored or shown). Each crop has its own sizes, so
// the same size name can appear under both.
type Call = { path: string; method: string; body?: string };
const calls: Call[] = [];
const state = vi.hoisted(() => ({ products: [] as unknown[], deleteFails: false }));

const PRODUCTS = [
  { code: "bell_pepper", name: "Bell Peppers", tracksColour: true, tracksSizes: true, status: "active" },
  { code: "cucumber", name: "Cucumbers", tracksColour: false, tracksSizes: false, status: "active" }
];
const VARIETIES = [
  { id: "v-cad", name: "Cadalora", area_m2: 1000, case_kg: 5, planting_date: null, pull_out_date: null, status: "active", color: "red", product_code: "bell_pepper", created_at: "", updated_at: "" },
  { id: "v-bon", name: "Bonbon", area_m2: 400, case_kg: 12, planting_date: null, pull_out_date: null, status: "active", color: null, product_code: "cucumber", created_at: "", updated_at: "" }
];
const SIZES = [
  { id: "s-xl", name: "XL", sort_order: 2, status: "active", product_code: "bell_pepper", created_at: "", updated_at: "" },
  { id: "s-lg", name: "Large", sort_order: 1, status: "active", product_code: "bell_pepper", created_at: "", updated_at: "" },
  { id: "c-st", name: "Straight", sort_order: 2, status: "active", product_code: "cucumber", created_at: "", updated_at: "" },
  { id: "c-lg", name: "Large", sort_order: 1, status: "inactive", product_code: "cucumber", created_at: "", updated_at: "" }
];

vi.mock("../../lib/api", () => ({
  apiUrl: (path: string) => path,
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, body: options.body });
    let body: unknown = [];
    let ok = true;
    if (method === "GET" && path === "/api/products") body = { products: state.products, available: [] };
    else if (method === "GET" && path === "/api/varieties") body = VARIETIES;
    else if (method === "GET" && path === "/api/yield-sizes") body = SIZES;
    else if (method === "DELETE" && path.startsWith("/api/yield-sizes/") && state.deleteFails) {
      ok = false;
      body = { message: "This size is on recorded harvests. Set it to Inactive to retire it; its history stays readable." };
    } else if (method !== "GET") body = {};
    return Promise.resolve({ ok, status: ok ? 200 : 409, json: async () => body });
  }
}));

import { VarietiesSetupPage } from "../VarietiesSetupPage";

beforeEach(() => {
  calls.length = 0;
  state.products = PRODUCTS;
  state.deleteFails = false;
});
afterEach(() => vi.clearAllMocks());

const saves = (prefix = "/api/varieties") => calls.filter((c) => c.method !== "GET" && c.path.startsWith(prefix));
const tableUnder = (heading: string) => screen.getByRole("heading", { name: heading }).parentElement!.querySelector("table");
const rowsOf = (table: Element | null, cells = 2) =>
  Array.from(table?.querySelectorAll("tbody tr") ?? []).map((row) =>
    Array.from(row.querySelectorAll("td")).slice(0, cells).map((cell) => cell.textContent)
  );
const cropPicker = () => screen.getByLabelText("Crop") as HTMLSelectElement;

async function renderPage() {
  const user = userEvent.setup();
  render(<VarietiesSetupPage />);
  await screen.findByRole("cell", { name: "Cadalora" });
  return user;
}

async function chooseCrop(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.selectOptions(cropPicker(), code);
}

describe("Varieties Setup — organized by crop", () => {
  it("lists the enabled crops and opens on Bell Peppers: only its varieties and its sizes, in sort order", async () => {
    await renderPage();
    // Now under Crop Planner → Varieties; the page itself is unchanged.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Varieties$/);
    expect(within(cropPicker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Bell Peppers", "Cucumbers"]);
    expect(cropPicker()).toHaveValue("bell_pepper");
    expect(rowsOf(tableUnder("Existing Varieties"))).toEqual([["Cadalora", "Red"]]);
    expect(rowsOf(tableUnder("Yield Sizes"), 3)).toEqual([
      ["Large", "1", "Active"],
      ["XL", "2", "Active"]
    ]);
  });

  it("Cucumbers shows its own varieties (no colour column) and its own sizes, including the same name as a pepper size", async () => {
    const user = await renderPage();
    await chooseCrop(user, "cucumber");
    const varieties = tableUnder("Existing Varieties")!;
    expect(Array.from(varieties.querySelectorAll("th")).map((th) => th.textContent)).not.toContain("Color");
    expect(rowsOf(varieties, 1)).toEqual([["Bonbon"]]);
    expect(rowsOf(tableUnder("Yield Sizes"), 3)).toEqual([
      ["Large", "1", "Inactive"],
      ["Straight", "2", "Active"]
    ]);
  });

  it("Add Variety joins the selected crop: a cucumber variety is saved with no colour", async () => {
    const user = await renderPage();
    await chooseCrop(user, "cucumber");
    await user.click(screen.getByRole("button", { name: "+ Add Variety" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Variety" });
    expect(within(dialog).getByText("Cucumbers")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Crop")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Color")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Variety name"), "Proloog");
    await user.click(within(dialog).getByRole("button", { name: "Save variety" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].method).toBe("POST");
    expect(JSON.parse(saves()[0].body!)).toMatchObject({ name: "Proloog", product_code: "cucumber", color: null });
  });

  it("a Bell Pepper variety is saved with its crop and colour, as before", async () => {
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "+ Add Variety" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Variety" });
    expect(within(dialog).getByText("Bell Peppers")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Variety name"), "Sunny");
    await user.selectOptions(within(dialog).getByLabelText("Color"), "yellow");
    await user.click(within(dialog).getByRole("button", { name: "Save variety" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(JSON.parse(saves()[0].body!)).toMatchObject({ name: "Sunny", product_code: "bell_pepper", color: "yellow" });
  });

  it("Add Size joins the selected crop", async () => {
    const user = await renderPage();
    await chooseCrop(user, "cucumber");
    await user.click(screen.getByRole("button", { name: "+ Add Size" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Size" });
    expect(within(dialog).getByText("Cucumbers")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Size name"), "XL");
    await user.clear(within(dialog).getByLabelText("Sort order"));
    await user.type(within(dialog).getByLabelText("Sort order"), "3");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves("/api/yield-sizes")).toHaveLength(1));
    expect(saves("/api/yield-sizes")[0].method).toBe("POST");
    expect(JSON.parse(saves("/api/yield-sizes")[0].body!)).toEqual({ name: "XL", sort_order: 3, status: "active", product_code: "cucumber" });
  });

  it("editing a size keeps its crop", async () => {
    const user = await renderPage();
    const row = screen.getByRole("cell", { name: "XL" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Size" });
    expect(within(dialog).getByText("Bell Peppers")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves("/api/yield-sizes")).toHaveLength(1));
    expect(saves("/api/yield-sizes")[0]).toMatchObject({ path: "/api/yield-sizes/s-xl", method: "PUT" });
    expect(JSON.parse(saves("/api/yield-sizes")[0].body!)).toMatchObject({ product_code: "bell_pepper" });
  });

  it("a size on recorded harvests can't be deleted: the page says to retire it", async () => {
    state.deleteFails = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = await renderPage();
    const row = screen.getByRole("cell", { name: "XL" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Set it to Inactive to retire it/)).toBeInTheDocument();
  });

  it("editing a cucumber variety keeps it colourless", async () => {
    const user = await renderPage();
    await chooseCrop(user, "cucumber");
    const row = screen.getByRole("cell", { name: "Bonbon" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Variety" });
    expect(within(dialog).getByLabelText("Crop")).toHaveValue("cucumber");
    expect(within(dialog).queryByLabelText("Color")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save variety" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toMatchObject({ path: "/api/varieties/v-bon", method: "PUT" });
    expect(JSON.parse(saves()[0].body!)).toMatchObject({ product_code: "cucumber", color: null });
  });

  it("a crop turned off with varieties left stays reachable", async () => {
    state.products = [PRODUCTS[0], { ...PRODUCTS[1], status: "inactive" }];
    await renderPage();
    expect(within(cropPicker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Bell Peppers", "Cucumbers (turned off)"]);
  });
});
