import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Node only: brain/ read live from disk (local dev, gates). The Worker uses the deploy-time bundle. */
export function fsBrain(root: string) {
  return async () => {
    const out: { path: string; body: string }[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(md|csv)$/i.test(name))
          out.push({
            path: relative(root, p).split("\\").join("/"),
            body: readFileSync(p, "utf8"),
          });
      }
    };
    walk(join(root, "brain"));
    return out;
  };
}
