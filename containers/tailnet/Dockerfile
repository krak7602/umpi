# Umpi's door into the owner's tailnet. It runs only while Umpi reads or acts on a machine, joins the tailnet as a
# temporary tag:umpi device (userspace networking, no special privileges), and forwards HTTPS requests to ts.net hosts.
FROM tailscale/tailscale:v1.104.4 AS tailscale

FROM node:24.20.0-alpine
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
WORKDIR /app
COPY containers/tailnet/bridge.mjs containers/tailnet/start.sh ./
RUN chmod 755 /app/start.sh && mkdir -p /tmp/tailscale && chown node:node /tmp/tailscale
USER node
EXPOSE 8080
CMD ["/app/start.sh"]
