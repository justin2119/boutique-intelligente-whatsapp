/** Accès typé aux arguments de ligne de commande, sans dépendre des types Node. */
export function cliArgs(): readonly string[] {
  const proc = (globalThis as unknown as { process?: { argv?: string[] } }).process;
  return proc?.argv ?? [];
}
