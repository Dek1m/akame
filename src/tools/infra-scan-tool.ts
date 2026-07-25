// ── Tool: infra_scan — каталогизация инфраструктуры ──
// ДОСТУПЕН ТОЛЬКО агенту memory-granulator (Тишь).
// Собирает данные о серверах, контейнерах, сетях и сохраняет в namespace "infrastructure".

import { tool } from "@opencode-ai/plugin";
import { MCPClient, type MemoryRecord } from "../mcp/client.js";
import type { AkameConfig } from "../constants.js";
import type { Logger } from "../logger.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const EXEC_TIMEOUT = 15000;

// ── Типы ──

interface ScanResult {
  hostname: string;
  os: OSInfo;
  resources: ResourceInfo;
  containers: ContainerInfo[];
  networks: NetworkInfo[];
  ports: PortInfo[];
  volumes: VolumeInfo[];
}

interface OSInfo {
  name: string;
  version: string;
  prettyName: string;
}

interface ResourceInfo {
  cpu: string;
  ram: string;
  disk: string;
}

interface ContainerInfo {
  name: string;
  image: string;
  ports: string;
  status: string;
}

interface NetworkInfo {
  name: string;
  driver: string;
  scope: string;
}

interface PortInfo {
  port: string;
  process: string;
}

interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
}

interface InfraGranule {
  content: string;
  entity_type: string;
  entity_name: string;
  title: string;
  links: { type: string; target: string; description?: string }[];
}

// ── Сбор через SSH ──

async function scanViaSSH(
  host: string,
  user: string,
  keyPath: string
): Promise<ScanResult> {
  const sshCmd = (cmd: string) =>
    `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i ${keyPath} ${user}@${host} "${cmd}"`;

  // hostname
  const { stdout: hostname } = await execAsync(sshCmd("hostname"), {
    timeout: EXEC_TIMEOUT,
  });
  const hn = hostname.trim();

  // OS
  const { stdout: osRelease } = await execAsync(
    sshCmd("cat /etc/os-release | head -3"),
    { timeout: EXEC_TIMEOUT }
  );
  const os = parseOSRelease(osRelease);

  // Resources
  const { stdout: cpuStr } = await execAsync(sshCmd("nproc"), {
    timeout: EXEC_TIMEOUT,
  });
  const { stdout: memStr } = await execAsync(
    sshCmd("free -h | head -2"),
    { timeout: EXEC_TIMEOUT }
  );
  const { stdout: diskStr } = await execAsync(
    sshCmd("df -h / | tail -1"),
    { timeout: EXEC_TIMEOUT }
  );

  const resources: ResourceInfo = {
    cpu: cpuStr.trim(),
    ram: parseRAM(memStr),
    disk: parseDisk(diskStr),
  };

  // Containers
  let containers: ContainerInfo[] = [];
  try {
    const { stdout: dockerPs } = await execAsync(
      sshCmd("docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'"),
      { timeout: EXEC_TIMEOUT }
    );
    containers = parseContainers(dockerPs);
  } catch {
    // docker не установлен или нет прав
  }

  // Networks
  let networks: NetworkInfo[] = [];
  try {
    const { stdout: dockerNet } = await execAsync(
      sshCmd("docker network ls"),
      { timeout: EXEC_TIMEOUT }
    );
    networks = parseNetworks(dockerNet);
  } catch {
    // docker не установлен или нет прав
  }

  // Ports
  let ports: PortInfo[] = [];
  try {
    const { stdout: ssOut } = await execAsync(
      sshCmd("ss -tlnp | head -10"),
      { timeout: EXEC_TIMEOUT }
    );
    ports = parsePorts(ssOut);
  } catch {
    // ss не доступен
  }

  return {
    hostname: hn,
    os,
    resources,
    containers,
    networks,
    ports,
    volumes: [],
  };
}

// ── Сбор через Docker socket ──

async function scanViaDocker(socketPath: string): Promise<ScanResult> {
  const curl = (endpoint: string) =>
    `curl -s --unix-socket ${socketPath} http://localhost${endpoint}`;

  // hostname — через docker info
  let hostname = "localhost";
  let os: OSInfo = { name: "unknown", version: "unknown", prettyName: "unknown" };
  try {
    const { stdout: infoStr } = await execAsync(curl("/info"), {
      timeout: EXEC_TIMEOUT,
    });
    const info = JSON.parse(infoStr);
    hostname = info.Name || "localhost";
    os = {
      name: info.OperatingSystem || "unknown",
      version: info.KernelVersion || "unknown",
      prettyName: `${info.OperatingSystem || "Linux"} (${info.OSType || "linux"})`,
    };
  } catch {
    // fallback: пробуем hostname
    try {
      const { stdout: hn } = await execAsync("hostname", { timeout: 5000 });
      hostname = hn.trim();
    } catch {
      // оставляем localhost
    }
  }

  // Resources — не доступны через Docker API напрямую
  const resources: ResourceInfo = {
    cpu: "n/a",
    ram: "n/a",
    disk: "n/a",
  };

  // Containers
  let containers: ContainerInfo[] = [];
  try {
    const { stdout: contStr } = await execAsync(
      curl("/containers/json"),
      { timeout: EXEC_TIMEOUT }
    );
    const raw = JSON.parse(contStr);
    containers = raw.map((c: Record<string, unknown>) => ({
      name: String((c.Names as string[])?.[0] || "").replace(/^\//, ""),
      image: String(c.Image || ""),
      ports: ((c.Ports as Array<Record<string, unknown>>) || [])
        .map((p) => {
          const pub = p.PublicPort ? `${p.PublicPort}->` : "";
          return `${pub}${p.PrivatePort}/${p.Type || "tcp"}`;
        })
        .join(", "),
      status: String(c.Status || ""),
    }));
  } catch {
    // docker не доступен
  }

  // Networks
  let networks: NetworkInfo[] = [];
  try {
    const { stdout: netStr } = await execAsync(
      curl("/networks"),
      { timeout: EXEC_TIMEOUT }
    );
    const raw = JSON.parse(netStr);
    networks = raw.map((n: Record<string, unknown>) => ({
      name: String(n.Name || ""),
      driver: String(n.Driver || ""),
      scope: String(n.Scope || ""),
    }));
  } catch {
    // docker не доступен
  }

  // Volumes
  let volumes: VolumeInfo[] = [];
  try {
    const { stdout: volStr } = await execAsync(
      curl("/volumes"),
      { timeout: EXEC_TIMEOUT }
    );
    const raw = JSON.parse(volStr);
    volumes = (raw.Volumes as Array<Record<string, unknown>> || []).map(
      (v) => ({
        name: String(v.Name || ""),
        driver: String(v.Driver || ""),
        mountpoint: String(v.Mountpoint || ""),
      })
    );
  } catch {
    // docker не доступен
  }

  // Порты — через контейнеры (уже в ContainerInfo)
  const ports: PortInfo[] = [];

  return {
    hostname,
    os,
    resources,
    containers,
    networks,
    ports,
    volumes,
  };
}

// ── Парсеры ──

function parseOSRelease(raw: string): OSInfo {
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).replace(/^"/, "").replace(/"$/, "");
      map[key] = val;
    }
  }
  return {
    name: map.NAME || map.ID || "unknown",
    version: map.VERSION || map.VERSION_ID || "unknown",
    prettyName: map.PRETTY_NAME || map.NAME || "unknown",
  };
}

function parseRAM(raw: string): string {
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return "unknown";
  const mem = lines[1].trim().split(/\s+/);
  return mem[1] || "unknown";
}

function parseDisk(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 4) return "unknown";
  return `${parts[1]} total, ${parts[2]} used, ${parts[3]} avail`;
}

function parseContainers(raw: string): ContainerInfo[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      const [name, image, ports, status] = line.split("\t");
      return { name: name || "", image: image || "", ports: ports || "-", status: status || "" };
    })
    .filter((c) => c.name);
}

function parseNetworks(raw: string): NetworkInfo[] {
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      name: parts[1] || "",
      driver: parts[2] || "",
      scope: parts[3] || "",
    };
  });
}

function parsePorts(raw: string): PortInfo[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const local = parts[4] || "";
      const port = local.includes(":") ? local.split(":").pop() || local : local;
      const procRaw = parts.slice(6).join(" ");
      const procMatch = procRaw.match(/"([^"]+)"/);
      const process = procMatch ? procMatch[1] : "";
      return { port, process };
    })
    .filter((p) => p.port);
}

// ── Маппинг результатов в гранулы ──

function mapResultsToGranules(result: ScanResult, project: string): InfraGranule[] {
  const granules: InfraGranule[] = [];
  const osKey = `${result.os.name}-${result.os.version}`.replace(/\s+/g, "-").toLowerCase();

  // OS
  granules.push({
    content: `Операционная система: ${result.os.prettyName} (ядро: ${result.os.version}, имя: ${result.os.name})`,
    entity_type: "os",
    entity_name: osKey,
    title: `OS: ${result.os.prettyName}`.slice(0, 80),
    links: [],
  });

  // Server
  const serverLinks: InfraGranule["links"] = [
    { type: "runs_on", target: osKey, description: `работает на ${result.os.name}` },
  ];

  for (const c of result.containers) {
    serverLinks.push({ type: "contains", target: c.name, description: `контейнер ${c.name}` });
  }
  for (const n of result.networks) {
    serverLinks.push({ type: "contains", target: n.name, description: `сеть ${n.name}` });
  }
  for (const v of result.volumes) {
    serverLinks.push({ type: "contains", target: v.name, description: `volume ${v.name}` });
  }

  granules.push({
    content: `Сервер ${result.hostname}. Ресурсы: CPU ${result.resources.cpu} ядер, RAM ${result.resources.ram}, диск ${result.resources.disk}`,
    entity_type: "server",
    entity_name: result.hostname,
    title: `Server: ${result.hostname}`.slice(0, 80),
    links: serverLinks,
  });

  // Containers
  for (const c of result.containers) {
    const cLinks: InfraGranule["links"] = [
      { type: "contained_by", target: result.hostname, description: `запущен на ${result.hostname}` },
    ];

    // Связываем контейнер с сетью, если есть совпадения по имени сети в Networks
    for (const n of result.networks) {
      // эвристика: если имя сети — bridge/host/none — это стандартные, связываем
      if (n.name !== "bridge" && n.name !== "host" && n.name !== "none") {
        cLinks.push({
          type: "related_to",
          target: n.name,
          description: `может быть подключён к сети ${n.name}`,
        });
      }
    }

    // Порты контейнера → API
    if (c.ports && c.ports !== "-") {
      for (const p of c.ports.split(",")) {
        const trimmed = p.trim();
        if (trimmed) {
          const apiName = `${c.name}:${trimmed.replace(/[^a-zA-Z0-9:./]/g, "")}`;
          cLinks.push({
            type: "exposes",
            target: apiName,
            description: `открывает порт ${trimmed}`,
          });
          granules.push({
            content: `API эндпоинт ${trimmed} (контейнер ${c.name})`,
            entity_type: "api",
            entity_name: apiName,
            title: `API: ${trimmed}`.slice(0, 80),
            links: [
              {
                type: "exposed_by",
                target: c.name,
                description: `предоставляется контейнером ${c.name}`,
              },
            ],
          });
        }
      }
    }

    granules.push({
      content: `Контейнер ${c.name}: образ ${c.image}, статус: ${c.status}, порты: ${c.ports || "-"}`,
      entity_type: "container",
      entity_name: c.name,
      title: `Container: ${c.name}`.slice(0, 80),
      links: cLinks,
    });
  }

  // Networks
  for (const n of result.networks) {
    granules.push({
      content: `Сеть Docker: ${n.name} (driver: ${n.driver}, scope: ${n.scope})`,
      entity_type: "network",
      entity_name: n.name,
      title: `Network: ${n.name}`.slice(0, 80),
      links: [
        { type: "contained_by", target: result.hostname, description: `сеть на хосте ${result.hostname}` },
      ],
    });
  }

  // Volumes
  for (const v of result.volumes) {
    granules.push({
      content: `Volume Docker: ${v.name} (driver: ${v.driver}, mountpoint: ${v.mountpoint})`,
      entity_type: "volume",
      entity_name: v.name,
      title: `Volume: ${v.name}`.slice(0, 80),
      links: [
        { type: "contained_by", target: result.hostname, description: `volume на хосте ${result.hostname}` },
      ],
    });
  }

  // Ports (host level) → API
  for (const p of result.ports) {
    const apiName = `host:${p.port}`;
    granules.push({
      content: `Открытый порт ${p.port} (процесс: ${p.process || "неизвестно"}) на хосте ${result.hostname}`,
      entity_type: "api",
      entity_name: apiName,
      title: `API: host:${p.port}`.slice(0, 80),
      links: [
        { type: "exposed_by", target: result.hostname, description: `порт открыт на ${result.hostname}` },
      ],
    });
  }

  return granules;
}

// ── Построение отчёта в виде графа ──

function buildGraphReport(granules: InfraGranule[]): string {
  const lines: string[] = [];
  lines.push("## Граф инфраструктуры");
  lines.push("");

  for (const g of granules) {
    const typeTag = `[${g.entity_type}]`;
    lines.push(`${typeTag} ${g.entity_name}`);
    if (g.links.length > 0) {
      for (const l of g.links) {
        lines.push(`  └─ ${l.type} → ${l.target}${l.description ? ` (${l.description})` : ""}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Синхронизация: найти существующие, сохранить новые, обновить изменившиеся, пометить исчезнувшие ──

interface ExistingEntry {
  id: string;
  entity_name: string;
  is_deprecated: boolean;
}

async function findExistingGranules(
  mcp: MCPClient,
  userId: string,
  project: string
): Promise<Map<string, ExistingEntry>> {
  const map = new Map<string, ExistingEntry>();
  try {
    const results = await mcp.search(
      project,
      userId,
      500,
      0.2,
      "infrastructure"
    );
    for (const r of results) {
      const meta = r.metadata as Record<string, unknown>;
      const entityName = meta?.entity_name;
      if (entityName && typeof entityName === "string") {
        map.set(entityName, {
          id: r.id,
          entity_name: entityName,
          is_deprecated: !!meta?.is_deprecated,
        });
      }
    }
  } catch {
    // пустой индекс — всё создадим
  }
  return map;
}

async function upsertGranules(
  mcp: MCPClient,
  userId: string,
  project: string,
  granules: InfraGranule[],
  existing: Map<string, ExistingEntry>,
  log: Logger
): Promise<{ created: number; updated: number; deprecated: number }> {
  let created = 0;
  let updated = 0;
  let deprecated = 0;

  const seen = new Set<string>();
  const baseMetadata = {
    agent: "infra_scan",
    session_id: "infra_scan",
    project_id: project,
    message_ids: [],
    participants: ["memory-granulator"],
  };

  for (const g of granules) {
    seen.add(g.entity_name);
    const entry = existing.get(g.entity_name);

    if (entry) {
      // Обновляем существующую
      try {
        await mcp.update(entry.id, g.content, {
          ...baseMetadata,
          entity_type: g.entity_type,
          entity_name: g.entity_name,
          title: g.title,
          is_deprecated: false,
          links: g.links,
        });
        updated++;
        log.debug(`infra_scan: обновлена гранула ${g.entity_type}/${g.entity_name}`);
      } catch (err) {
        log.error(
          `infra_scan: ошибка обновления ${g.entity_name}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    } else {
      // Создаём новую
      try {
        const metadata: Record<string, unknown> = {
          ...baseMetadata,
          entity_type: g.entity_type,
          entity_name: g.entity_name,
          title: g.title,
          is_deprecated: false,
          links: g.links,
        };
        await mcp.store(g.content, userId, metadata, "infrastructure");
        created++;
        log.debug(`infra_scan: создана гранула ${g.entity_type}/${g.entity_name}`);
      } catch (err) {
        log.error(
          `infra_scan: ошибка создания ${g.entity_name}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  // Помечаем исчезнувшие сущности
  for (const [entityName, entry] of existing) {
    if (!seen.has(entityName) && !entry.is_deprecated) {
      try {
        await mcp.update(entry.id, undefined, {
          ...baseMetadata,
          entity_name: entityName,
          is_deprecated: true,
        });
        deprecated++;
        log.info(`infra_scan: помечена как устаревшая гранула ${entityName}`);
      } catch (err) {
        log.error(
          `infra_scan: ошибка пометки ${entityName}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  return { created, updated, deprecated };
}

// ── Создание тула ──

export function createInfraScanTool(config: AkameConfig, log: Logger) {
  const mcp = new MCPClient(config);

  return tool({
    description:
      "[ТОЛЬКО ДЛЯ memory-granulator] Сканировать инфраструктуру и сохранить в athena-memory (namespace: infrastructure). " +
      "Собирает данные об ОС, ресурсах сервера, Docker-контейнерах, сетях, томах и открытых портах. " +
      "Поддерживает два режима: ssh (удалённый сервер) и docker (локальный Docker socket). " +
      "Автоматически синхронизирует: создаёт новые гранулы, обновляет существующие, помечает исчезнувшие как deprecated.",

    args: {
      mode: tool.schema
        .enum(["ssh", "docker"] as const)
        .describe("Режим сбора: ssh — через SSH на удалённый сервер, docker — через Docker socket локально"),

      host: tool.schema
        .string()
        .optional()
        .describe("Хост для SSH-подключения (только для mode=ssh)"),

      user: tool.schema
        .string()
        .optional()
        .describe("Пользователь для SSH (только для mode=ssh)"),

      keyPath: tool.schema
        .string()
        .optional()
        .describe("Путь к SSH-ключу (только для mode=ssh)"),

      socketPath: tool.schema
        .string()
        .optional()
        .describe("Путь к Docker socket (по умолчанию /var/run/docker.sock, только для mode=docker)"),

      project: tool.schema
        .string()
        .describe("Имя проекта (например 'akame')"),
    },

    async execute(args, context) {
      // ── Защита: ТОЛЬКО memory-granulator может сканировать инфраструктуру ──
      const caller = context.agent || "unknown";
      if (caller !== "memory-granulator") {
        const errMsg = `Доступ запрещён: агент "${caller}" не имеет права вызывать infra_scan. Только memory-granulator (Тишь) может сканировать инфраструктуру.`;
        log.warn(errMsg);
        throw new Error(errMsg);
      }

      const { mode, project } = args;
      const host = args.host as string | undefined;
      const user = args.user as string | undefined;
      const keyPath = args.keyPath as string | undefined;
      const socketPath = (args.socketPath as string) || "/var/run/docker.sock";

      // ── Валидация ──
      if (mode === "ssh" && (!host || !user || !keyPath)) {
        throw new Error(
          "Для mode=ssh обязательны аргументы: host, user, keyPath"
        );
      }

      log.info(`infra_scan: начало сканирования (mode=${mode}, project=${project})`);

      // ── Сбор данных ──
      let result: ScanResult;
      if (mode === "ssh") {
        result = await scanViaSSH(host!, user!, keyPath!);
        log.info(
          `infra_scan: SSH — хост ${result.hostname}, контейнеров: ${result.containers.length}, сетей: ${result.networks.length}`
        );
      } else {
        result = await scanViaDocker(socketPath);
        log.info(
          `infra_scan: Docker — хост ${result.hostname}, контейнеров: ${result.containers.length}, сетей: ${result.networks.length}, томов: ${result.volumes.length}`
        );
      }

      // ── Маппинг в гранулы ──
      const granules = mapResultsToGranules(result, project);
      log.debug(
        `infra_scan: сформировано ${granules.length} гранул (${[...new Set(granules.map((g) => g.entity_type))].join(", ")})`
      );

      // ── Поиск существующих ──
      const existing = await findExistingGranules(mcp, config.userId, project);
      log.debug(`infra_scan: найдено ${existing.size} существующих гранул в infrastructure`);

      // ── Синхронизация ──
      const stats = await upsertGranules(
        mcp,
        config.userId,
        project,
        granules,
        existing,
        log
      );

      // ── Отчёт ──
      const entityCounts = new Map<string, number>();
      for (const g of granules) {
        entityCounts.set(g.entity_type, (entityCounts.get(g.entity_type) || 0) + 1);
      }

      const summary = [
        `## infra_scan: сканирование завершено`,
        ``,
        `**Режим:** ${mode}`,
        `**Хост:** ${result.hostname}`,
        `**Проект:** ${project}`,
        ``,
        `### Найденные сущности`,
        ...Array.from(entityCounts.entries()).map(
          ([type, count]) => `- ${type}: ${count}`
        ),
        ``,
        `### Синхронизация`,
        `- Создано: ${stats.created}`,
        `- Обновлено: ${stats.updated}`,
        `- Помечено устаревшими: ${stats.deprecated}`,
        `- Всего гранул: ${granules.length}`,
      ];

      if (granules.length > 0) {
        summary.push(``);
        summary.push(buildGraphReport(granules));
      }

      return summary.join("\n");
    },
  });
}
