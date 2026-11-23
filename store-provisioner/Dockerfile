# Build context = repository root (the image bundles charts/store):
#   docker buildx build --platform linux/arm64 -f store-provisioner/Dockerfile -t <registry>/store-provisioner:<tag> .

# ---------- Stage 1: compile ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY store-provisioner/package.json store-provisioner/package-lock.json ./
RUN npm ci
COPY store-provisioner/tsconfig.json ./
COPY store-provisioner/src ./src
RUN npm run build && npm prune --omit=dev

# ---------- Stage 2: helm + kubectl for the target architecture ----------
FROM alpine:3.22 AS tools
ARG TARGETARCH
ARG HELM_VERSION=v3.22.1
RUN apk add --no-cache curl \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" | tar -xz -C /tmp \
 && mv "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
 && KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /usr/local/bin/helm /usr/local/bin/kubectl

# ---------- Stage 3: runtime (non-root, read-only root filesystem in the chart) ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp \
    HELM_CACHE_HOME=/tmp/helm/cache HELM_CONFIG_HOME=/tmp/helm/config HELM_DATA_HOME=/tmp/helm/data
COPY --from=tools /usr/local/bin/helm /usr/local/bin/kubectl /usr/local/bin/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY store-provisioner/package.json ./
COPY charts/store ./charts/store
USER 1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
