# Friction log

Submitted with our Devpost entry; up to a 10% judging bonus. **Add a row the moment something fights you**, not at the end.
Severity: S1 = blocker, S2 = major workaround, S3 = annoyance.

| # | Tool | Task attempted | Steps taken | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|---|---|
| 1 | Ring Developer Playground | Receive a `motion_detected` webhook for a simulated Package/Vehicle/Motion event | Registered a webhook URL, triggered the simulated streams in Playground | Signed webhook delivered to our endpoint | No webhook delivered; Playground simulates live view only (also reported by other entrants on the Devpost forum) | S2 | Wrote a simulator that posts v1.1-shaped payloads, HMAC-signed with our own test key, to the same production endpoint | Add "send test webhook" per event type to Playground, signed with the app's real HMAC key |
| 2 | Ring Developer Playground | Read event history for the sandbox device | `GET /v1/history/devices/{id}/events` | Recent simulated events | Empty list for the sandbox device (forum-reported; to re-verify) | S3 | Reconcile from our own event store | Populate history for simulated events |
| 3 | Alexa+ add-on docs | Match the MCP protocol version Alexa+ uses | Read `mcp-toolkit-client-lifecycle` | Example aligned with spec 2025-11-25 (required by the hackathon rules) | Doc example initializes with `2025-03-26` and no session id | S3 | Server supports both: stateless tools + session features when available | Publish the client's supported protocol versions and capabilities (elicitation, Tasks, sampling) |
| 4 | Alexa+ add-on tooling | Test a self-hosted MCP add-on end to end | Searched for the MCP Toolkit / Web Simulator | Some sandbox for hackathon entrants | Tooling is select-partners only (FAQ) | S2 | Built our own Echo-Show-style MCP client + MCP Apps host | A time-boxed hackathon sandbox for the Web Simulator |
| 5 | Vega SDK | Run the Vega Virtual Device on Windows | Checked install docs | Windows support or WSL path | macOS/Ubuntu only | S3 | Fire OS path on the Android TV emulator | WSL2 support for VVD |

| 6 | Strands Agents TS 1.21 | Stop a misbehaving model from looping on a tool that keeps rejecting its output | Ran an agent whose tool throws a validation error (our leak guard) | A sensible default turn cap | No default cap; the loop ran until the test runner timed out | S2 | `agent.invoke(prompt, { limits: { turns: 6 }, cancelSignal: AbortSignal.timeout(20_000) })` + template fallback | Ship a conservative default `limits.turns` and document it next to `tool()` errors |
| 7 | Strands Agents TS 1.21 | Run the same agent offline in CI | Implemented a custom `Model` subclass emitting stream events | A documented fake/mock model for tests | Had to read the `.d.ts` stream event types to build one | S3 | `ScriptedModel` in `services/agents/src/llm.ts` | Export a `FakeModel` / test model helper |
| 8 | Alexa+ add-ons (MCP) | Decide whether to support the standalone GET SSE stream | Browser MCP client with several tabs open | Docs on what Alexa+ expects for GET | The client's default standalone stream exhausted the browser's 6-connections-per-host limit and stalled `initialize` | S2 | Server returns 405 on GET (allowed by spec); elicitations ride POST streams | State in the add-on docs whether the Alexa+ client opens a GET stream and whether servers may 405 it |
| 9 | Alexa+ add-ons (payments) | Hold funds until a physical handoff is verified | Read payments-overview + checkout-integration | A hold / delayed-capture option for marketplace add-ons | Only immediate checkout is described | S2 | Our own escrow layer (authorization hold + capture on proof), labelled | Document a delayed-capture pattern for marketplace/peer sales |

<!-- Template:
| n | Tool | Task attempted | Steps taken | Expected | Actual | S1/S2/S3 | Workaround | Actionable suggestion |
-->
