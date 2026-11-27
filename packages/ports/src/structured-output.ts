/**
 * Checks a JSON Schema against what Anthropic's structured output (output_config.format, json_schema)
 * accepts, so a schema that would be refused with a 400 fails a test instead of a live call.
 *
 * Source: platform.claude.com/docs/en/build-with-claude/structured-outputs, "JSON Schema limitations",
 * read 2026-11-27. Fail closed: any keyword not on the supported list is a problem.
 *
 * Returns a list of problems (empty = fine), each with the path where it was found.
 */

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "$ref",
  "$defs",
  "definitions",
  "default",
  "format",
  "minItems",
  "pattern",
  // Annotations
  "title",
  "description",
]);

const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);
/** Keywords that mean "this schema constrains something": a schema with none of them accepts anything. */
const CONSTRAINING = ["type", "enum", "const", "anyOf", "allOf", "$ref"];

export const STRUCTURED_OUTPUT_LIMITS = { optional_params: 24, union_params: 16 } as const;

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

export function structuredOutputProblems(root: unknown): string[] {
  const problems: string[] = [];
  let optional = 0;
  let unions = 0;
  if (!isObj(root)) return ["$: schema is not an object"];
  const defs: Schema = {
    ...(isObj(root.$defs) ? root.$defs : {}),
    ...(isObj(root.definitions) ? root.definitions : {}),
  };

  const walk = (s: unknown, path: string, refStack: string[]) => {
    if (!isObj(s)) {
      problems.push(`${path}: schema is not an object`);
      return;
    }
    const keys = Object.keys(s);
    if (!CONSTRAINING.some((k) => k in s))
      problems.push(`${path}: empty schema (accepts any JSON value; give it a concrete type)`);
    for (const k of keys)
      if (!SUPPORTED_KEYWORDS.has(k)) problems.push(`${path}: unsupported keyword "${k}"`);

    const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
    for (const t of types)
      if (typeof t !== "string" || !TYPES.has(t))
        problems.push(`${path}: unknown type ${String(t)}`);
    if (Array.isArray(s.type) && s.type.length > 1) unions++;

    if (types.includes("object") || "properties" in s) {
      if (s.additionalProperties !== false)
        problems.push(`${path}: objects must set additionalProperties: false`);
      const props = isObj(s.properties) ? s.properties : {};
      if (Object.keys(props).length === 0)
        problems.push(`${path}: object lists no properties (the model could only return {})`);
      const required = Array.isArray(s.required) ? s.required : [];
      for (const r of required)
        if (!(String(r) in props))
          problems.push(`${path}: required "${String(r)}" is not a property`);
      for (const [name, sub] of Object.entries(props)) {
        if (!required.includes(name)) optional++;
        walk(sub, `${path}.properties.${name}`, refStack);
      }
    } else if ("additionalProperties" in s || "required" in s) {
      problems.push(`${path}: additionalProperties/required on a non-object schema`);
    }

    if ("items" in s) walk(s.items, `${path}.items`, refStack);
    if ("minItems" in s && s.minItems !== 0 && s.minItems !== 1)
      problems.push(`${path}: minItems must be 0 or 1 (got ${String(s.minItems)})`);

    for (const k of ["enum", "const"] as const) {
      if (!(k in s)) continue;
      const vals = k === "enum" ? s.enum : [s.const];
      if (!Array.isArray(vals) || vals.some((v) => !isPrimitive(v)))
        problems.push(`${path}: ${k} values must be strings, numbers, booleans or null`);
    }

    if ("format" in s && !FORMATS.has(String(s.format)))
      problems.push(`${path}: unsupported string format "${String(s.format)}"`);
    if ("pattern" in s) {
      const p = String(s.pattern);
      if (/\(\?[=!<]|\\[1-9]|\\[bB]|\\k</.test(p))
        problems.push(`${path}: pattern uses lookaround, backreference or word boundary`);
    }

    if ("anyOf" in s) {
      unions++;
      if ("type" in s || "properties" in s)
        problems.push(`${path}: anyOf in the same schema as type/properties`);
      if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) problems.push(`${path}: anyOf is empty`);
      else for (const [i, b] of s.anyOf.entries()) walk(b, `${path}.anyOf[${i}]`, refStack);
    }
    if ("allOf" in s) {
      const parts = Array.isArray(s.allOf) ? s.allOf : [];
      if (parts.length === 0) problems.push(`${path}: allOf is empty`);
      const partTypes = new Set(parts.filter(isObj).map((p) => JSON.stringify(p.type ?? null)));
      partTypes.delete("null");
      if (partTypes.size > 1) problems.push(`${path}: allOf with conflicting types`);
      if (
        parts.length >= 2 &&
        parts.some((p) => isObj(p) && ("$ref" in p || "anyOf" in p || "allOf" in p))
      )
        problems.push(`${path}: allOf of 2+ schemas where one contains $ref/anyOf/allOf`);
      for (const [i, p] of parts.entries()) walk(p, `${path}.allOf[${i}]`, refStack);
    }
    if ("$ref" in s) {
      const ref = String(s.$ref);
      const m = ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
      if (!m) problems.push(`${path}: $ref "${ref}" is not a local #/$defs reference`);
      else if (refStack.includes(ref)) problems.push(`${path}: recursive schema via ${ref}`);
      else if (!(String(m[2]) in defs)) problems.push(`${path}: $ref "${ref}" not found`);
      else walk(defs[String(m[2])], `${path}->${ref}`, [...refStack, ref]);
    }
  };

  walk(root, "$", []);
  if (optional > STRUCTURED_OUTPUT_LIMITS.optional_params)
    problems.push(
      `$: ${optional} optional properties (limit ${STRUCTURED_OUTPUT_LIMITS.optional_params})`,
    );
  if (unions > STRUCTURED_OUTPUT_LIMITS.union_params)
    problems.push(
      `$: ${unions} union-typed parameters (limit ${STRUCTURED_OUTPUT_LIMITS.union_params})`,
    );
  return problems;
}
