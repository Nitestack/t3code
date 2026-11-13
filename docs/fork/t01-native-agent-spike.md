# T01: Native agent compatibility spike

**Status:** STOP — exact model and endpoint compatibility is unverified.
**Inspected baseline:** `368ec8a21a8a18cba83495a86173696804b95bc2`
**Scope:** documentation-only spike; no product code or credentials used.

## Environment and reproducibility

Installed CLI versions on the spike host:

| CLI         | Version/result                           |
| ----------- | ---------------------------------------- |
| Codex       | `codex-cli 0.166.0`                      |
| Claude Code | `2.1.316`                                |
| OpenCode    | `v2.2.5`                                 |
| aix         | Not installed (`aix: command not found`) |

There is no safe LiteLLM test endpoint or disposable test credential configured/provided. I did not
run `aix profiles`, `aix env`, provider authentication, or any model request. Consequently no model
availability, response, tool call, or endpoint error was observed. Model names and the locally
installed CLI versions are not evidence of runtime compatibility.

The existing test fixtures were run after the worktree-local `vp i` completed successfully. They
passed with each package's workspace-local Vite+ shim. These fixtures validate T3-side behavior only;
they do not prove model availability at a real endpoint.

The `vite-plus` symlinks for the root, `apps/server`, and `packages/provider-opencode` resolve to the
same worktree-local `node_modules/.pnpm/vite-plus@1.4.0_.../node_modules/vite-plus` package. The
package-local `node_modules/.bin/vp` entries are generated shims targeting that package's `bin/vp`.
The earlier failed attempts put the isolated
`/home/nhan/Programming/projects/t3code/.git/t3-aix-orchestration/t00-tests/bin` runner first in
`PATH`, causing the duplicate Vitest context described in the T00 runner probe. The passing commands
below invoke the local shim by path and do not include that directory in `PATH`.

## Existing extension points and constraints

- **Codex:** [`CodexDriver`](../../apps/server/src/provider/Drivers/CodexDriver.ts) merges the
  provider instance environment and launches the installed app-server. Hidden `customModels`
  settings allow a custom model slug. `CodexTextGeneration` sends a registered custom slug through,
  but an unregistered selection can be replaced by a same-family or default catalog model. That is
  a silent model substitution and conflicts with the ticket's no-fallback invariant. The T3 driver
  does not currently build an aix-profile-specific Codex `model_providers` configuration. Codex's
  documented custom provider configuration includes `base_url`, `env_key`, and `wire_api =
  "responses"`; the wire API must be Responses-compatible. See [Codex advanced
  configuration](https://developers.openai.com/codex/config-advanced).
- **Claude Code:** T3 passes the resolved model to `claude --model`; unknown slugs pass through
  unchanged. Its process environment can carry `ANTHROPIC_BASE_URL` and an auth variable through
  `ProviderInstanceEnvironment`. Model IDs still need to be recognized by the configured gateway;
  T3 has not demonstrated that any of the listed IDs are accepted. Anthropic documents gateway
  environment variables and explicitly does not support routing Claude Code to non-Claude models
  through a gateway ([gateway documentation](https://code.claude.com/docs/en/llm-gateway)).
- **OpenCode:** T3's provider core starts/connects to OpenCode and uses OpenCode's provider/model
  catalog. Models are selected as `providerID/modelID`. Custom provider definitions currently come
  from OpenCode configuration (including project `opencode.json`); T3's `customModels` list alone
  does not define endpoint, auth, or API package. OpenCode supports distinct compatible runtimes,
  including Responses, OpenAI-compatible, and Anthropic-compatible packages; choosing the package
  is endpoint-specific. See [OpenCode provider configuration](https://opencode.ai/docs/providers).
- **Profile isolation:** all three drivers receive per-instance environments, and secret references
  are resolved before driver launch. This is a candidate runtime injection seam, not evidence that
  aix output is currently consumed safely. Codex's continuation key uses `sharedHomePath`, including
  in `authOverlay` mode; it excludes `shadowHomePath`. Two profiles sharing a shared home can remain
  continuation-compatible even with separate auth overlays. Claude's continuation key uses its
  config directory. Endpoint/credential changes are not part of either key; profile isolation must
  account for this before native continuation across profile changes is enabled.
  OpenCode's continuation identity uses the driver kind and `instanceId`: different instances are
  incompatible and require a handoff under T3's transition policy, while rotating credentials within
  the same instance does not change its identity.
- **Switch/handoff:** `provider.switch` is handled by `ProviderSwitchService`; incompatible
  continuation identities select `create_with_handoff`, and T3's provider-turn start persists a
  portable context transfer. This transfers selected conversation history; it does not promise the
  same native provider session ID. A model/instance change does not guarantee that the new provider
  actually accepted the requested model.

## Required model matrix

The endpoint column identifies the protocol each driver would have to use. **Every real model
request remains unrun**, because no safe endpoint or credential was available. Therefore the error
column means no runtime error was captured, not that a request succeeded. The fixture tests below
are not endpoint observations. The routing expectations below describe the proposed F-09 mapping,
not implemented aix routing in the inspected baseline.

| Model ID                | Agent       | Endpoint / API type to probe                      | Expected from proposed F-09 mapping and existing interfaces                                                                       | Observed result / error             |
| ----------------------- | ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `gpt-6.1-sol`           | Codex       | LiteLLM Responses API; Codex `wire_api=responses` | Candidate only with explicit custom model and compatible Responses/tool behavior. Current T3 may substitute an unregistered slug. | Not run; no request/error captured. |
| `gpt-6.1-sol`           | Claude Code | LiteLLM Anthropic Messages                        | Not selected by the GPT-to-Codex routing rule; non-Claude routing is not a supported Claude gateway guarantee.                    | Not run; no request/error captured. |
| `gpt-6.1-sol`           | OpenCode    | Explicit Responses or OpenAI-compatible package   | Candidate only after endpoint API type and tool behavior are known and configured.                                                | Not run; no request/error captured. |
| `claude-opus-5-5`       | Codex       | LiteLLM Responses API                             | Not selected by the Claude-to-Claude routing rule. An ID string alone does not show Codex protocol compatibility.                 | Not run; no request/error captured. |
| `claude-opus-5-5`       | Claude Code | LiteLLM Anthropic Messages                        | Candidate if the gateway recognizes the exact model ID and supports Claude Code's tool protocol.                                  | Not run; no request/error captured. |
| `claude-opus-5-5`       | OpenCode    | Explicit Anthropic-compatible package             | Directly configurable in OpenCode, but not the automatic routing target for the Claude family.                                    | Not run; no request/error captured. |
| `gpt-oss-120b`          | Codex       | LiteLLM Responses API                             | Excluded from automatic Codex mapping; compatibility requires an explicit Responses/tool probe.                                   | Not run; no request/error captured. |
| `gpt-oss-120b`          | Claude Code | LiteLLM Anthropic Messages                        | Not a supported Claude gateway target and not selected by the routing rule.                                                       | Not run; no request/error captured. |
| `gpt-oss-120b`          | OpenCode    | Explicit OpenAI-compatible or Responses package   | OpenCode fallback candidate; package and backend API must be established before selection.                                        | Not run; no request/error captured. |
| `google/gemma-4-31b-it` | Codex       | LiteLLM Responses API                             | Not selected by automatic Codex mapping; slash-qualified ID also needs exact custom-model handling.                               | Not run; no request/error captured. |
| `google/gemma-4-31b-it` | Claude Code | LiteLLM Anthropic Messages                        | Not a supported Claude gateway target and not selected by the routing rule.                                                       | Not run; no request/error captured. |
| `google/gemma-4-31b-it` | OpenCode    | Explicit OpenAI-compatible or Responses package   | OpenCode fallback candidate; slash-qualified model ID must map exactly and pass a tool-call probe.                                | Not run; no request/error captured. |

**Native availability conclusion:** none of the four exact model IDs is proven available through a
native T3 driver. The matrix contains protocol candidates, not Go decisions. Mock protocol fixtures
cannot close this gap.

## Profile and context continuation probe

Not run: aix and a safe two-profile endpoint fixture are unavailable. The required cases remain:

1. Same driver, two profiles with distinct credentials and isolated native homes: turn, switch
   profile, then continue with a portable handoff; capture whether the native session ID changes.
2. Claude Code to Codex and Codex to Claude Code: verify handoff history reaches the new run and
   confirm a new native session is expected.
3. For each model, request a tool call and verify the selected endpoint receives the exact original
   model ID and supported tool schema. Any API/model/tool error must be surfaced without retrying
   through another model or agent.

## Fixture test attempts

After `vp i` succeeded, these focused tests were run via the package-local Vite+ shims. Only the
Node toolchain directory was added to `PATH`; the isolated T00 runner directory was omitted.

| Command                                                                                                                                                                                                        | Result                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| From `apps/server`: `./node_modules/.bin/vp run test src/textGeneration/CodexTextGeneration.test.ts src/textGeneration/ClaudeTextGeneration.test.ts src/orchestration-v2/SelectionRestart.integration.test.ts` | Exit 0; 3 files passed, 60 tests passed. |
| From `packages/provider-opencode`: `./node_modules/.bin/vp run test src/server/textGeneration.test.ts`                                                                                                         | Exit 0; 1 file passed, 13 tests passed.  |

No tests or runner files were added or changed. The earlier global-runner failures were invocation
errors and were superseded by these package-local passing runs.

## Recommendation and gates

| Follow-up | Recommendation | Gate                                                                                                                                                                                |
| --------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T05       | **STOP**       | Do not enable native model routing until a safe Responses endpoint proves exact ID, tool calling, failure behavior, and no Codex substitution.                                      |
| T06       | **STOP**       | Do not enable Claude profile routing until an Anthropic Messages gateway proves exact model ID, base URL, auth isolation, and tool calling.                                         |
| T08       | **STOP**       | Do not advertise OpenCode fallback until a profile-bound config selects the correct API package and an endpoint fixture proves exact model/tool behavior without manual user setup. |
| T11       | **STOP**       | Do not claim profile/session continuation until two distinct credentials and cross-driver portable handoffs are exercised; native session identity is not portable.                 |

STOP here means the required evidence is missing; it does not establish that the models fail. The
ticket remains blocked on a safe, disposable LiteLLM gateway for real model requests. An endpoint
emulator can validate protocol handling only; it cannot prove real model availability. No silent
replacement routing is approved by this spike.
