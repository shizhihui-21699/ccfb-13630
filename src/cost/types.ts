import type { GraphQLSchema } from 'graphql';
import type { PricingConfig } from './pricing.js';

/** A pagination argument as it appeared (or would have appeared) in the query. */
export interface PaginationInfo {
  /** Field path of the list field carrying the argument, e.g. `users.posts`. */
  path: string;
  argName: string;
  /** What the caller asked for (undefined when they relied on the default). */
  requested?: number;
  /** Value actually used for costing (defaulted or clamped). */
  effective: number;
  cappedToMax: boolean;
  /** True when the value came from a GraphQL variable rather than a literal. */
  fromVariable: boolean;
}

/** One entry in an alias-bomb group: same underlying field, multiple aliases. */
export interface AliasDuplicateGroup {
  path: string;
  typeName: string;
  fieldName: string;
  aliases: string[];
  count: number;
  /** Each alias independently fans out, so the group costs this many times. */
  subtreeCostEach: number;
}

/** Serialised node of the estimated cost tree. */
export interface CostNode {
  /** Response-shape path, using the alias where one was given. */
  path: string;
  typeName: string;
  fieldName: string;
  alias?: string;
  kind: 'scalar' | 'object' | 'list' | 'meta';
  /** Cost of this field alone (fan-out applied for list elements). */
  selfCost: number;
  /** selfCost plus every descendant, multiplied through by list fan-out. */
  subtreeCost: number;
  /** Number of backend field resolutions this subtree is expected to cause. */
  estimatedResolutions: number;
  /** Static number of field selections in the subtree (pre fan-out). */
  staticFieldCount: number;
  depth: number;
  /** For list nodes: the effective page size used in multiplication. */
  pageSize?: number;
  children: CostNode[];
}

export interface QueryCostSummary {
  totalCost: number;
  /** Sum of every field resolution we expect the backend to perform. */
  totalEstimatedResolutions: number;
  /** Static field count before fan-out multiplication. */
  staticFieldCount: number;
  maxDepth: number;
  /** Largest single page argument seen anywhere in the query. */
  maxPageSizeRequested?: number;
  pagination: PaginationInfo[];
  aliasDuplicates: AliasDuplicateGroup[];
  /** Heaviest subtrees, used to explain *where* the budget went. */
  topContributors: Array<{ path: string; subtreeCost: number; reason: string }>;
  costTree: CostNode;
}

export type RejectionCode =
  | 'PARSE_ERROR'
  | 'VALIDATION_ERROR'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'COST_LIMIT_EXCEEDED'
  | 'QUOTA_EXCEEDED';

export interface Rejection {
  code: RejectionCode;
  message: string;
  /** Human-readable bullet points for the 429 response body. */
  details: string[];
}

export interface AnalysisInput {
  query: string;
  operationName?: string | null;
  variables?: Record<string, unknown> | null;
  schema: GraphQLSchema;
  pricing: PricingConfig;
  /** Per-caller guard rails, evaluated before quota accounting. */
  maxDepth: number;
}
