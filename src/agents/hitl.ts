import type { OrderDraft, ValidationDecision, ValidationRecord } from "../types/palier2";

/**
 * Validation humaine (HITL) : toute commande assemblée est mise en PENDING_HUMAN_VALIDATION
 * et ne peut être finalisée qu'après une décision explicite (gérant ou client).
 */
export class HitlValidator {
  private readonly records = new Map<string, ValidationRecord>();
  private readonly clock: () => Date;
  private sequence = 0;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  submit(draft: OrderDraft): ValidationRecord {
    this.sequence += 1;
    const record: ValidationRecord = {
      id: `VAL-${this.sequence.toString().padStart(4, "0")}`,
      status: "PENDING_HUMAN_VALIDATION",
      draft,
      createdAt: this.clock().toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  decide(id: string, decision: ValidationDecision): ValidationRecord {
    const current = this.get(id);
    if (current === undefined) {
      throw new Error(`Validation inconnue : ${id}`);
    }
    if (current.status !== "PENDING_HUMAN_VALIDATION") {
      throw new Error(`La validation ${id} est déjà traitée (${current.status}).`);
    }
    const next: ValidationRecord = {
      ...current,
      status: decision.approved ? "CONFIRMED" : "REJECTED",
      decidedAt: this.clock().toISOString(),
      decidedBy: decision.by,
      note: decision.note ?? null,
    };
    this.records.set(id, next);
    return next;
  }

  get(id: string): ValidationRecord | undefined {
    return this.records.get(id);
  }

  listPending(): ValidationRecord[] {
    return [...this.records.values()].filter((record) => record.status === "PENDING_HUMAN_VALIDATION");
  }
}
