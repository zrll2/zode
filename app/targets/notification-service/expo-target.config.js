/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "notification-service",
  name: "ZodeNotificationService",
  bundleIdentifier: "com.zode.app.notification-service",
  deploymentTarget: "15.1",
  appleTeamId: "JLB545UV6D",
  entitlements: {
    "keychain-access-groups": ["$(AppIdentifierPrefix)com.zode.app.shared"],
  },
};
