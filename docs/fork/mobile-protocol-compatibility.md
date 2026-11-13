# T02: mobile protocol compatibility

Status: source and fixture evidence complete; official-binary smoke tests remain blocked.
Evidence is from fork base `368ec8a21a8a18cba83495a86173696804b95bc2` (T00 integrated).

## Finding

The current mobile client already represents provider choices as a provider instance plus the
server-supplied model ID. It does not need an aix-specific client field:

- `ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap` merges configured instances
  with the built-in drivers, and the registry snapshots each instance with its driver and models.
- The server sends `ServerProvider` records in `ServerConfig.providers`, followed by
  `providerStatuses`. Deltas are opt-in through the `providerStatusDeltas` capability; clients that
  do not request them continue to receive full provider-status records.
- `ServerProvider` exposes the picker metadata (`instanceId`, `driver`, optional `displayName`, and
  `models` with `slug`, `name`, `isCustom`, and capabilities). It does not expose provider settings
  or environment credentials.
- Mobile `buildModelOptions` keys choices by `${instanceId}:${slug}` and sends a
  `ModelSelection` containing the same `instanceId` and `model` slug. The picker can show distinct
  instances of the same driver and distinct deployments of one model.

Source anchors: [`ServerProvider`](../../packages/contracts/src/server.ts),
[`ModelSelection`](../../packages/contracts/src/modelSelection.ts),
[provider hydration](../../apps/server/src/provider/ProviderInstanceRegistryHydration.ts),
[provider stream and protocol gate](../../apps/server/src/ws.ts),
[mobile picker model options](../../apps/mobile/src/lib/modelOptions.ts), and
[mobile thread model picker](../../apps/mobile/src/features/threads/ThreadSettingsSheet.tsx).

Use only these existing DTOs. The aix profile, endpoint, API key, and any resolved `aix env` output
stay in the server process/settings boundary; do not add them to provider snapshots or mobile RPCs.
`claudeAgent` is the current T3 driver kind for Claude Code. The examples in the fixture use
`codex`, `claudeAgent`, and `opencode` with instance IDs `codex_work`, `claude_work`, and
`opencode_work`.

## Compatibility matrix

| Client/server pair                      | Source/contract result                                                                                                                                                                                                                   | Binary result and boundary                                                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official Android → fork server          | Current upstream mobile source uses the same generic provider DTO and picker flow; the serialization and picker fixtures cover three instance IDs and custom model IDs.                                                                  | Not run. No Android device/ADB is available to this environment, and the integrated client pass owns server/device execution. The official nightly release page exposed `0.1.10-nightly.20261113.4643` on 2026-11-13; this version was not downloaded or installed. |
| Official iOS → fork server              | Same React Native source and contracts; no fork-only UI field is required for model selection. The official client receives no Work/Private toggle.                                                                                      | Not run. Device access is disabled here. No fork iOS build was made.                                                                                                                                                                                                |
| Fork mobile client → original T3 server | The fork client sends the existing `ModelSelection` shape and requests only existing config/provider DTOs. It can select only instances and models the original server reports. Work/Private classification remains local to the client. | Source/contract only; no live original server was contacted. An aix-only instance cannot be selected when the original server does not provide it.                                                                                                                  |

The official iOS App Store listing showed version `1.4.0` on 2026-11-13. The official GitHub
releases page showed the Android nightly above. These are discovery observations, not binaries
tested by this spike ([App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[official releases](https://github.com/pingdotgg/t3code/releases)). A future app version is not
covered merely because it keeps the same display version.

## Version gate

The current source uses `ORCHESTRATION_PROTOCOL_VERSION = 2`. Pairing compatibility is checked
against the environment descriptor. The WebSocket upgrade also requires the exact
`orchestrationProtocol=2` query parameter; a mismatch receives HTTP 426 with
`orchestration_protocol_incompatible`. Therefore “official client” is not an unbounded
compatibility promise: test the exact installed binary against the fork server's advertised
protocol before claiming support. The existing client-runtime compatibility tests cover equal,
older, and newer descriptor versions; `apps/server/src/ws.ts` is the upgrade check.

The provider DTO itself is forward-compatible at the provider-list boundary, but a client can
still reject a new required field, an unknown event type, or a changed protocol version. Keep fork
metadata additive and optional, and prefer server-side `displayName` plus normal model metadata.

## Reproducible local evidence

Added tests round-trip custom models for `codex`, `claudeAgent`, and `opencode` through the existing
provider-status JSON codec, reject an empty model ID, verify mobile selection preserves exact
instance/model IDs, and verify a driver-locked picker excludes other drivers. Existing
`modelSelection.test.ts` covers legacy `provider` decoding and canonical `instanceId` serialization.
Existing `packages/client-runtime/src/connection/compatibility.test.ts` covers the descriptor
version boundary.

## Manual smoke plan (still required)

Run this on an isolated development environment using controlled test fixtures only. Keep its
`T3CODE_HOME` and ports separate from the developer's live install and do not send provider turns
to paid or production credentials.

1. Record the official app's exact version, package/bundle ID, and signing source; install/update
   only the official app on the test device.
2. Start the fork test server under its worktree-local `.t3` state with three standard driver
   instances, labels, and fixture model IDs; check its `ServerConfig.providers` response for
   secrets before pairing.
3. Pair the official app and confirm all three labels/model IDs are visible. Create a thread with
   each selection, reopen and continue it, then switch model/instance in an existing thread.
   Use a controlled test harness and verify the server receives the exact `{instanceId, model}`.
4. Connect the fork client to an original T3 test server and confirm ordinary reported models still
   work; aix-only models should be absent.
5. Repeat on iOS when a real device is available. Record app versions, protocol version, selection
   results, and any 426 response. Do not infer iOS Work/Private UI support.

This worktree did not start a server or install/run an app: device discovery returned “Agent device
access is turned off for this environment,” `adb` is not on `PATH`, and the primary agent owns the
integrated client pass. Official Android/iOS pairing, thread creation/continuation/switching, and
fork-to-original live connection remain acceptance blockers.
