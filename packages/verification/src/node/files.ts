import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { parse } from "csv-parse";
import yauzl from "yauzl";
import type { ResponseCache } from "../sources/companies-house/client.ts";

/** Node-only helpers: streaming zips and CSVs (bulk files are several GB), and a disk cache. */

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) =>
      err || !zip ? reject(err) : resolve(zip),
    ),
  );
}

/** Visit entries of a zip one at a time (streams; never loads the whole archive). */
export async function forEachZipEntry(
  path: string,
  filter: (name: string) => boolean,
  onEntry: (name: string, stream: Readable) => Promise<void>,
): Promise<number> {
  const zip = await openZip(path);
  let visited = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (name.endsWith("/") || !filter(basename(name))) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err);
        visited++;
        onEntry(basename(name), stream)
          .then(() => zip.readEntry())
          .catch(reject);
      });
    });
    zip.readEntry();
  });
  return visited;
}

export async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Stream CSV records (objects keyed by header) from a .csv file or the first .csv inside a .zip. */
export async function forEachCsvRecord(
  path: string,
  onHeader: (headers: string[]) => void,
  onRecord: (row: Record<string, string>) => void | Promise<void>,
): Promise<number> {
  let count = 0;
  const consume = async (input: Readable) => {
    const parser = input.pipe(
      parse({
        columns: (headers: string[]) => {
          onHeader(headers);
          return headers.map((h) => h.trim());
        },
        bom: true,
        relax_column_count: true,
        skip_empty_lines: true,
      }),
    );
    for await (const row of parser) {
      count++;
      await onRecord(row as Record<string, string>);
    }
  };
  if (path.toLowerCase().endsWith(".zip")) {
    let done = false;
    await forEachZipEntry(
      path,
      (n) => !done && n.toLowerCase().endsWith(".csv"),
      async (_n, s) => {
        done = true;
        await consume(s);
      },
    );
  } else {
    await consume(createReadStream(path));
  }
  return count;
}

/** API response cache on disk: data/cache/ch/<path>.json. Re-runs cost no API calls. */
export function diskCache(dir: string): ResponseCache {
  const file = (key: string) => join(dir, `${key.replace(/^\//, "").replace(/[?&=]/g, "_")}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), "utf8"));
      } catch {
        return undefined;
      }
    },
    async set(key, body) {
      const f = file(key);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, JSON.stringify(body));
    },
  };
}
