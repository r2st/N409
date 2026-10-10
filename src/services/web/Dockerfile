# Build from the repo root: docker build -f src/services/web/Dockerfile .
FROM node:25-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY src/packages/shared/package.json src/packages/shared/
COPY src/services/web/package.json src/services/web/
COPY src/services/web-frontend/package.json src/services/web-frontend/
RUN npm ci --workspaces --include-workspace-root
COPY src/packages/shared src/packages/shared
COPY src/services/web src/services/web
COPY src/services/web-frontend src/services/web-frontend
RUN npx tsc -b src/services/web && npm run build -w @n409/web-frontend

FROM node:25-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/src/packages/shared/package.json src/packages/shared/
COPY --from=build /repo/src/packages/shared/dist src/packages/shared/dist
COPY --from=build /repo/src/services/web/package.json src/services/web/
COPY --from=build /repo/src/services/web/dist src/services/web/dist
COPY --from=build /repo/src/services/web-frontend/dist src/services/web-frontend/dist
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force
USER node
EXPOSE 3000
# A container that is running is not a container that is serving. Without this,
# the image reports "up" from the moment the process forks — an orchestrator
# routes traffic to a service still running migrations, and a wedged process
# that stopped answering is never restarted because nothing ever asks it.
#
# docker-compose.yml declares its own healthcheck for each service; that stays,
# because compose tunes the intervals per service. This is the floor for every
# *other* way the image is run — `docker run`, a plain scheduler, anything that
# reads the image rather than the compose file.
#
# Shell form on purpose: $PORT is resolved at run time, so an image started on a
# remapped port probes the port it actually bound rather than the build default.
# 127.0.0.1 is correct whether the service bound loopback or 0.0.0.0.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/services/web/dist/index.js"]
