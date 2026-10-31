-- Palier 3 : table des commandes (D1). Montants en FCFA (entiers).
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  customer_phone TEXT NOT NULL,
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  delivery_fee INTEGER NOT NULL CHECK (delivery_fee >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING_HUMAN_VALIDATION', 'CONFIRMED', 'REJECTED')),
  zone_id TEXT NOT NULL,
  delivery_option TEXT NOT NULL CHECK (delivery_option IN ('standard', 'express')),
  eta_days INTEGER NOT NULL,
  validation_id TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders (customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
