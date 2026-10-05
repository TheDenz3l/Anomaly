const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

const uniwindConfig = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
});

// Uniwind's web resolver swaps react-native-web's own `exports/InputAccessoryView`
// for its wrapper, which reads `ReactNative.InputAccessoryView` while the RNW index
// is still initialising (circular import → crash on web). Keep RNW's original there.
const uniwindResolve = uniwindConfig.resolver.resolveRequest;
uniwindConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === "web" &&
    moduleName.endsWith("exports/InputAccessoryView") &&
    context.originModulePath.includes("react-native-web")
  ) {
    return context.resolveRequest(context, moduleName, platform);
  }
  return uniwindResolve(context, moduleName, platform);
};

module.exports = uniwindConfig;
