# A cloud machine: T3 Code with the Pi agent, Git over SSH, and a small control server Umpi talks to. Pi's model
# calls go to Umpi's gateway, so the container holds no model credential. State is packed into R2 when it sleeps.
FROM node:24.20.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates zstd procps ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g t3@0.1.6 @earendil-works/pi-coding-agent@1.5.0 && npm cache clean --force
# GitHub's host keys, pinned at build time so clones never trust a key on first use.
RUN ssh-keyscan -t ed25519,ecdsa,rsa github.com > /etc/ssh/ssh_known_hosts 2>/dev/null && test -s /etc/ssh/ssh_known_hosts
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent
# Fetch T3 Code's server runtime into the image, so a wake does not download it.
RUN t3 --version && test -d /home/agent/.t3/runtime
COPY --chown=agent:agent containers/cloud-machine/control.mjs /app/control.mjs
EXPOSE 8080 3773
CMD ["node", "/app/control.mjs"]
