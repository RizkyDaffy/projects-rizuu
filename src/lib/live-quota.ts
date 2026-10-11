import { Database } from "bun:sqlite";

export type LiveQuotaData = {
  used: number;
  total: number;
  name?: string | null;
  status?: string | null;
  expDate?: string | null;
};

/**
 * Parse quota info out of provider quota-gate messages.
 * Handles common relay formats (Ryzumi/OneAPI/NewAPI style):
 *   "Quota: 12500/100000 tokens"
 *   "You have used 12500 of 100000 tokens (12.5%)"
 *   "API key status: exceeded"
 */
export function parseQuotaMessage(text: string): LiveQuotaData | null {
  if (!text) return null;

  // "quota: 12,500 / 100,000 tokens" or "12500/100000"
  const ratio = text.match(/quota\s*[:=]?\s*([\d,]+(?:\.\d+)?)\s*\/\s*([\d,]+(?:\.\d+)?)/i);
  if (ratio) {
    return {
      used: Number(ratio[1].replace(/,/g, "")),
      total: Number(ratio[2].replace(/,/g, "")),
    };
  }

  // "used 12500 of 100000 tokens" / "12,500 of 100,000"
  const usedOf = text.match(/([\d,]+(?:\.\d+)?)\s*(?:tokens\s*)?of\s*([\d,]+(?:\.\d+)?)/i);
  if (usedOf) {
    return {
      used: Number(usedOf[1].replace(/,/g, "")),
      total: Number(usedOf[2].replace(/,/g, "")),
    };
  }

  // Bare exhausted status — no numbers to grab, but persist the fact
  if (/quota\s*[:=]?\s*0\s*\/\s*\d+/i.test(text)) {
    return { used: 0, total: Number(text.match(/quota\s*[:=]?\s*0\s*\/\s*(\d+)/i)?.[1] ?? 0) };
  }

  return null;
}

/** Extract a subscription/plan label from the message, if present (e.g. "Plan: Pro"). */
export function parseQuotaPlanName(text: string): string | null {
  const m = text.match(/(?:plan|tier|package|subscription)\s*[:=]\s*([\w\s-]{2,40})/i);
  return m ? m[1].trim() : null;
}

/** Extract an expiry date mention, if present (e.g. "expires 2026-12-31"). */
export function parseQuotaExpDate(text: string): string | null {
  const m = text.match(/expi\w*\s*[:=]?\s*(\d{4}-\d{2}-\d{2}(?:[T ][\d:]+)?)/i);
  return m ? m[1] : null;
}

/**
 * Persist live provider-reported quota for an upstream key.
 * Called when the proxy screens out a quota-gate response — the payload is
 * about to be discarded, so capture the real numbers first.
 */
export function updateKeyLiveQuota(
  db: Database,
  keyId: string,
  data: LiveQuotaData
): void {
  try {
    db.prepare(
      `UPDATE upstream_keys SET
         live_quota_used = ?,
         live_quota_total = ?,
         live_quota_name = COALESCE(?, live_quota_name),
         live_quota_status = ?,
         live_quota_exp_date = COALESCE(?, live_quota_exp_date),
         live_quota_checked_at = datetime('now')
       WHERE id = ?`
    ).run(
      data.used,
      data.total,
      data.name ?? null,
      data.status ?? null,
      data.expDate ?? null,
      keyId
    );
  } catch (_) {
    // Telemetry must never break proxying; swallow persistence errors.
  }
}
