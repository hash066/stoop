// The source package.json points bin/exports at src/*.ts for the monorepo; publishConfig swaps in
// dist/ but only pnpm applies it. A plain `npm publish` from here would ship a package whose `poh`
// and import both point at files that aren't in the tarball, so refuse it.
if (!(process.env.npm_config_user_agent ?? "").startsWith("pnpm/")) {
  console.error("Publish with pnpm (pnpm publish), or npm publish a tarball made by pnpm pack: npm ignores publishConfig.bin/exports.");
  process.exit(1);
}
