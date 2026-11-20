// Metro (React Native's JavaScript bundler) configuration. Metro normally only
// bundles files inside this folder; watchFolders adds the dashboard's shared
// library folder, so the app uses the dashboard's own API client and
// check-type registry (dashboard/app/lib/api.ts, checkTypes.ts) instead of
// copies that could drift apart.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../dashboard/app/lib")];

module.exports = config;
