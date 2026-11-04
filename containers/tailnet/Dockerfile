# Umpi's door into the owner's tailnet. It runs only while Umpi reads or acts on a machine, joins the tailnet as a
# temporary tag:umpi device (userspace networking, no special privileges), and forwards HTTPS requests to ts.net hosts.
FROM tailscale/tailscale:v1.104.4 AS tailscale

FROM node:24.20.0-alpine
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
WORKDIR /app
COPY containers/tailnet/bridge.mjs ./
RUN mkdir -p /tmp/tailscale && chown node:node /tmp/tailscale
USER node
# The forwarder reaches the tailnet through tailscaled's proxy; Node reads these at startup.
ENV HTTPS_PROXY=http://127.0.0.1:1055 HTTP_PROXY=http://127.0.0.1:1055 NODE_USE_ENV_PROXY=1
EXPOSE 8080
# The forwarder starts tailscaled itself, so the two stop together.
CMD ["node", "/app/bridge.mjs"]
