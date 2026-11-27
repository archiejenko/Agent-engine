import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadFieldRegistry } from "@ae/config";
import { IDEA_ANSWER_SCHEMA } from "@ae/infra";
import { structuredOutputProblems } from "@ae/ports";
import { buildExtractSchema, WEBSITE_EXTRACT } from "@ae/verification";
import { describe, expect, it } from "vitest";

/**
 * Every structured-output schema we send to a model must be one Anthropic's structured output accepts
 * (Opus 5.5 is the production default). A schema it rejects fails every call with a 400 — that is how
 * the website extractor's v1 `value: {}` broke the Opus side of the extractor comparison.
 */

/** Every schema any model call sends, by the expression the call site uses. */
const SENT_SCHEMAS: Record<string, unknown> = {
  "WEBSITE_EXTRACT.schema": WEBSITE_EXTRACT.schema,
  IDEA_ANSWER_SCHEMA: IDEA_ANSWER_SCHEMA,
};

const ROOT = join(import.meta.dirname, "..");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".wrangler"].includes(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const sources = ["apps", "packages", "scripts"]
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => relative(ROOT, p))
  .filter(
    (p) =>
      !/\.test\.tsx?$/.test(p) &&
      !p.includes("/__tests__/") &&
      !p.endsWith("worker-configuration.d.ts") &&
      // The model port's own type declaration, not a call site.
      p !== "packages/ports/src/model.ts",
  );

describe("structured-output schemas we send (Anthropic limits)", () => {
  for (const [name, schema] of Object.entries(SENT_SCHEMAS))
    it(`${name} is accepted`, () => {
      expect(structuredOutputProblems(schema)).toEqual([]);
    });

  it("every json_schema sent anywhere is one of the checked schemas", () => {
    const unchecked: string[] = [];
    for (const file of sources) {
      const text = readFileSync(join(ROOT, file), "utf8");
      // `json_schema: <expr>` property assignments, and the `{ json_schema }` shorthand.
      for (const m of text.matchAll(/(?<![\w."'])json_schema\s*:\s*([^,\n}]+)/g)) {
        const expr = (m[1] ?? "").trim();
        if (!(expr in SENT_SCHEMAS)) unchecked.push(`${file}: json_schema: ${expr}`);
      }
      for (const _ of text.matchAll(/[{,]\s*json_schema\s*[,}]/g))
        unchecked.push(`${file}: json_schema shorthand (use a checked schema constant)`);
    }
    expect(unchecked).toEqual([]);
  });

  it("the extractor types each field's value from the field registry", () => {
    const s = WEBSITE_EXTRACT.schema as {
      properties: { facts: { items: { anyOf: { properties: Record<string, unknown> }[] } } };
    };
    const byField = Object.fromEntries(
      s.properties.facts.items.anyOf.map((b) => [
        (b.properties.field as { enum: string[] }).enum[0],
        b.properties.value,
      ]),
    );
    expect(byField).toEqual({
      company_number: { type: "string" },
      trading_address_postcode: { type: "string" },
      contact_email: { type: "string" },
      job_postings: { type: "array", items: { type: "string" } },
    });
    expect(WEBSITE_EXTRACT.version).toBe(2);
  });

  it("the extractor schema follows the registry, and refuses a field typed as an object", () => {
    const reg = loadFieldRegistry();
    const asNumber = new Map(reg);
    const def = reg.get("website_company_number");
    if (!def) throw new Error("missing registry entry");
    asNumber.set("website_company_number", { ...def, value_type: "integer" });
    expect(JSON.stringify(buildExtractSchema(["company_number"], asNumber))).toContain(
      '"value":{"type":"integer"}',
    );
    asNumber.set("website_company_number", { ...def, value_type: "object" });
    expect(() => buildExtractSchema(["company_number"], asNumber)).toThrow(/can't be extracted/);
    expect(() => buildExtractSchema(["not_a_field"], reg)).toThrow(/no field-registry entry/);
  });
});

describe("structuredOutputProblems: what Anthropic's structured output rejects", () => {
  const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    ...extra,
  });
  const bad: [string, unknown, RegExp][] = [
    ["empty schema {}", obj({ value: {} }), /empty schema/],
    ["description-only schema", obj({ value: { description: "x" } }), /empty schema/],
    [
      "missing additionalProperties",
      { type: "object", properties: { a: { type: "string" } } },
      /additionalProperties: false/,
    ],
    [
      "additionalProperties true",
      obj({ a: { type: "string" } }, { additionalProperties: true }),
      /additionalProperties: false/,
    ],
    ["object with no properties", obj({ a: { type: ["object", "null"] } }), /no properties/],
    ["oneOf", obj({ a: { oneOf: [{ type: "string" }] } }), /"oneOf"/],
    ["not", obj({ a: { not: { type: "string" } } }), /"not"/],
    ["minimum", obj({ a: { type: "number", minimum: 0 } }), /"minimum"/],
    ["maximum", obj({ a: { type: "number", maximum: 9 } }), /"maximum"/],
    ["multipleOf", obj({ a: { type: "number", multipleOf: 2 } }), /"multipleOf"/],
    ["minLength", obj({ a: { type: "string", minLength: 1 } }), /"minLength"/],
    ["maxLength", obj({ a: { type: "string", maxLength: 9 } }), /"maxLength"/],
    [
      "maxItems",
      obj({ a: { type: "array", items: { type: "string" }, maxItems: 3 } }),
      /"maxItems"/,
    ],
    [
      "minItems 2",
      obj({ a: { type: "array", items: { type: "string" }, minItems: 2 } }),
      /minItems/,
    ],
    [
      "anyOf next to type",
      obj({ a: { type: "string", anyOf: [{ type: "string" }] } }),
      /anyOf in the same/,
    ],
    ["complex enum value", obj({ a: { type: "object", enum: [{ x: 1 }] } }), /enum values/],
    ["unknown format", obj({ a: { type: "string", format: "phone" } }), /format/],
    ["lookahead pattern", obj({ a: { type: "string", pattern: "^(?=a)" } }), /lookaround/],
    ["word boundary pattern", obj({ a: { type: "string", pattern: "\\bx" } }), /word boundary/],
    ["external $ref", obj({ a: { $ref: "http://x.example/s.json" } }), /not a local/],
    [
      "recursive $ref",
      {
        ...obj({ n: { $ref: "#/$defs/node" } }),
        $defs: { node: obj({ next: { $ref: "#/$defs/node" } }) },
      },
      /recursive/,
    ],
    [
      "allOf conflicting types",
      obj({ a: { allOf: [{ type: "string" }, { type: "number" }] } }),
      /conflicting/,
    ],
    [
      "too many optional properties",
      {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: "string" }]),
        ),
      },
      /optional properties/,
    ],
  ];
  for (const [name, schema, re] of bad)
    it(`rejects ${name}`, () => {
      expect(structuredOutputProblems(schema).join("\n")).toMatch(re);
    });

  it("accepts a schema using only supported features", () => {
    const ok = {
      ...obj({
        s: { type: "string", format: "date", pattern: "^\\d{4}$" },
        e: { type: "string", enum: ["a", "b"] },
        c: { const: 3 },
        u: { anyOf: [{ type: "string" }, { type: "null" }] },
        n: { type: ["integer", "null"], default: null },
        l: { type: "array", items: { $ref: "#/$defs/item" }, minItems: 1 },
      }),
      $defs: { item: obj({ v: { type: "boolean" } }) },
    };
    expect(structuredOutputProblems(ok)).toEqual([]);
  });
});
