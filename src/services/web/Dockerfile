# Build from the repo root: docker build -f src/services/web/Dockerfile .
FROM node:22-alpine AS build
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

FROM node:22-alpine
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
CMD ["node", "src/services/web/dist/index.js"]
