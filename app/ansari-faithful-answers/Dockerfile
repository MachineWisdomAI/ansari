FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
RUN printf 'packages: []\ncatalog:\n  typescript: ~6.0.3\noverrides:\n  "@a2ui/markdown-it": "0.2.1"\n' > pnpm-workspace.yaml
RUN node scripts/check-release.mjs && pnpm install --strict-peer-dependencies && pnpm build
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
