import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { hashPin, ok, verifyPin } from "../lib/utils";

const SESSION_COOKIE = "rzuu_session";
// In-memory session token (single-server, resets on restart - ok for this use case)
// For production, use DB-backed sessions
let SESSION_TOKEN = "";

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  // GET /api/auth/status
  .get("/status", ({ cookie }) => {
    const token = cookie[SESSION_COOKIE]?.value;
    const authed = !!SESSION_TOKEN && token === SESSION_TOKEN;
    return ok({ authenticated: authed });
  })

  // POST /api/auth/login
  .post(
    "/login",
    ({ body, cookie, set }) => {
      const db = getDb();
      const row = db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get() as
        | { value: string }
        | undefined;
      const pinHash = row?.value ?? "";

      // If no PIN set yet, first login sets it
      if (!pinHash) {
        const hashed = hashPin(body.pin);
        db.prepare("UPDATE settings SET value = ? WHERE key = 'pin_hash'").run(hashed);
        SESSION_TOKEN = crypto.randomUUID();
        cookie[SESSION_COOKIE].set({ value: SESSION_TOKEN, httpOnly: true, path: "/", maxAge: 86400 * 30 });
        return ok(null, "PIN set and logged in");
      }

      if (!verifyPin(body.pin, pinHash)) {
        set.status = 401;
        return { success: false, error: "Invalid PIN" };
      }

      SESSION_TOKEN = crypto.randomUUID();
      cookie[SESSION_COOKIE].set({ value: SESSION_TOKEN, httpOnly: true, path: "/", maxAge: 86400 * 30 });
      return ok(null, "Logged in");
    },
    { body: t.Object({ pin: t.String(), turnstileToken: t.Optional(t.String()) }) }
  )

  // POST /api/auth/change-pin
  .post(
    "/change-pin",
    ({ body, cookie, set }) => {
      const token = cookie[SESSION_COOKIE]?.value;
      if (!SESSION_TOKEN || token !== SESSION_TOKEN) {
        set.status = 401;
        return { success: false, error: "Unauthorized" };
      }
      const db = getDb();
      const row = db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get() as
        | { value: string }
        | undefined;
      const pinHash = row?.value ?? "";

      if (!verifyPin(body.currentPin, pinHash)) {
        set.status = 401;
        return { success: false, error: "Current PIN incorrect" };
      }

      const newHash = hashPin(body.newPin);
      db.prepare("UPDATE settings SET value = ? WHERE key = 'pin_hash'").run(newHash);
      return ok(null, "PIN changed");
    },
    {
      body: t.Object({
        currentPin: t.String(),
        newPin: t.String({ minLength: 6 }),
      }),
    }
  )

  // POST /api/auth/logout
  .post("/logout", ({ cookie }) => {
    SESSION_TOKEN = "";
    cookie[SESSION_COOKIE].set({ value: "", maxAge: 0, path: "/" });
    return ok(null, "Logged out");
  });
