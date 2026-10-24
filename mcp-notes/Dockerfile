# ---------- Stage 1: build ----------
# Has the full toolchain (TypeScript, type definitions). Thrown away at the end.
FROM node:22-alpine AS build
WORKDIR /app

# Copy only the dependency lists first. Docker caches each step, so as long as
# these two files don't change, "npm ci" is skipped on the next build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build                 # tsc: src/*.ts -> dist/*.js


# ---------- Stage 2: runtime ----------
# Starts clean. Gets only: production dependencies + the compiled JavaScript.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force   # no typescript/tsx/@types in the final image

COPY --from=build /app/dist ./dist

# The node image ships an unprivileged user "node" (uid 1000). If someone breaks
# into the process, they are not root inside the container.
USER node

EXPOSE 3000
# Kubernetes will use /healthz for probes; this is the plain-Docker equivalent.
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# No secrets here: WC_BASE_URL / keys arrive as environment variables at runtime.
CMD ["node", "dist/server.js"]
