# Add media helpers: snapshots (303 flow) and clips (416/425 retries)

## What

- `scripts/media_helpers.py`: snapshot and clip download helpers, plus `RingMediaError` with Ring's error detail.
- `scripts/download_snapshot.py`, `scripts/download_clip.py`: CLI scripts in the same style as the existing ones (print the equivalent curl).
- `scripts/test_media_helpers.py`: stdlib `unittest` tests with a fake session, no network, no new dependencies.
- `app/api/ring/snapshot/route.ts`: a Next.js route that serves a device snapshot to the dashboard.

## Why

The repo has no media download yet, and two documented behaviours trip people up:

1. **Snapshots answer `303 See Other`** with a pre-signed `Location`. Clients have to follow it, and must **not** send the bearer token to the pre-signed host. That would leak a Ring token to a third party. The helper and route use `allow_redirects=False` / `redirect: 'manual'` and then fetch the URL without the token. The tests assert the token isn't sent.
2. **Clips return `416 MEDIA_NOT_FOUND` / `425 RECORDING_NOT_READY`** while a recording is still being processed. The docs say to retry for about 2 minutes. `download_clip` retries every 10 s up to `--max-wait`, follows 301/302, and caps duration at 15 minutes (900000 ms).

Snapshots are requested at 1920×1080 so the mandatory watermark stays proportionally small.

## How it was tested

`cd scripts && python -m unittest test_media_helpers -v` gives 7 tests covering:
- the 303 flow and that no token leaks
- error detail surfacing
- request body shapes
- retry then success, and giving up after `max_wait`
- the duration cap
- redirect following

## Related

HMAC webhook verification (#31) and the v1.1 payload / test-webhook script (#32) are in separate open PRs. This PR doesn't touch webhooks.

_Built while making Stoop for the Build, Ship, Shape hackathon. MIT, same as this repo._
