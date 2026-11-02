/**
 * Fiches techniques des ordinateurs du catalogue. Valeurs reprises des descriptions de data/catalog/products.json,
 * sans donnée ajoutée. Un ordinateur sans fiche ici est affiché sans lignes de spécifications.
 */
export interface LaptopSpecs {
  readonly processor: string;
  readonly ram: string;
  readonly storage: string;
  readonly graphics?: string;
}

export const LAPTOP_SPECS: Readonly<Record<string, LaptopSpecs>> = {
  "PC-001": { processor: "Apple M3 (CPU 8 cœurs)", ram: "16 Go", storage: "SSD 256 Go" },
  "PC-002": { processor: "Apple M4 (CPU 10 cœurs)", ram: "16 Go", storage: "SSD 512 Go" },
  "PC-003": { processor: "Intel Core i7 (13e génération)", ram: "16 Go DDR5", storage: "SSD 512 Go" },
  "PC-004": { processor: "Intel Core i7 1365U", ram: "32 Go", storage: "SSD 1 To" },
  "PC-005": { processor: "Intel Core i7-1360P", ram: "16 Go", storage: "SSD 512 Go" },
  "PC-006": {
    processor: "Intel Core i5 (13e génération)",
    ram: "16 Go",
    storage: "SSD 512 Go",
    graphics: "NVIDIA GeForce RTX 4050 6 Go",
  },
  "PC-007": { processor: "Intel Core Ultra 7", ram: "16 Go LPDDR5X", storage: "SSD 1 To" },
  "PC-008": { processor: "AMD Ryzen 7 7730U", ram: "16 Go", storage: "SSD 512 Go" },
};

/** Fiche technique d'un ordinateur par identifiant, ou undefined. */
export function specsFor(id: string): LaptopSpecs | undefined {
  return LAPTOP_SPECS[id];
}
