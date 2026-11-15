FROM node:24-alpine AS frontend
RUN apk add --no-cache git
WORKDIR /build
COPY frontend/yacd.json ./frontend/yacd.json
COPY scripts/install-yacd.mjs ./scripts/install-yacd.mjs
RUN node scripts/install-yacd.mjs

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json server.js frontends.js ./
COPY public ./public
COPY --from=frontend /build/vendor/yacd ./vendor/yacd
# LocalAPI requires root for write access to the shared tailscaled Unix socket.
# Run with capabilities dropped, read-only root filesystem, no privileged mode.
USER 0:0
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
