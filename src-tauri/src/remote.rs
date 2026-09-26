//! SSH sessions and the non-interactive side channel next to them.
//!
//! Every ssh invocation shares one ControlMaster connection per host, so side
//! commands (hook checks, installs, later polling) reuse the tab's login
//! instead of authenticating again. ssh command lines are only ever built here
//! from a stored profile, never from strings the webview passes in.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use portable_pty::CommandBuilder;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

use crate::hooks;
use crate::pty::{self, PtyState};
use crate::store::{CommandType, CommandsFile, Store};

/// Unix socket paths are capped at 104 bytes on macOS; ssh's %C adds 40.
const MAX_SOCKET_PATH: usize = 104;
const REMOTE_HOOK_DIR: &str = ".burrow/shell/zsh";

/// `[user@]host[:port]`, never starting with "-" (ssh would read it as an
/// option — `-oProxyCommand=…` runs arbitrary commands). Mirrors the check in
/// src/ui/command-validation.ts; this one is the one that must hold.
pub fn validate_host(host: &str) -> Result<(), String> {
    let ok_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    let (user, rest) = match host.split_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, host),
    };
    let (name, port) = match rest.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (rest, None),
    };
    let valid_word = |w: &str| !w.is_empty() && !w.starts_with('-') && w.chars().all(ok_char);
    let valid = user.is_none_or(valid_word)
        && valid_word(name)
        && port.is_none_or(|p| (1..=5).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit()));
    if valid {
        Ok(())
    } else {
        Err(format!("사용할 수 없는 SSH 호스트: {host}"))
    }
}

fn control_dir(store: &Store) -> PathBuf {
    let preferred = store.root().join("cm");
    // "/" + 40-char %C hash + the ".XXXXXXXXXXXXXXXX" suffix ssh adds while binding.
    if preferred.as_os_str().len() + 1 + 40 + 17 < MAX_SOCKET_PATH {
        return preferred;
    }
    // macOS's per-user $TMPDIR is itself ~50 bytes, so fall back to /tmp.
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata(store.root())
        .map(|m| m.uid())
        .unwrap_or(0);
    PathBuf::from(format!("/tmp/burrow-cm-{uid}"))
}

/// /tmp is shared, so a control directory someone else created or opened up
/// must not be used: its sockets would hand them our authenticated sessions.
fn ensure_private_dir(dir: &Path, uid: u32) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
    let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != uid {
        return Err(format!(
            "{}는 다른 사용자 소유라 쓸 수 없습니다",
            dir.display()
        ));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Options shared by the interactive session and side commands.
fn common_args(store: &Store) -> Result<Vec<String>, String> {
    let dir = control_dir(store);
    {
        use std::os::unix::fs::MetadataExt;
        let uid = std::fs::metadata(store.root())
            .map_err(|e| e.to_string())?
            .uid();
        ensure_private_dir(&dir, uid)?;
    }
    let mut args = Vec::new();
    // Development and tests can point at a throwaway ssh_config.
    if let Some(config) = std::env::var_os("BURROW_SSH_CONFIG").filter(|v| !v.is_empty()) {
        args.push("-F".into());
        args.push(config.to_string_lossy().into_owned());
    }
    for opt in [
        "ControlMaster=auto".to_string(),
        format!("ControlPath={}/%C", dir.display()),
        "ControlPersist=10m".into(),
        "ServerAliveInterval=15".into(),
        "ServerAliveCountMax=3".into(),
    ] {
        args.push("-o".into());
        args.push(opt);
    }
    Ok(args)
}

pub(crate) struct Profile {
    /// `[user@]host`, what ssh takes as its destination.
    dest: String,
    port: Option<String>,
    tmux_session: Option<String>,
}

impl Profile {
    /// Arguments that pick the host, after every option.
    fn target_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = &self.port {
            args.push("-p".into());
            args.push(port.clone());
        }
        args.push("--".into());
        args.push(self.dest.clone());
        args
    }
}

/// tmux session names go into a remote shell command, so only plain words.
pub fn validate_tmux_session(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "tmux 세션 이름은 영문·숫자·_·-만 쓸 수 있습니다: {name}"
        ))
    }
}

pub(crate) fn load_profile(store: &Store, profile_id: &str) -> Result<Profile, String> {
    let commands = store.load::<CommandsFile>();
    let profile = commands
        .commands
        .iter()
        .find(|c| c.id == profile_id && c.kind == CommandType::SshProfile)
        .ok_or("SSH 프로필을 찾을 수 없습니다")?;
    let host = profile.ssh_host.clone().unwrap_or_default();
    validate_host(&host)?;
    // ssh has no host:port syntax; the port becomes -p.
    let (dest, port) = match host.rsplit_once(':') {
        Some((dest, port)) => (dest.to_string(), Some(port.to_string())),
        None => (host, None),
    };
    let tmux_session = profile
        .tmux_session
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(name) = &tmux_session {
        validate_tmux_session(name)?;
    }
    Ok(Profile {
        dest,
        port,
        tmux_session,
    })
}

/// Runs `script` on the host with `sh`, without a tty and without ever prompting.
pub(crate) fn side_command(
    store: &Store,
    profile: &Profile,
    script: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let result = run_ssh(store, profile, script, stdin, &[]);
    match result {
        // A master that fails to log in dies in the background, taking ssh's
        // actual reason (e.g. "Permission denied") with it. Ask again without one.
        Err(e) if e.contains("control master") => {
            run_ssh(store, profile, script, stdin, &["-o", "ControlMaster=no"])
        }
        other => other,
    }
}

fn run_ssh(
    store: &Store,
    profile: &Profile,
    script: &str,
    stdin: Option<&[u8]>,
    extra: &[&str],
) -> Result<String, String> {
    let mut child = Command::new("ssh")
        .args(extra)
        .args(common_args(store)?)
        .args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"])
        .args(profile.target_args())
        .arg(script)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ssh를 실행하지 못했습니다: {e}"))?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let lines: Vec<&str> = err
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let reason = if lines.is_empty() {
            "ssh failed".to_string()
        } else {
            lines.join(" / ")
        };
        Err(reason.chars().take(240).collect())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum HookStatus {
    Current,
    Outdated,
    Missing,
    NoZsh,
    Unreachable { reason: String },
}

/// What a connect needs to know about the host, from one ssh round trip.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    hooks: HookStatus,
    /// `mosh-server` is on the host's login PATH.
    mosh_server: bool,
    tmux: bool,
    /// `mosh` is installed on this Mac.
    local_mosh: bool,
}

// Lines are tagged because the user's login files may print their own output.
const PROBE_SCRIPT: &str = concat!(
    "if command -v zsh >/dev/null 2>&1; then ",
    "printf 'burrow:version:%s\\n' \"$(cat \"$HOME/.burrow/shell/zsh/VERSION\" 2>/dev/null || echo missing)\"; ",
    "else echo burrow:no-zsh; fi; ",
    // Non-interactive ssh lacks Homebrew's PATH; a login shell has it.
    "\"${SHELL:-sh}\" -lc 'command -v mosh-server >/dev/null 2>&1 && echo burrow:mosh; ",
    "command -v tmux >/dev/null 2>&1 && echo burrow:tmux' </dev/null 2>/dev/null; true"
);

fn parse_probe(out: &str) -> (HookStatus, bool, bool) {
    let mut hooks = HookStatus::Missing;
    let (mut mosh, mut tmux) = (false, false);
    for line in out.lines().map(str::trim) {
        match line {
            "burrow:no-zsh" => hooks = HookStatus::NoZsh,
            "burrow:mosh" => mosh = true,
            "burrow:tmux" => tmux = true,
            _ => {
                if let Some(v) = line.strip_prefix("burrow:version:") {
                    hooks = match v {
                        "missing" | "" => HookStatus::Missing,
                        v if v == hooks::version() => HookStatus::Current,
                        _ => HookStatus::Outdated,
                    };
                }
            }
        }
    }
    (hooks, mosh, tmux)
}

#[tauri::command(async)]
pub fn remote_probe(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<RemoteProbe, String> {
    let profile = load_profile(&store, &profile_id)?;
    let local_mosh = local_mosh().is_some();
    Ok(match side_command(&store, &profile, PROBE_SCRIPT, None) {
        Err(reason) => RemoteProbe {
            hooks: HookStatus::Unreachable { reason },
            mosh_server: false,
            tmux: false,
            local_mosh,
        },
        Ok(out) => {
            let (hooks, mosh_server, tmux) = parse_probe(&out);
            RemoteProbe {
                hooks,
                mosh_server,
                tmux,
                local_mosh,
            }
        }
    })
}

/// Apps started from the Finder get a bare PATH, so look where Homebrew puts it too.
fn local_mosh() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from))
        .map(|dir| dir.join("mosh"))
        .find(|p| p.is_file())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Reachability {
    Online,
    Offline {
        reason: String,
    },
    /// Behind a ProxyJump/ProxyCommand: only ssh itself can tell.
    Unknown,
}

/// A TCP connect to the resolved sshd port — ICMP is often filtered, and this
/// answers in two seconds instead of ssh's much longer connect timeout.
#[tauri::command(async)]
pub fn remote_reachable(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<Reachability, String> {
    let profile = load_profile(&store, &profile_id)?;
    // `ssh -G` applies ssh_config (HostName, Port, ProxyJump) without connecting.
    let mut cmd = Command::new("ssh");
    if let Some(config) = std::env::var_os("BURROW_SSH_CONFIG").filter(|v| !v.is_empty()) {
        cmd.arg("-F").arg(config);
    }
    let out = cmd
        .arg("-G")
        .args(profile.target_args())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let config = String::from_utf8_lossy(&out.stdout);
    let value = |key: &str| {
        config.lines().find_map(|l| {
            l.strip_prefix(key)
                .and_then(|v| v.strip_prefix(' '))
                .map(str::trim)
        })
    };
    let proxied = |key: &str| value(key).is_some_and(|v| v != "none");
    if proxied("proxyjump") || proxied("proxycommand") {
        return Ok(Reachability::Unknown);
    }
    let hostname = value("hostname").unwrap_or(&profile.dest).to_string();
    let port: u16 = value("port").and_then(|p| p.parse().ok()).unwrap_or(22);
    Ok(tcp_check(&hostname, port))
}

fn tcp_check(hostname: &str, port: u16) -> Reachability {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let addrs = match (hostname, port).to_socket_addrs() {
        Ok(addrs) => addrs.collect::<Vec<_>>(),
        Err(e) => {
            return Reachability::Offline {
                reason: format!("{hostname}을(를) 찾을 수 없습니다 ({e})"),
            }
        }
    };
    let mut last = String::from("주소 없음");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
            Ok(_) => return Reachability::Online,
            Err(e) => last = e.to_string(),
        }
    }
    Reachability::Offline { reason: last }
}

/// Writes the hook files into `~/.burrow/shell/zsh` on the host — nowhere else.
#[tauri::command(async)]
pub fn remote_install_hooks(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<(), String> {
    let profile = load_profile(&store, &profile_id)?;
    // One tar-free round trip: a shell archive of here-documents written by `sh`.
    let mut script = format!(
        "set -e; d=\"$HOME/{REMOTE_HOOK_DIR}\"; mkdir -p \"$d\"; chmod 700 \"$HOME/.burrow\"\n"
    );
    for (name, contents) in hooks::FILES {
        let body = contents.strip_suffix('\n').unwrap_or(contents);
        script.push_str(&format!(
            "cat > \"$d/{name}\" <<'BURROW_HOOK_EOF'\n{body}\nBURROW_HOOK_EOF\n"
        ));
    }
    script.push_str(&format!(
        "printf '%s\\n' '{}' > \"$d/VERSION\"\n",
        hooks::version()
    ));
    side_command(&store, &profile, "sh -s", Some(script.as_bytes())).map(|_| ())
}

/// The command the remote side runs, or None for the user's plain login shell.
/// sshd hands it to the user's shell; mosh-server execs it, hence `sh -c` there.
fn remote_command(with_hooks: bool, tmux_session: Option<&str>) -> Option<String> {
    let wrapper = format!("$HOME/{REMOTE_HOOK_DIR}");
    match (tmux_session, with_hooks) {
        (None, false) => None,
        (None, true) => Some(format!("ZDOTDIR=\"{wrapper}\" exec zsh -l")),
        // A running tmux server keeps its own environment: -e only reaches a new
        // session, set-environment reaches new panes of an existing one.
        (Some(name), true) => Some(format!(
            "exec zsh -lc 'W=\"{wrapper}\"; if command -v tmux >/dev/null; then \
             tmux has-session -t \"={name}\" 2>/dev/null && tmux set-environment -t \"={name}\" ZDOTDIR \"$W\"; \
             exec tmux new -A -s {name} -e ZDOTDIR=\"$W\"; fi; \
             echo \"burrow: tmux가 없어 일반 셸로 접속합니다\" >&2; ZDOTDIR=\"$W\" exec zsh -l'"
        )),
        (Some(name), false) => Some(format!(
            "exec \"${{SHELL:-sh}}\" -lc 'if command -v tmux >/dev/null; then exec tmux new -A -s {name}; fi; \
             echo \"burrow: tmux가 없어 일반 셸로 접속합니다\" >&2; exec \"${{SHELL:-sh}}\" -l'"
        )),
    }
}

/// Quotes one word for a POSIX shell; mosh splits its --ssh value like one.
fn shell_quote(word: &str) -> String {
    if !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=%@:,".contains(c))
    {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn session_command(
    store: &Store,
    profile: &Profile,
    with_hooks: bool,
    transport: SessionTransport,
) -> Result<CommandBuilder, String> {
    let remote = remote_command(with_hooks, profile.tmux_session.as_deref());
    let mut cmd = match transport {
        SessionTransport::Ssh => {
            let mut cmd = CommandBuilder::new("ssh");
            cmd.args(common_args(store)?);
            cmd.arg("-t");
            cmd.args(profile.target_args());
            if let Some(remote) = remote {
                cmd.arg(remote);
            }
            cmd
        }
        SessionTransport::Mosh => {
            let mosh = local_mosh().ok_or("이 Mac에 mosh가 없습니다 (brew install mosh)")?;
            let mut ssh = vec!["ssh".to_string()];
            ssh.extend(common_args(store)?);
            if let Some(port) = &profile.port {
                ssh.push("-p".into());
                ssh.push(port.clone());
            }
            let ssh = ssh.iter().map(|w| shell_quote(w)).collect::<Vec<_>>();
            let mut cmd = CommandBuilder::new(&mosh);
            cmd.arg(format!("--ssh={}", ssh.join(" ")));
            cmd.arg(&profile.dest);
            if let Some(remote) = remote {
                cmd.args(["--", "sh", "-c", &remote]);
            }
            // mosh is a script that finds mosh-client next to itself on PATH.
            if let Some(dir) = mosh.parent() {
                let path = std::env::var("PATH").unwrap_or_default();
                cmd.env("PATH", format!("{}:{path}", dir.display()));
            }
            cmd
        }
    };
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    pty::base_env(&mut cmd);
    Ok(cmd)
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionTransport {
    Ssh,
    Mosh,
}

// Tauri injects the app handle and state as arguments.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_spawn_ssh(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
    with_hooks: bool,
    transport: SessionTransport,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let profile = load_profile(&store, &profile_id)?;
    let command = session_command(&store, &profile, with_hooks, transport)?;
    pty::spawn(app, &state, command, cols, rows, on_output)
}

/// Emits `network-changed` when this Mac's outbound address changes (Wi-Fi to
/// tethering, VPN up) — mosh roams silently, so this is how the UI finds out.
pub fn watch_network(app: AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last = outbound_ip();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let now = outbound_ip();
            if now != last {
                let _ = app.emit("network-changed", now.map(|ip| ip.to_string()));
                last = now;
            }
        }
    });
}

/// The source address the OS would route to the internet from. Connecting a
/// UDP socket only picks a route; nothing is sent.
fn outbound_ip() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_hosts() {
        for host in [
            "home-laptop",
            "home-laptop.tailnet.ts.net",
            "felix@home-laptop.tailnet.ts.net",
            "deploy@10.0.0.12",
            "server:2222",
            "me@my_alias",
        ] {
            assert!(validate_host(host).is_ok(), "{host}");
        }
    }

    #[test]
    fn rejects_option_injection_and_shell_syntax() {
        for host in [
            "-oProxyCommand=touch /tmp/pwned",
            "-J",
            "user@-oProxyCommand=x",
            "-user@host",
            "host name",
            "host;rm -rf ~",
            "$(whoami)@host",
            "host:port",
            "host:123456",
            "",
            "@host",
        ] {
            assert!(validate_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn hook_version_is_stable_and_tracks_contents() {
        let v = hooks::version();
        assert_eq!(v.len(), 16);
        assert_eq!(v, hooks::version());
    }

    #[test]
    fn short_store_roots_keep_their_control_directory() {
        // Like the real default (~/.burrow): short enough for the socket limit.
        let dir = PathBuf::from(format!("/tmp/bcs-{}", std::process::id()));
        let store = Store::open(dir.clone()).unwrap();
        assert_eq!(control_dir(&store), dir.join("cm"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_store_roots_fall_back_to_a_short_control_directory() {
        let dir = std::env::temp_dir().join("x".repeat(70));
        let store = Store::open(dir.clone()).unwrap();
        let cm = control_dir(&store);
        assert!(
            cm.as_os_str().len() + 58 < MAX_SOCKET_PATH,
            "{}",
            cm.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_directories_must_be_private_and_ours() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("bcs-priv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        let uid = std::fs::metadata(&dir).unwrap().uid();
        assert!(ensure_private_dir(&dir, uid + 1).is_err());
        ensure_private_dir(&dir, uid).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn probe_output_ignores_whatever_login_files_print() {
        let v = hooks::version();
        let out = format!("Welcome!\nburrow:version:{v}\nnvm loaded\nburrow:tmux\n");
        let (hooks, mosh, tmux) = parse_probe(&out);
        assert!(matches!(hooks, HookStatus::Current));
        assert!(!mosh && tmux);
        assert!(matches!(
            parse_probe("burrow:version:missing\nburrow:mosh").0,
            HookStatus::Missing
        ));
        assert!(matches!(
            parse_probe("burrow:version:0123").0,
            HookStatus::Outdated
        ));
        assert!(matches!(
            parse_probe("burrow:no-zsh\n").0,
            HookStatus::NoZsh
        ));
    }

    #[test]
    fn tmux_session_names_are_plain_words() {
        for ok in ["burrow", "api-server", "proj_2"] {
            assert!(validate_tmux_session(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-t", "a b", "x;rm", "a'b", "$(id)", "a:b", "a.b"] {
            assert!(validate_tmux_session(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn remote_commands_per_hook_and_tmux_choice() {
        assert_eq!(remote_command(false, None), None);
        assert_eq!(
            remote_command(true, None).unwrap(),
            "ZDOTDIR=\"$HOME/.burrow/shell/zsh\" exec zsh -l"
        );
        let hooked = remote_command(true, Some("burrow")).unwrap();
        assert!(hooked.contains("tmux new -A -s burrow -e ZDOTDIR=\"$W\""));
        assert!(hooked.contains("tmux set-environment -t \"=burrow\" ZDOTDIR"));
        let plain = remote_command(false, Some("burrow")).unwrap();
        assert!(plain.contains("exec tmux new -A -s burrow;") && !plain.contains("ZDOTDIR"));
    }

    #[test]
    fn shell_quote_round_trips_through_sh() {
        for word in [
            "plain",
            "ControlPath=/tmp/burrow-cm-501/%C",
            "has space",
            "it's",
            "",
        ] {
            let out = Command::new("sh")
                .args(["-c", &format!("printf %s {}", shell_quote(word))])
                .output()
                .unwrap();
            assert_eq!(String::from_utf8(out.stdout).unwrap(), word);
        }
    }

    #[test]
    fn closed_ports_are_offline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(matches!(tcp_check("127.0.0.1", port), Reachability::Online));
        drop(listener);
        // A freed ephemeral port can be reused by a parallel test; nothing listens on 1.
        assert!(matches!(
            tcp_check("127.0.0.1", 1),
            Reachability::Offline { .. }
        ));
    }

    #[test]
    fn profile_ports_become_dash_p() {
        let root = std::env::temp_dir().join(format!("bcs-prof-{}", std::process::id()));
        let store = Store::open(root.clone()).unwrap();
        std::fs::write(
            root.join("commands.json"),
            r#"{"version":1,"commands":[{"id":"a","name":"a","type":"ssh-profile","sshHost":"me@box:2222","tmuxSession":" work "}]}"#,
        )
        .unwrap();
        let profile = load_profile(&store, "a").unwrap();
        assert_eq!(profile.target_args(), ["-p", "2222", "--", "me@box"]);
        assert_eq!(profile.tmux_session.as_deref(), Some("work"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
