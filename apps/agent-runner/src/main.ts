import { resolve } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { AgentService, loadPlaybooks } from "./service.ts";

// One runner tick against the local database (fakes; nothing external happens).
const root = resolve(import.meta.dirname, "../../..");
const storage = await openSqliteStorage(process.env.AE_DB ?? resolve(root, "data/dev.sqlite"));
const service = new AgentService({
  storage,
  playbooks: await loadPlaybooks(resolve(root, "playbooks")),
});
console.log(await service.tick());
await storage.close();
