// PM2: one process, one sequencer-native flash-arb strategy.
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

module.exports = {
  apps: [{
    name: 'robinhood-sequencer-arb',
    script: 'sequencer-bot.js',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 100,
    restart_delay: 1000,
    max_memory_restart: '700M',
    out_file: './logs/sequencer-out.log',
    error_file: './logs/sequencer-err.log',
    merge_logs: true,
    time: true,
  }],
};
