// Not a test — a one-off measurement harness used to quantify the storm for
// the bug report. Simulates a realistic CSV Templates session against the
// OLD and NEW strict-limiter configuration and counts 429s.
//
// Session model, taken from the client's actual call graph: the tab issues
// one weekly-cards GET on mount, and every mutating action (import / remove /
// resolve-labels) is followed by a weekly-cards refresh. So each action costs
// 1 write + 1 read.
import express from "express";
import { rateLimit } from "express-rate-limit";
import type { AddressInfo } from "node:net";
import { createStrictLimiter } from "./../rateLimiters";

const ACTIONS = 15;

function oldStrictLimiter() {
  // origin/main behaviour: IP-keyed, skips only /preview, counts GETs.
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => req.originalUrl.split("?")[0] === "/api/csv-templates/preview",
    handler: (_req, res) => { res.status(429).json({ message: "rate limited" }); }
  });
}

async function run(label: string, limiter: express.RequestHandler, users: string[]) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/csv-templates", limiter);
  app.use("/api/csv-templates", (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  let reads = 0, readsBlocked = 0, writes = 0, writesBlocked = 0;

  for (const user of users) {
    const headers = { authorization: `Bearer ${user}` };
    // page load
    const load = await fetch(`${base}/api/csv-templates/pending/weekly-cards`, { headers });
    reads++; if (load.status === 429) readsBlocked++;

    for (let i = 0; i < ACTIONS; i++) {
      const w = await fetch(`${base}/api/csv-templates/pending/import-week`, { method: "POST", headers });
      writes++; if (w.status === 429) writesBlocked++;
      const r = await fetch(`${base}/api/csv-templates/pending/weekly-cards`, { headers });
      reads++; if (r.status === 429) readsBlocked++;
    }
  }

  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  console.log(
    `${label.padEnd(34)} reads ${String(reads).padStart(3)} (${String(readsBlocked).padStart(3)} × 429)   ` +
    `writes ${String(writes).padStart(3)} (${String(writesBlocked).padStart(3)} × 429)`
  );
  return { reads, readsBlocked, writes, writesBlocked };
}

const solo = ["alice"];
const shared = ["alice", "bob", "carol"]; // same NAT, three people

console.log(`\nOne user, ${ACTIONS} import actions (1 page load + ${ACTIONS} × [write + refresh]):`);
async function main() {
  await run("  BEFORE (origin/main)", oldStrictLimiter(), solo);
  await run("  AFTER  (this branch)", createStrictLimiter(), solo);

  console.log(`\nThree users behind one office NAT, ${ACTIONS} actions each:`);
  await run("  BEFORE (origin/main)", oldStrictLimiter(), shared);
  await run("  AFTER  (this branch)", createStrictLimiter(), shared);
  console.log();
}

void main();
