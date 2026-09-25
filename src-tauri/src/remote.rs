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

fn profile_host(store: &Store, profile_id: &str) -> Result<String, String> {
    let commands = store.load::<CommandsFile>();
    let profile = commands
        .commands
        .iter()
        .find(|c| c.id == profile_id && c.kind == CommandType::SshProfile)
        .ok_or("SSH 프로필을 찾을 수 없습니다")?;
    let host = profile.ssh_host.clone().unwrap_or_default();
    validate_host(&host)?;
    Ok(host)
}

/// Runs `script` on the host with `sh`, without a tty and without ever prompting.
fn side_command(
    store: &Store,
    host: &str,
    script: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let mut child = Command::new("ssh")
        .args(common_args(store)?)
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "--",
            host,
            script,
        ])
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
        Err(err
            .lines()
            .last()
            .unwrap_or("ssh failed")
            .trim()
            .to_string())
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

#[tauri::command]
pub fn remote_hook_status(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<HookStatus, String> {
    let host = profile_host(&store, &profile_id)?;
    let script = format!(
        "command -v zsh >/dev/null 2>&1 || {{ echo no-zsh; exit 0; }}; cat \"$HOME/{REMOTE_HOOK_DIR}/VERSION\" 2>/dev/null || echo missing"
    );
    Ok(match side_command(&store, &host, &script, None) {
        Err(reason) => HookStatus::Unreachable { reason },
        Ok(out) => match out.trim() {
            "no-zsh" => HookStatus::NoZsh,
            "missing" => HookStatus::Missing,
            v if v == hooks::version() => HookStatus::Current,
            _ => HookStatus::Outdated,
        },
    })
}

/// Writes the hook files into `~/.burrow/shell/zsh` on the host — nowhere else.
#[tauri::command]
pub fn remote_install_hooks(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<(), String> {
    let host = profile_host(&store, &profile_id)?;
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
    side_command(&store, &host, "sh -s", Some(script.as_bytes())).map(|_| ())
}

fn ssh_session_command(
    store: &Store,
    host: &str,
    with_hooks: bool,
) -> Result<CommandBuilder, String> {
    let mut cmd = CommandBuilder::new("ssh");
    cmd.args(common_args(store)?);
    cmd.arg("-t");
    cmd.arg("--");
    cmd.arg(host);
    if with_hooks {
        cmd.arg(format!("ZDOTDIR=\"$HOME/{REMOTE_HOOK_DIR}\" exec zsh -l"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    pty::base_env(&mut cmd);
    Ok(cmd)
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
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let host = profile_host(&store, &profile_id)?;
    let command = ssh_session_command(&store, &host, with_hooks)?;
    pty::spawn(app, &state, command, cols, rows, on_output)
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
}
