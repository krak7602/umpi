#!/bin/sh
# Join the tailnet, then serve. The forwarder's port opens only after the device is up, so Umpi waits for a working door.
set -eu
if [ -z "${TS_AUTHKEY:-}" ]; then echo "No Tailscale credential is configured" >&2; exit 1; fi
SOCKET=/tmp/tailscale/tailscaled.sock
tailscaled --tun=userspace-networking --state=mem: --statedir=/tmp/tailscale --socket="$SOCKET" \
  --outbound-http-proxy-listen=127.0.0.1:1055 >/tmp/tailscale/tailscaled.log 2>&1 &
# An OAuth client secret works as an auth key when the device asks for a tag; ephemeral devices leave the tailnet on their own.
case "$TS_AUTHKEY" in
  tskey-client-*) KEY="${TS_AUTHKEY}?ephemeral=true&preauthorized=true" ;;
  *) KEY="$TS_AUTHKEY" ;;
esac
tailscale --socket="$SOCKET" up --auth-key="$KEY" --advertise-tags="${TS_TAGS:-tag:umpi}" --hostname="${TS_HOSTNAME:-umpi-bridge}" --timeout=40s
unset TS_AUTHKEY KEY
export HTTPS_PROXY=http://127.0.0.1:1055 HTTP_PROXY=http://127.0.0.1:1055 NODE_USE_ENV_PROXY=1
exec node /app/bridge.mjs
