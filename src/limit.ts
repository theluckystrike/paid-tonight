// Daily cap on AI calls so the public demo stays inside the Workers AI free allocation (0 USD).
export interface Counter { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }

export const DAILY_AI_CAP = 60;

export async function takeAiCall(kv: Counter | undefined, today: string, cap = DAILY_AI_CAP): Promise<boolean> {
  if (!kv) return true; // local dev without KV: no cap
  const key = `ai:${today}`;
  const used = Number((await kv.get(key)) ?? "0");
  if (!Number.isFinite(used) || used >= cap) return false;
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
  return true;
}
