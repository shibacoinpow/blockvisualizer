// PM2 config for the ShibaCoin Block Visualizer.
// From the repository directory:
//   pm2 start ecosystem.config.js
//   pm2 save
// Edit the env block to match your server, then: pm2 restart shibacoin-blockvisualizer --update-env
module.exports = {
  apps: [
    {
      name: 'shibacoin-blockvisualizer',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,              // must stay 1: state lives in memory
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      env: {
        PORT: 3002,
        HOST: '127.0.0.1',       // keep on localhost and put nginx/Caddy in front
        SHIBACOIN_CLI: '/usr/local/bin/shibacoin-cli',
        SHIBACOIN_CLI_ARGS: '',  // e.g. '-conf=/home/shibacoin/.shibacoin/shibacoin.conf'
        // One mempool + block cycle every 6 s. Matches the browser's 6 s poll
        // (setInterval(refreshState, 6000) in public/index.html).
        POLL_MS: 6000,
      },
    },
  ],
};
