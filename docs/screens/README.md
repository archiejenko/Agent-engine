# Screenshot record

- `index.html`: the gallery (all images embedded; open in any browser).
- `screens.pdf`: the same as an A5 contact sheet for reading on a phone (very tall pages are cropped to their top section there).
- `ui-issues.md`: what looked broken or awkward while capturing.
- `*.png`: the screenshots, named `<area>-<page>-<width>-<theme>.png`; `manifest.json` lists them with routes.

## Regenerate (local only, no network, kill switch ON)

```bash
npx tsx scripts/screens/seed.ts                       # data/screens.sqlite from the Phase 2–5 gates
AE_DB=data/screens.sqlite PORT=8787 npx tsx apps/api/src/node.ts &
AE_DB=data/screens-empty.sqlite PORT=8788 npx tsx apps/api/src/node.ts &      # empty states
cp data/screens.sqlite data/screens-public.sqlite
npx tsx scripts/screens/public-copy.ts data/screens-public.sqlite > ids.json  # copy with external actions on (demo pages)
AE_DB=data/screens-public.sqlite PORT=8789 npx tsx apps/api/src/node.ts &
(cd apps/dashboard && npx vite --port 5173) &
node scripts/screens/capture.cjs ids.json docs/screens
python3 scripts/screens/build_gallery.py docs/screens && node scripts/screens/pdf.cjs docs/screens
```

Demo pages are only served while external actions are allowed, so they're captured from a copy of the
database with the kill switch off. The real seeded database keeps it ON; its `/demo` URL returns 404, as
the `public-demo-kill-switch-on` shot shows.
