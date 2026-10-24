# ---------- Stage 1: build the static site ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build                    # -> /app/dist (plain HTML/CSS/JS)

# ---------- Stage 2: serve it with nginx, as a non-root user ----------
# nginx-unprivileged runs as uid 101 and listens on 8080 instead of 80.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
