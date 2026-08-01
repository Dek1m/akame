# Стандарт развертывания akame

> Версия: 1.0
> Статус: Черновик
> Целевая аудитория: разработчики, DevOps

---

## 1. Цель

Единый стандарт развертывания плагина akame: от написания кода до работы на продакшене. Отвечает на вопросы «как собрать», «как задеплоить», «как откатить».

---

## 2. Среда

| Параметр | Значение |
|---|---|
| Сервер | `ai.atom.ui` |
| Runtime | Bun (встроен в opencode) |
| Контейнер | Docker (opencode) |
| ОС сервера | Debian |
| Docker | 29.5.2 |
| Compose | v5.1.4 |

---

## 3. Build

### 3.1 Локальная сборка

```bash
# Из корня проекта
npm ci
npm run build
```

**Что происходит:**
- `npm ci` — чистая установка зависимостей из `package-lock.json`
- `npm run build` → `tsc` — компиляция TypeScript в `dist/`

**Результат:** директория `dist/` с `.js`, `.d.ts`, `.d.ts.map`, `.js.map` файлами.

### 3.2 Проверки перед коммитом

```bash
# Typecheck (без генерации файлов)
npx tsc --noEmit

# Тесты
npx vitest run

# Всё вместе
npm run build && npx tsc --noEmit && npx vitest run
```

**Минимум для коммита:** `tsc --noEmit` без ошибок + все тесты зелёные.

---

## 4. Context в Dockerfile

### 4.1 Принцип

Docker-сборка akame **не нужна** — плагин устанавливается как npm-пакет в существующий контейнер opencode. Но если потребуется изолированная среда для тестов или сборки:

### 4.2 Dockerfile (для тестирования/CI)

```dockerfile
# ── Stage 1: зависимости ──
FROM node:22-slim AS deps

WORKDIR /app

# Копируем только то, что нужно для установки
COPY package.json package-lock.json ./

# Кэширование: слой не пересобирается, пока не изменится package*.json
RUN npm ci

# ── Stage 2: сборка + тесты ──
FROM deps AS build

COPY tsconfig.json ./
COPY src/ ./src/

# Typecheck + сборка
RUN npx tsc --noEmit && npx tsc

# ── Stage 3: runtime (minimal) ──
FROM node:22-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ ./dist/

# Плагин готов к подключению
```

### 4.3 Правила контекста

| Правило | Описание |
|---|---|
| **COPY package*.json отдельно** | Слой кэша зависимостей не сбрасывается при изменении кода |
| **npm ci, не npm install** | Гарантирует воспроизводимость через lock-файл |
| **--omit=dev в runtime** | devDependencies (vitest, typescript) не попадают в продакшен |
| **Нет COPY ./** | Копируются только нужные файлы — уменьшение образа и кэширование |
| **.dockerignore** | Исключить `node_modules/`, `dist/`, `.git/`, `.env`, `tests/` |

### 4.4 .dockerignore

```
node_modules/
dist/
.git/
.env
.env.*
*.log
tests/
coverage/
.github/
docs/
```

---

## 5. Деплой на ai.atom.ui

### 5.1 Текущий процесс (ручной)

```bash
# 1. Сборка локально
cd /home/opencode/projects/akame
npm ci && npm run build

# 2. Копирование на сервер
scp -r dist/* svc_athene_ai@ai.atom.ui:~/.config/opencode/plugins/akame/

# 3. Перезапуск контейнера
ssh svc_athene_ai@ai.atom.ui "docker restart opencode"
```

### 5.2 Целевой процесс (через GH Actions)

См. секцию 6.

---

## 6. GitHub Actions Integration

### 6.1 Текущий workflow

Файл: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: "npm"
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run --reporter=verbose
      - run: npx tsc
```

**Что проверяет:**
- Установка зависимостей (`npm ci`)
- Typecheck (`tsc --noEmit`)
- 88 тестов (`vitest run`)
- Сборка (`tsc` → `dist/`)

### 6.2 Целевой workflow: CI + CD

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  # ── CI: проверки ──
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "npm"
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run --reporter=verbose
      - run: npx tsc

  # ── CD: деплой (только push в main, не PR) ──
  deploy:
    needs: ci
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "npm"
      - run: npm ci
      - run: npx tsc

      # Деплой через rsync + SSH
      - name: Deploy to ai.atom.ui
        env:
          SSH_KEY: ${{ secrets.SSH_DEPLOY_KEY }}
          SERVER: svc_athene_ai@ai.atom.ui
          REMOTE_DIR: ~/.config/opencode/plugins/akame
        run: |
          mkdir -p ~/.ssh
          echo "$SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key

          rsync -avz --delete \
            -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \
            dist/ $SERVER:$REMOTE_DIR/

      # Рестарт контейнера
      - name: Restart opencode
        env:
          SSH_KEY: ${{ secrets.SSH_DEPLOY_KEY }}
          SERVER: svc_athene_ai@ai.atom.ui
        run: |
          ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no $SERVER \
            "docker restart opencode"
```

### 6.3 Необходимые secrets

| Secret | Описание | Где взять |
|---|---|---|
| `SSH_DEPLOY_KEY` | SSH-ключ для доступа к ai.atom.ui | `~/.config/opencode/.ssh/svc_athene_ai@atom.ui.key` |

### 6.4 Порядок настройки

1. Скопировать SSH-ключ в GitHub Secrets:
   ```bash
   # В настройках репозитория → Settings → Secrets → Actions
   # Название: SSH_DEPLOY_KEY
   # Значение: содержимое файла ~/.config/opencode/.ssh/svc_athene_ai@atom.ui.key
   ```

2. Добавить workflow-файл `.github/workflows/deploy.yml`

3. Пуш в `main` автоматически задеплоит

### 6.5 Что НЕ деплоится через GH Actions

| Что | Почему | Как |
|---|---|---|
| `opencode.json` | Конфиг агентов, не часть плагина | Ручное копирование или отдельный workflow |
| `AGENTS.md`, `agents/*.md` | Промпты агентов | Ручное копирование |
| `~/.config/opencode/` | Глобальные настройки opencode | Ручное управление |

---

## 7. Rollback

### 7.1 Быстрый откат (git)

```bash
# На сервере
ssh svc_athene_ai@ai.atom.ui

# Вернуть предыдущую версию dist/
cd ~/.config/opencode/plugins/akame
git log --oneline -5  # найти коммит
git checkout <previous-commit> -- dist/

# Рестарт
docker restart opencode
```

### 7.2 Откат через GH Actions

```bash
# Через GitHub UI
# Actions → последний успешный workflow → Re-run all jobs

# Или через CLI
gh run list --limit 5
gh run rerun <failed-run-id>
```

### 7.3 Полный откат (контейнер)

```bash
ssh svc_athene_ai@ai.atom.ui
docker stop opencode
docker rm opencode

# Восстановить из backup или пересоздать
docker compose -f /home/svc_athene_ai@atom.ui/app/docker-compose.yml up -d opencode
```

---

## 8. Health Check

### 8.1 Проверка плагина

```bash
# После деплоя — проверить логи
ssh svc_athene_ai@ai.atom.ui "docker logs opencode --tail=20"

# Должно появиться:
# akame загружен (userId: akame)
```

### 8.2 Проверка athena-memory

```bash
# Health check MCP-сервера
curl -s http://localhost:8000/healthz

# Проверка через opencode
# В диалоге: memory_stats
```

### 8.3 Автоматический health check (для CD)

```yaml
      - name: Health check
        run: |
          sleep 10  # Ждём перезапуска
          ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no $SERVER \
            "curl -sf http://localhost:8000/healthz || exit 1"
```

---

## 9. Секреты и безопасность

### 9.1 Что НЕ коммитится

| Файл | Причина |
|---|---|
| `.env` | Содержит `AKAME_API_KEY` |
| `~/.ssh/` | SSH-ключи |
| `opencode.json` | Содержит API-ключи провайдеров |

### 9.2 Где хранить секреты

| Секрет | Где |
|---|---|
| `AKAME_API_KEY` | `.env` на сервере или Docker env |
| SSH-ключ деплоя | GitHub Secrets (`SSH_DEPLOY_KEY`) |
| API-ключи LLM | `opencode.json` на сервере (не в Git) |

### 9.3 Правила

- **Никогда** не коммитить `.env`, ключи, токены
- Использовать `secrets.*` в GitHub Actions
- Ротация SSH-ключей — раз в 90 дней
- `AKAME_API_KEY` — отдельный ключ для каждого окружения

---

## 10. Troubleshooting

| Проблема | Решение |
|---|---|
| `akame не загружен` в логах | Проверить путь в `opencode.json` → `source` |
| `MCP timeout` | Проверить доступность `athena-memory` (`curl localhost:8000/healthz`) |
| `permission denied` для tools | Проверить `opencode.json` → `permission` секция |
| `tsc` ошибки после pull | `rm -rf dist && npm run build` |
| Контейнер не стартует | `docker logs opencode` — смотреть ошибки |
| Деплой не работает | Проверить SSH-ключ в GitHub Secrets |
| `module not found` | `npm ci` (не `npm install`) — чистая установка |

---

## 11. Чек-лист перед деплоем

- [ ] `npx tsc --noEmit` — 0 ошибок
- [ ] `npx vitest run` — все тесты зелёные
- [ ] `npm run build` — `dist/` создан
- [ ] `.env` на сервере актуален (новые env vars добавлены?)
- [ ] SSH-ключ в GitHub Secrets не истёк
- [ ] `opencode.json` на сервере содержит нужные permission rules
- [ ] После деплоя: `docker logs opencode` показывает `akame загружен`

---

## 12. Версионирование

| Что | Формат | Пример |
|---|---|---|
| Версия плагина | `package.json` → `version` | `0.11.0` |
| Git-тег | `v{version}` | `v0.11.0` |
| CHANGELOG | Добавлять в `PLAN.md` или отдельный файл | `## v0.11.0 — ...` |

### Порядок релиза

1. Обновить `version` в `package.json`
2. Обновить CHANGELOG
3. Коммит + пуш
4. Создать тег: `git tag v0.11.0 && git push --tags`
5. GH Actions задеплоит автоматически (если workflow настроен)
