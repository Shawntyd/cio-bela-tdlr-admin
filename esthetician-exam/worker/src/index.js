// Cloudflare Worker: esthetician-exam-log
// Saves study sessions, practice tests and flashcard progress for the
// Cio Bela esthetician exam page, and serves the owner's Study Report.
//
// Bindings (Worker > Settings):
//   EXAM_KV        KV namespace binding
//   PASSCODE       Secret: the passcode that unlocks the Study Report
//   ALLOWED_ORIGIN Variable: https://shawntyd.github.io
//   ROOM           Durable Object (StudyRoom): live "study together" link

const MAX_BODY = 60000;

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) },
  });
}
const safeId = (s) => typeof s === "string" && /^[A-Za-z0-9_\-.:]{1,80}$/.test(s);

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.EXAM_KV.list({ prefix, cursor, limit: 1000 });
    out.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const vals = await Promise.all(out.map((k) => env.EXAM_KV.get(k, "json")));
  return vals.filter(Boolean);
}

// One shared room. The owner's phone sets the current card; Mia's phone
// polls it and posts her answer back. Kept in a Durable Object so both
// phones always see the same state instantly.
export class StudyRoom {
  constructor(ctx, env) { this.ctx = ctx; this.seen = 0; }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.searchParams.get("who") === "student") this.seen = Date.now();
      const state = (await this.ctx.storage.get("state")) || null;
      return Response.json({ ok: true, state, seen: this.seen || null });
    }
    const body = await request.json();
    if (url.pathname === "/host") {
      const s = body.state || {};
      const state = s.active
        ? { active: true, n: s.n | 0, qid: s.qid | 0, order: Array.isArray(s.order) ? s.order.slice(0, 4).map((x) => x | 0) : [0, 1, 2, 3], src: String(s.src || "").slice(0, 20), pick: null, ok: null, at: Date.now() }
        : { active: false, n: s.n | 0, at: Date.now() };
      await this.ctx.storage.put("state", state);
      return Response.json({ ok: true, state });
    }
    if (url.pathname === "/pick") {
      const state = await this.ctx.storage.get("state");
      if (!state || !state.active || state.n !== (body.n | 0) || state.pick != null) return Response.json({ ok: false });
      state.pick = body.pick | 0; state.ok = !!body.ok; state.pickAt = Date.now();
      await this.ctx.storage.put("state", state);
      return Response.json({ ok: true, state });
    }
    return Response.json({ ok: false }, { status: 404 });
  }
}

async function room(env, path, init) {
  const stub = env.ROOM.get(env.ROOM.idFromName("main"));
  const r = await stub.fetch("https://room" + path, init);
  return r.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    // ---- study together (live room)
    if (url.pathname === "/room" && request.method === "GET") {
      return json(env, await room(env, "/state" + url.search, { method: "GET" }));
    }
    if (url.pathname === "/room/host" && request.method === "POST") {
      let body = {};
      try { body = JSON.parse(await request.text()); } catch {}
      if (!env.PASSCODE || body.code !== env.PASSCODE) return json(env, { ok: false, error: "passcode" }, 401);
      return json(env, await room(env, "/host", { method: "POST", body: JSON.stringify({ state: body.state }) }));
    }
    if (url.pathname === "/room/pick" && request.method === "POST") {
      let body = {};
      try { body = JSON.parse(await request.text()); } catch {}
      return json(env, await room(env, "/pick", { method: "POST", body: JSON.stringify({ n: body.n, pick: body.pick, ok: body.ok }) }));
    }

    // ---- save a record (sessions, tests, flashcard progress)
    if (request.method === "POST" && url.pathname === "/log") {
      const origin = request.headers.get("Origin") || "";
      if (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== "*" && origin && origin !== env.ALLOWED_ORIGIN) {
        return json(env, { ok: false, error: "origin" }, 403);
      }
      const text = await request.text();
      if (text.length > MAX_BODY) return json(env, { ok: false, error: "too_large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json(env, { ok: false, error: "bad_json" }, 400); }
      const { type, id, data } = body || {};
      if (!safeId(id) || typeof data !== "object" || !data) return json(env, { ok: false, error: "bad_record" }, 400);
      const prefix = { session: "s:", test: "t:", progress: "p:" }[type];
      if (!prefix) return json(env, { ok: false, error: "bad_type" }, 400);
      data.receivedAt = new Date().toISOString();
      await env.EXAM_KV.put(prefix + id, JSON.stringify(data));
      return json(env, { ok: true });
    }

    // ---- load flashcard progress for one device
    if (request.method === "GET" && url.pathname === "/progress") {
      const key = url.searchParams.get("key");
      if (!safeId(key)) return json(env, { ok: false }, 400);
      const data = await env.EXAM_KV.get("p:" + key, "json");
      return json(env, { ok: true, data });
    }

    // ---- owner erases everything (passcode required)
    if (request.method === "POST" && url.pathname === "/wipe") {
      let body = {};
      try { body = JSON.parse(await request.text()); } catch {}
      if (!env.PASSCODE || body.code !== env.PASSCODE) return json(env, { ok: false, error: "passcode" }, 401);
      let deleted = 0;
      for (const prefix of ["s:", "t:", "p:"]) {
        let cursor;
        do {
          const page = await env.EXAM_KV.list({ prefix, cursor, limit: 1000 });
          await Promise.all(page.keys.map((k) => env.EXAM_KV.delete(k.name)));
          deleted += page.keys.length;
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
      }
      return json(env, { ok: true, deleted });
    }

    // ---- owner's study report (passcode required)
    if (request.method === "GET" && url.pathname === "/report") {
      if (!env.PASSCODE || url.searchParams.get("code") !== env.PASSCODE) {
        return json(env, { ok: false, error: "passcode" }, 401);
      }
      const [sessions, tests, progress] = await Promise.all([listAll(env, "s:"), listAll(env, "t:"), listAll(env, "p:")]);
      return json(env, { ok: true, sessions, tests, progress });
    }

    return json(env, { ok: true, service: "esthetician-exam-log" });
  },
};
