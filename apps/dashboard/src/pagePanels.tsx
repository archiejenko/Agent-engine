import { lazy, Suspense } from "react";
import type { PagePanels as Impl } from "./kit/PagePanels.tsx";

/** The kit (and its chart library) loads only on pages that show panels. */
const Lazy = lazy(() => import("./kit/PagePanels.tsx"));

export function PagePanels(props: Parameters<typeof Impl>[0]) {
  return (
    <Suspense
      fallback={
        // Marked like a loading panel, so tests (and screenshots) wait for the real panels.
        <p className="muted" data-panel-state="loading">
          Loading the panels…
        </p>
      }
    >
      <Lazy {...props} />
    </Suspense>
  );
}
