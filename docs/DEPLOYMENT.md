# Стандарт развертывания akame

> Версия: 1.0.0  
> Дата: 2026-07-30  
> Автор: Рэй (DevOps)

---

## Принципы

1. **Сборка ТОЛЬКО через compose** — нет `docker build` напрямую
2. **Context = git-клон проекта** — `docker-compose.yml` в корне репозитория
3. **Dockerfile относительно context** — `dockerfile: Dockerfile` (не абсолютный путь)
4. **GH Actions через compose** — используем `docker compose build`

---

## Структура файлов

```
akame/
├── Dockerfile                  # Многостадийная сборка плагина
├── docker-compose.yml          # Определение сервисов
├── deploy.sh                   # Скрипт деплоя (SSH/rsync)
├── .dockerignore               # Исключения для build context
├── .github/
│   └── workflows/
│       ├── ci.yml              # Тестирование (PR)
│       └── deploy.yml          # Сборка + деплой (main)
└── dist/                       # Собранный код (артефакт)
```

---

## Dockerfile

### Многостадийная сборка

```dockerfile
# Stage 1: Builder — компиляция TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Production — минимальный образ
FROM node:22-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
```

### Почему two-stage

- **Builder**: полная среда с devDependencies (TypeScript, Vitest)
- **Production**: только runtime (Node.js + dist + node_modules)
- **Размер**: ~150MB vs ~500MB (single-stage)

### Build context

```bash
# Всегда из корня проекта
docker compose build akame

# НЕ напрямую
docker build -t akame .  # ❌ Запрещено
```

---

## docker-compose.yml

### Сервис akame (build)

```yaml
services:
  akame:
    build:
      context: .                    # Git-клон проекта
      dockerfile: Dockerfile        # Относительно context
      target: production            # Target stage
    image: ghcr.io/argenta-team/akame:latest
    volumes:
      - akame-dist:/app/dist:ro
    profiles:
      - build
```

### Сервисы dev-окружения

```yaml
services:
  opencode:
    image: ghcr.io/opencode-ai/opencode:latest
    volumes:
      - ./dist:/home/opencode/.config/opencode/plugins/akame/dist:ro
    depends_on:
      athena-memory:
        condition: service_healthy

  athena-memory:
    image: ghcr.io/selti-project/athena-memory:latest
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: pgvector/pgvector:pg17
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
```

### Profiles

| Profile | Сервисы | Назначение |
|---------|---------|------------|
| `build` | akame | Сборка плагина |
| `dev` | opencode, athena-memory, postgres, redis | Локальная разработка |

```bash
# Сборка
docker compose --profile build build akame

# Dev-окружение
docker compose --profile dev up -d

# Все сразу
docker compose --profile build --profile dev up -d
```

---

## GitHub Actions

### Workflow: deploy.yml

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'package.json'
      - 'Dockerfile'
      - 'docker-compose.yml'
  workflow_dispatch:
    inputs:
      dry_run:    # Только сборка
      rollback_tag:  # Откат на версию
```

### Jobs

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    build    │────>│   deploy    │     │  rollback   │
│             │     │             │     │             │
│ - npm ci    │     │ - rsync     │     │ - docker    │
│ - tsc       │     │ - ssh       │     │   pull      │
│ - vitest    │     │ - restart   │     │ - docker    │
│ - docker    │     │ - health    │     │   restart   │
│   build     │     │   check     │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                    │
      ▼                   ▼                    ▼
  ghcr.io/           ai.atom.ui          ai.atom.ui
  argenta-team/      ~/.config/          (older tag)
  akame:latest       opencode/plugins/
```

### Сборка через compose

```yaml
- name: Build and push Docker image
  uses: docker/build-push-action@v5
  with:
    context: .           # Git-клон
    file: ./Dockerfile   # Относительно context
    push: true
    tags: ${{ steps.meta.outputs.tags }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

### Кэширование

- **Layer cache**: GHA cache (type=gha)
- **npm cache**: actions/setup-node с cache: 'npm'
- **Docker cache**: registry (ghcr.io)

---

## Деплой

### Ручной деплой

```bash
# Полный цикл
./deploy.sh

# Только сборка
./deploy.sh --dry-run

# Dev-окружение
./deploy.sh --dev

# Откат
./deploy.sh --rollback v0.10.0

# Очистка
./deploy.sh --cleanup
```

### Автоматический деплой

При пуше в `main`:
1. CI: `npm ci` → `tsc` → `vitest` → `docker build`
2. CD: `rsync dist/` → `docker restart` → `health check`

### Rollback

```bash
# Через workflow
gh workflow run deploy.yml -f rollback_tag=v0.10.0

# Через скрипт
./deploy.sh --rollback v0.10.0
```

---

## Переменные окружения

### Docker Compose

| Переменная | Дефолт | Описание |
|------------|--------|----------|
| `AKAME_MCP_URL` | `http://athena-memory:8000/mcp/` | URL athena-memory |
| `AKAME_USER_ID` | `akame` | Владелец записей |
| `AKAME_COOLDOWN_MS` | `30000` | Cooldown (мс) |

### Deploy script

| Переменная | Дефолт | Описание |
|------------|--------|----------|
| `DEPLOY_SERVER` | `ai.atom.ui` | Адрес сервера |
| `DEPLOY_USER` | `svc_athene_ai` | SSH пользователь |
| `DEPLOY_KEY` | `~/.config/opencode/.ssh/...` | SSH ключ |
| `DEPLOY_PLUGIN_DIR` | `/home/opencode/.config/opencode/plugins/akame` | Директория плагина |
| `DEPLOY_CONTAINER` | `opencode` | Имя контейнера |

### GitHub Secrets

| Secret | Описание |
|--------|----------|
| `DEPLOY_SSH_KEY` | SSH приватный ключ для деплоя |

### GitHub Variables

| Variable | Дефолт | Описание |
|----------|--------|----------|
| `DEPLOY_SERVER` | `ai.atom.ui` | Адрес сервера |
| `DEPLOY_USER` | `svc_athene_ai` | SSH пользователь |
| `DEPLOY_PLUGIN_DIR` | `~/.config/opencode/plugins/akame` | Директория плагина |
| `DEPLOY_CONTAINER` | `opencode` | Имя контейнера |

---

## Health Check

### Контейнер opencode

```bash
# Проверка статуса
docker inspect --format='{{.State.Health.Status}}' opencode

# Ожидание healthy
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' opencode 2>/dev/null)
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
```

### Верификация плагина

```bash
# Проверка версии
docker exec opencode cat /home/opencode/.config/opencode/plugins/akame/package.json | jq -r .version

# Проверка наличия файлов
docker exec opencode ls -la /home/opencode/.config/opencode/plugins/akame/dist/
```

---

## Troubleshooting

### Контейнер не стартует

```bash
# Логи
docker logs opencode --tail 100

# Проверка конфига
docker exec opencode cat /home/opencode/.config/opencode/opencode.json

# Проверка плагина
docker exec opencode ls -la /home/opencode/.config/opencode/plugins/akame/
```

### Плагин не загружается

```bash
# Проверка entry point
docker exec opencode cat /home/opencode/.config/opencode/plugins/akame/dist/index.js | head -5

# Проверка зависимостей
docker exec opencode ls /home/opencode/.config/opencode/plugins/akame/node_modules/

# Проверка логов opencode
docker logs opencode 2>&1 | grep -i "akame"
```

### SSH недоступен

```bash
# Проверка ключа
ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no svc_athene_ai@ai.atom.ui "echo ok"

# Проверка known_hosts
ssh-keyscan -H ai.atom.ui >> ~/.ssh/known_hosts
```

---

## Чек-лист деплоя

- [ ] `npm ci` — зависимости установлены
- [ ] `npx tsc --noEmit` — типы проверены
- [ ] `npx vitest run` — тесты зелёные
- [ ] `docker compose build akame` — образ собран
- [ ] `docker compose up -d` — контейнер запущен
- [ ] `docker inspect --format='{{.State.Health.Status}}' opencode` — healthy
- [ ] Логи без ошибок
- [ ] Версия в `package.json` актуальна

---

## Связанные документы

- [PLAN.md](../PLAN.md) — общий план проекта
- [README.md](../README.md) — описание проекта
- [docs/CONFIGURATION.md](CONFIGURATION.md) — конфигурация плагина
