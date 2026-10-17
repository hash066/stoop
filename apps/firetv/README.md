# Stoop Garage (Fire TV / Android TV)

[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](./LICENSE)

**Garage Mode** puts the household's sellable things on the big screen. Pick items with the
remote's D-pad, press **List selected**, approve on screen, and Stoop lists them — then it haggles
inside your limits and pays out only when your doorbell verifies the pickup. The TV footer shows the
live sale line as a deal moves through to "Sold".

This is a **real MCP client**. It talks to the Stoop stack exactly the way Alexa+ does: MCP over
Streamable HTTP, **stateless**, with the documented approval fallback
(`approval_required` → on-screen confirm → `confirm_action`). The TV holds **no** money or address
keys — it only *proposes*; the Settlement service decides. Tools used: `my_items`, `appraise_photos`,
`list_items`, `confirm_action`, `handoff_status` (polled for the live-sale line).

> Built on Amazon's [`AmazonAppDev/react-native-multi-tv-app-sample`](https://github.com/AmazonAppDev/react-native-multi-tv-app-sample)
> (MIT-0, see [LICENSE](./LICENSE)). We kept the spatial-navigation / drawer / remote-control scaffolding
> and replaced the movie app with Garage Mode. See [What we changed](#what-we-changed).

## Run it

This workspace is **not** part of the repo's pnpm install. It's a separate **Yarn 4** workspace, so
use `corepack yarn` (a `yarn` on your PATH is probably v1 — don't use it).

1. Start the Stoop stack from the repo root so the TV has something to talk to:
   ```bash
   pnpm --filter @stoop/stack start      # http://localhost:8787, seller token seller-demo-okafor
   ```
2. Install and run the web target (serves on port 8082):
   ```bash
   cd apps/firetv
   corepack yarn install
   corepack yarn dev:web
   ```
   Open http://localhost:8082. Drive it with the **arrow keys** and **Enter**:
   - **Use demo photos** → loads the labelled demo set and appraises it (the drop-side crib is blocked).
   - Move to an item, press Enter to select, then **List selected** → an on-screen **Confirm** →
     the item goes LIVE.
   - The footer's **LIVE SALE** line updates as a sale progresses (polled every 4 s).

### Pointing at a different stack

| Env var | Default | Notes |
|---|---|---|
| `EXPO_PUBLIC_STOOP_URL` | `http://localhost:8787` (web), `http://10.0.2.2:8787` (Android) | The Android emulator reaches the host's localhost at `10.0.2.2`. |
| `EXPO_PUBLIC_STOOP_SELLER_TOKEN` | `seller-demo-okafor` | Local demo household token (not a real credential). |

### Android TV / Fire TV

`corepack yarn dev:android` builds and runs on an Android TV emulator or a connected Fire TV. This
needs an Android TV system image (~1.5 GB) and a first Gradle build (~2 GB); set `GRADLE_USER_HOME`
and `ANDROID_AVD_HOME` onto a roomy drive first. The web target above is the quickest way to see it.

## What we changed

- **Added** `packages/shared-ui/src/stoop/api.ts` (the stateless MCP client) and
  `screens/GarageScreen.tsx` (the Garage grid + confirm modal + live-sale footer).
- **Reduced** the drawer to **Garage + Settings** and set the Stoop "porch at night" palette in
  `theme/colors.ts`.
- **Removed** the sample's movie app: Home/Explore/TV/Details/Player screens, the video player
  components, the `VideoHandler`s, `moviesData`, and the Kepler/Vega variants (they depend on the
  Amazon Vega `@amazon-devices/*` SDK, which isn't on public npm). Remote-control support for
  web / Android TV / Apple TV is kept.
- **Hoisting:** `.yarnrc.yml` hoists dependencies to the workspace root (default), not per-workspace,
  so `packages/shared-ui` (a source-only package that lists its RN deps as peers) resolves
  `react-native` et al. during `tsc`. Metro already lists the root `node_modules` in
  `nodeModulesPaths`, so this is safe for the bundler.

## Verify

```bash
corepack yarn typecheck        # both workspaces clean
corepack yarn expo export -p web   # one-shot web bundle (from apps/expo-multi-tv)
```

## License

MIT-0, inherited from the upstream sample. See [LICENSE](./LICENSE).
