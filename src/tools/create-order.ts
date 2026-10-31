import type { Catalog, DeliveryZone, Order, OrderItem, ToolHandler, ToolResult } from "../types";
import { etaLabel, resolveDeliveryZone } from "./calculate-delivery";
import { optionalInteger, optionalString, requireString } from "./validation";

type Args = Readonly<Record<string, unknown>>;

export interface CreateOrderData {
  readonly order: Order;
  readonly deliveryEtaLabel: string;
  readonly confirmationRequired: true;
  readonly message: string;
}

const MAX_ITEMS = 20;

/**
 * Outil : prépare une commande en statut PENDING_CONFIRMATION.
 * Valide les articles et le stock, calcule total = articles + livraison. Ne décrémente pas le stock :
 * la commande n'est finalisée qu'après l'accord explicite du client.
 */
export function createCreateOrderTool(catalog: Catalog, clock: () => Date = () => new Date()): ToolHandler {
  const productsById = new Map(catalog.products.map((product) => [product.id.toUpperCase(), product] as const));

  return {
    definition: {
      name: "create_order",
      description:
        "Prépare une commande (statut PENDING_CONFIRMATION) après vérification du stock et calcul du total = articles + livraison. Ne finalise jamais la commande sans l'accord explicite du client.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ITEMS,
            items: {
              type: "object",
              properties: {
                productId: { type: "string" },
                quantity: { type: "integer", minimum: 1, maximum: 1000 },
              },
              required: ["productId"],
              additionalProperties: false,
            },
          },
          customerName: { type: "string" },
          deliveryLocation: { type: "string", description: "Quartier ou ville de livraison." },
          zoneId: { type: "string", description: "Identifiant exact de zone, si déjà choisi." },
          deliveryAddress: { type: "string" },
        },
        required: ["items", "deliveryLocation", "deliveryAddress"],
        additionalProperties: false,
      },
    },
    async run(args: Args): Promise<ToolResult<unknown>> {
      const rawItems = args["items"];
      if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
        return { ok: false, error: `Paramètre "items" : liste de 1 à ${MAX_ITEMS} articles attendue.` };
      }

      const quantities = new Map<string, number>();
      for (const raw of rawItems) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return { ok: false, error: 'Chaque article doit être un objet { "productId", "quantity" }.' };
        }
        const entry = raw as Readonly<Record<string, unknown>>;
        const productId = requireString(entry, "productId");
        if (!productId.ok) {
          return productId;
        }
        const quantity = optionalInteger(entry, "quantity", 1, 1, 1000);
        if (!quantity.ok) {
          return quantity;
        }
        const key = productId.data.toUpperCase();
        quantities.set(key, (quantities.get(key) ?? 0) + quantity.data);
      }

      const deliveryAddress = requireString(args, "deliveryAddress");
      if (!deliveryAddress.ok) {
        return deliveryAddress;
      }
      const deliveryLocation = requireString(args, "deliveryLocation");
      if (!deliveryLocation.ok) {
        return deliveryLocation;
      }
      const zoneId = optionalString(args, "zoneId");
      const customerName = optionalString(args, "customerName") ?? null;

      let zone: DeliveryZone | undefined;
      if (zoneId !== undefined) {
        zone = catalog.zones.find((candidate) => candidate.id === zoneId);
      } else {
        const resolution = resolveDeliveryZone(catalog.zones, deliveryLocation.data);
        if (resolution.kind === "zone") {
          zone = resolution.zone;
        }
      }
      if (zone === undefined) {
        return {
          ok: false,
          error: `Zone de livraison non déterminée pour "${deliveryLocation.data}" : demander au client son quartier précis.`,
        };
      }

      const items: OrderItem[] = [];
      const problems: string[] = [];
      for (const [key, quantity] of quantities) {
        const product = productsById.get(key);
        if (product === undefined) {
          return { ok: false, error: `Produit introuvable : "${key}".` };
        }
        if (product.stock < quantity) {
          problems.push(`${product.name} (${product.id}) : stock disponible ${product.stock}, demandé ${quantity}`);
          continue;
        }
        items.push({
          productId: product.id,
          name: product.name,
          quantity,
          unitPriceXof: product.priceXof,
          lineTotalXof: product.priceXof * quantity,
        });
      }
      if (problems.length > 0) {
        return {
          ok: false,
          error: `Stock insuffisant : ${problems.join(" ; ")}. Proposer les alternatives via check_stock.`,
        };
      }

      const subtotalXof = items.reduce((sum, item) => sum + item.lineTotalXof, 0);
      const deliveryFeeXof = zone.feeXof;
      const now = clock();
      const order: Order = {
        reference: `BTQ-${now.getTime().toString(36).toUpperCase()}`,
        status: "PENDING_CONFIRMATION",
        items,
        deliveryZoneId: zone.id,
        deliveryAddress: deliveryAddress.data,
        customerName,
        subtotalXof,
        deliveryFeeXof,
        totalXof: subtotalXof + deliveryFeeXof,
        createdAt: now.toISOString(),
      };
      const data: CreateOrderData = {
        order,
        deliveryEtaLabel: etaLabel(zone.etaDays),
        confirmationRequired: true,
        message: "Commande en attente : demander la confirmation explicite du client avant de la finaliser.",
      };
      return { ok: true, data };
    },
  };
}
