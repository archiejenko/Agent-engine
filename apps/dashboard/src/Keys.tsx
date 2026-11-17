import { useCallback, useEffect, useState } from "react";
import { day, getJson } from "./api.ts";

/**
 * Controls → Keys (v3 rule 20). Write-only: the page can save a key but never show one. The value goes
 * once to the Worker, which hands it to Cloudflare Secrets Store; the input is cleared straight after.
 */
interface KeyView {
  name: string;
  label: string;
  host: string;
  purpose: string;
  status: "unset" | "set" | "ok" | "failing";
  saved: boolean;
  last_used_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  playbooks: string[];
  tools: string[];
  store: string;
}

const STATUS: Record<KeyView["status"], [string, string]> = {
  unset: ["not set", "kind-assumed"],
  set: ["saved, not used yet", "kind-estimated"],
  ok: ["working", "kind-real"],
  failing: ["failing: dependants paused", "kind-failing"],
};

export function ControlsTabs({ tab }: { tab: "controls" | "keys" }) {
  return (
    <div className="tabs" role="tablist">
      <a href="#/controls" role="tab" aria-selected={tab === "controls"}>
        Switches and budgets
      </a>
      <a href="#/controls/keys" role="tab" aria-selected={tab === "keys"}>
        Keys
      </a>
    </div>
  );
}

function SaveKey({ k, onSaved }: { k: KeyView; onSaved: (msg: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/keys/${encodeURIComponent(k.name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const body = (await r.json()) as { error?: string };
      onSaved(r.ok ? `${k.label}: saved. It can't be shown again.` : `${k.label}: ${body.error}`);
    } finally {
      setValue(""); // the value never stays on the page
      setBusy(false);
    }
  };
  return (
    <form
      className="keyform"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) void save();
      }}
    >
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={k.saved ? "Replace key" : "Paste key"}
        aria-label={`New value for ${k.label}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" disabled={!value || busy}>
        Save
      </button>
    </form>
  );
}

export function Keys() {
  const [keys, setKeys] = useState<KeyView[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ keys: KeyView[] }>("/api/keys")
      .then((d) => setKeys(d.keys))
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <ControlsTabs tab="keys" />
      <p className="muted">
        Keys are write-only: once saved they can't be viewed here or anywhere else. They're used
        only inside the tool registry, never shown to an agent or a model. A key a provider refuses
        pauses only the playbooks listed against it, and asks you in Needs you.
      </p>
      {msg && <p role="status">{msg}</p>}
      {!keys ? (
        <p>Loading…</p>
      ) : (
        <div className="cards">
          {keys.map((k) => {
            const [label, cls] = STATUS[k.status];
            return (
              <div key={k.name} className="card">
                <h3>
                  {k.label} <span className={`kind ${cls}`}>{label}</span>
                </h3>
                <p className="muted">
                  <code>{k.name}</code> · {k.host}
                </p>
                <p>{k.purpose}</p>
                <p className="muted">
                  Last used {day(k.last_used_at)} · last worked {day(k.last_ok_at)}
                  {k.last_error ? ` · ${k.last_error}` : ""}
                </p>
                <p className="muted">
                  Used by: {k.playbooks.join(", ") || "—"}
                  {k.tools.length ? ` (tools: ${k.tools.join(", ")})` : ""}
                </p>
                <SaveKey
                  k={k}
                  onSaved={(m) => {
                    setMsg(m);
                    load();
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      {keys && <p className="muted">Stored in: {keys[0]?.store}</p>}
    </>
  );
}
