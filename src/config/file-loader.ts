import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";

// ── Интерфейс результата загрузки ──

/**
 * Результат загрузки akame.json5.
 * @property source — абсолютный путь к загруженному файлу
 * @property data — распарсенные данные (плоский объект, ключи = camelCase)
 */
export interface FileConfig {
  /** Абсолютный путь к загруженному файлу */
  source: string;
  /** Распарсенные данные из JSON5 */
  data: Record<string, unknown>;
}

// ── Пути поиска akame.json5 ──

const CONFIG_FILENAME = "akame.json5";

/**
 * Формирует список путей для поиска akame.json5.
 * Порядок важен — первый найденный файл будет использован.
 *
 * @param cwd — рабочая директория (если задана, добавляет `{cwd}/akame.json5` первым)
 * @returns массив абсолютных путей для поиска
 */
function getConfigPaths(cwd?: string): string[] {
  const paths: string[] = [];

  // 1) Текущая рабочая директория
  if (cwd) {
    paths.push(join(cwd, CONFIG_FILENAME));
  }

  // 2) ~/.config/opencode/
  paths.push(join(homedir(), ".config", "opencode", CONFIG_FILENAME));

  return paths;
}

// ── Загрузка JSON5 файла ──

/**
 * Загружает и парсит akame.json5.
 *
 * Алгоритм поиска:
 * 1. `{cwd}/akame.json5` — локальный файл рядом с opencode.json
 * 2. `~/.config/opencode/akame.json5` — глобальный файл пользователя
 *
 * Приоритет: первый найденный файл. Если ни один не найден — возвращает null.
 * При ошибке парсинга — логирует предупреждение и возвращает null (используются дефолты).
 *
 * @param cwd — текущая рабочая директория (обычно process.cwd())
 * @returns FileConfig с путем и данными, или null если файл не найден/не парсится
 */
export function loadConfigFile(cwd?: string): FileConfig | null {
  const paths = getConfigPaths(cwd);

  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON5.parse(raw) as Record<string, unknown>;
      return { source: filePath, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[akame] Ошибка парсинга ${filePath}: ${message}`);
      return null;
    }
  }

  return null;
}
