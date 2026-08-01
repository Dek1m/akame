# ── akame plugin: multi-stage build ──
# Сборка плагина для opencode
# Usage: docker compose build akame

# ── Stage 1: Build ──
FROM node:22-alpine AS builder

WORKDIR /app

# Кэширование зависимостей
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Сборка TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Удаление devDependencies для production
RUN npm prune --omit=dev

# ── Stage 2: Production ──
FROM node:22-alpine AS production

WORKDIR /app

# Копируем собранный код и зависимости
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Метаданные
LABEL maintainer="Argenta Team <dev@argenta.team>"
LABEL description="akame — opencode plugin for memory granulation"
LABEL version="0.11.0"

# Точка входа — экспорт плагина
CMD ["node", "--eval", "console.log(JSON.stringify({name:'akame',version:'0.11.0',status:'ready'}))"]
