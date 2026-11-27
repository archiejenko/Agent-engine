import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every .ts/.tsx file under a folder. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Comments removed (string contents kept: URLs live there). */
export const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** URL with ${...} parts replaced by ":x", quotes removed. */
const norm = (lit: string) => lit.slice(1, -1).replace(/\$\{[^}]*\}/g, ":x");

/**
 * Every write request in a file: fetch(url, { ... method: "POST" ... }) and calls to the
 * dashboard's post(url, ...) helpers. Returns normalised URLs.
 */
export function writeUrls(src: string): string[] {
  const s = stripComments(src);
  const out: string[] = [];
  const lit = String.raw`(\x60[^\x60]*\x60|"[^"]*")`;
  for (const m of s.matchAll(
    new RegExp(String.raw`fetch\(\s*${lit}\s*,\s*\{([\s\S]{0,300}?)\}`, "g"),
  ))
    if (/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(m[2] ?? "")) out.push(norm(m[1] as string));
  // post("/api/…") helpers; a bare word is a path suffix already counted in its helper's fetch.
  for (const m of s.matchAll(new RegExp(String.raw`\bpost\(\s*${lit}`, "g")))
    if (norm(m[1] as string).startsWith("/")) out.push(norm(m[1] as string));
  return out;
}

const MONEY = String.raw`(?:[\w.?]*_gbp\b|\.(?:value|previous|change|spark|ci95)\b(?:\[\d\])?)`;
const OP = String.raw`(?<![=!<>])[-+*/%](?![=>+\-])`;
/** Arithmetic next to a money field, or Math.* applied to one. */
export const MONEY_MATHS = new RegExp(
  String.raw`${MONEY}\)?\s*${OP}|${OP}\s*\(?\s*[\w.?()]*${MONEY}|[-+*/%]=\s*[\w.?()]*${MONEY}|Math\.\w+\([^)]*${MONEY}`,
);

/** A template literal reduced to its ${...} expressions (its text can't do arithmetic). */
const templateExprs = (t: string) => [...t.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(" ; ");

/** Lines of a file that do arithmetic on money fields (string text blanked first). */
export function moneyMaths(src: string): string[] {
  return stripComments(src)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\x60[^\x60]*\x60/g, templateExprs)
    .split("\n")
    .filter((l) => MONEY_MATHS.test(l));
}
