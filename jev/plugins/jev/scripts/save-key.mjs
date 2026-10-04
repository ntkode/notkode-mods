// Checks a key for Jev with one real call and saves it to jev-gateway's own key file
// (~/.jev-gateway/.env, readable by its owner only), through the gateway's own setup code, so the
// mod and every jev-* launcher read the same key the same way.
//
// The mod runs it with `node save-key.mjs` and the input as JSON on stdin, never in argv, so the
// key stays out of the process list:
//   { "root": "<the installed jev-gateway package>", "provider": "openrouter", "key": "…", "paid": false }
// It prints one JSON line, never the key:
//   { "ok": true, "ms": 312, "file": "…/.jev-gateway/.env" }
//   { "ok": false, "reason": "401 …", "refused": true, "freeUnavailable": false }
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");

let text = "";
for await (const chunk of process.stdin) text += chunk;
const { root, provider: id, key, paid } = JSON.parse(text);

const setup = await import(pathToFileURL(join(root, "bin", "setup.mjs")).href);
const provider = setup.loadProviders(root)[id];
if (!provider) {
  say({ ok: false, reason: `unknown provider ${id}` });
  process.exit(0);
}

// The free model first; the paid one only when the person said yes (its key check may be billed).
const model = paid && provider.paidModel ? provider.paidModel : provider.model;
const result = await setup.validateKey({ ...provider, model, ...(paid ? { paidModel: undefined } : {}) }, key);
if (!result.ok) {
  say({ ok: false, reason: result.reason, refused: Boolean(result.refused), freeUnavailable: Boolean(result.freeUnavailable) });
  process.exit(0);
}

const file = join(homedir(), ".jev-gateway", ".env");
const values = { JEV_PROVIDER: id, [provider.keyEnv]: key };
if (provider.paidModel) values.JEV_MODEL = model;
setup.saveEnv(file, values);
say({ ok: true, ms: result.ms, file });
