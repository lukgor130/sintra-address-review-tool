const DEFAULT_SESSION_SLUG = "default";
const MAX_TEXT_LENGTH = 2000;
const MAX_ROWS_PER_WRITE = 100;

const VALID_STATUSES = new Set([
  "",
  "unknown",
  "possible_lead",
  "definite_lead",
  "no_local_lead",
]);

function json(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload, null, 2), { ...init, headers });
}

function text(message, status = 400) {
  return json({ ok: false, error: message }, { status });
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function limitText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "").slice(0, maxLength);
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim();
  return VALID_STATUSES.has(status) ? status : "unknown";
}

function dbFromEnv(env) {
  return env.AOI_DB || env.DB || env.D1_DB || null;
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_pack_slug
      ON sessions(pack_id, slug);

    CREATE TABLE IF NOT EXISTS parcel_feedback (
      session_id TEXT NOT NULL,
      parcel_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, parcel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_parcel_feedback_session
      ON parcel_feedback(session_id);
  `);
}

function parseBody(request) {
  return request
    .json()
    .catch(() => ({}));
}

function normalizeFeedback(payload, parcelId) {
  const now = nowIso();
  const safeParcelId = Number(parcelId);
  return {
    sourceObjectId: Number(payload?.sourceObjectId ?? safeParcelId),
    parcelObjectId: Number(payload?.parcelObjectId ?? safeParcelId),
    knowledgeStatus: normalizeStatus(payload?.knowledgeStatus),
    leadName: limitText(payload?.leadName, 240),
    contactTrail: limitText(payload?.contactTrail, 500),
    confidence: limitText(payload?.confidence, 80),
    notes: limitText(payload?.notes, MAX_TEXT_LENGTH),
    reviewedAt: payload?.reviewedAt ? String(payload.reviewedAt) : null,
    updatedAt: payload?.updatedAt ? String(payload.updatedAt) : now,
  };
}

function serializeSession(row) {
  return {
    id: row.id,
    packId: row.pack_id,
    slug: row.slug,
    title: row.title,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeFeedbackRow(row) {
  try {
    const parsed = JSON.parse(row.data);
    return {
      ...parsed,
      updatedAt: row.updated_at,
    };
  } catch {
    return {
      sourceObjectId: Number(row.parcel_id),
      parcelObjectId: Number(row.parcel_id),
      knowledgeStatus: "",
      leadName: "",
      contactTrail: "",
      confidence: "",
      notes: "",
      reviewedAt: null,
      updatedAt: row.updated_at,
    };
  }
}

async function getSessionBySlug(db, packId, slug) {
  return db
    .prepare(
      `SELECT id, pack_id, slug, title, is_default, created_at, updated_at
       FROM sessions
       WHERE pack_id = ?1 AND slug = ?2`,
    )
    .bind(packId, slug)
    .first();
}

async function getSessionById(db, sessionId) {
  return db
    .prepare(
      `SELECT id, pack_id, slug, title, is_default, created_at, updated_at
       FROM sessions
       WHERE id = ?1`,
    )
    .bind(sessionId)
    .first();
}

async function ensureDefaultSession(db, packId, title) {
  const existing = await getSessionBySlug(db, packId, DEFAULT_SESSION_SLUG);
  if (existing) {
    return existing;
  }
  const session = {
    id: randomId(),
    pack_id: packId,
    slug: DEFAULT_SESSION_SLUG,
    title: `${title} shared notes`,
    is_default: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await db
    .prepare(
      `INSERT INTO sessions (id, pack_id, slug, title, is_default, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      session.id,
      session.pack_id,
      session.slug,
      session.title,
      session.is_default,
      session.created_at,
      session.updated_at,
    )
    .run();
  return session;
}

async function ensureSessionById(db, packId, sessionId, title) {
  const existing = await getSessionById(db, sessionId);
  if (existing) {
    if (existing.pack_id !== packId) {
      throw new Error("session-pack-mismatch");
    }
    return existing;
  }
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO sessions (id, pack_id, slug, title, is_default, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
    )
    .bind(sessionId, packId, sessionId, title || "AOI session", now, now)
    .run();
  return getSessionById(db, sessionId);
}

async function loadFeedback(db, sessionId) {
  const rows = await db
    .prepare(
      `SELECT parcel_id, data, updated_at
       FROM parcel_feedback
       WHERE session_id = ?1
       ORDER BY parcel_id`,
    )
    .bind(sessionId)
    .all();
  const parcels = {};
  for (const row of rows.results || []) {
    parcels[String(row.parcel_id)] = serializeFeedbackRow(row);
  }
  return parcels;
}

async function upsertFeedbackRows(db, session, rows) {
  if (!rows.length) {
    return [];
  }
  const syncedAt = nowIso();
  const statements = rows.map((row) => {
    const parcelId = Number(row.parcelId);
    const feedback = normalizeFeedback(row.feedback, parcelId);
    return db
      .prepare(
        `INSERT INTO parcel_feedback (session_id, parcel_id, data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id, parcel_id) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .bind(session.id, parcelId, JSON.stringify(feedback), syncedAt, syncedAt);
  });
  await db.batch(statements);
  await db
    .prepare(
      `UPDATE sessions
       SET updated_at = ?1
       WHERE id = ?2`,
    )
    .bind(syncedAt, session.id)
    .run();
  return {
    syncedAt,
    parcels: await loadFeedback(db, session.id),
  };
}

async function cloneFeedbackRows(db, sourceSessionId, targetSessionId) {
  const rows = await db
    .prepare(
      `SELECT parcel_id, data
       FROM parcel_feedback
       WHERE session_id = ?1`,
    )
    .bind(sourceSessionId)
    .all();
  if (!(rows.results || []).length) {
    return [];
  }
  const now = nowIso();
  const statements = (rows.results || []).map((row) =>
    db
      .prepare(
        `INSERT INTO parcel_feedback (session_id, parcel_id, data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id, parcel_id) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .bind(targetSessionId, row.parcel_id, row.data, now, now),
  );
  await db.batch(statements);
  return loadFeedback(db, targetSessionId);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const db = dbFromEnv(env);
  if (!db) {
    return text("Missing AOI database binding.", 500);
  }

  await ensureSchema(db);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "bootstrap";
  const rawPackId = url.searchParams.get("packId");

  if (!rawPackId) {
    return text("Missing packId.", 400);
  }
  const packId = slugify(rawPackId);
  const title = url.searchParams.get("title") || "AOI";

  try {
    if (action === "health" && request.method === "GET") {
      return json({ ok: true, storage: "d1", checkedAt: nowIso() });
    }

    if (action === "bootstrap" && request.method === "POST") {
      const body = await parseBody(request);
      const requestedSessionId = String(body.sessionId || "").trim();
      const session = requestedSessionId
        ? await ensureSessionById(db, packId, requestedSessionId, title)
        : await ensureDefaultSession(db, packId, title);
      const feedback = await loadFeedback(db, session.id);
      return json({ ok: true, session: serializeSession(session), feedback });
    }

    if (action === "create-session" && request.method === "POST") {
      const body = await parseBody(request);
      const cloneFromSessionId = String(body.cloneFromSessionId || "").trim();
      const sessionId = randomId();
      const now = nowIso();
      const sessionTitle = String(body.title || `${title} session`).trim();
      await db
        .prepare(
          `INSERT INTO sessions (id, pack_id, slug, title, is_default, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
        )
        .bind(sessionId, packId, sessionId, sessionTitle, now, now)
        .run();

      const session = await getSessionById(db, sessionId);
      let feedback = {};
      if (cloneFromSessionId) {
        const sourceSession = await getSessionById(db, cloneFromSessionId);
        if (sourceSession && sourceSession.pack_id === packId) {
          feedback = await cloneFeedbackRows(db, cloneFromSessionId, sessionId);
        }
      }
      return json({ ok: true, session: serializeSession(session), feedback });
    }

    if (action === "upsert" && request.method === "POST") {
      const body = await parseBody(request);
      const sessionId = String(body.sessionId || "").trim();
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS_PER_WRITE) : [];
      if (!sessionId) {
        return text("Missing sessionId.", 400);
      }
      const session = await getSessionById(db, sessionId);
      if (!session) {
        return text("Unknown session.", 404);
      }
      if (session.pack_id !== packId) {
        return text("Session does not belong to this AOI pack.", 409);
      }
      const result = await upsertFeedbackRows(db, session, rows);
      return json({
        ok: true,
        session: serializeSession(await getSessionById(db, sessionId)),
        feedback: result,
      });
    }

    return text("Unsupported action.", 404);
  } catch (error) {
    if (error?.message === "session-pack-mismatch") {
      return text("Session does not belong to this AOI pack.", 409);
    }
    console.error("AOI API error", error);
    return text("Failed to process AOI request.", 500);
  }
}
