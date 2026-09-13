// pm2 process definitions for a production deploy. From the repo root:
//   pm2 start ecosystem.config.cjs
// See docs/deployment-guide.md for the systemd equivalent if you'd rather
// not use pm2.
module.exports = {
  apps: [
    {
      name: "looksee-engine",
      cwd: "./engine",
      script: "dist/index.js",
      env: { NODE_ENV: "production" },
    },
    {
      name: "looksee-dashboard",
      cwd: "./dashboard",
      script: "node_modules/.bin/next",
      args: "start -p 3100",
      env: { NODE_ENV: "production" },
    },
  ],
};
