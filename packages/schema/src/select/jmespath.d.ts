// Types for the vendored jmespath.js 0.16.0 (see jmespath.js): the parts deck uses.

/** A parsed expression: a tree of `{ type, name?, value?, children? }` nodes. */
export interface JmesNode {
  type: string;
  name?: string;
  value?: unknown;
  children?: JmesNode[];
}

export interface JmesSignatureEntry {
  types: number[];
  variadic?: boolean;
  optional?: boolean;
}

export interface JmesFunctionEntry {
  _func: (this: Runtime, resolvedArgs: unknown[]) => unknown;
  _signature: JmesSignatureEntry[];
}

/** Parse an expression; throws a `ParserError`/`LexerError` with a message. */
export function compile(expression: string): JmesNode;
export function search(data: unknown, expression: string): unknown;

export class Runtime {
  constructor(interpreter?: TreeInterpreter);
  _interpreter: TreeInterpreter;
  /** The work meter: a no-op unless replaced; it throws to stop an evaluation. */
  charge(cost: number): void;
  functionTable: Record<string, JmesFunctionEntry>;
  callFunction(name: string, resolvedArgs: unknown[]): unknown;
}

export class TreeInterpreter {
  constructor(runtime: Runtime);
  runtime: Runtime;
  search(node: JmesNode, value: unknown): unknown;
  visit(node: JmesNode, value: unknown): unknown;
}
