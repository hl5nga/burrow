import { invoke } from "@tauri-apps/api/core";

export type Reachability =
  { state: "online" } | { state: "offline"; reason: string } | { state: "unknown" };

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; value: Promise<Reachability> }>();

/** A 2-second TCP check of the profile's sshd, shared by the host cards and connect. */
export function checkReachable(profileId: string, fresh = false): Promise<Reachability> {
  const hit = cache.get(profileId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = invoke<Reachability>("remote_reachable", { profileId }).catch(
    (err): Reachability => ({ state: "offline", reason: String(err) }),
  );
  cache.set(profileId, { at: Date.now(), value });
  return value;
}
