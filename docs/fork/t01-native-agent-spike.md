# T01: Native agent compatibility spike

**Result: exact native routes have live evidence; no aix routing is enabled in T3.** One minimal
Codex turn for `gpt-6.1-sol` through a configured Responses gateway passed, and one Claude Code
turn for `claude-opus-5-5` through direct Anthropic Messages passed. Two OpenCode runs are limited
evidence. An earlier, broader Codex attempt failed; it is kept below as history. T05 may map exact
pairs in pure code (`apps/server/src/aix/ModelRouting.ts`). The live turns do not establish T3
end-to-end behavior, registry handoff, or profile switching.

## Probe scope and evidence

The tested model IDs were `gpt-6.1-sol`, `claude-opus-5-5`, `gpt-oss-120b`, and
`google/gemma-4-31b-it`. The provider CLIs on the probe host were Codex `0.166.0`, Claude Code
`2.1.316`, and OpenCode `2.2.5`. No private profile names, endpoint hostnames, or credential values
are recorded here.

The reviewed probe harness reported 33 offline fixture checks and 5 pending-RPC boundary tests
passing. The offline fixtures inject a sentinel into raw fields and exercise the normalizer and
serializer; they do not prove that an endpoint supports a model. The harness was not included in
this checkout, so these counts are recorded as supplied results rather than as commands another
checkout can replay. The review fixed pending-RPC timeouts across all three phases. No model
requests were made for this documentation update.

The later Codex probe (Codex `0.166.0`) reported its own self-tests separately from those counts:
5 pending-RPC tests, 13 normalizer checks, and a loopback check of the request shape (one request,
exact model, `auto` reasoning summary, no reasoning effort override). These verify the probe's
parsing and request construction, not model availability. That probe is not part of this checkout.

The later Codex probe's secret scan reported no resolved key in serialized output. It was not
independently rescanned. Its profile-name check flagged a two-character alias substring; that is a
false positive, and the check does not prove that a profile name is absent.

The live harness reported that its scan of normalized runtime output and final output did not match
the actual resolved key. This was not independently rescanned during review. The harness declared
a sentinel but did not inject it into runtime input; its false `sentinelLeakObserved` value only
records the absence of that unused value and is not evidence of runtime sentinel redaction. The
live probe therefore provides no runtime sentinel-redaction proof. The injected-sentinel fixture
is separate offline evidence and was not rerun for this correction.

Retained successful calls reported `$0.0083248` for Claude, `$0.00301269` for GPT-OSS through
OpenCode, and `$0.00795365537` for Gemma through OpenCode: `$0.01929114537` in known CLI-reported
cost. The total cost of all calls is unknown: two discarded OpenCode parser attempts had no captured
cost, and the Codex runs reported none. The later Codex turn also reported unknown cost, so the total
remains unknown. Cost reporting is not evidence of compatibility.

Earlier T3 fixture runs exercised model selection, Codex and Claude text generation, provider
switching, and OpenCode text generation. They establish T3-side behavior only; fixture results are
not live endpoint evidence:

| Historical command (from the owning package)                                                                                                                                                                  | Result                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `./node_modules/.bin/vp run test src/textGeneration/CodexTextGeneration.test.ts src/textGeneration/ClaudeTextGeneration.test.ts src/orchestration-v2/SelectionRestart.integration.test.ts` from `apps/server` | Exit 0; 3 files, 60 tests passed. |
| `./node_modules/.bin/vp run test src/server/textGeneration.test.ts` from `packages/provider-opencode`                                                                                                         | Exit 0; 1 file, 13 tests passed.  |

These earlier fixture commands were not rerun during this documentation update.

## Runtime results

“Exact ID echoed” means the runtime response reported the requested model ID. It is not a general
compatibility guarantee. “Not tested” means this model/agent combination was not exercised.

| Model ID                | Agent           | Endpoint/API route                                                      | Expected result                                                  | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gpt-6.1-sol`           | Codex 0.166.0   | Configured Responses gateway, minimal config; private host omitted      | Exact model ID, one correlated tool result, and a final response | Exact model and provider echoed; one `commandExecution` (`printf`, exit 0) whose output was correlated with its item ID; separate final answer; turn `completed`; no retries, provider errors, or fallback. HTTP path, request count, and cost are not captured or unknown. **Successful probe (single turn).**                                                                                                                              |
| `gpt-6.1-sol`           | Codex (earlier) | LiteLLM Responses route; private host omitted                           | Exact model ID and a tool-using turn complete                    | **Historical failed run.** Thread-start model/provider echo matched; the turn then failed with provider error kind `other` and fixed label `invalid_request_error`, before any tool result or final response. HTTP status, rejected field, and cost are unknown. That run forced `minimal` reasoning effort and `none` summary and changed several variables at once, so its cause is not isolated. It is not evidence against all gateways. |
| `gpt-6.1-sol`           | Claude Code     | Anthropic Messages                                                      | Not a Claude-family route                                        | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `gpt-6.1-sol`           | OpenCode        | LiteLLM Chat Completions; configured OpenCode OpenAI-compatible package | Exact model ID and tool call complete                            | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `claude-opus-5-5`       | Codex           | LiteLLM Responses route; private host omitted                           | Not a Codex-family route                                         | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `claude-opus-5-5`       | Claude Code     | Direct Anthropic API, Messages                                          | Exact model ID, tool call, and final response                    | Exact ID echoed; correlated Bash tool call and final response succeeded. **Successful probe.**                                                                                                                                                                                                                                                                                                                                               |
| `claude-opus-5-5`       | OpenCode        | LiteLLM Chat Completions; configured OpenCode OpenAI-compatible package | OpenCode may run only with a compatible configured API package   | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `gpt-oss-120b`          | Codex           | LiteLLM Responses route; private host omitted                           | Do not infer Codex compatibility from the `gpt-` prefix          | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `gpt-oss-120b`          | Claude Code     | Anthropic Messages                                                      | Not a Claude-family route                                        | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `gpt-oss-120b`          | OpenCode        | LiteLLM Chat Completions; configured OpenCode OpenAI-compatible package | Requested ID and tool behavior must be verified                  | ID was configured and requested, but OpenCode did not echo the model ID. A correlated shell tool result and a separate final response completed. **Limited runtime evidence only.**                                                                                                                                                                                                                                                          |
| `google/gemma-4-31b-it` | Codex           | LiteLLM Responses route; private host omitted                           | Do not infer Codex compatibility from the model name             | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `google/gemma-4-31b-it` | Claude Code     | Anthropic Messages                                                      | Not a Claude-family route                                        | Not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `google/gemma-4-31b-it` | OpenCode        | LiteLLM Chat Completions; configured OpenCode OpenAI-compatible package | Requested ID and tool behavior must be verified                  | ID was configured and requested, but OpenCode did not echo the model ID. A correlated shell tool result and a separate final response completed. **Limited runtime evidence only.**                                                                                                                                                                                                                                                          |

The two OpenCode runs used the configured `@opencode/ai/providers/openai-compatible` package
and completed correlated shell results and final responses. The CLI did not echo the model ID;
the requested and configured IDs are known, while the model actually served remains unconfirmed.

The successful Codex turn used an isolated key environment, the Responses wire API, no
`requires_openai_auth`, zero retries, and T3's normal `auto` reasoning summary, with no reasoning
effort override. The probe wrote that configuration itself; T3 does not yet generate it. This is
one turn, not a stable guarantee for other gateways, Codex versions, or models.

## T3 extension points and constraints

- **Codex:** [`CodexDriver`](../../apps/server/src/provider/Drivers/CodexDriver.ts) merges the
  provider-instance environment and starts the installed app-server. Separately, the
  [Codex text-generation path](../../apps/server/src/textGeneration/CodexTextGeneration.ts) can
  replace an unregistered selection with a catalog or default model, so that path does not prove
  that a requested aix model will be used. T3 does not construct an aix-profile-specific
  Codex `model_providers` configuration. A compatible custom provider requires a Responses API
  route. See [Codex advanced configuration](https://developers.openai.com/codex/config-advanced).
- **Claude Code:** T3 passes the selected model to `claude --model`; its process environment can
  carry `ANTHROPIC_BASE_URL` and auth through `ProviderInstanceEnvironment`. The direct Anthropic
  probe above succeeded for `claude-opus-5-5`; it does not prove compatibility for arbitrary
  LiteLLM aliases. See [Claude Code gateway documentation](https://code.claude.com/docs/en/llm-gateway).
- **OpenCode:** T3 selects models using `providerID/modelID`. Custom endpoint, auth, and API package
  come from OpenCode provider configuration; T3's `customModels` list does not supply those
  settings. The probes configured the OpenAI-compatible package, but did not receive a runtime
  echo of the model ID. See [OpenCode provider configuration](https://opencode.ai/docs/providers).
- **Credential and profile boundary:** all three drivers accept per-instance environments, and T3
  resolves secret references before launch. This is a candidate injection seam, not evidence that
  aix credentials are integrated or isolated. The probe compared distinct profile keys in memory;
  it did not prove process isolation, rotation, or safe continuation after a profile change.
- **Continuation:** Codex continuation identity uses `sharedHomePath`, including in `authOverlay`
  mode, and excludes `shadowHomePath`; profiles that share a shared home may therefore remain
  continuation-compatible despite separate auth overlays. Claude uses its config directory.
  OpenCode identity includes driver kind and `instanceId`, so distinct instances are incompatible;
  rotating credentials within one instance does not change that identity. Endpoint and credential
  changes are not included in the Codex or Claude continuation keys. T3's `provider.switch` path can
  use `create_with_handoff` and transfer portable conversation context; it does not promise the
  same native session ID.

## Profile switching

The probe did not test same-driver profile A → C continuation or cross-driver Claude ↔ Codex
handoff. The credentials were compared in memory, which is not a runtime isolation or rotation
test. T11 must verify both cases using distinct disposable credentials and confirm that the next
provider receives the expected portable context. Do not claim native-session continuity.

## Follow-up gates

| Ticket | Recommendation                                                                                                 | Evidence required before enabling the behavior                                                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T05    | **GO for the bounded pure mapping only** (`ModelRouting.ts`); no T3 routing is enabled                         | Native Codex is limited to the exact `gpt-6.1-sol` Responses pair without reasoning overrides. Enabling it in T3 needs a T3-driven turn with the generated config and exact echo; that is outside T05.   |
| T06    | **Exploratory GO for the validated Claude direct-Anthropic route and shared fixture credential boundary only** | Keep scope to the successful Claude path. Prove per-profile process isolation, rotation for new turns, redaction, and failure behavior before enabling aix routing. This does not approve Codex routing. |
| T08    | **Runtime GO for the two probed OpenCode request paths only; integration remains blocked**                     | Verify the configured API package through T3 and establish the actual served model ID; prove exact model and tool behavior with a profile-bound config and no manual setup.                              |
| T11    | **STOP**                                                                                                       | Exercise same-driver profile switching with separate credentials and cross-driver portable handoffs. Verify context transfer and the expected native-session change.                                     |

These are scoped evidence gates, not a product routing decision. Do not silently retry a failed
Codex request through OpenCode or substitute another model. A real endpoint emulator can verify
protocol handling, but only a controlled model endpoint can establish model availability.
