import { FormEvent, useEffect, useState } from "react";
import { apiFetch, apiUrl } from "../lib/api";
import { ModalOverlay } from "../components/ModalOverlay";

type VarietyStatus = "active" | "inactive";
type VarietyColor = "red" | "orange" | "yellow" | "green";
type YieldSizeStatus = "active" | "inactive";

type Variety = {
  id: string;
  name: string;
  area_m2: number;
  case_kg: number;
  planting_date: string | null;
  pull_out_date: string | null;
  status: VarietyStatus;
  /** Null for a product that doesn't track colour (Cucumbers). */
  color: VarietyColor | null;
  product_code: string;
  created_at: string;
  updated_at: string;
};

/** An enabled product from Setup → Products. */
type ProductOption = {
  code: string;
  name: string;
  tracksColour: boolean;
  status: "active" | "inactive";
};

type VarietyFormState = {
  name: string;
  area_m2: string;
  case_kg: string;
  planting_date: string;
  pull_out_date: string;
  status: VarietyStatus;
  color: VarietyColor;
  product_code: string;
};

type YieldSize = {
  id: string;
  name: string;
  sort_order: number;
  status: YieldSizeStatus;
  /** The crop the size belongs to (migration 0152); absent from a server before it, where every size is Bell Peppers. */
  product_code?: string;
  created_at: string;
  updated_at: string;
};

type YieldSizeFormState = {
  name: string;
  sort_order: string;
  status: YieldSizeStatus;
};

const API_BASE = apiUrl("/api/varieties");
const YIELD_SIZES_API_BASE = apiUrl("/api/yield-sizes");
const PRODUCTS_API_BASE = apiUrl("/api/products");

const INITIAL_FORM: VarietyFormState = {
  name: "",
  area_m2: "0",
  case_kg: "0",
  planting_date: "",
  pull_out_date: "",
  status: "active",
  color: "red",
  product_code: ""
};

const INITIAL_SIZE_FORM: YieldSizeFormState = {
  name: "",
  sort_order: "0",
  status: "active"
};

function toFormState(variety: Variety): VarietyFormState {
  return {
    name: variety.name,
    area_m2: String(variety.area_m2),
    case_kg: String(variety.case_kg),
    planting_date: variety.planting_date ?? "",
    pull_out_date: variety.pull_out_date ?? "",
    status: variety.status,
    // A colourless variety moved to Bell Peppers starts from the usual default.
    color: variety.color ?? "red",
    product_code: variety.product_code
  };
}

// A variety of a product without colours (Cucumbers) is saved with none.
function toPayload(form: VarietyFormState, product: ProductOption | undefined) {
  return {
    name: form.name.trim(),
    area_m2: Number(form.area_m2),
    case_kg: Number(form.case_kg),
    planting_date: form.planting_date || null,
    pull_out_date: form.pull_out_date || null,
    status: form.status,
    product_code: form.product_code,
    color: product?.tracksColour === false ? null : form.color
  };
}

function colorLabel(color: VarietyColor) {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

function toSizeFormState(size: YieldSize): YieldSizeFormState {
  return {
    name: size.name,
    sort_order: String(size.sort_order),
    status: size.status
  };
}

function toSizePayload(form: YieldSizeFormState, productCode: string) {
  return {
    name: form.name.trim(),
    sort_order: Number(form.sort_order),
    status: form.status,
    product_code: productCode
  };
}

/** A size's crop: a size from a server before per-crop sizes is a Bell Peppers size. */
const sizeCrop = (size: YieldSize) => size.product_code ?? "bell_pepper";

/** The server's message for a failed request, or the fallback. */
async function responseMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

export function VarietiesSetupPage() {
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [sizes, setSizes] = useState<YieldSize[]>([]);
  const [loading, setLoading] = useState(true);
  const [sizesLoading, setSizesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sizeSaving, setSizeSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sizesError, setSizesError] = useState<string | null>(null);
  const [form, setForm] = useState<VarietyFormState>(INITIAL_FORM);
  const [sizeForm, setSizeForm] = useState<YieldSizeFormState>(INITIAL_SIZE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSizeId, setEditingSizeId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSizeModalOpen, setIsSizeModalOpen] = useState(false);
  // The crop both lists show and new varieties and sizes are added to.
  const [selectedCropCode, setSelectedCropCode] = useState("");

  async function fetchVarieties() {
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(API_BASE);
      if (!res.ok) {
        throw new Error("Failed to fetch");
      }

      const data = (await res.json()) as Variety[];
      setVarieties(data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  async function fetchSizes() {
    setSizesLoading(true);
    setSizesError(null);

    try {
      const response = await apiFetch(YIELD_SIZES_API_BASE);
      if (!response.ok) {
        throw new Error("Failed to fetch sizes");
      }

      const data = (await response.json()) as YieldSize[];
      setSizes(data);
    } catch (fetchError) {
      setSizesError(
        fetchError instanceof Error ? fetchError.message : "Failed to fetch sizes"
      );
    } finally {
      setSizesLoading(false);
    }
  }

  useEffect(() => {
    void fetchVarieties();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchProducts() {
      try {
        const response = await apiFetch(PRODUCTS_API_BASE);
        if (!response.ok) throw new Error("Failed to load products");
        const data = (await response.json()) as { products?: ProductOption[] };
        if (!cancelled) setProducts(data.products ?? []);
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "Failed to load products");
      }
    }
    void fetchProducts();
    return () => {
      cancelled = true;
    };
  }, []);

  const productByCode = new Map(products.map((product) => [product.code, product]));
  const selectedProduct = productByCode.get(form.product_code);
  // New varieties go to a product the organization is using; an existing
  // variety also lists its own product, even if that is turned off.
  const productChoices = products.filter(
    (product) => product.status === "active" || product.code === form.product_code
  );
  const defaultProductCode =
    products.find((product) => product.code === "bell_pepper" && product.status === "active")?.code ??
    products.find((product) => product.status === "active")?.code ??
    "";

  // Crops to choose from: those enabled for the organization, plus a crop
  // that was turned off but still has varieties or sizes, so they stay
  // reachable.
  const cropChoices = products.filter(
    (product) =>
      product.status === "active" ||
      varieties.some((variety) => variety.product_code === product.code) ||
      sizes.some((size) => sizeCrop(size) === product.code)
  );
  const cropCode = cropChoices.some((crop) => crop.code === selectedCropCode) ? selectedCropCode : defaultProductCode;
  const selectedCrop = productByCode.get(cropCode);
  const cropName = selectedCrop?.name ?? "this crop";
  const cropVarieties = cropCode ? varieties.filter((variety) => variety.product_code === cropCode) : varieties;
  const cropSizes = (cropCode ? sizes.filter((size) => sizeCrop(size) === cropCode) : sizes)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const showColour = selectedCrop?.tracksColour !== false;
  const editingSize = editingSizeId ? sizes.find((size) => size.id === editingSizeId) : undefined;
  const sizeModalCrop = productByCode.get(editingSize ? sizeCrop(editingSize) : cropCode);

  useEffect(() => {
    void fetchSizes();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = toPayload(form, selectedProduct);

    if (!payload.product_code) {
      setError("Choose a product for this variety.");
      return;
    }

    if (!payload.name) {
      setError("Variety name is required.");
      return;
    }

    if (payload.area_m2 < 0 || payload.case_kg < 0) {
      setError("Area and Case kg must be 0 or greater.");
      return;
    }

    setSaving(true);

    try {
      const method = editingId ? "PUT" : "POST";
      const url = editingId ? `${API_BASE}/${editingId}` : API_BASE;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `${editingId ? "Update" : "Create"} failed`;

        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore malformed error response and use fallback message.
        }

        throw new Error(message);
      }

      setIsModalOpen(false);
      setForm(INITIAL_FORM);
      setEditingId(null);
      await fetchVarieties();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save variety"
      );
    } finally {
      setSaving(false);
    }
  }

  function openAddModal() {
    setEditingId(null);
    setForm({ ...INITIAL_FORM, product_code: cropCode || defaultProductCode });
    setError(null);
    setIsModalOpen(true);
  }

  function beginEdit(variety: Variety) {
    setEditingId(variety.id);
    setForm(toFormState(variety));
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
    setError(null);
  }

  async function deleteVariety(id: string) {
    const confirmed = window.confirm("Delete this variety?");
    if (!confirmed) {
      return;
    }

    setError(null);

    try {
      const response = await apiFetch(`${API_BASE}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await responseMessage(response, `Delete failed (${response.status})`));
      }

      if (editingId === id) {
        closeModal();
      }

      await fetchVarieties();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete variety"
      );
    }
  }

  async function handleSizeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSizesError(null);

    // A new size joins the selected crop; an edited size keeps its own.
    const payload = toSizePayload(sizeForm, editingSize ? sizeCrop(editingSize) : cropCode);

    if (!payload.product_code) {
      setSizesError("Choose a crop for this size.");
      return;
    }

    if (!payload.name) {
      setSizesError("Size name is required.");
      return;
    }

    if (!Number.isInteger(payload.sort_order) || payload.sort_order < 0) {
      setSizesError("Sort order must be 0 or greater.");
      return;
    }

    setSizeSaving(true);

    try {
      const method = editingSizeId ? "PUT" : "POST";
      const url = editingSizeId
        ? `${YIELD_SIZES_API_BASE}/${editingSizeId}`
        : YIELD_SIZES_API_BASE;

      const response = await apiFetch(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `${editingSizeId ? "Update" : "Create"} failed`;

        try {
          const responseBody = (await response.json()) as { message?: string };
          if (responseBody.message) {
            message = responseBody.message;
          }
        } catch {
          // Ignore malformed error response and use fallback message.
        }

        throw new Error(message);
      }

      closeSizeModal();
      await fetchSizes();
    } catch (submitError) {
      setSizesError(
        submitError instanceof Error ? submitError.message : "Failed to save size"
      );
    } finally {
      setSizeSaving(false);
    }
  }

  function openAddSizeModal() {
    setEditingSizeId(null);
    setSizeForm(INITIAL_SIZE_FORM);
    setSizesError(null);
    setIsSizeModalOpen(true);
  }

  function beginEditSize(size: YieldSize) {
    setEditingSizeId(size.id);
    setSizeForm(toSizeFormState(size));
    setSizesError(null);
    setIsSizeModalOpen(true);
  }

  function closeSizeModal() {
    setIsSizeModalOpen(false);
    setEditingSizeId(null);
    setSizeForm(INITIAL_SIZE_FORM);
    setSizesError(null);
  }

  async function deleteSize(id: string) {
    const confirmed = window.confirm("Delete this size?");
    if (!confirmed) {
      return;
    }

    setSizesError(null);

    try {
      const response = await apiFetch(`${YIELD_SIZES_API_BASE}/${id}`, { method: "DELETE" });
      if (!response.ok) {
        // A size on recorded harvests is retired (Inactive) rather than deleted.
        throw new Error(await responseMessage(response, `Delete failed (${response.status})`));
      }

      if (editingSizeId === id) {
        closeSizeModal();
      }

      await fetchSizes();
    } catch (deleteError) {
      setSizesError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete size"
      );
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Varieties Setup</h1>
        <p>Manage crop varieties and baseline growing attributes.</p>
      </header>

      <div className="varieties-toolbar varieties-crop-toolbar">
        <label className="varieties-crop-picker">
          Crop
          <select value={cropCode} onChange={(event) => setSelectedCropCode(event.target.value)} disabled={cropChoices.length === 0}>
            {cropChoices.length === 0 ? <option value="">No crops enabled</option> : null}
            {cropChoices.map((crop) => (
              <option key={crop.code} value={crop.code}>
                {crop.status === "active" ? crop.name : `${crop.name} (turned off)`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={openAddModal}>
          + Add Variety
        </button>
      </div>

      <div className="coming-soon-card">
        <h2>Existing Varieties</h2>
        <p className="form-hint">{selectedCrop ? `${selectedCrop.name} varieties.` : "Every variety."}</p>

        {error ? <p className="form-error">{error}</p> : null}

        {loading ? <p>Loading...</p> : null}

        {!loading && cropVarieties.length === 0 ? <p>No {selectedCrop ? `${cropName} ` : ""}varieties added yet.</p> : null}

        {!loading && cropVarieties.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  {showColour ? <th>Color</th> : null}
                  <th>Area m²</th>
                  <th>Case kg</th>
                  <th>Planting date</th>
                  <th>Pull-out date</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cropVarieties.map((variety) => (
                  <tr key={variety.id}>
                    {(() => {
                      const color = variety.color;

                      return (
                        <>
                          <td>{variety.name}</td>
                          {showColour ? (
                          <td>
                            {color ? (
                              <span className={`color-badge ${color}`}>{colorLabel(color)}</span>
                            ) : (
                              <span className="form-hint" aria-label="No colour">—</span>
                            )}
                          </td>
                          ) : null}
                          <td>{variety.area_m2}</td>
                          <td>{variety.case_kg}</td>
                          <td>{variety.planting_date ?? "-"}</td>
                          <td>{variety.pull_out_date ?? "-"}</td>
                          <td>
                            <span
                              className={
                                variety.status === "active"
                                  ? "status-badge active"
                                  : "status-badge inactive"
                              }
                            >
                              {variety.status === "active" ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button type="button" onClick={() => beginEdit(variety)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => deleteVariety(variety.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </>
                      );
                    })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="varieties-toolbar">
        <button type="button" onClick={openAddSizeModal} disabled={!cropCode}>
          + Add Size
        </button>
      </div>

      <div className="coming-soon-card">
        <h2>Yield Sizes</h2>
        <p className="form-hint">
          {selectedCrop ? `${selectedCrop.name} sizes, in the order Manual Entry shows them. ` : ""}
          Each crop has its own sizes. Set a size to Inactive to retire it: it leaves Manual Entry, and the harvests that used it keep it.
        </p>

        {sizesError && !isSizeModalOpen ? <p className="form-error">{sizesError}</p> : null}

        {sizesLoading ? <p>Loading...</p> : null}

        {!sizesLoading && cropSizes.length === 0 ? (
          <p>
            {selectedCrop
              ? `No ${cropName} sizes yet. Without sizes, Manual Entry records each ${cropName} harvest as a single total.`
              : "No sizes added yet."}
          </p>
        ) : null}

        {!sizesLoading && cropSizes.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Sort Order</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cropSizes.map((size) => (
                  <tr key={size.id}>
                    <td>{size.name}</td>
                    <td>{size.sort_order}</td>
                    <td>
                      <span
                        className={
                          size.status === "active"
                            ? "status-badge active"
                            : "status-badge inactive"
                        }
                      >
                        {size.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => beginEditSize(size)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => deleteSize(size.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {isModalOpen ? (
        <ModalOverlay onClose={closeModal} contentClassName="variety-modal" titleId="variety-modal-title">
            <h2 id="variety-modal-title">{editingId ? "Edit Variety" : "Add Variety"}</h2>

            <form className="varieties-form" onSubmit={handleSubmit}>
              <label>
                Variety name
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              {editingId ? (
              <label>
                Crop
                <select
                  value={form.product_code}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, product_code: event.target.value }))
                  }
                  required
                >
                  {productChoices.length === 0 ? <option value="">No products enabled</option> : null}
                  {productChoices.map((product) => (
                    <option key={product.code} value={product.code}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </label>
              ) : (
              <p className="varieties-modal-crop">
                Crop: <strong>{selectedProduct?.name ?? "—"}</strong>
              </p>
              )}

              <label>
                Area in m²
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.area_m2}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, area_m2: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Case kg
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.case_kg}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, case_kg: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Planting date
                <input
                  type="date"
                  value={form.planting_date}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      planting_date: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Pull-out date
                <input
                  type="date"
                  value={form.pull_out_date}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      pull_out_date: event.target.value
                    }))
                  }
                />
              </label>

              <label>
                Status
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      status: event.target.value as VarietyStatus
                    }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>

              {selectedProduct?.tracksColour === false ? null : (
              <label>
                Color
                <select
                  value={form.color}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      color: event.target.value as VarietyColor
                    }))
                  }
                >
                  <option value="red">Red</option>
                  <option value="orange">Orange</option>
                  <option value="yellow">Yellow</option>
                  <option value="green">Green</option>
                </select>
              </label>
              )}

              <div className="form-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save variety"}
                </button>
                <button type="button" className="secondary" onClick={closeModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}

      {isSizeModalOpen ? (
        <ModalOverlay onClose={closeSizeModal} contentClassName="variety-modal" titleId="variety-size-modal-title">
            <h2 id="variety-size-modal-title">{editingSizeId ? "Edit Size" : "Add Size"}</h2>

            {sizesError ? <p className="form-error">{sizesError}</p> : null}

            <form className="varieties-form" onSubmit={handleSizeSubmit}>
              <p className="varieties-modal-crop">
                Crop: <strong>{sizeModalCrop?.name ?? "—"}</strong>
              </p>
              <label>
                Size name
                <input
                  type="text"
                  value={sizeForm.name}
                  onChange={(event) =>
                    setSizeForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Sort order
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={sizeForm.sort_order}
                  onChange={(event) =>
                    setSizeForm((current) => ({
                      ...current,
                      sort_order: event.target.value
                    }))
                  }
                  required
                />
              </label>

              <label>
                Status
                <select
                  value={sizeForm.status}
                  onChange={(event) =>
                    setSizeForm((current) => ({
                      ...current,
                      status: event.target.value as YieldSizeStatus
                    }))
                  }
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>

              <div className="form-actions">
                <button type="submit" disabled={sizeSaving}>
                  {sizeSaving ? "Saving..." : "Save"}
                </button>
                <button type="button" className="secondary" onClick={closeSizeModal}>
                  Cancel
                </button>
              </div>
            </form>
        </ModalOverlay>
      ) : null}
    </section>
  );
}
