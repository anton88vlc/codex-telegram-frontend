import { spawn } from "node:child_process";

function escapeSqlText(value) {
  return String(value ?? "").replaceAll("'", "''");
}

function execJsonCommand(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `failed to parse JSON from ${command}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export async function listProjectThreads(threadsDbPath, projectRoot, { limit = 10 } = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 10), 1, 50);
  const sql = `
    select
      id,
      title,
      cwd,
      archived,
      updated_at,
      coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms,
      source,
      rollout_path,
      model_provider,
      model,
      reasoning_effort,
      tokens_used
    from threads
    where cwd = '${escapeSqlText(projectRoot)}'
      and archived = 0
      and coalesce(agent_nickname, '') = ''
      and coalesce(agent_role, '') = ''
      and source not like '{"subagent":%'
    order by updated_at desc, id desc
    limit ${cappedLimit};
  `;

  const rows = await execJsonCommand("sqlite3", ["-json", threadsDbPath, sql], {
    timeoutMs: 15_000,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function listRecentProjects(threadsDbPath, { limit = 20 } = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 20), 1, 100);
  const sql = `
    select
      cwd as projectRoot,
      count(*) as threadCount,
      max(updated_at) as latestUpdatedAt,
      max(coalesce(updated_at_ms, updated_at * 1000)) as latestUpdatedAtMs
    from threads
    where archived = 0
      and coalesce(agent_nickname, '') = ''
      and coalesce(agent_role, '') = ''
      and source not like '{"subagent":%'
      and coalesce(cwd, '') != ''
    group by cwd
    order by latestUpdatedAt desc, cwd asc
    limit ${cappedLimit};
  `;

  const rows = await execJsonCommand("sqlite3", ["-json", threadsDbPath, sql], {
    timeoutMs: 15_000,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function listRecentThreads(threadsDbPath, { limit = 10 } = {}) {
  const cappedLimit = clamp(parsePositiveInt(limit, 10), 1, 100);
  const sql = `
    select
      id,
      title,
      cwd,
      archived,
      updated_at,
      coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms,
      source,
      rollout_path,
      model_provider,
      model,
      reasoning_effort,
      tokens_used
    from threads
    where archived = 0
      and coalesce(agent_nickname, '') = ''
      and coalesce(agent_role, '') = ''
      and source not like '{"subagent":%'
      and coalesce(cwd, '') != ''
    order by updated_at desc, id desc
    limit ${cappedLimit};
  `;

  const rows = await execJsonCommand("sqlite3", ["-json", threadsDbPath, sql], {
    timeoutMs: 15_000,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function getThreadsByIds(threadsDbPath, threadIds) {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(threadIds) ? threadIds : [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
  if (normalizedIds.length === 0) {
    return [];
  }

  const idsClause = normalizedIds.map((id) => `'${escapeSqlText(id)}'`).join(", ");
  const sql = `
    select
      id,
      title,
      cwd,
      archived,
      updated_at,
      coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms,
      source,
      rollout_path,
      model_provider,
      model,
      reasoning_effort,
      tokens_used
    from threads
    where id in (${idsClause});
  `;

  const rows = await execJsonCommand("sqlite3", ["-json", threadsDbPath, sql], {
    timeoutMs: 15_000,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function getThreadById(threadsDbPath, threadId) {
  const rows = await getThreadsByIds(threadsDbPath, [threadId]);
  return rows[0] ?? null;
}
