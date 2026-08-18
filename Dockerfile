# PRISMA DUEL -- matchmaking + signalling server, and the game it serves.
#
# The container ships the whole client (index.html plus the ES modules under
# src/) because the server doubles as the static host. Once a direct WebRTC
# link is up the peers talk directly and the container is idle for that pair;
# pairs that cannot connect (NAT, firewalls) are relayed through it, opaquely.
#
#   docker build -t prisma-duel .
#   docker run --rm --init -p 8090:8080 prisma-duel

# ---------------------------------------------------------------- build ---
# Assemble index.html from src/. A deploy must not fail because someone edited
# src/ and forgot to run build.js, so a stale copy is rebuilt rather than
# rejected -- but it says so loudly in the build log, because that drift is
# worth knowing about.
FROM node:22-alpine AS build
WORKDIR /build
COPY build.js index.html ./
COPY src/ ./src/
COPY pages/ ./pages/
RUN node build.js --check \
    || (echo ">>> index.html was stale for this commit; rebuilding from src/" \
        && node build.js)

# ----------------------------------------------------------------- deps ---
# Separate layer so a source edit doesn't reinstall `ws`. `npm ci` needs the
# lockfile and installs exactly what it pins.
FROM node:22-alpine AS deps
WORKDIR /deps
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ----------------------------------------------------------------- test ---
# Not built by default. `docker build --target test .` runs the suites that
# need no browser; the headless mesh tests need Chromium and stay outside.
FROM node:22-alpine AS test
WORKDIR /app
COPY --from=deps /deps/node_modules ./server/node_modules
COPY server/ ./server/
COPY src/ ./src/
COPY --from=build /build/index.html ./index.html
RUN node src/core.test.js && node server/test-signalling.js

# --------------------------------------------------------------- runtime ---
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="Prisma Duel" \
      org.opencontainers.image.description="Turn-based spectral laser dogfight; matchmaking + signalling server and the client it hosts." \
      org.opencontainers.image.source="https://github.com/maxberggren/lazer" \
      org.opencontainers.image.licenses="MIT"

# PORT is what the process binds and what EXPOSE advertises; a reverse proxy
# (Coolify/Traefik, or anything else) discovers the port from EXPOSE. Change
# one and you must change the other, so leave both alone unless you mean it.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app

# node:alpine already provides an unprivileged `node` user (uid 1000). Nothing
# here is written at runtime, so the whole tree stays root-owned and read-only
# to the process that serves it.
COPY --from=deps --chown=root:root /deps/node_modules ./server/node_modules
COPY --chown=root:root server/server.js server/package.json server/package-lock.json ./server/
COPY --chown=root:root src/ ./src/
# The icons, the link-preview card, and the three files a crawler asks for by
# name. server.js serves them from STATIC_DIR beside index.html.
COPY --chown=root:root assets/ ./assets/
COPY --chown=root:root site.webmanifest robots.txt sitemap.xml ./
# The site's documents: /how-it-works, /critical-mass and the rest. server.js
# routes the clean URLs to pages/<slug>.html; they wear src/hud.css.
COPY --from=build --chown=root:root /build/pages ./pages/
COPY --from=build --chown=root:root /build/index.html ./index.html

# STATIC_ROOT resolution walks up from server/ looking for an index.html, which
# lands on /app. Pin it anyway so the layout is explicit rather than inferred.
ENV STATIC_DIR=/app

USER node
EXPOSE 8080

# The server answers /healthz with room and peer counts; a 200 means the HTTP
# side and the room table are both alive.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/healthz',timeout:2500},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Direct exec, no shell wrapper, so the process is PID 1 and receives SIGTERM.
# server.js handles it and closes sockets instead of waiting out the timeout.
CMD ["node", "server/server.js"]
