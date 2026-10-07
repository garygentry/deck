import type { JsonValue } from "@deck/schema";
import { DRIFT_UI_DEFAULTS } from "./ordering.js";
import { DriftProjectionError } from "./types.js";
import type { EvidencePreview, EvidencePreviewLimits, EvidencePreviewReason, ReadonlyJsonValue } from "./types.js";

/** Fixed inert marker placed where a branch is omitted from the preview. */
const TRUNCATION_MARKER = "… truncated …";

/** One reusable UTF-8 encoder; measurement never allocates a new encoder per node. */
const ENCODER = new TextEncoder();

/** Internal sentinel distinguishing an omitted branch from a real data string. */
class OmittedBranch {}

/** Wrapper for a terminal marker-prefix string so it is finalized as raw text. */
class PreviewString {
  constructor(readonly text: string) {}
}

/** Ordinal (code-point) key comparison; never locale-sensitive. */
function compareCodePoints(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Throw the fixed non-JSON failure without leaking the value, key path, or cause. */
function invalidJson(): never {
  throw new DriftProjectionError("INVALID_INPUT", "Evidence value must be valid JSON data.");
}

/** UTF-8 byte length of an already-built serialization chunk. */
function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * Iteratively serialize a validated JSON value into canonical form while
 * measuring its UTF-8 byte length and greatest zero-based value depth. Rejects
 * cycles, non-finite numbers, and non-JSON runtime values defensively.
 */
function measureCanonical(root: unknown): { readonly bytes: number; readonly depth: number } {
  const chunks: string[] = [];
  let maxDepth = 0;
  const ancestors = new Set<object>();

  type Task =
    | { readonly kind: "value"; readonly value: unknown; readonly depth: number }
    | { readonly kind: "raw"; readonly text: string }
    | { readonly kind: "close"; readonly text: string; readonly obj: object };

  const stack: Task[] = [{ kind: "value", value: root, depth: 0 }];

  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.kind === "raw") {
      chunks.push(task.text);
      continue;
    }
    if (task.kind === "close") {
      ancestors.delete(task.obj);
      chunks.push(task.text);
      continue;
    }

    const { value, depth } = task;
    if (depth > maxDepth) maxDepth = depth;

    if (value === null) {
      chunks.push("null");
      continue;
    }
    const type = typeof value;
    if (type === "string") {
      chunks.push(JSON.stringify(value));
      continue;
    }
    if (type === "number") {
      if (!Number.isFinite(value)) invalidJson();
      chunks.push(JSON.stringify(value));
      continue;
    }
    if (type === "boolean") {
      chunks.push(value ? "true" : "false");
      continue;
    }
    if (type !== "object") invalidJson(); // undefined, function, symbol, bigint

    const obj = value as object;
    if (ancestors.has(obj)) invalidJson();

    if (Array.isArray(obj)) {
      chunks.push("[");
      ancestors.add(obj);
      stack.push({ kind: "close", text: "]", obj });
      for (let i = obj.length - 1; i >= 0; i--) {
        if (i > 0) stack.push({ kind: "raw", text: "," });
        stack.push({ kind: "value", value: obj[i], depth: depth + 1 });
      }
      continue;
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) invalidJson();

    const keys = Object.keys(obj).sort(compareCodePoints);
    chunks.push("{");
    ancestors.add(obj);
    stack.push({ kind: "close", text: "}", obj });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const nested = (obj as Record<string, unknown>)[key];
      if (nested === undefined) invalidJson();
      if (i > 0) stack.push({ kind: "raw", text: "," });
      stack.push({ kind: "value", value: nested, depth: depth + 1 });
      stack.push({ kind: "raw", text: `${JSON.stringify(key)}:` });
    }
  }

  return { bytes: byteLength(chunks.join("")), depth: maxDepth };
}

/**
 * Iteratively build an independently owned copy of the value with object keys
 * in ordinal order. Any value that would appear at `depth > maxDepth` is
 * replaced by an omitted-branch sentinel and its subtree is not descended.
 */
function buildBoundedCopy(root: unknown, maxDepth: number): unknown {
  const holder: { value: unknown } = { value: undefined };
  type Frame = { readonly value: unknown; readonly depth: number; readonly place: (built: unknown) => void };
  const stack: Frame[] = [{ value: root, depth: 0, place: (built) => (holder.value = built) }];

  while (stack.length > 0) {
    const { value, depth, place } = stack.pop()!;
    if (depth > maxDepth) {
      place(new OmittedBranch());
      continue;
    }
    if (value === null || typeof value !== "object") {
      place(value);
      continue;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = new Array(value.length);
      place(copy);
      for (let i = value.length - 1; i >= 0; i--) {
        const index = i;
        stack.push({ value: value[index], depth: depth + 1, place: (built) => (copy[index] = built) });
      }
      continue;
    }
    const copy: Record<string, unknown> = {};
    place(copy);
    const keys = Object.keys(value as Record<string, unknown>).sort(compareCodePoints);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      stack.push({
        value: (value as Record<string, unknown>)[key],
        depth: depth + 1,
        place: (built) => (copy[key] = built),
      });
    }
  }

  return holder.value;
}

/** Serialize a working preview tree (marker-aware); the tree is acyclic and pre-sorted. */
function serializePreview(root: unknown): string {
  const chunks: string[] = [];
  type Task = { readonly kind: "value"; readonly value: unknown } | { readonly kind: "raw"; readonly text: string };
  const stack: Task[] = [{ kind: "value", value: root }];

  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.kind === "raw") {
      chunks.push(task.text);
      continue;
    }
    const value = task.value;
    if (value instanceof OmittedBranch) {
      chunks.push(JSON.stringify(TRUNCATION_MARKER));
      continue;
    }
    if (value === null) {
      chunks.push("null");
      continue;
    }
    if (typeof value !== "object") {
      chunks.push(JSON.stringify(value));
      continue;
    }
    if (Array.isArray(value)) {
      chunks.push("[");
      stack.push({ kind: "raw", text: "]" });
      for (let i = value.length - 1; i >= 0; i--) {
        if (i > 0) stack.push({ kind: "raw", text: "," });
        stack.push({ kind: "value", value: value[i] });
      }
      continue;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    chunks.push("{");
    stack.push({ kind: "raw", text: "}" });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      if (i > 0) stack.push({ kind: "raw", text: "," });
      stack.push({ kind: "value", value: (value as Record<string, unknown>)[key] });
      stack.push({ kind: "raw", text: `${JSON.stringify(key)}:` });
    }
  }

  return chunks.join("");
}

/** One replaceable non-marker node found while scanning the working tree. */
interface Candidate {
  readonly depth: number;
  readonly order: number;
  readonly replace: () => void;
}

/**
 * Collect every non-marker node in canonical traversal order with the means to
 * replace it in-place with an omitted-branch marker.
 */
function collectCandidates(holder: { value: unknown }): Candidate[] {
  const candidates: Candidate[] = [];
  let order = 0;
  type Frame = { readonly value: unknown; readonly depth: number; readonly replace: () => void };
  // Use a queue processed in canonical order so `order` increases with position.
  const queue: Frame[] = [{ value: holder.value, depth: 0, replace: () => (holder.value = new OmittedBranch()) }];

  for (let head = 0; head < queue.length; head++) {
    const { value, depth, replace } = queue[head]!;
    if (value instanceof OmittedBranch) continue;
    candidates.push({ depth, order: order++, replace });
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const index = i;
        queue.push({ value: value[index], depth: depth + 1, replace: () => (value[index] = new OmittedBranch()) });
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      queue.push({ value: record[key], depth: depth + 1, replace: () => (record[key] = new OmittedBranch()) });
    }
  }

  return candidates;
}

/** Longest ordinal prefix of the marker whose JSON string fits within `maxBytes`. */
function markerPrefixWithin(maxBytes: number): string {
  let fitted = "";
  for (let length = 0; length <= TRUNCATION_MARKER.length; length++) {
    const candidate = TRUNCATION_MARKER.slice(0, length);
    if (byteLength(JSON.stringify(candidate)) <= maxBytes) fitted = candidate;
    else break;
  }
  return fitted;
}

/** Replace every omitted-branch sentinel with the marker string and freeze the tree. */
function finalizePreview(root: unknown): ReadonlyJsonValue {
  if (root instanceof OmittedBranch) return TRUNCATION_MARKER;
  if (root === null || typeof root !== "object") return root as ReadonlyJsonValue;

  const stack: object[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child instanceof OmittedBranch) node[i] = TRUNCATION_MARKER;
        else if (child !== null && typeof child === "object") stack.push(child);
      }
    } else {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const child = record[key];
        if (child instanceof OmittedBranch) record[key] = TRUNCATION_MARKER;
        else if (child !== null && typeof child === "object") stack.push(child);
      }
    }
    Object.freeze(node);
  }

  return root as ReadonlyJsonValue;
}

/** Validate one optional limit as a finite, non-negative safe integer. */
function resolveLimit(supplied: number | undefined, fallback: number): number {
  if (supplied === undefined) return fallback;
  if (!Number.isSafeInteger(supplied) || supplied < 0) {
    throw new DriftProjectionError(
      "INVALID_INPUT",
      "Evidence preview limits must be non-negative safe integers.",
    );
  }
  return supplied;
}

/**
 * Measure JSON evidence and return a deterministic bounded structural preview
 * with the exact supplied value retained for on-demand full inspection.
 *
 * @param value - Exact supplied JSON evidence value.
 * @param limits - Optional depth/byte bounds; omitted bounds use release defaults.
 * @returns The bounded inert preview, exact `fullValue`, truncation reasons, and
 * full-value byte and depth measurements.
 * @throws {DriftProjectionError} `INVALID_INPUT` for invalid limits or for a
 * cyclic/non-JSON runtime value, without leaking the value or exception text.
 */
export function buildEvidencePreview(value: JsonValue, limits?: EvidencePreviewLimits): EvidencePreview {
  const maxDepth = resolveLimit(limits?.maxDepth, DRIFT_UI_DEFAULTS.evidenceMaxDepth);
  const maxBytes = resolveLimit(limits?.maxBytes, DRIFT_UI_DEFAULTS.evidenceMaxBytes);

  // Measure (and validate) the full value first so cyclic/non-JSON input throws
  // the fixed error before any preview work.
  const { bytes: serializedBytes, depth: observedDepth } = measureCanonical(value);

  const depthExceeded = observedDepth > maxDepth;
  const bytesExceeded = serializedBytes > maxBytes;
  const reasons: EvidencePreviewReason[] = [];
  if (depthExceeded) reasons.push("depth");
  if (bytesExceeded) reasons.push("bytes");

  // Depth-bounded, key-sorted, independently owned copy of the value.
  const holder = { value: buildBoundedCopy(value, maxDepth) };

  // Byte reduction: replace the deepest (then latest) non-marker subtree until
  // the canonical serialization fits, or only the root marker remains.
  let currentBytes = byteLength(serializePreview(holder.value));
  while (currentBytes > maxBytes) {
    const candidates = collectCandidates(holder);
    if (candidates.length === 0) break;
    let best = candidates[0]!;
    for (const candidate of candidates) {
      if (candidate.depth > best.depth || (candidate.depth === best.depth && candidate.order > best.order)) {
        best = candidate;
      }
    }
    best.replace();
    currentBytes = byteLength(serializePreview(holder.value));
  }

  // Terminal fallback: even the root marker cannot fit, so degrade to a marker
  // prefix (possibly "") or JSON null for sub-2-byte limits.
  if (currentBytes > maxBytes && holder.value instanceof OmittedBranch) {
    holder.value = maxBytes < 2 ? null : new PreviewString(markerPrefixWithin(maxBytes));
  }

  const preview =
    holder.value instanceof PreviewString
      ? (holder.value.text as ReadonlyJsonValue)
      : finalizePreview(holder.value);

  return Object.freeze({
    preview,
    fullValue: value as ReadonlyJsonValue,
    truncated: depthExceeded || bytesExceeded,
    reasons: Object.freeze(reasons),
    serializedBytes,
    observedDepth,
  });
}
