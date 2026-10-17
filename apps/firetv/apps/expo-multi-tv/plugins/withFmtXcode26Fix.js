const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

function withFmtXcode26Fix(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        "Podfile"
      );
      let podfile = fs.readFileSync(podfilePath, "utf8");

      if (podfile.includes("CLANG_CXX_LANGUAGE_STANDARD") && podfile.includes("fmt")) {
        return config;
      }

      const fmtFix = `
    # Fix fmt consteval errors on Xcode 26+ by compiling fmt with C++17
    installer.pods_project.targets.each do |target|
      if target.name == 'fmt'
        target.build_configurations.each do |bc|
          bc.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
        end
      end
    end`;

      podfile = podfile.replace(
        /post_install do \|installer\|/,
        `post_install do |installer|${fmtFix}`
      );

      fs.writeFileSync(podfilePath, podfile, "utf8");
      return config;
    },
  ]);
}

module.exports = withFmtXcode26Fix;
