import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { usePermissions } from "../hooks/usePermissions";

type ProductUnit = {
  code: string;
  name: string;
  dimension: "weight" | "count" | null;
};

type OrganizationProduct = {
  code: string;
  name: string;
  tracksColour: boolean;
  tracksSizes?: boolean;
  status: "active" | "inactive";
  defaultUnit: ProductUnit;
  supportedUnits: ProductUnit[];
  varietyCount: number;
  activeVarietyCount: number;
};

/** A catalog product the organization hasn't enabled yet. */
type AvailableProduct = {
  code: string;
  name: string;
  defaultUnit: ProductUnit;
  supportedUnits: ProductUnit[];
};

type ProductsResponse = { products: OrganizationProduct[]; available?: AvailableProduct[] };

const API_BASE = "/api/products";

/** "Kilograms (kg)", "Pieces (pcs)". */
const unitText = (unit: ProductUnit) => `${unit.name} (${unit.code})`;

export function ProductsSetupPage() {
  const { can } = usePermissions();
  const canEdit = can("greenhouse_setup:edit");
  const [products, setProducts] = useState<OrganizationProduct[]>([]);
  const [available, setAvailable] = useState<AvailableProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // The unit picked on a row before it is saved, by product code: on an
  // Available row it is the unit to enable with; on an Enabled row, the new default.
  const [enableUnits, setEnableUnits] = useState<Record<string, string>>({});
  const [pendingUnits, setPendingUnits] = useState<Record<string, string>>({});

  function applyResponse(data: ProductsResponse) {
    setProducts(data.products ?? []);
    setAvailable(data.available ?? []);
  }

  useEffect(() => {
    let cancelled = false;

    async function fetchProducts() {
      setLoading(true);
      setError(null);

      try {
        const res = await apiFetch(API_BASE);
        if (!res.ok) {
          throw new Error("Failed to load products");
        }

        const data = (await res.json()) as ProductsResponse;
        if (!cancelled) applyResponse(data);
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "Failed to load products");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchProducts();
    return () => {
      cancelled = true;
    };
  }, []);

  async function changeProduct(code: string, action: "enable" | "disable", unitCode?: string) {
    setActionError(null);
    setActionNotice(null);
    setSavingCode(code);

    try {
      const res = await apiFetch(`${API_BASE}/${code}/${action}`, {
        method: "POST",
        body: JSON.stringify(unitCode ? { unit_code: unitCode } : {})
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ProductsResponse> & { message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? (action === "enable" ? "Failed to enable product" : "Failed to turn off product"));
      }
      applyResponse(body as ProductsResponse);
    } catch (changeError) {
      setActionError(changeError instanceof Error ? changeError.message : "Failed to update product");
    } finally {
      setSavingCode(null);
    }
  }

  // A new default unit applies to harvests entered from now on; saved
  // harvests keep the unit they were recorded in.
  async function saveDefaultUnit(product: OrganizationProduct, unitCode: string) {
    setActionError(null);
    setActionNotice(null);
    setSavingCode(product.code);

    try {
      const res = await apiFetch(`${API_BASE}/${product.code}`, {
        method: "PATCH",
        body: JSON.stringify({ default_unit_code: unitCode })
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ProductsResponse> & { message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? "Failed to change the default unit");
      }
      applyResponse(body as ProductsResponse);
      setPendingUnits((current) => {
        const next = { ...current };
        delete next[product.code];
        return next;
      });
      const saved = (body.products ?? []).find((p) => p.code === product.code)?.defaultUnit;
      setActionNotice(`New ${product.name} harvests will be recorded in ${saved ? unitText(saved) : unitCode}. Existing harvests keep their units.`);
    } catch (changeError) {
      setActionError(changeError instanceof Error ? changeError.message : "Failed to change the default unit");
    } finally {
      setSavingCode(null);
    }
  }

  return (
    <section className="page-shell">
      <header>
        <h1>Products Setup</h1>
        <p>Products your organization grows, from the GrowLink product catalog.</p>
      </header>

      <div className="coming-soon-card">
        <h2>Enabled Products</h2>

        {error ? <p className="form-error">{error}</p> : null}
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
        {actionNotice ? <p className="form-success" role="status">{actionNotice}</p> : null}

        {loading ? <p>Loading...</p> : null}

        {!loading && !error && products.length === 0 ? <p>No products enabled.</p> : null}

        {!loading && products.length > 0 ? (
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Default unit</th>
                  <th>Supported units</th>
                  <th>Varieties</th>
                  <th>Status</th>
                  {canEdit ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => {
                  const canChooseUnit = canEdit && product.status === "active" && product.supportedUnits.length > 1;
                  const chosenUnit = pendingUnits[product.code] ?? product.defaultUnit.code;
                  return (
                  <tr key={product.code}>
                    <td>{product.name}</td>
                    <td>
                      {canChooseUnit ? (
                        <div className="product-unit-choice">
                          <select
                            aria-label={`Default unit for ${product.name}`}
                            value={chosenUnit}
                            disabled={savingCode !== null}
                            onChange={(event) => {
                              const value = event.target.value;
                              setActionNotice(null);
                              setPendingUnits((current) => ({ ...current, [product.code]: value }));
                            }}
                          >
                            {product.supportedUnits.map((unit) => (
                              <option key={unit.code} value={unit.code}>
                                {unitText(unit)}
                              </option>
                            ))}
                          </select>
                          {chosenUnit !== product.defaultUnit.code ? (
                            <>
                              <button
                                type="button"
                                disabled={savingCode !== null}
                                onClick={() => void saveDefaultUnit(product, chosenUnit)}
                              >
                                {savingCode === product.code ? "Saving..." : "Save unit"}
                              </button>
                              <span className="form-hint">Applies to new entries. Existing harvests keep the unit they were recorded in.</span>
                            </>
                          ) : null}
                        </div>
                      ) : (
                        unitText(product.defaultUnit)
                      )}
                    </td>
                    <td>{product.supportedUnits.map((unit) => unit.code).join(", ")}</td>
                    <td>
                      {product.activeVarietyCount} active of {product.varietyCount}
                    </td>
                    <td>
                      <span className={product.status === "active" ? "status-badge active" : "status-badge inactive"}>
                        {product.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </td>
                    {canEdit ? (
                      <td>
                        <div className="row-actions">
                          {product.status === "active" ? (
                            <button
                              type="button"
                              className="secondary"
                              disabled={savingCode !== null}
                              onClick={() => void changeProduct(product.code, "disable")}
                            >
                              {savingCode === product.code ? "Saving..." : "Turn off"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={savingCode !== null}
                              onClick={() => void changeProduct(product.code, "enable")}
                            >
                              {savingCode === product.code ? "Saving..." : "Turn on"}
                            </button>
                          )}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {!loading && !error && available.length > 0 ? (
        <div className="coming-soon-card">
          <h2>Available to Enable</h2>
          <p className="form-hint">
            Enabling a product lets you create its varieties and record its harvests. It doesn&rsquo;t change your
            existing products or their history.
          </p>
          <div className="varieties-table-wrapper">
            <table className="varieties-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Default unit</th>
                  <th>Supported units</th>
                  {canEdit ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {available.map((product) => {
                  const enableUnit = enableUnits[product.code] ?? product.defaultUnit.code;
                  return (
                  <tr key={product.code}>
                    <td>{product.name}</td>
                    <td>
                      {canEdit && product.supportedUnits.length > 1 ? (
                        <div className="product-unit-choice">
                        <select
                          aria-label={`Default unit for ${product.name}`}
                          value={enableUnit}
                          disabled={savingCode !== null}
                          onChange={(event) => {
                            const value = event.target.value;
                            setEnableUnits((current) => ({ ...current, [product.code]: value }));
                          }}
                        >
                          {product.supportedUnits.map((unit) => (
                            <option key={unit.code} value={unit.code}>
                              {unitText(unit)}
                            </option>
                          ))}
                        </select>
                        </div>
                      ) : (
                        unitText(product.defaultUnit)
                      )}
                    </td>
                    <td>{product.supportedUnits.map((unit) => unit.code).join(", ")}</td>
                    {canEdit ? (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            disabled={savingCode !== null}
                            onClick={() => void changeProduct(product.code, "enable", enableUnit)}
                          >
                            {savingCode === product.code ? "Enabling..." : `Enable ${product.name}`}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <p className="form-hint">
        GrowLink adds products and the units they support. Varieties are managed in Crop Planner → Varieties.
      </p>
    </section>
  );
}
