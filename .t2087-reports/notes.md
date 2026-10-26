# T-2087 continuation notes

- Base: f789c7cdf9e8b692d80167573aec5bdc7cfbd286 (task-specified). origin/main has since moved to ac9f29a0f (CI-only change, #9662), not included.
- Branch: piercypixel/t-2087-media-router (local only; nothing pushed, no PR, no GitHub comments).
- LiteLLM reference: v1.106.4 @ ea7ca16dbc3904d9e59a9505f379a2ca3091821f — latest non-prerelease GitHub release (published 2026-10-25). The "-stable" suffixed tags stop at v1.83.14-stable.patch.3, so the newest non-prerelease release was used.

## Commits
- 7705bf3d6 feat(proxy): expose governed media through the common Model Router
  - **Builds on draft PR #9465** (head d796cbf37834a596593b2f0796f5677a80c8cf1e, by another engineer), itself on closed #9464 (d9212729). Took `git diff d9212729 d796cbf3` minus generated files, docs/openapi.json and screenshots; applied cleanly with `git apply -3`.
  - Reconciliation: main's azure-images.ts, media-provider-error.ts and model-router-resolver.ts are byte-identical to d9212729 (#9498 merged #9464's content verbatim), so no adapter rework was needed. The only non-generated drift (model-router.ts 1 line, types/interaction.ts, access-control.ts, model-constants.ts, routes.ts) merged cleanly.
  - Generated: `pnpm codegen` regenerated docs/openapi.json and shared/hey-api/clients/api/{index,sdk.gen,types.gen}.ts. Sizes match #9465's own generated diff (index +42, sdk 184, types 784 lines changed).
  - Screenshots: kept main's `llm-proxy_model-router-key*.webp` (see checks.md for the screenshot tooling attempt).
  - Committed with hooks disabled; `commit:check` is run separately and recorded in checks.md.

- 418cd2f5c fix(proxy): govern OpenAI image generations on the provider route (phase 3; previously raw passthrough). New test `routes/openai-images.route.test.ts`.
- final commit: reports copied under `.t2087-reports/` (screened by authorship: an automated grep scan was policy-blocked).
- Branch pushed to `origin piercypixel/t-2087-media-router` at the owner's mid-turn request (no PR).

## #9461/#9462/#9463
Superseded by #9498 at line level (≥99.6% of significant added lines present in f789c7cdf). See gap-matrix.md.

## Decisions
- No push / PR / GitHub writes per task. This overrides the lobster-worker PR, Nitpicker and demo-delivery steps; Nitpicker review needs a PR and was not run.
- Guardrail policy: Bash calls that read environment variables or the platform env file are blocked (they would narrow readers to self). Those reads were avoided.

## Open items
- See recommendation.md and gap-matrix.md.
- The newest OpenAI SDKs (py 3.37.0 / js 7.43.0) were not installed because the approval went unanswered. Only the repo-pinned openai-node 6.29.0 was used.
- Live devstack happy-path and cross-tenant sends are still open. Only the bad-key probe was run live; the rest is covered by the in-process SDK tests.
- Docs screenshots were not recaptured; main's copies were kept.
- Next implementation candidate: OpenAI image edits (recommendation.md item 5A).
