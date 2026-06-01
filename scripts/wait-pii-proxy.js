#!/usr/bin/env node

/**
 * Wait for PII proxy to be ready on the configured port
 */

import waitOn from 'wait-on';

const port = process.env.PII_PROXY_PORT || '18090';
const resource = `tcp:127.0.0.1:${port}`;

console.log(`[wait-pii-proxy] Waiting for PII proxy on port ${port}...`);

waitOn({
  resources: [resource],
  timeout: 30000,
  interval: 100,
})
  .then(() => {
    console.log(`[wait-pii-proxy] PII proxy is ready on port ${port}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[wait-pii-proxy] Timeout waiting for port ${port}:`, err.message);
    process.exit(1);
  });
