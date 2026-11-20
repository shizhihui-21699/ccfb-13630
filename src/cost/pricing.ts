/**
 * Cost pricing configuration.
 *
 * Units are abstract "work points". The intuition: every resolved field is one
 * unit of backend work, object materialisation costs more than a scalar, and a
 * list field costs `base + perElement * effectivePageSize` because the backend
 * has to fetch, hydrate and authorise every row. Nesting multiplies, which is
 * exactly what makes a 10-level nested query explosive.
 */
export interface PricingConfig {
  /** Cost of resolving one scalar field once. */
  scalarCost: number;
  /** Cost of materialising one object/interface/union field once. */
  objectCost: number;
  /** Base cost of touching a list field (query planning, connection setup). */
  listBaseCost: number;
  /** Per-row cost added on top of the list base cost. */
  listPerElementCost: number;
  /** Meta fields (__schema / __type): introspection is comparatively heavy. */
  introspectionCost: number;
  /** __typename is answered from the type info, no DB work. */
  typenameCost: number;
  /**
   * Pagination arguments recognised on list fields. When present, the largest
   * effective value drives the fan-out estimate.
   */
  paginationArgs: string[];
  /**
   * Fallback page size assumed when a list field exposes a pagination argument
   * but the query sets none of them (the backend would apply its own default).
   */
  defaultPageSize: number;
  /**
   * Page size the backend will clamp to. A request asking for more is still
   * billed at the clamped value (the backend cannot return more), but the
   * over-shoot is flagged in the breakdown so callers can see it.
   */
  maxPageSize: number;
  /** Hard rejection: anything above this is never even clamped-and-run. */
  hardPageLimit: number;
  /** Saturation guard so pathological products stay finite (1e15). */
  costCeiling: number;
  /** Per-field price overrides keyed by `TypeName.fieldName`. */
  fieldOverrides: Record<string, number>;
}

export const DEFAULT_PRICING: PricingConfig = {
  scalarCost: 1,
  objectCost: 5,
  listBaseCost: 10,
  listPerElementCost: 1,
  introspectionCost: 500,
  typenameCost: 0,
  paginationArgs: ['first', 'last', 'limit', 'take', 'count'],
  defaultPageSize: 20,
  maxPageSize: 100,
  hardPageLimit: 10_000,
  costCeiling: 1e15,
  fieldOverrides: {
    // Full-text / ranked search touches an external engine, not just the DB.
    'Query.search': 200,
    // Aggregation queries scan whole tables.
    'Query.analytics': 1_000,
    'Query.auditLog': 500,
  },
};
