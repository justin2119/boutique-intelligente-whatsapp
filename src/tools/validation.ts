import type { ToolResult } from "../types";

type Args = Readonly<Record<string, unknown>>;

export function requireString(args: Args, key: string): ToolResult<string> {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `Paramètre "${key}" requis (texte non vide).` };
  }
  return { ok: true, data: value.trim() };
}

export function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function requireNumber(args: Args, key: string): ToolResult<number> {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `Paramètre "${key}" requis (nombre positif).` };
  }
  return { ok: true, data: value };
}

export function optionalInteger(
  args: Args,
  key: string,
  fallback: number,
  min: number,
  max: number,
): ToolResult<number> {
  const value = args[key];
  if (value === undefined) {
    return { ok: true, data: fallback };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `Paramètre "${key}" : entier compris entre ${min} et ${max}.` };
  }
  return { ok: true, data: value };
}
