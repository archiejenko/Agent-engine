/**
 * D1 read replication (data layer plan, step 4), per request:
 * - a GET or HEAD reads through a session that starts from the caller's bookmark (cookie), so Archie
 *   always reads their own writes, even from a replica; without one it may use any replica;
 * - any other request goes to the primary ("first-primary");
 * - the response carries the new bookmarks back, one per database, in an HttpOnly cookie.
 * Turning replication on is a dashboard switch per database (docs/runbooks/deploy.md); without it,
 * sessions just read the primary.
 */
export const BOOKMARK_COOKIE = "ae_d1";
export const SESSION_BINDINGS = ["DB", "FACTS", "TELEMETRY"] as const;
type Binding = (typeof SESSION_BINDINGS)[number];

export interface D1SessionLike {
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<unknown[]>;
  getBookmark(): string | null;
}
export interface D1WithSessions {
  withSession(constraintOrBookmark?: string): D1SessionLike;
}

const isRead = (method: string) => method === "GET" || method === "HEAD";

export function readBookmarks(cookieHeader: string | null): Partial<Record<Binding, string>> {
  const raw = cookieHeader
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${BOOKMARK_COOKIE}=`))
    ?.slice(BOOKMARK_COOKIE.length + 1);
  if (!raw) return {};
  try {
    const v = JSON.parse(atob(decodeURIComponent(raw))) as Record<string, unknown>;
    return Object.fromEntries(
      SESSION_BINDINGS.filter((b) => typeof v[b] === "string").map((b) => [b, v[b] as string]),
    );
  } catch {
    return {};
  }
}

/** The env for one request, with each database replaced by a session, and how to read the bookmarks. */
export function withD1Sessions<E extends Record<string, unknown>>(request: Request, env: E) {
  const marks = readBookmarks(request.headers.get("cookie"));
  const sessions: Partial<Record<Binding, D1SessionLike>> = {};
  const out: Record<string, unknown> = { ...env };
  for (const b of SESSION_BINDINGS) {
    const db = env[b] as D1WithSessions | undefined;
    if (!db?.withSession) continue;
    const s = db.withSession(
      isRead(request.method) ? (marks[b] ?? "first-unconstrained") : "first-primary",
    );
    sessions[b] = s;
    out[b] = s;
  }
  return {
    env: out as E,
    bookmarks: () =>
      Object.fromEntries(
        Object.entries(sessions)
          .map(([b, s]) => [b, s?.getBookmark() ?? null])
          .filter(([, m]) => m),
      ) as Partial<Record<Binding, string>>,
  };
}

/** Adds the bookmark cookie to a dashboard API response (never to public routes). */
export function withBookmarkCookie(
  request: Request,
  res: Response,
  marks: Partial<Record<Binding, string>>,
): Response {
  if (!new URL(request.url).pathname.startsWith("/api/") || !Object.keys(marks).length) return res;
  const r = new Response(res.body, res);
  r.headers.append(
    "set-cookie",
    `${BOOKMARK_COOKIE}=${encodeURIComponent(btoa(JSON.stringify(marks)))}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
  );
  return r;
}
