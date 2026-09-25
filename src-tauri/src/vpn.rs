//! VPN status for the corner chip, and the profile's own pre-connect command.
//!
//! Burrow never guesses which VPN to start: the only command it runs is the
//! one the user wrote into an SSH profile's `vpnPreConnect`.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::store::{CommandType, CommandsFile, Store};

const PRE_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VpnService {
    pub name: String,
    /// "macOS" (System Settings VPN), "Tailscale", or "utun" (unknown client).
    pub kind: String,
    pub connected: bool,
    /// Extra detail, e.g. the tailnet name or the interface's address.
    pub detail: Option<String>,
}

/// `scutil --nc list` lines look like
/// `* (Connected)      UUID PPP --> L2TP       "Name"   [PPP:L2TP]`.
fn parse_scutil(out: &str) -> Vec<VpnService> {
    out.lines()
        .filter_map(|line| {
            let state = line.split_once('(')?.1.split_once(')')?.0;
            let name = line.split_once('"')?.1.rsplit_once('"')?.0;
            Some(VpnService {
                name: name.to_string(),
                kind: "macOS".into(),
                connected: state == "Connected",
                detail: None,
            })
        })
        .collect()
}

fn tailscale_cli() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from))
        .map(|dir| dir.join("tailscale"))
        .chain([PathBuf::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        )])
        .find(|p| p.is_file())
}

fn parse_tailscale(json: &str) -> Option<VpnService> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let state = value.get("BackendState")?.as_str()?;
    let detail = value
        .pointer("/CurrentTailnet/Name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some(VpnService {
        name: "Tailscale".into(),
        kind: "Tailscale".into(),
        connected: state == "Running",
        detail,
    })
}

/// VPN clients that aren't macOS services still show up as a utun interface
/// with an IPv4 address; the system's own utuns only carry IPv6 link-locals.
fn parse_utun(ifconfig: &str) -> Vec<VpnService> {
    let mut found = Vec::new();
    let mut current: Option<&str> = None;
    for line in ifconfig.lines() {
        if !line.starts_with(['\t', ' ']) {
            current = line
                .split_once(':')
                .map(|(name, _)| name)
                .filter(|n| n.starts_with("utun"));
        } else if let (Some(name), Some(addr)) = (current, line.trim().strip_prefix("inet ")) {
            found.push(VpnService {
                name: name.to_string(),
                kind: "utun".into(),
                connected: true,
                detail: addr.split_whitespace().next().map(str::to_string),
            });
            current = None;
        }
    }
    found
}

fn output(cmd: &mut Command) -> Option<String> {
    let out = cmd
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command(async)]
pub fn vpn_status() -> Vec<VpnService> {
    let mut services = output(Command::new("scutil").args(["--nc", "list"]))
        .map(|out| parse_scutil(&out))
        .unwrap_or_default();
    let tailscale = tailscale_cli()
        .and_then(|cli| output(Command::new(cli).args(["status", "--json"])))
        .and_then(|json| parse_tailscale(&json));
    let known_up =
        services.iter().any(|s| s.connected) || tailscale.as_ref().is_some_and(|t| t.connected);
    services.extend(tailscale);
    // Only a guess, so only when nothing named explains the tunnel.
    if !known_up {
        if let Some(out) = output(&mut Command::new("ifconfig")) {
            services.extend(parse_utun(&out));
        }
    }
    services
}

/// Runs the profile's `vpnPreConnect` in a login shell (so Homebrew tools are on
/// PATH), without a terminal: anything that asks for a password fails instead
/// of hanging.
#[tauri::command(async)]
pub fn vpn_pre_connect(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<(), String> {
    let commands = store.load::<CommandsFile>();
    let command = commands
        .commands
        .iter()
        .find(|c| c.id == profile_id && c.kind == CommandType::SshProfile)
        .and_then(|c| c.vpn_pre_connect.clone())
        .filter(|c| !c.trim().is_empty())
        .ok_or("이 프로필에는 VPN 명령이 없습니다")?;
    run_with_timeout(&command, PRE_CONNECT_TIMEOUT)
}

fn run_with_timeout(command: &str, timeout: Duration) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-lc", command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{}초 안에 끝나지 않았습니다", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if status.success() {
        return Ok(());
    }
    let mut err = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut err);
    }
    let last = err.lines().map(str::trim).rfind(|l| !l.is_empty());
    let mut reason = last.unwrap_or("실패").chars().take(200).collect::<String>();
    if command.trim_start().starts_with("sudo") {
        reason.push_str(" — sudo가 필요한 명령은 비밀번호를 물을 수 없어 실행되지 않습니다");
    }
    Err(format!(
        "종료 코드 {}: {reason}",
        status.code().unwrap_or(-1)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scutil_services_and_states() {
        let out = r#"Available network connection services in the current set (*=enabled):
* (Disconnected)   433F9543-CD7C-4D19-8BB5-5ACDDADDEEE8 VPN (com.draytek.SmartVPN) "Vigor HOME"                     [VPN:com.draytek.SmartVPN]
* (Connected)      08A90D4A-20D7-4077-A15A-7AAE88E26D18 PPP --> L2TP       "회사 VPN"                            [PPP:L2TP]
"#;
        let services = parse_scutil(out);
        assert_eq!(services.len(), 2);
        assert_eq!(services[0].name, "Vigor HOME");
        assert!(!services[0].connected);
        assert_eq!(services[1].name, "회사 VPN");
        assert!(services[1].connected);
    }

    #[test]
    fn tailscale_backend_state() {
        let up =
            parse_tailscale(r#"{"BackendState":"Running","CurrentTailnet":{"Name":"me.github"}}"#)
                .unwrap();
        assert!(up.connected);
        assert_eq!(up.detail.as_deref(), Some("me.github"));
        assert!(
            !parse_tailscale(r#"{"BackendState":"Stopped"}"#)
                .unwrap()
                .connected
        );
        assert!(parse_tailscale("not json").is_none());
    }

    #[test]
    fn only_utuns_with_ipv4_count() {
        let out = "utun0: flags=8051<UP> mtu 1500\n\tinet6 fe80::1%utun0 prefixlen 64\nutun4: flags=8051<UP> mtu 1280\n\tinet 100.101.1.2 --> 100.101.1.2 netmask 0xffffffff\nen0: flags=8863<UP> mtu 1500\n\tinet 192.168.0.3 netmask 0xffffff00\n";
        let found = parse_utun(out);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "utun4");
        assert_eq!(found[0].detail.as_deref(), Some("100.101.1.2"));
    }

    #[test]
    fn pre_connect_reports_failures_and_timeouts() {
        assert!(run_with_timeout("true", Duration::from_secs(5)).is_ok());
        let err = run_with_timeout("echo nope >&2; exit 3", Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("3") && err.contains("nope"), "{err}");
        let err = run_with_timeout("sleep 5", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("끝나지 않았습니다"), "{err}");
    }
}
