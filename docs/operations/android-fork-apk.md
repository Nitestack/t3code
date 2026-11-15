# Nitestack Android APK

The `Nitestack Android APK` workflow builds a signed, sideloadable Android APK on GitHub-hosted `ubuntu-latest`. Run it manually from `main` for a workflow artifact, or push a `t3-android-v*` tag to attach the APK, SHA-256 checksum, and version metadata to a GitHub Release. It does not run on the hourly upstream checks and builds Android only.

Release tags use `t3-android-vMAJOR.MINOR.PATCH` and set the APK version from that tag. A manual run can supply the `version` input; otherwise it uses the app configuration's version. Android `versionCode` is `MAJOR * 1000000 + MINOR * 1000 + PATCH`, so each increasing release version produces a larger code. Minor and patch components must be at most 999, and the result must be within Android's positive version-code range. Prerelease versions are rejected. The workflow verifies the APK's embedded name and code against the selected Expo configuration before uploading it.

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

The workflow checks that all four secrets exist before installing dependencies, decodes the key into the runner's temporary directory with restrictive permissions, and passes signing values to Gradle through the process environment. It verifies that the APK certificate matches the configured keystore before uploading only the APK, checksum, and metadata. Do not commit the keystore or print secret values. If any secret is missing, the build stops without producing a debug-signed APK.

## Key rotation and integrations

Back up the original keystore and passwords separately from GitHub. For sideloaded installs, replacing the signing key means Android will reject an in-place update signed by the new key. Coordinate rotation as a new install: users must remove the prior app and install the new APK. Keep the old key available for releases intended to update existing installations.

This standalone build disables Expo Updates and does not require EAS, Clerk, Firebase, or Play credentials. Any sign-in, push, or Google OAuth flow that requires upstream Clerk/Firebase application credentials is unavailable until the fork supplies compatible configuration. Android HTTPS app-link verification also depends on a matching `assetlinks.json` for the fork package, so the app's dedicated `t3code-aix` scheme is the portable deep-link path.

## Update and rollback

Install a newer release APK over the existing app. Android keeps its data when the package name and signing certificate match and the `versionCode` is higher. Before installing, compare the APK's SHA-256 with the `.sha256` file from the same release.

Android refuses to install a lower `versionCode` over a newer one. To roll back, publish the known-good source as a new, higher patch version, for example `t3-android-v1.2.4` built from the commit behind `1.2.2`. Uninstalling and reinstalling an older APK also works, but it deletes the app's saved environments and settings. Don't delete or reuse a published tag. Release a fixed version instead.

## Troubleshooting

- **The build stops before installing dependencies.** One of the four signing secrets is missing or empty. Check the secret names, not their values.
- **"APK signature does not match the configured upload keystore".** The `ANDROID_KEY_ALIAS` or a password belongs to a different key than `ANDROID_KEYSTORE_BASE64`. The log prints both certificate digests. Compare them with `keytool -list -v` on the backed-up keystore.
- **Generating the Android project fails on the version.** The tag or `version` input is not plain `MAJOR.MINOR.PATCH`, or a component is above 999. Push a corrected tag.
- **"APK version does not match".** The built APK's version name or code differs from the Expo configuration. Check that no config plugin or Gradle setting overrides them.
- **Android reports "App not installed" or a package conflict.** The installed app has a different signing certificate or a higher `versionCode`. See [Update and rollback](#update-and-rollback) and [Key rotation](#key-rotation-and-integrations).
- **The workflow never starts.** See the Actions known issue in the [fork release runbook](./fork-release.md#known-issues).
