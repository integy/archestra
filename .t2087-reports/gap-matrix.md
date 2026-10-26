# T-2087 gap matrix: LLM-proxy media and SDK parity vs LiteLLM

- LiteLLM: v1.106.4 @ ea7ca16dbc3904d9e59a9505f379a2ca3091821f. This is the latest non-prerelease GitHub release; the `-stable` suffixed tags stop at v1.83.14-stable.patch.3. Full LiteLLM citations (file:line, tests) are in `evidence/litellm-surfaces.md`.
- Archestra: base f789c7cdf (main). "Branch" means `piercypixel/t-2087-media-router` (7705bf3d6 = #9465 port, 418cd2f5c = OpenAI images provider route).
- Paths are relative to `platform/backend/src/routes/proxy/`. MR = common Model Router (`routes/model-router.ts`). All proxy code listed here is AGPL. No enterprise marker covers these files (see LICENSE.md).
- Release status comes from `git tag --contains`: #9414 first shipped in platform-v1.5.0-rc.3, #9364 in rc.4, #9498 in rc.6. **Deployed: unverified** for every row.
- Cross-cutting LiteLLM behaviour: every route uses `user_api_key_auth`, a pre-call budget reservation, RPM/TPM limiter hooks, and the cost callback from `cost_calculator.py`. There is no `premium_user` gate on any surface below.
- Cross-cutting Archestra behaviour: governed routes go through `handleLLMProxy` (`llm-proxy-handler.ts`), which handles virtual key/OAuth/JWT auth, limits before dispatch, interaction logging and cost. Catch-all routes use `createPassthroughAuthenticator` (`llm-proxy-auth.ts:713`): they authenticate, then forward raw, with no limits, usage or cost.

| # | Surface | LiteLLM v1.106.4 | Archestra provider routes (main) | Archestra MR | Status |
|---|---|---|---|---|---|
| 1 | Chat Completions | Supported, OSS. SSE, token cost | Supported on all providers (`routes/*.ts`, e.g. `openai.ts` chat routes) | main: supported (`model-router.ts:602,623`) | released |
| 2 | Responses | Supported, OSS. Also WS mode | openai, azure, xai, perplexity, github-copilot | main: supported (`:520,539`); tests `model-router-native-responses.test.ts` | released |
| 3 | Embeddings | Supported, OSS | openai, azure, gemini, mistral, ollama, vllm, zhipuai | main: supported (`:561,580`) | released |
| 4 | Image generation | Supported, OSS. Cost per-image, per-pixel or token (`cost_calculator.py:1681`) | azure governed (`azure.ts:140`, test `azure-images.route.test.ts`). **openai on main: raw passthrough only** (no limits or cost). Branch 418cd2f5c governs it (`openai.ts:86`, test `openai-images.route.test.ts`). Gemini has no OpenAI-shaped provider route | main: 404. Branch: azure, openai and gemini (`model-router.ts:456`, dispatch `:700-728`); test `model-router-media.sdk.test.ts` "uses one URL/key for images, Chat, Responses and embeddings…" | azure: released rc.4. MR and openai: branch (builds on pending #9465) |
| 5 | Image edits, references, masks | Supported, OSS. Multipart `image[]`, `mask` | azure governed (`azure.ts:80`, test `azure-image-edits.route.test.ts`). openai: raw passthrough | Branch: Azure only (`model-router.ts:343`); test `model-router-image-edits.sdk.test.ts`. OpenAI and Gemini edits return 400 | azure: released rc.6. MR: branch |
| 6 | Image variations | Partial: SDK only, no proxy route, no cost | openai: raw passthrough. azure: none | 404 (live probe) | gap, low priority |
| 7 | Partial-image streaming | Missing on /images. Responses-only (`partial_images` event) | `stream:true` rejected with 400 on governed image routes | same | **customer-dependent requirement, not a blocker** |
| 8 | Speech (TTS) | Supported, OSS. Chunked binary; cost per character or per audio token | openai and azure governed (`audio.ts:184`, `adapters/audio.ts:48` handles SSE `stream_format`). Tests `audio.route.test.ts`, `audio-failures.route.test.ts` | Branch (`model-router.ts:394`); test `model-router-audio.sdk.test.ts` | provider: released rc.6. MR: branch |
| 9 | Transcriptions | Supported, OSS. Cost per second or per token; no streaming found | openai and azure governed, multipart and SSE | Branch, same test | same as row 8 |
| 10 | Translations | **Missing** in LiteLLM (passthrough only) | openai and azure governed | Branch | Archestra ahead |
| 11 | Audio in chat | Supported, OSS. Audio-token pricing | Forwarded inside chat bodies. Audio-token cost: not separately priced (unverified) | Via chat | partial (pricing) |
| 12 | SSE streaming | Supported, OSS | Supported (chat/responses, `stream-keepalive.ts`, audio SSE) | Supported for chat/responses/audio | released |
| 13 | Files API, multipart | Supported, OSS. Managed files are Enterprise. No `/v1/uploads` | azure governed Files (`azure-files.ts:44`, test `azure-files.route.test.ts`). openai: raw passthrough | Not on MR | azure: released rc.6. Gap elsewhere |
| 14 | Batches | Supported, OSS. Cost on retrieve | raw passthrough only (openai/azure catch-all) | Not on MR | gap (design) |
| 15 | Azure aliases, Foundry non-OpenAI | Supported, OSS (`azure/<deployment>`, `azure_ai/`) | Supported: resource-scoped capabilities, Azure SDK ingress (#9498; tests `azure-sdk-ingress.route.test.ts`, `anthropic-azure-foundry.test.ts`) | MR resolves aliases against resource evidence (`model-router-resolver.ts`); test `model-router-media.sdk.test.ts` "the same Azure alias binds to the selected resource's evidence and credentials" | released rc.6. MR media: branch |
| 16 | Unsupported-endpoint passthrough | Supported, OSS. Authenticated provider and custom passthrough; logging per provider handler | Catch-all `fastifyHttpProxy` per provider (e.g. `openai.ts:71`) with `createPassthroughAuthenticator`: auth only, no limits, usage or cost. GitHub Copilot rejects unknown paths | MR: 404 for unknown paths | partial (design) |
| 17 | Realtime full duplex | Supported, OSS. WS `/v1/realtime`, WebRTC `/calls`; WS cost from audio tokens | Azure bounded turn only (`azure.ts:110`, `adapters/azure-realtime.ts`; test `azure-realtime.test.ts`). No full-duplex WS or WebRTC | none | **customer-dependent requirement, not a blocker** |

## Related drafts #9461 / #9462 / #9463
#9498 says these drafts are included in it. Checked by comparing the significant added lines (≥12 chars, generated/migration files excluded) of each draft against f789c7cdf:
- #9461: 916 of 922 present
- #9462: 2948 of 2958
- #9463: 4124 of 4135

The remainder is rewording or rebase drift, so the drafts are effectively superseded by #9498. They do not reverse-apply cleanly because main moved on. Line-level verification only, not semantic.

## SDK reproduction
- Real SDK in the repo-pinned test path: `openai` JS 6.29.0 (`platform/backend/node_modules`), changing only `baseURL` and `apiKey`, against a controlled local `node:http` upstream. Ported tests `model-router-{media,audio,image-edits}.sdk.test.ts` cover these flows. Results: 135 pass (`evidence/vitest-router-media.log`), plus 111 in the phase-3 set (`evidence/vitest-phase3.log`). The media test also drives the Python SDK through a `python3 -c "import openai"` subprocess when that SDK is present (line 585). Whether that branch actually ran here was not verified.
- Live devstack (pid 88238, built from the branch; `evidence/build-proof-after-1.txt`): openai-node 6.29.0 against `/v1/model-router` with a bad key. All 8 governed endpoints return 401 `Invalid virtual API key`; `images.createVariation` returns 404 (`evidence/live-router-probe-badkey.txt`).
- **Not done:** the brief asked to pin the current OpenAI SDKs (PyPI `openai` 3.37.0, npm `openai` 7.43.0). Installing them required an approval that went unanswered, so it was not run. Live happy-path sends (virtual key with a mapped local upstream) and the cross-tenant checks on the devstack also still need to be run. Those flows are covered only by the in-process SDK tests above.
