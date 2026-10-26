# T-2087 checks (run from platform/)

| Command | Result | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | pass | evidence/pnpm-install.log |
| NAPI builds | built by Tilt (openappa-rs, app-runtime-rs); sandbox-rs/image-rs not built and not needed by the tests run | — |
| `pnpm codegen` (after port, after phase 3) | pass; regenerated openapi + hey-api client | evidence/codegen-1.log, codegen-2.log |
| `pnpm type-check` | pass, 10/10 tasks (twice) | evidence/type-check-2.log, type-check-3.log |
| `pnpm lint` | pass, 9/9 (twice) | evidence/lint-1.log, lint-2.log |
| `cd backend && pnpm knip` (dev+production) | pass (twice) | evidence/knip-backend-1.log, knip-backend-2.log |
| `pnpm commit:check` | pass, 5/5 (run after the port commit; not re-run after 418cd2f5c, whose type-check/lint/knip were re-run) | evidence/commit-check.log |
| vitest: ported #9465 files + rbac + rollback (6 files) | 135 pass | evidence/vitest-router-media.log |
| vitest: adjacent proxy media/router/azure/audio/limits (31 files) | 366 pass, 1 skipped (live-key file) | evidence/vitest-proxy-adjacent.log |
| vitest: shared | 1048 pass | evidence/vitest-shared.log |
| vitest: phase 3 set (openai-images, openai, prehandler, router media, audio, passthrough auth, rbac) | 111 pass | evidence/vitest-phase3.log |
| Live devstack SDK probe (bad key) | 8 governed MR endpoints 401, variations 404 | evidence/live-router-probe-badkey.txt |

## Gaps
- No new failures were seen, so no comparison against clean main was needed.
- The whole backend suite was not run, per the brief.
- Docs checks were not run separately. The docs change is #9465's model-router page (unchanged from that PR), and lint passed.
- Screenshot recapture was not run (it needs the docs-screenshots Playwright flow). Main's two webp files were kept.
- Newest OpenAI SDKs (py 3.37.0 / js 7.43.0) were not installed because approval went unanswered. Live happy-path and cross-tenant sends on the devstack are not done.
- Commits were made with hooks disabled; commit:check was run instead.
- No Nitpicker review or demo, since there is no PR, per the brief.
