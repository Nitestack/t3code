const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING_CONFIG_MARKER = "// Nitestack fork release signing";

module.exports = function withAndroidForkSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("The Nitestack Android release signing plugin requires Groovy build.gradle.");
    }

    const contents = nextConfig.modResults.contents;
    if (contents.includes(SIGNING_CONFIG_MARKER)) return nextConfig;

    nextConfig.modResults.contents = `${contents.trimEnd()}

${SIGNING_CONFIG_MARKER}
android {
    signingConfigs {
        release {
            storeFile file(System.getenv("T3_ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("T3_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("T3_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("T3_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
`;

    return nextConfig;
  });
};
