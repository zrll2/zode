/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "watch",
  name: "ZodeWatch",
  displayName: "Zode",
  bundleIdentifier: "com.zode.app.watch",
  // Lowest the SDK allows but not below watchOS 10.
  deploymentTarget: "10.0",
  appleTeamId: "JLB545UV6D",
  frameworks: ["WatchConnectivity"],
};
