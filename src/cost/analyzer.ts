import {
  Kind,
  parse,
  isCompositeType,
  isLeafType,
  isListType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  doTypesOverlap,
  getNamedType,
  isNonNullType,
  type GraphQLSchema,
  type GraphQLType,
  type GraphQLCompositeType,
  type DocumentNode,
  type OperationDefinitionNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type FieldNode,
  type ValueNode,
  type GraphQLObjectType,
} from 'graphql';
import type {
  AnalysisInput,
  CostNode,
  PaginationInfo,
  AliasDuplicateGroup,
  QueryCostSummary,
} from './types.js';
import type { PricingConfig } from './pricing.js';

/** Error carrying the same vocabulary as a gateway rejection. */
export class AnalysisError extends Error {
  code: 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'PAGE_LIMIT_EXCEEDED';
  constructor(code: AnalysisError['code'], message: string) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
  }
}

interface InternalNode {
  path: string;
  typeName: string;
  fieldName: string;
  alias?: string;
  kind: CostNode['kind'];
  selfCost: number;
  subtreeCost: number;
  estimatedResolutions: number;
  staticFieldCount: number;
  depth: number;
  pageSize?: number;
  children: InternalNode[];
}

interface WalkContext {
  schema: GraphQLSchema;
  pricing: PricingConfig;
  fragments: Map<string, FragmentDefinitionNode>;
  variables: Record<string, unknown>;
  pagination: PaginationInfo[];
  aliasDuplicates: AliasDuplicateGroup[];
  fragmentStack: Set<string>;
}

function saturate(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value > ceiling) return ceiling;
  return Math.round(value);
}

function satMul(a: number, b: number, ceiling: number): number {
  return saturate(a * b, ceiling);
}

/**
 * Resolve a field's arguments into plain runtime values.
 *
 * Variable references are resolved against the request's `variables` map, so a
 * `first: $pageSize` attack cannot hide its fan-out from the estimator.
 */
function resolveArguments(
  field: FieldNode,
  variableValues: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments ?? []) {
    out[arg.name.value] = resolveValueNode(arg.value, variableValues);
  }
  return out;
}

function resolveValueNode(
  node: ValueNode,
  variableValues: Record<string, unknown>,
): unknown {
  if (node.kind === Kind.VARIABLE) {
    return variableValues[node.name.value];
  }
  return literalToValue(node);
}

/** Read a GraphQL literal back into a plain JS value. */
function literalToValue(node: ValueNode): unknown {
  switch (node.kind) {
    case Kind.NULL:
      return null;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(node.value);
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return node.value;
    case Kind.LIST:
      return node.values.map(literalToValue);
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) {
        out[field.name.value] = literalToValue(field.value);
      }
      return out;
    }
    case Kind.VARIABLE:
      return undefined;
  }
}

interface PaginationResolution {
  argName: string;
  requested?: number;
  effective: number;
  fromVariable: boolean;
  capped: boolean;
}

/**
 * Find the effective page size for a list field.
 *
 * The largest of the recognised pagination arguments wins (mirroring `first`
 * vs `last` semantics where the backend honours the bigger bound). When the
 * field exposes a pagination argument but the query omits it, the backend's
 * default page size is assumed instead of pretending the list returns one row.
 */
function resolvePagination(
  field: FieldNode,
  args: Record<string, unknown>,
  ctx: WalkContext,
): PaginationResolution | null {
  const { pricing } = ctx;

  let chosen: { name: string; raw: number; fromVariable: boolean } | null = null;
  let hasPaginationArg = false;

  for (const argNode of field.arguments ?? []) {
    if (!pricing.paginationArgs.includes(argNode.name.value)) continue;
    hasPaginationArg = true;
    const raw = args[argNode.name.value];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (!chosen || raw > chosen.raw) {
      chosen = {
        name: argNode.name.value,
        raw,
        fromVariable: argNode.value.kind === Kind.VARIABLE,
      };
    }
  }

  if (!chosen) {
    // No usable value: the caller either omitted pagination (backend default
    // applies) or fed a non-numeric variable — bill the default conservatively.
    if (!hasPaginationArg) return null;
    return {
      argName: 'default',
      effective: pricing.defaultPageSize,
      capped: false,
      fromVariable: false,
    };
  }

  if (chosen.raw > pricing.hardPageLimit) {
    throw new AnalysisError(
      'PAGE_LIMIT_EXCEEDED',
      `Pagination argument "${chosen.name}" = ${chosen.raw} exceeds the hard limit of ${pricing.hardPageLimit}`,
    );
  }
  if (chosen.raw < 0) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Pagination argument "${chosen.name}" must be non-negative, got ${chosen.raw}`,
    );
  }

  const effective = Math.min(chosen.raw, pricing.maxPageSize);
  return {
    argName: chosen.name,
    requested: chosen.raw,
    effective,
    fromVariable: chosen.fromVariable,
    capped: effective < chosen.raw,
  };
}

function baseCostOf(
  parentTypeName: string,
  fieldName: string,
  isList: boolean,
  pricing: PricingConfig,
): number {
  const override = pricing.fieldOverrides[`${parentTypeName}.${fieldName}`];
  if (override !== undefined) return override;
  if (isList) return pricing.listBaseCost;
  return pricing.objectCost;
}

/** True when any wrapper in the type chain is a GraphQLList. */
function containsList(type: GraphQLType): boolean {
  let t: GraphQLType = type;
  while (true) {
    if (isListType(t)) return true;
    if (isNonNullType(t)) {
      t = t.ofType;
      continue;
    }
    return false;
  }
}

function walkSelectionSet(
  selectionSet: SelectionSetNode,
  parentType: GraphQLCompositeType,
  parentPath: string,
  depth: number,
  ctx: WalkContext,
): {
  nodes: InternalNode[];
  subtreeCost: number;
  resolutions: number;
  staticFieldCount: number;
  maxDepth: number;
} {
  const nodes: InternalNode[] = [];
  let subtreeCost = 0;
  let resolutions = 0;
  let staticFieldCount = 0;
  let maxDepth = depth;

  // Group selections on the same underlying field. Every alias is a separate
  // response entry the backend must populate independently — that is the whole
  // point of the alias-bomb attack, and each copy stays billable.
  const aliasGroups = new Map<string, InternalNode[]>();

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const node = walkField(selection, parentType, parentPath, depth, ctx);
      nodes.push(node);
      subtreeCost = saturate(subtreeCost + node.subtreeCost, ctx.pricing.costCeiling);
      resolutions += node.estimatedResolutions;
      staticFieldCount += node.staticFieldCount;
      maxDepth = Math.max(maxDepth, node.depth);

      const group = aliasGroups.get(node.fieldName) ?? [];
      group.push(node);
      aliasGroups.set(node.fieldName, group);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = ctx.fragments.get(selection.name.value);
      if (!fragment) {
        throw new AnalysisError(
          'VALIDATION_ERROR',
          `Unknown fragment "${selection.name.value}"`,
        );
      }
      if (ctx.fragmentStack.has(selection.name.value)) {
        throw new AnalysisError(
          'VALIDATION_ERROR',
          `Cannot spread fragment "${selection.name.value}" within itself (fragment cycle)`,
        );
      }
      const fragType = ctx.schema.getType(fragment.typeCondition.name.value);
      if (!fragType || !isCompositeType(fragType)) {
        throw new AnalysisError(
          'VALIDATION_ERROR',
          `Fragment "${selection.name.value}" has invalid type condition "${fragment.typeCondition.name.value}"`,
        );
      }
      // A fragment only contributes work where its type condition can overlap
      // the current runtime parent type.
      if (!doTypesOverlap(ctx.schema, fragType, parentType)) continue;

      ctx.fragmentStack.add(selection.name.value);
      try {
        const frag = walkSelectionSet(
          fragment.selectionSet,
          fragType,
          parentPath,
          depth,
          ctx,
        );
        nodes.push(...frag.nodes);
        subtreeCost = saturate(subtreeCost + frag.subtreeCost, ctx.pricing.costCeiling);
        resolutions += frag.resolutions;
        staticFieldCount += frag.staticFieldCount;
        maxDepth = Math.max(maxDepth, frag.maxDepth);
      } finally {
        ctx.fragmentStack.delete(selection.name.value);
      }
    } else {
      // INLINE_FRAGMENT
      let fragType: GraphQLCompositeType = parentType;
      if (selection.typeCondition) {
        const t = ctx.schema.getType(selection.typeCondition.name.value);
        if (!t || !isCompositeType(t)) {
          throw new AnalysisError(
            'VALIDATION_ERROR',
            `Inline fragment has invalid type condition "${selection.typeCondition.name.value}"`,
          );
        }
        if (!doTypesOverlap(ctx.schema, t, parentType)) continue;
        fragType = t;
      }
      const frag = walkSelectionSet(
        selection.selectionSet,
        fragType,
        parentPath,
        depth,
        ctx,
      );
      nodes.push(...frag.nodes);
      subtreeCost = saturate(subtreeCost + frag.subtreeCost, ctx.pricing.costCeiling);
      resolutions += frag.resolutions;
      staticFieldCount += frag.staticFieldCount;
      maxDepth = Math.max(maxDepth, frag.maxDepth);
    }
  }

  for (const [fieldName, group] of aliasGroups) {
    if (group.length <= 1) continue;
    const first = group[0]!;
    ctx.aliasDuplicates.push({
      path: first.path,
      typeName: first.typeName,
      fieldName,
      aliases: group.map((g) => g.alias ?? g.fieldName),
      count: group.length,
      subtreeCostEach: first.subtreeCost,
    });
  }

  return { nodes, subtreeCost, resolutions, staticFieldCount, maxDepth };
}

function walkField(
  field: FieldNode,
  parentType: GraphQLCompositeType,
  parentPath: string,
  depth: number,
  ctx: WalkContext,
): InternalNode {
  const { pricing } = ctx;
  const fieldName = field.name.value;
  const responseKey = field.alias?.value ?? fieldName;
  const path = `${parentPath}.${responseKey}`;
  const parentTypeName = parentType.name;

  // ---- Meta fields -------------------------------------------------------
  if (fieldName.startsWith('__')) {
    if (fieldName === '__typename') {
      return {
        path,
        typeName: parentTypeName,
        fieldName,
        alias: field.alias?.value,
        kind: 'meta',
        selfCost: pricing.typenameCost,
        subtreeCost: pricing.typenameCost,
        estimatedResolutions: 1,
        staticFieldCount: 1,
        depth: depth + 1,
        children: [],
      };
    }
    // __schema / __type — full schema introspection. The inner selection set
    // is walked against the introspection field's own return type (__Schema /
    // __Type), not the query root.
    const queryRoot = ctx.schema.getQueryType();
    const introFieldDef = queryRoot?.getFields()[fieldName];
    const intro: InternalNode = {
      path,
      typeName: parentTypeName,
      fieldName,
      alias: field.alias?.value,
      kind: 'meta',
      selfCost: pricing.introspectionCost,
      subtreeCost: pricing.introspectionCost,
      estimatedResolutions: 1,
      staticFieldCount: 1,
      depth: depth + 1,
      children: [],
    };
    if (field.selectionSet && queryRoot && introFieldDef) {
      const innerType = getNamedType(introFieldDef.type);
      if (isCompositeType(innerType)) {
        const inner = walkSelectionSet(
          field.selectionSet,
          innerType,
          path,
          depth + 1,
          ctx,
        );
        intro.children = inner.nodes;
        intro.subtreeCost = saturate(
          intro.selfCost + inner.subtreeCost,
          pricing.costCeiling,
        );
        intro.estimatedResolutions += inner.resolutions;
        intro.staticFieldCount += inner.staticFieldCount;
        intro.depth = Math.max(intro.depth, inner.maxDepth);
      }
    }
    return intro;
  }

  if (!isObjectType(parentType) && !isInterfaceType(parentType)) {
    // Unions only expose __typename and typed fragments.
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Cannot select field "${fieldName}" on union type "${parentTypeName}" (use an inline fragment)`,
    );
  }

  const fieldDef = parentType.getFields()[fieldName];
  if (!fieldDef) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Cannot query field "${fieldName}" on type "${parentTypeName}" at ${path}`,
    );
  }

  const rawType: GraphQLType = fieldDef.type;
  const namedType = getNamedType(rawType);
  const fieldIsList = containsList(rawType);
  const args = resolveArguments(field, ctx.variables);

  // ---- Leaf fields (scalars / enums), including lists of them ------------
  if (isLeafType(namedType)) {
    if (field.selectionSet) {
      throw new AnalysisError(
        'VALIDATION_ERROR',
        `Field "${fieldName}" on type "${parentTypeName}" is a leaf (${namedType.name}) but has a selection set`,
      );
    }

    if (!fieldIsList) {
      const selfCost = pricing.scalarCost;
      return {
        path,
        typeName: parentTypeName,
        fieldName,
        alias: field.alias?.value,
        kind: 'scalar',
        selfCost,
        subtreeCost: selfCost,
        estimatedResolutions: 1,
        staticFieldCount: 1,
        depth: depth + 1,
        children: [],
      };
    }

    // A list of scalars still forces the backend to resolve every element,
    // so pagination drives fan-out here as well.
    const page = resolvePagination(field, args, ctx);
    const effective = page?.effective ?? pricing.defaultPageSize;
    recordPagination(ctx, path, page, effective);
    const fanOut = Math.max(1, effective);
    const base = baseCostOf(parentTypeName, fieldName, true, pricing);
    const selfCost = saturate(
      base + satMul(pricing.listPerElementCost, fanOut, pricing.costCeiling),
      pricing.costCeiling,
    );
    return {
      path,
      typeName: parentTypeName,
      fieldName,
      alias: field.alias?.value,
      kind: 'list',
      selfCost,
      subtreeCost: selfCost,
      estimatedResolutions: fanOut,
      staticFieldCount: 1,
      depth: depth + 1,
      pageSize: fanOut,
      children: [],
    };
  }

  // ---- Composite (object / interface / union) ----------------------------
  if (!isCompositeType(namedType)) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Field "${fieldName}" resolves to an unsupported type at ${path}`,
    );
  }
  if (!field.selectionSet) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Field "${fieldName}" on type "${parentTypeName}" is an object type (${namedType.name}) and needs a selection set`,
    );
  }

  // Resolve this field's own fan-out before descending, so pagination
  // evidence is recorded in top-to-bottom query order.
  let fanOut = 1;
  let pageSize: number | undefined;
  let selfCost: number;

  if (fieldIsList) {
    const page = resolvePagination(field, args, ctx);
    const effective = page?.effective ?? pricing.defaultPageSize;
    recordPagination(ctx, path, page, effective);
    fanOut = Math.max(1, effective);
    pageSize = effective;
    selfCost = saturate(
      baseCostOf(parentTypeName, fieldName, true, pricing) +
        satMul(pricing.listPerElementCost, fanOut, pricing.costCeiling),
      pricing.costCeiling,
    );
  } else {
    selfCost = baseCostOf(parentTypeName, fieldName, false, pricing);
  }

  const childWalk = walkSelectionSet(
    field.selectionSet,
    namedType,
    path,
    depth + 1,
    ctx,
  );

  // Every descendant selection runs once per parent row — the nested fan-out
  // multiplication that makes deep nested queries catastrophic.
  const subtreeCost = saturate(
    satMul(selfCost + childWalk.subtreeCost, fanOut, pricing.costCeiling),
    pricing.costCeiling,
  );

  return {
    path,
    typeName: parentTypeName,
    fieldName,
    alias: field.alias?.value,
    kind: fieldIsList ? 'list' : 'object',
    selfCost,
    subtreeCost,
    estimatedResolutions: satMul(
      1 + childWalk.resolutions,
      fanOut,
      pricing.costCeiling,
    ),
    staticFieldCount: 1 + childWalk.staticFieldCount,
    depth: childWalk.maxDepth,
    pageSize,
    children: childWalk.nodes,
  };
}

function recordPagination(
  ctx: WalkContext,
  path: string,
  page: PaginationResolution | null,
  effective: number,
): void {
  const info: PaginationInfo = page
    ? {
        path,
        argName: page.argName,
        requested: page.requested,
        effective: page.effective,
        cappedToMax: page.capped,
        fromVariable: page.fromVariable,
      }
    : {
        path,
        argName: 'default',
        effective,
        cappedToMax: false,
        fromVariable: false,
      };
  ctx.pagination.push(info);
}

function toSerializable(node: InternalNode): CostNode {
  return {
    path: node.path,
    typeName: node.typeName,
    fieldName: node.fieldName,
    alias: node.alias,
    kind: node.kind,
    selfCost: node.selfCost,
    subtreeCost: node.subtreeCost,
    estimatedResolutions: node.estimatedResolutions,
    staticFieldCount: node.staticFieldCount,
    depth: node.depth,
    pageSize: node.pageSize,
    children: node.children.map(toSerializable),
  };
}

function flatten(node: InternalNode): InternalNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function explain(node: InternalNode): string {
  if (node.kind === 'list') {
    return `list field ×${node.pageSize ?? 1} rows, ${node.children.length} selected field(s) per row`;
  }
  if (node.kind === 'meta') return `introspection/meta field "${node.fieldName}"`;
  if (node.kind === 'object') {
    return `object materialisation with ${node.children.length} selected field(s)`;
  }
  return `scalar field "${node.fieldName}"`;
}

function analyzeOperation(
  doc: DocumentNode,
  operation: OperationDefinitionNode,
  input: AnalysisInput,
): QueryCostSummary {
  const rootType =
    operation.operation === 'mutation'
      ? input.schema.getMutationType()
      : operation.operation === 'subscription'
        ? input.schema.getSubscriptionType()
        : input.schema.getQueryType();

  if (!rootType) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Schema does not support ${operation.operation} operations`,
    );
  }

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }

  const ctx: WalkContext = {
    schema: input.schema,
    pricing: input.pricing,
    fragments,
    variables: input.variables ?? {},
    pagination: [],
    aliasDuplicates: [],
    fragmentStack: new Set(),
  };

  const walked = walkSelectionSet(
    operation.selectionSet,
    rootType as GraphQLObjectType,
    rootType.name,
    0,
    ctx,
  );

  const root: InternalNode = {
    path: rootType.name,
    typeName: rootType.name,
    fieldName: rootType.name,
    kind: 'object',
    selfCost: 0,
    subtreeCost: walked.subtreeCost,
    estimatedResolutions: walked.resolutions,
    staticFieldCount: walked.staticFieldCount,
    depth: walked.maxDepth,
    children: walked.nodes,
  };

  // De-duplicate alias groups that repeat through fragment expansion.
  const seenAlias = new Set<string>();
  const aliasDuplicates = ctx.aliasDuplicates.filter((d) => {
    const key = `${d.path}:${d.aliases.join(',')}`;
    if (seenAlias.has(key)) return false;
    seenAlias.add(key);
    return true;
  });

  const maxPageSizeRequested = ctx.pagination.reduce<number | undefined>(
    (max, p) => Math.max(max ?? 0, p.requested ?? p.effective),
    undefined,
  );

  const topContributors = flatten(root)
    .filter((n) => n.path !== root.path)
    .sort((a, b) => b.subtreeCost - a.subtreeCost)
    .slice(0, 5)
    .map((n) => ({ path: n.path, subtreeCost: n.subtreeCost, reason: explain(n) }));

  return {
    totalCost: root.subtreeCost,
    totalEstimatedResolutions: root.estimatedResolutions,
    staticFieldCount: root.staticFieldCount,
    maxDepth: root.depth,
    maxPageSizeRequested,
    pagination: ctx.pagination,
    aliasDuplicates,
    topContributors,
    costTree: toSerializable(root),
  };
}

/**
 * Estimate how much backend work a GraphQL request will cause, before the
 * request is executed. Throws {@link AnalysisError} on parse/validation/page
 * problems; quota enforcement lives in the gateway layer.
 */
export function analyzeQueryCost(input: AnalysisInput): QueryCostSummary {
  let doc: DocumentNode;
  try {
    doc = parse(input.query);
  } catch (err) {
    throw new AnalysisError(
      'PARSE_ERROR',
      err instanceof Error ? err.message : String(err),
    );
  }

  const operations = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length === 0) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      'Request contains no executable operation',
    );
  }

  let operation: OperationDefinitionNode;
  if (input.operationName) {
    const found = operations.find((op) => op.name?.value === input.operationName);
    if (!found) {
      throw new AnalysisError(
        'VALIDATION_ERROR',
        `Unknown operation name "${input.operationName}"`,
      );
    }
    operation = found;
  } else if (operations.length === 1) {
    operation = operations[0]!;
  } else {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      'Request contains multiple operations; operationName is required',
    );
  }

  const summary = analyzeOperation(doc, operation, input);

  if (summary.maxDepth > input.maxDepth) {
    throw new AnalysisError(
      'VALIDATION_ERROR',
      `Query depth ${summary.maxDepth} exceeds the maximum allowed depth of ${input.maxDepth}`,
    );
  }

  return summary;
}
