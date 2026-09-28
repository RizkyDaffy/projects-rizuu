import { randomBytes } from "crypto";

export function newId(): string {
  return randomBytes(12).toString("hex");
}

export function newKey(prefix = "rzk"): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function hashPin(pin: string): string {
  return Bun.password.hashSync(pin, { algorithm: "bcrypt", cost: 10 });
}

export function verifyPin(pin: string, hash: string): boolean {
  if (!hash) return false;
  return Bun.password.verifySync(pin, hash);
}

export function ok(data: unknown = null, message?: string) {
  return { success: true, data, ...(message ? { message } : {}) };
}

export function err(message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
