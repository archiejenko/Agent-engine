import type { Tolerance } from "@ae/contracts";
import { canonicalJson } from "./ids.ts";

/** Do two values agree within the field's tolerance? All maths in code. */
export function agree(a: unknown, b: unknown, tolerance: Tolerance): boolean {
  if (tolerance.kind === "exact") return canonicalJson(a) === canonicalJson(b);
  if (typeof a !== "number" || typeof b !== "number") return canonicalJson(a) === canonicalJson(b);
  if (tolerance.kind === "absolute") return Math.abs(a - b) <= tolerance.value;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) / scale <= tolerance.value + 1e-12;
}
