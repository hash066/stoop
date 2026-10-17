const { withXcodeProject } = require("expo/config-plugins");

function withTvosDeploymentTarget(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();

    for (const key in configurations) {
      const buildSettings = configurations[key].buildSettings;
      if (buildSettings && buildSettings.TVOS_DEPLOYMENT_TARGET) {
        buildSettings.TVOS_DEPLOYMENT_TARGET = "15.1";
      }
    }

    return config;
  });
}

module.exports = withTvosDeploymentTarget;
