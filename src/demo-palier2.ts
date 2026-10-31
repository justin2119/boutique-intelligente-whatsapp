import { loadCatalog } from "./data/catalog";
import { FormatterAgent } from "./agents/formatter-agent";
import { HitlValidator } from "./agents/hitl";
import { LogisticsAgent } from "./agents/logistics-agent";
import { ManagerAgent } from "./agents/manager-agent";
import { SellerAgent } from "./agents/seller-agent";
import { cliArgs } from "./runtime";
import type { Palier2Trace } from "./types/palier2";

const DEMO_INSTANT = "2026-10-31T18:35:43.000Z";
const DEMO_CLOCK = (): Date => new Date(DEMO_INSTANT);

const MESSAGE_INQUIRY = "Bonjour, je cherche du super wax vert, 2 pagnes. Je livre à Dantokpa en express. Combien ça coûte ?";
const MESSAGE_ORDER = "Je prends la commande : 2 pagnes SW-002, livraison à Dantokpa en express.";

/** Scénario Palier 2 : routage multi-agents, validation humaine, réponse finale. */
export async function runPalier2Demo(): Promise<string> {
  const catalog = loadCatalog();
  const hitl = new HitlValidator(DEMO_CLOCK);
  const manager = new ManagerAgent({
    catalog,
    seller: new SellerAgent(catalog),
    logistics: new LogisticsAgent(catalog.zones),
    formatter: new FormatterAgent(),
    hitl,
    clock: DEMO_CLOCK,
  });

  const step1 = await manager.handle(MESSAGE_INQUIRY);
  const step2 = await manager.handle(MESSAGE_ORDER);
  const pending = step2.aggregated.validation;
  if (pending === null) {
    throw new Error("Aucune commande n'a été assemblée pour la validation humaine.");
  }
  const resolved = manager.resolveValidation(pending.id, {
    by: "manager",
    approved: true,
    note: "Stock vérifié au magasin.",
  });

  return [
    "# Trace Palier 2 : multi-agents et validation humaine",
    "",
    renderStep("Étape 1 : demande produit et livraison", step1),
    renderStep("Étape 2 : commande et validation humaine", step2),
    "## Étape 3 : décision humaine et réponse finale",
    "",
    `Décision : ${resolved.validation.id} ${resolved.validation.status} par ${resolved.validation.decidedBy ?? "inconnu"} (${resolved.validation.decidedAt ?? ""})`,
    "",
    "```text",
    resolved.customerMessage,
    "```",
    "",
  ].join("\n");
}

function renderStep(title: string, trace: Palier2Trace): string {
  const delegations = trace.delegations.map(
    (step, index) => `${index + 1}. ${step.from} → ${step.to} : ${step.task}\n   Résultat : ${step.output}`,
  );
  return [
    `## ${title}`,
    "",
    `Message client : ${trace.message}`,
    "",
    "### Délégations",
    ...delegations,
    "",
    "### Événements",
    ...trace.events.map((event) => `- ${event}`),
    "",
    "### Réponse WhatsApp",
    "",
    "```text",
    trace.customerMessage,
    "```",
    "",
  ].join("\n");
}

const args = cliArgs();
if (args[args.length - 1] === "demo") {
  runPalier2Demo().then((markdown) => console.log(markdown));
}
