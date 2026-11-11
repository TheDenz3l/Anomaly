const fs = require("fs");
const path = require("path");
const { withFinalizedMod } = require("expo/config-plugins");

/**
 * expo-share-intent names the extension's Xcode target and folder after its display name, so
 * naming it "Anomaly" would collide with the app's own target. It is set up as "Anomaly Share";
 * this renames what the share sheet shows back to "Anomaly", after every other mod has run.
 */
module.exports = function withShareExtensionName(config, { folder, displayName }) {
  return withFinalizedMod(config, [
    "ios",
    async (config) => {
      const file = path.join(
        config.modRequest.platformProjectRoot,
        folder,
        "ShareExtension-Info.plist"
      );
      if (fs.existsSync(file)) {
        const plist = fs.readFileSync(file, "utf8");
        fs.writeFileSync(
          file,
          plist.replace(
            /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
            `$1${displayName}$2`
          )
        );
      }
      return config;
    },
  ]);
};
