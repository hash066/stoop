# Stoop hosted mode: the web app (real shops, each a private world) and the Alexa+ device tour, on one port.
#   docker build -t stoop .
#   docker run -p 8080:8080 -e ADMIN_KEY=change-me -v stoop-data:/data stoop
# Without LLM_MODE=bedrock the agents run offline (catalog photos only). On AWS add
# -e LLM_MODE=bedrock -e LLM_DAILY_CALL_CAP=... and an instance role with Bedrock access.
FROM node:22-slim AS build
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY . .
# Only what hosted mode needs: the stack and its workspace deps, the four apps, the cards
RUN pnpm install --frozen-lockfile \
      --filter "@stoop/stack..." --filter "@stoop/web..." --filter "@stoop/alexa-sim..." --filter "@stoop/pass..." \
      --filter "@stoop/ops..." --filter "@stoop/ui-cards..." \
 && pnpm build:web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tsx lives in the stack package (pnpm does not hoist it to the root)
WORKDIR /app/services/stack
CMD ["node", "--import", "tsx", "src/serve.ts"]
