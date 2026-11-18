/** 1venue entrypoint (Docker and npm start). */
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

require('./src').start().catch((err) => {
  console.error('[FATAL] 1venue failed to start:', err);
  process.exit(1);
});
