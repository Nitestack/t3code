import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    ...(process.env.T3CODE_MOBILE_VERSION === undefined
      ? {}
      : { T3CODE_MOBILE_VERSION: process.env.T3CODE_MOBILE_VERSION }),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, production, or android-fork.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it.each([
  ["2.3.0", 2_003_000],
  ["2.3.1", 2_003_001],
  ["2.4.0", 2_004_000],
  ["3.0.0", 3_000_000],
])("versions the Android fork as %s without changing its identity", async (version, code) => {
  vi.stubEnv("T3CODE_MOBILE_VERSION", version);
  const config = await loadConfig("android-fork");

  expect(config.name).toBe("T3 Code (Nitestack)");
  expect(config.scheme).toBe("t3code-aix");
  expect(config.android?.package).toBe("com.nitestack.t3code");
  expect(config.ios?.bundleIdentifier).toBe("com.t3tools.t3code");
  expect(config.version).toBe(version);
  expect(config.android?.versionCode).toBe(code);
});

it.each(["2.3.0-preview.1", "2.03.0", "2.1000.0", "2.3.1000", "2100.0.1", "0.0.0"])(
  "rejects an Android fork version that cannot produce an ordered version code: %s",
  async (version) => {
    vi.stubEnv("T3CODE_MOBILE_VERSION", version);
    await expect(loadConfig("android-fork")).rejects.toThrow("Android fork version");
  },
);
