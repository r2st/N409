# Build from the repo root: docker build -f src/services/valuation/Dockerfile .
FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY src/packages/shared/package.json src/packages/shared/
COPY src/services/valuation/package.json src/services/valuation/
RUN npm ci --workspaces --include-workspace-root
COPY src/packages/shared src/packages/shared
COPY src/services/valuation src/services/valuation
RUN npx tsc -b src/services/valuation

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/src/packages/shared/package.json src/packages/shared/
COPY --from=build /repo/src/packages/shared/dist src/packages/shared/dist
COPY --from=build /repo/src/services/valuation/package.json src/services/valuation/
COPY --from=build /repo/src/services/valuation/dist src/services/valuation/dist
COPY --from=build /repo/src/services/valuation/migrations src/services/valuation/migrations
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force
USER node
EXPOSE 3001
CMD ["node", "src/services/valuation/dist/index.js"]
