export type CommandType = "shell" | "ssh-profile";
export type Transport = "auto" | "ssh" | "mosh";

/** A network where the host is reachable without the VPN, by its router's MAC. */
export interface HomeNetwork {
  gatewayMac: string;
  name: string;
}

export interface StoredCommand {
  id: string;
  name: string;
  command: string;
  description: string;
  type: CommandType;
  sshHost: string | null;
  tmuxSession: string | null;
  transport: Transport;
  vpnPreConnect: string | null;
  /** Run once no open tab needs this VPN anymore (T31). Optional — empty
   * means Burrow never turns this VPN off on its own. */
  vpnPostDisconnect: string | null;
  homeNetworks: HomeNetwork[];
}

export type FieldErrors = Partial<Record<keyof StoredCommand, string>>;

// [user@]host with an optional :port; host may be an ssh_config alias, a DNS name
// or an IPv4 address. A leading "-" would reach ssh as an option (e.g.
// -oProxyCommand=…, which runs arbitrary commands), so it is never allowed.
const SSH_HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*(?::\d{1,5})?$/;
// tmux rejects "." and ":" in session names; keep it to a safe, predictable set.
const TMUX_SESSION = /^[A-Za-z0-9_-]{1,64}$/;

export function validateCommand(c: StoredCommand): FieldErrors {
  const errors: FieldErrors = {};
  if (c.type === "shell") {
    if (!c.command.trim()) errors.command = "실행할 명령을 입력하세요";
  } else {
    if (!c.name.trim()) errors.name = "프로필 이름을 입력하세요";
    const host = c.sshHost?.trim() ?? "";
    if (!host) errors.sshHost = "접속할 호스트를 입력하세요";
    else if (!SSH_HOST.test(host))
      errors.sshHost = "user@host, 호스트 별칭, host:port 형식만 가능합니다 (공백·'-'로 시작 불가)";
    const session = c.tmuxSession?.trim() ?? "";
    if (session && !TMUX_SESSION.test(session))
      errors.tmuxSession = "영문·숫자·'-'·'_'만 쓸 수 있습니다 (최대 64자)";
  }
  return errors;
}

/** Trims text fields and blanks out fields that do not apply to the type. */
export function normalizeCommand(c: StoredCommand): StoredCommand {
  const text = (v: string | null) => {
    const t = v?.trim() ?? "";
    return t ? t : null;
  };
  const ssh = c.type === "ssh-profile";
  return {
    ...c,
    name: c.name.trim(),
    command: ssh ? "" : c.command.trim(),
    description: c.description.trim(),
    sshHost: ssh ? text(c.sshHost) : null,
    tmuxSession: ssh ? text(c.tmuxSession) : null,
    transport: ssh ? c.transport : "auto",
    vpnPreConnect: ssh ? text(c.vpnPreConnect) : null,
    vpnPostDisconnect: ssh ? text(c.vpnPostDisconnect) : null,
    homeNetworks: ssh ? (c.homeNetworks ?? []) : [],
  };
}

/**
 * A best-effort reverse of a `vpnPreConnect` value, for the manager form to
 * suggest (never applied silently — the user sees and can edit/clear it).
 * Only the exact commands Burrow's own VPN card would generate are
 * recognized; anything else (a custom script, wg-quick, …) returns null.
 */
export function suggestVpnDisconnect(preConnect: string): string | null {
  const pre = preConnect.trim();
  const scutil = pre.match(/^scutil\s+--nc\s+start\s+(".*"|\S+)$/);
  if (scutil) return `scutil --nc stop ${scutil[1]}`;
  if (/^tailscale\s+up\b/.test(pre)) return "tailscale down";
  return null;
}

export function emptyCommand(type: CommandType = "shell"): StoredCommand {
  return {
    id: "",
    name: "",
    command: "",
    description: "",
    type,
    sshHost: null,
    tmuxSession: null,
    transport: "auto",
    vpnPreConnect: null,
    vpnPostDisconnect: null,
    homeNetworks: [],
  };
}
