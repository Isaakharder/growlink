import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type ProductUnit = {
  code: string;
  name: string;
  dimension: "weight" | "count" | null;
};

type OrganizationProduct = {
  code: string;
  name: string;
  tracksColour: boolean;
  status: "active" | "inactive";
  defaultUnit: ProductUnit;
  supportedUnits: ProductUnit[];
  varietyCount: number;
  activeVarietyCount: number;
};

const API_BASE = "/api/products";

export function ProductsSetupPage() {
  const [products, setProducts] = useState<OrganizationProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

        const data = (await res.json()) as { products: OrganizationProduct[] };
        if (!cancelled) setProducts(data.products ?? []);
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

  return (
    <section className="page-shell">
      <header>
        <h1>Products Setup</h1>
        <p>Products your organization grows, from the GrowLink product catalog.</p>
      </header>

      <div className="coming-soon-card">
        <h2>Enabled Products</h2>

        {error ? <p className="form-error">{error}</p> : null}

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
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.code}>
                    <td>{product.name}</td>
                    <td>
                      {product.defaultUnit.name} ({product.defaultUnit.code})
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <p className="form-hint">
          GrowLink adds products and the units they support. Bell Peppers in kilograms is available today; varieties
          are managed in Varieties Setup.
        </p>
      </div>
    </section>
  );
}
