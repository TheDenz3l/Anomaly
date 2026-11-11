const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

/**
 * iOS 27 stops any app built with its SDK at launch unless the app uses the scene life cycle
 * (UIKit's _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption trap). Expo ships the
 * scene delegate (ExpoAppSceneDelegate) but SDK 57's template doesn't use it yet, so this:
 * - declares one window scene in Info.plist, run by SceneDelegate;
 * - adds SceneDelegate, a subclass of ExpoAppSceneDelegate, next to the AppDelegate;
 * - leaves creating the window and starting React Native to it, so the AppDelegate only builds the
 *   factory and hands it over through ExpoReactNativeFactoryProvider.
 */

const START =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;
const CLASS = "class AppDelegate: ExpoAppDelegate {";

function adoptScenes(contents) {
  if (contents.includes("ExpoReactNativeFactoryProvider")) return contents;
  if (!contents.includes(CLASS) || !START.test(contents)) {
    throw new Error(
      "withSceneLifecycle: AppDelegate.swift doesn't match the Expo template it expects. Adopt the scene life cycle by hand, or update the plugin."
    );
  }
  return (
    contents
      .replace(CLASS, "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {")
      .replace(
        START,
        "\n    // SceneDelegate creates the window and starts React Native into it.\n"
      ) +
    "\n/** Runs the app's one window scene; required to launch on iOS 27. */\nclass SceneDelegate: ExpoAppSceneDelegate {}\n"
  );
}

module.exports = function withSceneLifecycle(config) {
  config = withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      throw new Error("withSceneLifecycle: expects a Swift AppDelegate.");
    }
    config.modResults.contents = adoptScenes(config.modResults.contents);
    return config;
  });
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return config;
  });
};

module.exports.adoptScenes = adoptScenes;
