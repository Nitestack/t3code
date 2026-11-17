# T3 Code Android APK

The `Nitestack Android APK` workflow builds a signed, sideloadable Android APK on GitHub-hosted
`ubuntu-latest`, with the launcher label **T3 Code**. It uses the official package ID
`com.t3tools.t3code`, because T3 Connect's Clerk instance only accepts that package's sign-in
redirect. It cannot be installed alongside the Play Store app, and Android refuses to update one
with the other because the signing keys differ. Run it manually from
`main` for the standalone Actions artifact `t3-code-android-<run-id>`, containing
`T3-Code-<version>.apk`, its checksum, and metadata. The existing upstream `Release` workflow
reuses this Android build and also builds the Windows installer and matching Nix package. Its
default is build-only: download `t3-code-installers-<version>-<12-character-commit>` from the
Actions run to test `T3-Code-<version>.apk` and `T3-Code-<version>-x64.exe` without creating a tag,
draft, or GitHub release. If the source has no upstream sync marker, supply the full 40-character
SHA in `upstream_base`. An authorized stable release uses the same upstream `vX.Y.Z` tag and
`T3 Code vX.Y.Z` title. The legacy
`t3-android-v*` tag route remains available for compatibility; it does not set the canonical
release version.

The canonical Android app version comes from the stable application version, which the release workflow
checks against the server, desktop, web, and contracts manifests. Android `versionCode` is
`MAJOR * 1000000 + MINOR * 1000 + PATCH`, so each increasing release version produces a larger code.
Minor and patch components must be at most 999, and the result must be within Android's positive
version-code range. Prerelease versions are rejected. The workflow verifies the APK's embedded name
and code against the selected Expo configuration before uploading it.

## Configure the signing key

Generate a dedicated upload key on a trusted machine. `keytool` prompts for the passwords; keep the
keystore and password backup in the team's approved encrypted storage.

```sh
keytool -genkeypair -v \
  -keystore t3code-android-upload.jks \
  -alias t3code-nitestack \
  -storetype JKS -keyalg RSA -keysize 4096 -validity 10000
base64 < t3code-android-upload.jks | tr -d '\r\n'
```

Add these repository Actions secrets in the Nitestack fork:

- `ANDROID_KEYSTORE_BASE64`: the single-line Base64 output
- `ANDROID_KEYSTORE_PASSWORD`: keystore password
- `ANDROID_KEY_ALIAS`: `t3code-nitestack`
- `ANDROID_KEY_PASSWORD`: private-key password

The workflow checks that all four secrets exist before installing dependencies, decodes the key into the runner's temporary directory with restrictive permissions, and passes signing values to Gradle through the process environment. It verifies that the APK certificate matches the configured keystore before uploading the APK, checksum, and metadata. In the combined release artifact those files appear beside the Windows installer and `nix-build.json`. Do not commit the keystore or print secret values. If any secret is missing, the build stops without producing a debug-signed APK.

## Key rotation and integrations

Back up the original keystore and passwords separately from GitHub. For sideloaded installs, replacing the signing key means Android will reject an in-place update signed by the new key. Coordinate rotation as a new install: users must remove the prior app and install the new APK. Keep the old key available for releases intended to update existing installations.

This standalone build disables Expo Updates and does not require EAS, Clerk, Firebase, or Play credentials. Native Google sign-in and push need upstream Google and Firebase credentials tied to the Play signing key, so they may not work. Android HTTPS app-link verification depends on `assetlinks.json` listing the Play signing key, so the app's dedicated `t3code-aix` scheme is the portable deep-link path.

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
