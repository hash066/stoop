#!/usr/bin/env -S npx tsx
// ring-sim: simulator-signed Ring events for a Stoop stack (local or deployed).
//   ring-sim event motion --sub-type human      ring-sim event button
//   ring-sim event offline                       ring-sim replay
//   ring-sim scenario golden [--deal deal_x]     (needs the stack's /sim routes)
// Options: --url (STOOP_URL), --key (RING_SIMULATOR_KEY), --device, --stale-ms, --bad-signature
import { parseArgs } from "node:util";
import { DEFAULT_DEVICE, DEFAULT_SIM_KEY, DEFAULT_URL, replayAttack, scenario, send, signedEvent, type SimEventType } from "./sim.ts";

const TYPES: Record<string, SimEventType> = {
  motion: "motion_detected",
  button: "button_press",
  offline: "device_offline",
  online: "device_online",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: process.env.STOOP_URL ?? DEFAULT_URL },
    key: { type: "string", default: process.env.RING_SIMULATOR_KEY ?? DEFAULT_SIM_KEY },
    device: { type: "string", default: DEFAULT_DEVICE },
    "sub-type": { type: "string" },
    "stale-ms": { type: "string" },
    "bad-signature": { type: "boolean", default: false },
    deal: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, arg] = positionals;
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

async function main() {
  if (values.help || !cmd) {
    console.log("usage: ring-sim event <motion|button|offline|online> | replay | scenario <name>");
    console.log("       [--url] [--key] [--device] [--sub-type] [--stale-ms] [--bad-signature] [--deal]");
    console.log("scenarios: golden, piracy, still_there, no_show, camera_offline, replay_attack");
    return;
  }
  console.error(`ring-sim -> ${values.url}  (simulator-signed, not Ring-signed)`);
  if (cmd === "event") {
    const type = TYPES[arg ?? ""];
    if (!type) throw new Error(`unknown event "${arg}". Use one of: ${Object.keys(TYPES).join(", ")}`);
    const ev = signedEvent({
      type,
      key: values.key!,
      deviceId: values.device,
      subType: values["sub-type"],
      at: Date.now() - Number(values["stale-ms"] ?? 0),
      badSignature: values["bad-signature"],
    });
    print({ requestId: ev.requestId, ...(await send(values.url!, ev)) });
  } else if (cmd === "replay") {
    print(await replayAttack(values.url!, values.key!, values.device));
  } else if (cmd === "scenario") {
    if (!arg) throw new Error("scenario name required");
    print(await scenario(values.url!, arg, values.deal));
  } else {
    throw new Error(`unknown command "${cmd}"`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
