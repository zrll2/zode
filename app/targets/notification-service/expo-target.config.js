/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "notification-service",
  name: "ZodeNotificationService",
  bundleIdentifier: "sg.comex.zode.notification-service",
  deploymentTarget: "15.1",
  appleTeamId: "XP5Q8LPH52",
  entitlements: {
    "keychain-access-groups": ["$(AppIdentifierPrefix)sg.comex.zode.shared"],
  },
};
