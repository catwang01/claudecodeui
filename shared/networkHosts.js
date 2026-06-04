export function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function normalizeLoopbackHost(host) {
  if (!host) {
    return host;
  }
  return isLoopbackHost(host) ? 'localhost' : host;
}

// Use localhost for connectable loopback and wildcard addresses in browser-facing URLs.
export function getConnectableHost(host) {
  if (!host) {
    return 'localhost';
  }
  return isWildcardHost(host) || isLoopbackHost(host) ? 'localhost' : host;
}

// Use 127.0.0.1 for server-to-server proxy targets (e.g. Vite → Express).
// On macOS, 'localhost' resolves to ::1 (IPv6) first; if the server only
// listens on IPv4, the IPv6 connect hangs until timeout and Vite's http.Agent
// connection pool stacks up, making every subsequent proxied request slower.
export function getProxyHost(host) {
  if (!host) {
    return '127.0.0.1';
  }
  return isWildcardHost(host) || isLoopbackHost(host) ? '127.0.0.1' : host;
}
