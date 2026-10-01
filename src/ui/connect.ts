import { invoke } from "@tauri-apps/api/core";
import type { StoredCommand } from "./command-validation";
import { chooseDialog } from "./dialog";
import { checkReachable, type Reachability } from "./reachability";
import { showToast } from "./toast";
import type { SessionTransport, TabManager } from "./tabs";
import type { VpnChip } from "./vpn-chip";
import { t } from "../i18n";

type HookStatus =
  | { state: "current" | "outdated" | "missing" | "noZsh" }
  | { state: "unreachable"; reason: string };

interface RemoteProbe {
  hooks: HookStatus;
  moshServer: boolean;
  moshServerPath: string | null;
  tmux: boolean;
  localMosh: boolean;
}

const VPN_WAIT_MS = 30_000;

/**
 * Runs the profile's own VPN command when the host can't be reached yet, then
 * waits for the host to answer. The command runs only when it is needed, and
 * never for profiles that don't have one.
 */
async function bringUpVpn(
  profile: StoredCommand,
  vpn: VpnChip,
  reason: { kind: "notHome" } | { kind: "unreachable"; label: string },
  /** Off the home network an answer at a private address proves nothing, so wait for the tunnel itself. */
  waitForTunnel = false,
) {
  showToast(
    reason.kind === "notHome"
      ? t("connect.vpnNotHome", { command: profile.vpnPreConnect ?? "" })
      : t("connect.vpnUnreachable", { label: reason.label, command: profile.vpnPreConnect ?? "" }),
  );
  try {
    await invoke("vpn_pre_connect", { profileId: profile.id });
  } catch (err) {
    showToast(t("connect.vpnCommandFailed", { error: String(err) }));
  }
  // Commands like `scutil --nc start` return before the tunnel is up.
  const deadline = Date.now() + VPN_WAIT_MS;
  if (waitForTunnel) {
    while (Date.now() < deadline && !(await vpn.refresh()).some((s) => s.connected)) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  let reach = await checkReachable(profile.id, true);
  while (reach.state === "offline" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    reach = await checkReachable(profile.id, true);
  }
  void vpn.refresh();
  return reach;
}

/**
 * A dropped connection usually took its VPN down with it, so reconnecting
 * can't succeed until the tunnel is back. Brings the profile's VPN up again
 * (its own pre-connect command) when that makes sense:
 * - the profile has such a command at all, and
 * - this Mac isn't on one of the profile's home networks (no VPN needed there;
 *   the host is simply down or asleep).
 * Resolves with the reachability after waiting, and the profile's disconnect
 * command to remember for this tab; undefined when nothing was attempted.
 */
export async function reconnectVpn(
  profile: StoredCommand,
  vpn: VpnChip,
): Promise<{ reach: Reachability; vpnDisconnect: string | null } | undefined> {
  if (!profile.vpnPreConnect?.trim()) return undefined;
  const homes = profile.homeNetworks ?? [];
  if (homes.length) {
    const fp = await invoke<{ gatewayMac: string } | null>("network_fingerprint").catch(() => null);
    if (fp && homes.some((h) => h.gatewayMac === fp.gatewayMac)) return undefined;
  }
  const label = profile.name || profile.sshHost || "SSH";
  const reach = await bringUpVpn(profile, vpn, { kind: "unreachable", label }, homes.length > 0);
  return { reach, vpnDisconnect: profile.vpnPostDisconnect?.trim() || null };
}

/** Profiles already told that installing mosh locally would help, this run. */
const moshHintShown = new Set<string>();

function chooseTransport(
  profile: StoredCommand,
  probe: RemoteProbe,
  label: string,
): SessionTransport {
  const reachable = probe.hooks.state !== "unreachable";
  if (profile.transport === "ssh") return "ssh";
  if (profile.transport === "mosh") {
    if (!probe.localMosh) {
      showToast(t("connect.noLocalMosh"));
      return "ssh";
    }
    if (reachable && !probe.moshServer) {
      showToast(t("connect.noRemoteMosh", { label }));
      return "ssh";
    }
    return "mosh";
  }
  // auto: Mosh whenever both ends have it.
  if (probe.moshServer && probe.localMosh) return "mosh";
  if (probe.moshServer && !moshHintShown.has(profile.id)) {
    moshHintShown.add(profile.id);
    showToast(t("connect.moshAvailableHint", { label }));
  }
  return "ssh";
}

/**
 * Opens an SSH profile in a new tab. Burrow's hooks are only installed on the
 * host after the user agrees; without them the session still works, it just
 * isn't tracked.
 */
export async function connectProfile(tabs: TabManager, profile: StoredCommand, vpn: VpnChip) {
  const label = profile.name || profile.sshHost || "SSH";
  let reach = await checkReachable(profile.id, true);
  // Set only when this connect actually ran vpnPreConnect — the disconnect
  // side (T31) must never fire for a tab that never touched the VPN, e.g.
  // one that connected straight from the home network.
  let vpnEngaged = false;
  if (profile.vpnPreConnect?.trim()) {
    const homes = profile.homeNetworks ?? [];
    if (homes.length) {
      // Home networks are known: decide by where this Mac is, not by whether
      // some device happens to answer at the host's (private) address.
      const fp = await invoke<{ gatewayMac: string } | null>("network_fingerprint").catch(
        () => null,
      );
      const atHome = !!fp && homes.some((h) => h.gatewayMac === fp.gatewayMac);
      if (!atHome) {
        vpnEngaged = true;
        reach = await bringUpVpn(profile, vpn, { kind: "notHome" }, true);
      }
    } else if (reach.state !== "online") {
      // "unknown" (behind a proxy) could just as well need the VPN.
      vpnEngaged = true;
      reach = await bringUpVpn(profile, vpn, { kind: "unreachable", label });
    }
  }
  if (reach.state === "offline") {
    showToast(t("connect.offline", { label, reason: reach.reason }));
    return;
  }

  let probe: RemoteProbe;
  try {
    probe = await invoke<RemoteProbe>("remote_probe", { profileId: profile.id });
  } catch (err) {
    showToast(t("connect.probeFailed", { label, error: String(err) }));
    return;
  }

  const status = probe.hooks;
  let withHooks = status.state === "current";
  if (status.state === "missing" || status.state === "outdated") {
    const outdated = status.state === "outdated";
    const choice = await chooseDialog(
      outdated
        ? t("connect.hooksUpdateConfirm", { label })
        : t("connect.hooksInstallConfirm", { label }),
      [
        outdated ? t("connect.hooksInstallBody1Update") : t("connect.hooksInstallBody1New"),
        t("connect.hooksInstallBody2"),
      ],
      [
        {
          value: "install",
          label: outdated
            ? t("connect.hooksUpdateAndConnect")
            : t("connect.hooksInstallAndConnect"),
        },
        { value: "plain", label: t("connect.connectPlain"), kind: "ghost" },
        { value: "cancel", label: t("connect.cancel"), kind: "ghost" },
      ],
    );
    if (!choice || choice === "cancel") return;
    if (choice === "install") {
      try {
        await invoke("remote_install_hooks", { profileId: profile.id });
        withHooks = true;
      } catch (err) {
        showToast(t("connect.hooksInstallFailed", { error: String(err) }));
      }
    }
  } else if (status.state === "noZsh") {
    showToast(t("connect.noZsh", { label }));
  } else if (status.state === "unreachable") {
    // Often a password-only login, which the non-interactive check cannot do.
    showToast(t("connect.unreachableProbe", { label, reason: status.reason }));
  }

  if (profile.tmuxSession && status.state !== "unreachable" && !probe.tmux) {
    showToast(t("connect.noTmux", { label }));
  }
  if (withHooks) {
    // The host's copy of the guardrail rules follows this Mac's.
    await invoke("remote_sync_guardrails", { profileId: profile.id }).catch((err) =>
      showToast(t("connect.guardrailSyncFailed", { error: String(err) })),
    );
  }
  const transport = chooseTransport(profile, probe, label);
  const vpnDisconnect = vpnEngaged ? (profile.vpnPostDisconnect?.trim() ?? null) : null;
  await tabs.newSshTab(
    profile.id,
    label,
    withHooks,
    transport,
    probe.moshServerPath,
    vpnDisconnect,
  );
}
