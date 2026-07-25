import { execSync } from "child_process";
import fs from "fs";
import type { Logger } from "../logger.js";

export interface DiffResult {
  diff: string;
  filePath: string;
  type: "modified" | "created" | "deleted";
  content?: string;
}

/**
 * Получает diff изменённого файла через git.
 * Если git недоступен или не в репозитории — читает содержимое файла.
 */
export function getGitDiff(filePath: string, log?: Logger): DiffResult {
  const exists = fs.existsSync(filePath);

  // Файл удалён
  if (!exists) {
    return { diff: "", filePath, type: "deleted" };
  }

  let diff = "";
  let type: DiffResult["type"] = "modified";
  let content = "";

  try {
    // Проверяем, в git-репозитории ли мы
    execSync("git rev-parse --git-dir", { stdio: "pipe" });

    // Пытаемся получить diff через git
    try {
      diff = execSync(`git diff HEAD -- "${filePath}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024, // 1MB
      });
    } catch (err) {
      log?.debug(`git diff HEAD не удался: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Если файл новый (не в HEAD) — используем git diff --no-index
    if (!diff.trim()) {
      try {
        diff = execSync(
          `git diff --no-index /dev/null "${filePath}"`,
          {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            maxBuffer: 1024 * 1024,
          }
        );
        type = "created";
      } catch (err) {
        log?.debug(`git diff --no-index не удался: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Если всё ещё нет diff — файл не изменился или git не видит изменений
    if (!diff.trim()) {
      content = fs.readFileSync(filePath, "utf-8");
      type = exists ? "modified" : "created";
      return { diff, filePath, type, content };
    }

    return { diff, filePath, type };
  } catch (err) {
    log?.debug(`Не git-репозиторий: ${err instanceof Error ? err.message : String(err)}`);
    // Не git-репозиторий — просто читаем файл
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (readErr) {
      log?.debug(`Не удалось прочитать файл: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
    }
    return { diff: "", filePath, type: exists ? "modified" : "deleted", content };
  }
}

/**
 * Обрезает diff до разумного размера для отправки в LLM.
 */
export function truncateDiff(diff: string, maxLines: number = 200): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;

  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [
    ...head,
    `... (пропущено ${lines.length - maxLines} строк)`,
    ...tail,
  ].join("\n");
}
