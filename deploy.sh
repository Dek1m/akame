#!/usr/bin/env bash
# ── akame: Deploy Script ──
# Полный цикл сборки и деплоя плагина на сервер
#
# Использование:
#   ./deploy.sh                    # Деплой на production
#   ./deploy.sh --dry-run          # Только сборка, без деплоя
#   ./deploy.sh --dev              # Запуск dev-окружения
#   ./deploy.sh --rollback <tag>   # Откат на версию
#
# Требования:
#   - Docker и Docker Compose v2
#   - SSH доступ к серверу (ai.atom.ui)
#   -jq (для парсинга JSON)

set -euo pipefail

# ── Конфигурация ──
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SERVER="${DEPLOY_SERVER:-ai.atom.ui}"
readonly SSH_USER="${DEPLOY_USER:-svc_athene_ai}"
readonly SSH_KEY="${DEPLOY_KEY:-$HOME/.config/opencode/.ssh/svc_athene_ai@atom.ui.key}"
readonly PLUGIN_DIR="${DEPLOY_PLUGIN_DIR:-/home/opencode/.config/opencode/plugins/akame}"
readonly CONTAINER_NAME="${DEPLOY_CONTAINER:-opencode}"
readonly COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"

# ── Цвета ──
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

# ── Утилиты ──
log() { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Проверки ──
check_prerequisites() {
    log "Проверка зависимостей..."

    command -v docker >/dev/null 2>&1 || error "Docker не установлен"
    command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || error "Docker Compose v2 не установлен"
    command -v jq >/dev/null 2>&1 || warn "jq не установлен — JSON-парсинг недоступен"

    if [[ ! -f "$SCRIPT_DIR/package.json" ]]; then
        error "package.json не найден. Запустите скрипт из корня проекта."
    fi

    success "Все зависимости установлены"
}

# ── Сборка ──
build() {
    log "Сборка плагина akame..."

    # Сборка Docker-образа через compose
    docker compose build akame

    success "Образ собран: ghcr.io/argenta-team/akame:latest"
}

# ── Тестирование ──
test_build() {
    log "Проверка собранных артефактов..."

    # Проверяем, что dist/ существует
    if [[ ! -d "$SCRIPT_DIR/dist" ]]; then
        error "Директория dist/ не найдена. Сначала выполните 'npm run build'"
    fi

    # Проверяем наличие ключевых файлов
    local required_files=("index.js" "index.d.ts")
    for file in "${required_files[@]}"; do
        if [[ ! -f "$SCRIPT_DIR/dist/$file" ]]; then
            error "Файл dist/$file не найден"
        fi
    done

    success "Артефакты проверены"
}

# ── Деплой ──
deploy() {
    log "Деплой на сервер $SERVER..."

    # Формируем команду SSH
    local ssh_opts=(
        -i "$SSH_KEY"
        -o StrictHostKeyChecking=no
        -o ConnectTimeout=10
    )

    # Проверяем SSH доступ
    log "Проверка SSH доступа..."
    ssh "${ssh_opts[@]}" "${SSH_USER}@${SERVER}" "echo 'SSH OK'" || error "SSH доступ недоступен"

    # Копируем артефакты
    log "Копирование файлов..."
    rsync -avz --delete \
        -e "ssh ${ssh_opts[*]}" \
        "$SCRIPT_DIR/dist/" \
        "${SSH_USER}@${SERVER}:${PLUGIN_DIR}/dist/"

    # Копируем package.json
    scp "${ssh_opts[@]}" \
        "$SCRIPT_DIR/package.json" \
        "${SSH_USER}@${SERVER}:${PLUGIN_DIR}/package.json"

    # Перезапускаем контейнер
    log "Перезапуск контейнера $CONTAINER_NAME..."
    ssh "${ssh_opts[@]}" "${SSH_USER}@${SERVER}" \
        "docker restart $CONTAINER_NAME"

    # Ждём healthy статуса
    log "Ожидание готовности контейнера..."
    local max_attempts=30
    local attempt=1
    while [[ $attempt -le $max_attempts ]]; do
        if ssh "${ssh_opts[@]}" "${SSH_USER}@${SERVER}" \
            "docker inspect --format='{{.State.Health.Status}}' $CONTAINER_NAME 2>/dev/null" | grep -q "healthy"; then
            success "Контейнер $CONTAINER_NAME готов"
            return 0
        fi
        sleep 2
        ((attempt++))
    done

    warn "Контейнер не перешёл в healthy за $((max_attempts * 2)) секунд"
}

# ── Dev-режим ──
dev() {
    log "Запуск dev-окружения..."

    docker compose --profile dev up -d

    success "Dev-окружение запущено"
    log "  opencode:      http://localhost:3000"
    log "  athena-memory: http://localhost:8000"
    log "  postgres:      localhost:5432"
    log "  redis:         localhost:6379"
}

# ── Rollback ──
rollback() {
    local tag="${1:-}"
    if [[ -z "$tag" ]]; then
        error "Укажите тег для отката: ./deploy.sh --rollback <tag>"
    fi

    log "Откат на версию $tag..."

    local ssh_opts=(
        -i "$SSH_KEY"
        -o StrictHostKeyChecking=no
    )

    # Pull предыдущего образа
    ssh "${ssh_opts[@]}" "${SSH_USER}@${SERVER}" \
        "docker pull ghcr.io/argenta-team/akame:$tag"

    # Restart
    ssh "${ssh_opts[@]}" "${SSH_USER}@${SERVER}" \
        "docker restart $CONTAINER_NAME"

    success "Откат на $tag выполнен"
}

# ── Очистка ──
cleanup() {
    log "Очистка неиспользуемых образов..."

    docker image prune -f
    docker volume prune -f

    success "Очистка завершена"
}

# ── Main ──
main() {
    local mode="${1:-deploy}"

    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  akame deploy — $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo

    check_prerequisites

    case "$mode" in
        --dry-run)
            build
            test_build
            log "Dry-run: деплой не выполняется"
            ;;
        --dev)
            build
            dev
            ;;
        --rollback)
            rollback "${2:-}"
            ;;
        --cleanup)
            cleanup
            ;;
        *)
            build
            test_build
            deploy
            ;;
    esac

    echo
    success "Операция '$mode' завершена"
}

main "$@"
