# Build from the repo root: docker build -f src/services/report/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY src/packages/shared/package.json src/packages/shared/
COPY src/services/report/package.json src/services/report/
RUN npm ci --workspaces --include-workspace-root
COPY src/packages/shared src/packages/shared
COPY src/services/report src/services/report
RUN npx tsc -b src/services/report

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/src/packages/shared/package.json src/packages/shared/
COPY --from=build /repo/src/packages/shared/dist src/packages/shared/dist
COPY --from=build /repo/src/services/report/package.json src/services/report/
COPY --from=build /repo/src/services/report/dist src/services/report/dist
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force
USER node
EXPOSE 3004
CMD ["node", "src/services/report/dist/index.js"]
