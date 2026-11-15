# Nitestack Android APK

The `Nitestack Android APK` workflow builds a signed, sideloadable Android APK on GitHub-hosted
`ubuntu-latest`. Run it manually from `main` for a standalone workflow artifact. The existing
upstream `Release` workflow reuses this Android build and also builds the Windows installer and
matching Nix package. Its default is build-only: download
`t3-code-nitestack-installers-<version>-<12-character-commit>` from the Actions run to test the APK
and Windows installer without creating a tag, draft, or GitHub release. An authorized stable
release uses the same upstream `vX.Y.Z` tag and `T3 Code vX.Y.Z` title. The legacy
`t3-android-v*` tag route remains available for compatibility; it does not set the canonical
release version.

The canonical Android app version comes from the stable application version, which the release workflow
checks against the server, desktop, web, and contracts manifests. Android `versionCode` is
`MAJOR * 1000000 + MINOR * 1000 + PATCH`, so each increasing release version produces a larger code.
Minor and patch components must be at most 999, and the result must be within Android's positive
version-code range. Prerelease versions are rejected. The workflow verifies the APK's embedded name
and code against the selected Expo configuration before uploading it.

## Configure the signing key

Generate a dedicated upload key on a trusted machine. `keytool` prompts for the passwords; keep the keystore and password backup in the team's approved encrypted storage.

```sh
keytool -genkeypair -v \
  -keystore t3code-nitestack-upload.jks \
  -alias t3code-nitestack \
  -storetype JKS -keyalg RSA -keysize 4096 -validity 10000
base64 < t3code-nitestack-upload.jks | tr -d '\r\n'
```

Add these repository Actions secrets in the Nitestack fork:

- `ANDROID_KEYSTORE_BASE64`: the single-line Base64 output
- `ANDROID_KEYSTORE_PASSWORD`: keystore password
- `ANDROID_KEY_ALIAS`: `t3code-nitestack`
- `ANDROID_KEY_PASSWORD`: private-key password

The workflow checks that all four secrets exist before installing dependencies, decodes the key into the runner's temporary directory with restrictive permissions, and passes signing values to Gradle through the process environment. It verifies that the APK certificate matches the configured keystore before uploading the APK, checksum, and metadata. In the combined release artifact those files appear beside the Windows installer and `nix-build.json`. Do not commit the keystore or print secret values. If any secret is missing, the build stops without producing a debug-signed APK.

## Key rotation and integrations

Back up the original keystore and passwords separately from GitHub. For sideloaded installs, replacing the signing key means Android will reject an in-place update signed by the new key. Coordinate rotation as a new install: users must remove the prior app and install the new APK. Keep the old key available for releases intended to update existing installations.

This standalone build disables Expo Updates and does not require EAS, Clerk, Firebase, or Play credentials. Any sign-in, push, or Google OAuth flow that requires upstream Clerk/Firebase application credentials is unavailable until the fork supplies compatible configuration. Android HTTPS app-link verification also depends on a matching `assetlinks.json` for the fork package, so the app's dedicated `t3code-aix` scheme is the portable deep-link path.

## Update and rollback

Install a newer release APK over the existing app. Android keeps its data when the package name and signing certificate match and the `versionCode` is higher. Before installing, compare the APK's SHA-256 with the `.sha256` file from the same release.

Android refuses to install a lower `versionCode` over a newer one. A canonical fork release always follows the upstream stable version and tag; never create a fork-only version to roll back. Uninstalling and reinstalling an older APK works, but it deletes the app's saved environments and settings. Keep a backup before downgrading, and do not delete or reuse a published tag.

## Troubleshooting

- **The build stops before installing dependencies.** One of the four signing secrets is missing or empty. Check the secret names, not their values.
- **"APK signature does not match the configured upload keystore".** The `ANDROID_KEY_ALIAS` or a password belongs to a different key than `ANDROID_KEYSTORE_BASE64`. The log prints both certificate digests. Compare them with `keytool -list -v` on the backed-up keystore.
- **Generating the Android project fails on the version.** The tag or `version` input is not plain `MAJOR.MINOR.PATCH`, or a component is above 999. Push a corrected tag.
- **"APK version does not match".** The built APK's version name or code differs from the Expo configuration. Check that no config plugin or Gradle setting overrides them.
- **Android reports "App not installed" or a package conflict.** The installed app has a different signing certificate or a higher `versionCode`. See [Update and rollback](#update-and-rollback) and [Key rotation](#key-rotation-and-integrations).
- **The release workflow rejects the source.** The exact commit must be contained in fork `main`,
  have a successful `CI` run on `main`, and use the same stable version across the application
  manifests. See the [fork release runbook](./fork-release.md#release-checklist).
