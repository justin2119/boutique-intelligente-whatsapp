import { loadCatalog } from "../src/data/catalog";
import { createToolRegistry } from "../src/tools";
import { createRuleBasedLLM } from "../src/agents/rule-based-llm";
import { SingleAgent } from "../src/agents/single-agent";
import type { ExecutedToolCall, ExecutionTrace, ToolResult } from "../src/types";
import { cliArgs } from "../src/runtime";

type Check = { readonly name: string; readonly pass: boolean; readonly detail: string };

function assertEqual(name: string, actual: unknown, expected: unknown): Check {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  return { name, pass, detail: pass ? "ok" : `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}` };
}

function toolData(trace: ExecutionTrace, name: string): ToolResult<unknown> | undefined {
  const calls: ExecutedToolCall[] = trace.steps.flatMap((step) => [...step.toolCalls]);
  return calls.find((entry) => entry.call.name === name)?.result;
}

export async function runPalier1Tests(): Promise<Check[]> {
  const catalog = loadCatalog();
  const fixedClock = () => new Date("2026-10-31T18:22:14.073Z");
  const offlineFetch: typeof fetch = () => Promise.reject(new Error("hors ligne"));
  const tools = createToolRegistry(catalog, { clock: fixedClock, fetchImpl: offlineFetch });
  const checks: Check[] = [];

  const stock = await tools.run("check_stock", { productId: "SW-003", quantity: 2 });
  checks.push(assertEqual("rupture détectée", stock.ok && (stock.data as { status: string }).status, "out_of_stock"));
  checks.push(assertEqual("alternatives SW-003", stock.ok && (stock.data as { alternativeIds: string[] }).alternativeIds, ["SW-002", "SW-001"]));

  const unknown = await tools.run("check_stock", { productId: "XX-999" });
  checks.push(assertEqual("produit inconnu refusé", unknown.ok, false));

  const delivery = await tools.run("calculate_delivery", { location: "Calavi" });
  checks.push(assertEqual("calavi alias -> centre", delivery.ok && (delivery.data as { zoneId: string }).zoneId, "calavi-centre"));
  const dantokpa = await tools.run("calculate_delivery", { location: "marché Dantokpa" });
  checks.push(assertEqual("dantokpa frais 500", dantokpa.ok && (dantokpa.data as { feeXof: number }).feeXof, 500));
  const ambiguous = await tools.run("calculate_delivery", { location: "Cotonou" });
  checks.push(assertEqual("cotonou ambigu", ambiguous.ok && (ambiguous.data as { status: string }).status, "needs_zone"));

  const fallback = await tools.run("convert_currency", { amountXof: 6100, target: "USD" });
  checks.push(assertEqual("repli USD", fallback.ok && (fallback.data as { source: string }).source, "fallback"));
  checks.push(assertEqual("6100 XOF = 10 USD (repli)", fallback.ok && (fallback.data as { convertedAmount: number }).convertedAmount, 10));

  const order = await tools.run("create_order", {
    items: [{ productId: "SW-002", quantity: 2 }, { productId: "AC-001", quantity: 1 }],
    deliveryLocation: "Dantokpa",
    deliveryAddress: "Marché Dantokpa, allée 3",
  });
  checks.push(assertEqual("commande en attente", order.ok && (order.data as { order: { status: string } }).order.status, "PENDING_CONFIRMATION"));
  checks.push(assertEqual("total = articles + livraison", order.ok && (order.data as { order: { totalXof: number } }).order.totalXof, 18000 + 2500 + 500));

  const outOfStock = await tools.run("create_order", {
    items: [{ productId: "SW-003", quantity: 1 }],
    deliveryLocation: "Dantokpa",
    deliveryAddress: "Dantokpa",
  });
  checks.push(assertEqual("commande refusée en rupture", outOfStock.ok, false));

  const agent = new SingleAgent({
    llm: createRuleBasedLLM({ searchQuery: "super wax vert", quantity: 2, location: "Dantokpa", targetCurrency: "EUR" }),
    tools,
  });
  const trace = await agent.run({ query: "super wax vert, 2 pagnes, Dantokpa, en euros ?" });
  checks.push(assertEqual("trace : réponse finale", trace.stoppedBy, "final_answer"));
  checks.push(assertEqual("trace : au moins 3 outils", trace.steps.flatMap((s) => s.toolCalls).length >= 3, true));
  const converted = toolData(trace, "convert_currency");
  checks.push(assertEqual("trace : conversion ok", converted?.ok, true));

  const limited = new SingleAgent({
    llm: { complete: async () => ({ content: "boucle", toolCalls: [{ id: "x", name: "search_product", arguments: { query: "wax" } }] }) },
    tools,
  });
  const looped = await limited.run({ query: "boucle" });
  checks.push(assertEqual("limite de 6 étapes", looped.stoppedBy, "max_steps"));

  return checks;
}

const testArgs = cliArgs();
if (testArgs[testArgs.length - 1] === "test") {
  runPalier1Tests().then((checks) => {
    let failed = 0;
    for (const check of checks) {
      console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name} ${check.pass ? "" : check.detail}`);
      if (!check.pass) failed += 1;
    }
    console.log(`${checks.length - failed}/${checks.length} vérifications réussies`);
  });
}
