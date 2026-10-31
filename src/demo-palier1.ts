import { loadCatalog } from "./data/catalog";
import { SingleAgent } from "./agents/single-agent";
import { createRuleBasedLLM } from "./agents/rule-based-llm";
import { renderTraceMarkdown } from "./agents/trace";
import { createToolRegistry } from "./tools";
import { cliArgs } from "./runtime";

/** Scénario Palier 1 : recherche -> stock (rupture + alternative) -> livraison -> conversion. */
export async function runPalier1Demo(): Promise<string> {
  const catalog = loadCatalog();
  const tools = createToolRegistry(catalog, { clock: () => new Date("2026-10-31T18:22:14.073Z") });
  const agent = new SingleAgent({
    llm: createRuleBasedLLM({
      searchQuery: "super wax vert",
      quantity: 2,
      location: "Dantokpa",
      targetCurrency: "EUR",
    }),
    tools,
  });
  const trace = await agent.run({
    query: "Bonjour, je cherche du super wax vert, 2 pagnes. Je livre à Dantokpa. Combien en euros ?",
  });
  return renderTraceMarkdown(trace, "Trace Palier 1 : vendeur WhatsApp Dantokpa");
}

const args = cliArgs();
if (args[args.length - 1] === "demo") {
  runPalier1Demo().then((markdown) => console.log(markdown));
}
