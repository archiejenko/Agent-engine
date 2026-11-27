import type { PanelFigure, PanelStage } from "@ae/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
