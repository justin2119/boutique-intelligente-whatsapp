import type { DeliveryZone } from "../types";
import type { DeliveryOption, LogisticsResult } from "../types/palier2";
import { normalizeText } from "./normalize";

/*
 * Hypothèses de Palier 2 à valider avec la boutique : majoration express et réduction de délai.
 * Les tarifs de base proviennent de data/catalog/delivery-zones.json.
 */
export const EXPRESS_FEE_MULTIPLIER = 1.5;
export const EXPRESS_ETA_REDUCTION_DAYS = 1;
/** Plancher du délai express : 0 jour, pour que la livraison du jour même (ex. Dantokpa, Lomé-Centre) reste le jour même. */
export const MIN_EXPRESS_ETA_DAYS = 0;

/** Calcule le délai express : jamais plus lent que le standard, et 0 jour reste 0 jour. */
export function expressEtaDays(standardEtaDays: number): number {
  return Math.min(standardEtaDays, Math.max(MIN_EXPRESS_ETA_DAYS, standardEtaDays - EXPRESS_ETA_REDUCTION_DAYS));
}

/** Agent Logisticien : frais, délai et options de livraison (Cotonou, Calavi, Porto-Novo, Lomé et régions du Togo). */
export class LogisticsAgent {
  private readonly zones: readonly DeliveryZone[];

  constructor(zones: readonly DeliveryZone[]) {
    this.zones = zones;
  }

  quote(zoneQuery: string, option: DeliveryOption): LogisticsResult {
    const query = normalizeText(zoneQuery);
    if (query.length === 0) {
      return { kind: "unknown_zone", query: zoneQuery };
    }
    const exact = this.zones.filter((zone) => labelsOf(zone).some((label) => label === query));
    const partial = this.zones.filter((zone) =>
      labelsOf(zone).some((label) => label.length >= 3 && (label.includes(query) || query.includes(label))),
    );
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 0) {
      return { kind: "unknown_zone", query: zoneQuery };
    }
    const distinctZones = new Set(matches.map((zone) => zone.id));
    if (distinctZones.size > 1) {
      return { kind: "ambiguous", query: zoneQuery, candidates: matches.map((zone) => zone.zone) };
    }
    const zone = matches[0];
    if (zone === undefined) {
      return { kind: "unknown_zone", query: zoneQuery };
    }
    const express = option === "express";
    return {
      kind: "quoted",
      zone,
      option,
      feeXof: express ? Math.round(zone.feeXof * EXPRESS_FEE_MULTIPLIER) : zone.feeXof,
      etaDays: express ? expressEtaDays(zone.etaDays) : zone.etaDays,
    };
  }

  /** Liste les zones d'une ville (ex. toutes les zones de Lomé) pour proposer un choix au client. */
  zonesInCity(city: string): DeliveryZone[] {
    const target = normalizeText(city);
    return this.zones.filter((zone) => normalizeText(zone.city) === target);
  }
}

/** Repère le lieu de livraison mentionné dans un message (le plus long terme trouvé). */
export function detectZoneTerm(message: string, zones: readonly DeliveryZone[]): string | null {
  const padded = ` ${normalizeText(message)} `;
  let best: string | null = null;
  for (const zone of zones) {
    for (const raw of [zone.zone, zone.city, ...zone.aliases]) {
      const label = normalizeText(raw);
      if (label.length >= 3 && padded.includes(` ${label} `)) {
        if (best === null || label.length > normalizeText(best).length) {
          best = raw;
        }
      }
    }
  }
  return best;
}

/** Message quand le client parle de livraison sans lieu précis : on demande le quartier ou la ville avec enthousiasme. */
export function askForZoneMessage(zones: readonly DeliveryZone[]): string {
  const lome = zones.filter((zone) => normalizeText(zone.city) === "lome").map((zone) => zone.zone);
  const cotonou = zones.filter((zone) => normalizeText(zone.city) === "cotonou").map((zone) => zone.zone);
  return [
    "Avec plaisir, on livre partout ! 🚚",
    `📍 *À Lomé* : ${lome.join(", ")} (à partir de 1 000 FCFA, souvent le jour même ou J+1).`,
    `📍 *Dans les régions* : Tsévié, Kpalimé, Vogan, Atakpamé, Sokodé, Kara, Dapaong (2 500 à 4 500 FCFA).`,
    `📍 *Au Bénin* : ${cotonou.join(", ")} et autres villes (sur demande).`,
    "Dans quel quartier ou quelle ville êtes-vous ? Je vous donne le tarif exact tout de suite 😊",
  ].join("\n");
}

function labelsOf(zone: DeliveryZone): string[] {
  return [zone.zone, zone.city, ...zone.aliases].map(normalizeText).filter((label) => label.length > 0);
}
