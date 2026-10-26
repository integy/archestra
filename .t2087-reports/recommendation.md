# T-2087 recommendations for remaining R11 gaps

Implemented (small, existing pattern): OpenAI provider `/images/generations` is now governed instead of raw passthrough (418cd2f5c).

## 1. Media pricing from the synced LiteLLM cost map (#9414 already syncs it)
Today image adapters record `costUnavailable` (`adapters/image-generation.ts:100`), and audio usage is unknown/null by design.
- A. Extend the model-pricing sync to keep `input_cost_per_image`/`output_cost_per_image`/`input_cost_per_pixel`, `input_cost_per_second`/`output_cost_per_second`, `input_cost_per_character`, and audio-token prices. Compute cost in the media adapters from request facts (n, size, quality, characters, duration). **Recommended.** Effort: M–L (schema column(s) + migration, sync, per-surface calculators, tests).
- B. Use only token usage when the provider returns it (gpt-image, gpt-4o-transcribe), and keep null otherwise. Effort: S. This is honest but incomplete.
- C. Admin-entered per-unit prices. Effort: M. This duplicates the map.

## 2. Realtime full duplex (customer-dependent)
- A. WebSocket relay `/v1/{openai,azure}/realtime` with auth at upgrade, limits checked per session, and audio-token accounting at close. Effort: L. **Recommended if a customer needs it.**
- B. WebRTC `/realtime/calls` (SDP brokering only). Media bypasses the proxy, so there is no metering. Effort: M.
- C. Keep the bounded Azure realtime turn only. Effort: none.

## 3. Partial-image streaming (customer-dependent)
- A. Allow `stream:true` on governed image routes and relay the SSE `image_generation.partial_image` events, accounting on the final `completed` event. Effort: M. **Recommended on demand.**
- B. Support it only via Responses `image_generation` tool streaming. Effort: S–M.

## 4. Generic passthrough governance
- A. Keep auth-only passthrough, but log an interaction (method, path, status, latency) and enforce request-count limits. Effort: M. **Recommended.**
- B. An opt-in per-path allowlist, with unknown paths denied (like GitHub Copilot's `rejectUnhandledPaths`). Effort: S. Safer default, but could break SDK calls that work today.
- C. Full governance per endpoint (as done for media). Effort: L per endpoint.

## 5. OpenAI / Gemini image edits through the router (and the OpenAI provider route)
- A. Add an `openai-image-edits` adapter reusing `image-edit-handler.ts` + `utils/image-edit-input.ts` (multipart, references, masks), and register it on `/v1/openai/images/edits` and in the MR dispatch. Effort: M. **Recommended next.**
- B. Gemini edits via `generateContent` with inline images, translated to an OpenAI images response. Effort: M–L.
- C. Keep a 400 on the MR for non-Azure edits. Effort: none.

## 6. Batches / Files beyond Azure
- A. Governed OpenAI Files reusing `provider-file-handler.ts` (pattern from `azure-files.ts`). Effort: M.
- B. Batches with cost on retrieve (as LiteLLM does). Effort: L.
**Recommendation:** A first.
