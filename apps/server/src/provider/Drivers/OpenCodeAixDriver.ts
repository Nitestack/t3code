import * as Effect from "effect/Effect";
import type { ProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";

import * as ServerConfig from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  OPENCODE_AIX_PROVIDER_ID,
  type OpenCodeAixModel,
  openCodeAixProfileReference,
  withOpenCodeAixRuntime,
} from "../OpenCodeAixLaunch.ts";

const AIX_SLUG_PREFIX = `${OPENCODE_AIX_PROVIDER_ID}/`;

const aixModels = (
  customModels: OpenCodeSettings["customModels"],
): ReadonlyArray<OpenCodeAixModel> =>
  customModels.map((model) => {
    const slug = typeof model === "string" ? model : model.slug;
    const id = slug.startsWith(AIX_SLUG_PREFIX) ? slug.slice(AIX_SLUG_PREFIX.length) : slug;
    return { id, name: typeof model === "string" ? id : (model.name ?? id) };
  });

/** OpenCode driver that injects an aix profile's gateway at each server start; other instances are unchanged. */
export const OpenCodeAixDriver: ProviderDriver<
  OpenCodeSettings,
  OpenCodeDriverEnv | ServerConfig.ServerConfig,
  ProviderUsageReaderEnv<typeof OpenCodeDriver>
> = {
  ...OpenCodeDriver,
  create: Effect.fn("OpenCodeAixDriver.create")(function* (input) {
    const profileReference = openCodeAixProfileReference({
      aixProfile: input.config.aixProfile,
      environment: input.environment,
    });
    if (profileReference._tag === "invalid") {
      return yield* new ProviderDriverError({
        driver: OpenCodeDriver.driverKind,
        instanceId: input.instanceId,
        detail: "The aix profile reference is invalid or could not be resolved.",
      });
    }
    if (profileReference._tag === "manual") return yield* OpenCodeDriver.create(input);
    if (input.config.serverUrl.trim().length > 0) {
      return yield* new ProviderDriverError({
        driver: OpenCodeDriver.driverKind,
        instanceId: input.instanceId,
        detail:
          "OpenCode aix profiles start an isolated local server; clear the configured Server URL.",
      });
    }

    const { stateDir } = yield* ServerConfig.ServerConfig;
    const base = yield* OpenCodeRuntime.OpenCodeRuntime;
    const aixRuntime = yield* withOpenCodeAixRuntime(base, {
      profileName: profileReference.profile,
      models: aixModels(input.config.customModels),
      stateDir,
    });
    return yield* OpenCodeDriver.create(input).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, { ...base, ...aixRuntime }),
    );
  }),
};
