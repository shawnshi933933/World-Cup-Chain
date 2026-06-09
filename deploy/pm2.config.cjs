const path = require("path");

const APP_DIR = "/opt/worldcup";

module.exports = {
  apps: [
    {
      name: "worldcup-api",
      script: path.join(APP_DIR, "artifacts/api-server/dist/index.mjs"),
      interpreter: "node",
      interpreter_args: "--enable-source-maps",
      cwd: APP_DIR,
      env_production: {
        NODE_ENV: "production",
        PORT: "3001",
      },
      error_file: path.join(APP_DIR, "logs/api-error.log"),
      out_file: path.join(APP_DIR, "logs/api-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
    },
  ],
};
