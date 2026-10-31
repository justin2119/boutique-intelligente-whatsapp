import productsJson from "../../data/catalog/products.json";
import zonesJson from "../../data/catalog/delivery-zones.json";
import type { Catalog, DeliveryZone, Product } from "../types";

/** Charge le catalogue versionné (produits et zones de livraison). */
export function loadCatalog(): Catalog {
  return {
    products: productsJson as Product[],
    zones: zonesJson as DeliveryZone[],
  };
}
