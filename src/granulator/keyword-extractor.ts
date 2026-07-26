// ── Извлечение ключевых слов из сообщений для поиска релевантных гранул ──

import type { GranulateContext } from "./engine.js";

export function extractKeywords(
  messages: GranulateContext["messages"]
): string[] {
  const keywords = new Set<string>();

  for (const msg of messages) {
    const text = msg.content;

    // entity_name: слова с большой буквы (PascalCase / CamelCase)
    const entityMatches =
      text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g) ?? [];
    for (const m of entityMatches) {
      if (m.length > 2) keywords.add(m);
    }

    // Имена файлов: *.ts, *.js, *.py, *.md, *.json, *.yaml, *.sql и т.д.
    const fileMatches =
      text.match(
        /\b[\w\-/]+\.(ts|js|py|md|json|ya?ml|sql|tsx|jsx|css|html)\b/g
      ) ?? [];
    for (const m of fileMatches) {
      keywords.add(m);
    }
  }

  return Array.from(keywords).slice(0, 20);
}
