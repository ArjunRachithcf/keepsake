# HomersLab's design kit, vendored

These files are Homeward's design system (`design/` of https://github.com/ArjunRachithcf/homeward), copied unchanged:
`tokens.css`, `components.css`, `icons.js`, `motion.js`, `mark.svg` (named by `components.css`) and the Inter font
(`fonts/`). `vendor.json` names the commit they came from and each file's SHA-256.

- Licence: Apache-2.0, as Keepsake (Copyright 2026 Arjun Rachith). Inter: SIL Open Font License 1.1 (`fonts/OFL-inter.txt`).
- Never edit them here. Update them with `scripts/sync-design.sh [path to a Homeward checkout]`, which copies them and
  rewrites `vendor.json`; `apps/web/test/vendor.test.ts` fails when a file differs from it.
- `vendor.json` pins the source commit. `scripts/sync-design.sh --check [path]` compares every vendored file, byte for
  byte, with `design/` at that commit in a Homeward checkout. It needs the checkout, so it is a local check; CI runs
  only the test against `vendor.json`.
- Keepsake's own look (posters, the draw card, wish rows, the made-here link, the shell) is in `src/keepsake.css`.
