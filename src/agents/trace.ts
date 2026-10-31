import type { ExecutionTrace } from "../types";

function jsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

/** Rend une trace d'exécution en Markdown lisible (étape, pensée, outil, arguments, résultat, réponse). */
export function renderTraceMarkdown(trace: ExecutionTrace, title: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}`, "");
  lines.push(`Requête client : ${trace.query}`, "");
  lines.push(`Limite d'étapes : ${trace.maxSteps}. Arrêt : ${trace.stoppedBy}.`, "");
  let toolSteps = 0;
  for (const step of trace.steps) {
    lines.push(`## Étape ${step.step}`, "");
    lines.push(`Pensée : ${step.thought || "(aucune)"}`, "");
    for (const executed of step.toolCalls) {
      toolSteps += 1;
      lines.push(`### Action ${toolSteps} : ${executed.call.name}`, "");
      lines.push("Arguments :", jsonBlock(executed.call.arguments), "");
      lines.push("Résultat :", jsonBlock(executed.result), "");
    }
    if (step.finalResponse !== undefined) {
      lines.push("Réponse finale :", "", step.finalResponse, "");
    }
  }
  lines.push(`Nombre d'appels d'outils : ${toolSteps}.`, "");
  return lines.join("\n");
}
