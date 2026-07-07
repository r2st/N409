# Build from the repo root: docker build -f src/services/engine-wrapper/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY src/packages/shared/package.json src/packages/shared/
COPY src/services/engine-wrapper/package.json src/services/engine-wrapper/
RUN npm ci --workspaces --include-workspace-root
COPY src/packages/shared src/packages/shared
COPY src/services/engine-wrapper src/services/engine-wrapper
RUN npx tsc -b src/services/engine-wrapper

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/src/packages/shared/package.json src/packages/shared/
COPY --from=build /repo/src/packages/shared/dist src/packages/shared/dist
COPY --from=build /repo/src/services/engine-wrapper/package.json src/services/engine-wrapper/
COPY --from=build /repo/src/services/engine-wrapper/dist src/services/engine-wrapper/dist
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force
USER node
EXPOSE 3003
CMD ["node", "src/services/engine-wrapper/dist/index.js"]
