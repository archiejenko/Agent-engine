import type { PanelFigure, PanelStage } from "@ae/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "./DecisionCard.tsx";
import { Funnel } from "./Funnel.tsx";
import { Kpi } from "./Kpi.tsx";

const stage = (key: string, unit: string): PanelStage => ({
  key,
  label: key,
  count: 1,
  share: 1,
  unit,
  rate_from_previous: null,
  kind: "real",
});

describe("Funnel", () => {
  it("draws one divider, with its note, where the unit changes from ideas to revenue paths", () => {
    const html = renderToStaticMarkup(
      createElement(Funnel, {
        stages: [
          stage("ideas", "ideas"),
          stage("approved", "ideas"),
          stage("first_revenue", "revenue paths"),
          stage("profitable", "revenue paths"),
        ],
      }),
    );
    expect(html.match(/funnel-divider/g)).toHaveLength(1);
    expect(html).toContain("The two halves count different things.");
    // The divider sits between the last idea stage and the first revenue-path stage.
    expect(html.indexOf("approved")).toBeLessThan(html.indexOf("funnel-divider"));
    expect(html.indexOf("funnel-divider")).toBeLessThan(html.indexOf("first_revenue"));
  });

  it("draws no divider when every stage counts the same thing", () => {
    const html = renderToStaticMarkup(
      createElement(Funnel, { stages: [stage("a", "ideas"), stage("b", "ideas")] }),
    );
    expect(html).not.toContain("funnel-divider");
  });
});

describe("Kpi", () => {
  const fig = (value: number | null): PanelFigure => ({
    key: "cac",
    label: "Cost to acquire a customer",
    value,
    unit: "gbp",
    kind: "assumed",
    note: null,
  });
  it("a missing value shows – and no kind badge", () => {
    const html = renderToStaticMarkup(createElement(Kpi, { f: fig(null) }));
    expect(html).toContain("–");
    expect(html).not.toContain("kind-badge");
  });
  it("a value shows its kind badge", () => {
    const html = renderToStaticMarkup(createElement(Kpi, { f: fig(12.5) }));
    expect(html).toContain("£12.50");
    expect(html).toContain("kind-badge kind-assumed");
  });
});

describe("DecisionCard (compact Needs-you row)", () => {
  const row = (type: string) => ({
    key: "d1",
    label: "Raise sme_outreach to S2",
    detail: "Spend tier",
    type,
    money_at_stake_gbp: 300,
    money_kind: "estimated",
    options: [
      { key: "raise", label: "Raise to S2", effect: "a higher daily cap" },
      { key: "keep", label: "Keep", effect: "no change" },
    ],
    recommended: "keep",
    safe_default: "keep",
    deadline: "2026-11-28T12:00:00.000Z",
    reasoning: "No paid lift yet.",
  });

  it("puts type, title, money at stake, due date and buttons on one line; details start closed", () => {
    const html = renderToStaticMarkup(createElement(DecisionCard, { d: row("spend_tier") }));
    const line = html.slice(html.indexOf("decision-line"), html.indexOf("</div>"));
    for (const want of [
      "Spend tier",
      "Raise sme_outreach to S2",
      "£300",
      "due",
      "Raise to S2",
      "Keep",
    ])
      expect(line, want).toContain(want);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("decision-details");
    expect(html).not.toContain("No paid lift yet.");
  });

  it("a decision you should read first links to it instead of showing buttons", () => {
    const html = renderToStaticMarkup(createElement(DecisionCard, { d: row("draft") }));
    expect(html).toContain("Read it first");
    expect(html).not.toContain("decision-actions");
  });
});
