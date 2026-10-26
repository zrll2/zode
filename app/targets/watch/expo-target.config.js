/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "watch",
  name: "ZodeWatch",
  displayName: "Zode",
  bundleIdentifier: "sg.comex.zode.watch",
  // Lowest the SDK allows but not below watchOS 10.
  deploymentTarget: "10.0",
  appleTeamId: "XP5Q8LPH52",
  frameworks: ["WatchConnectivity"],
  icon: "../../assets/icon.png",
};
