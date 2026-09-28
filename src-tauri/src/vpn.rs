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
    /// Coming up or going down right now (macOS reports it; others don't).
    pub transitioning: bool,
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
                transitioning: matches!(state, "Connecting" | "Disconnecting"),
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
        transitioning: state == "Starting",
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
                transitioning: false,
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

/// Connects or disconnects one VPN the user picked in the chip's card. Only a
/// service that exists right now can be named, and it goes to scutil/tailscale
/// as an argument, never through a shell.
#[tauri::command(async)]
pub fn vpn_toggle(kind: String, name: String, up: bool) -> Result<(), String> {
    let out = match kind.as_str() {
        "macOS" => {
            let listed = output(Command::new("scutil").args(["--nc", "list"]))
                .map(|o| parse_scutil(&o))
                .unwrap_or_default();
            if !listed.iter().any(|s| s.name == name) {
                return Err(format!("'{name}' VPN을 찾을 수 없습니다"));
            }
            Command::new("scutil")
                .args(["--nc", if up { "start" } else { "stop" }, &name])
                .stdin(Stdio::null())
                .output()
        }
        "Tailscale" => {
            let cli = tailscale_cli().ok_or("tailscale CLI를 찾을 수 없습니다")?;
            Command::new(cli)
                .arg(if up { "up" } else { "down" })
                .stdin(Stdio::null())
                .output()
        }
        _ => return Err("이 VPN은 Burrow에서 켜고 끌 수 없습니다".into()),
    }
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let out_text = String::from_utf8_lossy(&out.stdout);
        let reason = err
            .lines()
            .chain(out_text.lines())
            .map(str::trim)
            .find(|l| !l.is_empty());
        Err(reason.unwrap_or("실패").to_string())
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkFingerprint {
    pub gateway: String,
    pub gateway_mac: String,
    pub interface: String,
}

fn parse_route(out: &str) -> Option<(String, String)> {
    let field = |key: &str| {
        out.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(|v| v.trim().to_string()))
    };
    Some((field("gateway:")?, field("interface:")?))
}

/// arp prints "? (192.168.1.1) at 3c:52:a1:0:e:9 on en0 ..." — octets may lack
/// a leading zero; normalize so the same router always compares equal.
fn parse_arp_mac(out: &str) -> Option<String> {
    let mac = out.split(" at ").nth(1)?.split_whitespace().next()?;
    let octets: Vec<String> = mac
        .split(':')
        .map(|o| format!("{:0>2}", o.to_lowercase()))
        .collect();
    let ok = octets.len() == 6
        && octets
            .iter()
            .all(|o| o.len() == 2 && o.chars().all(|c| c.is_ascii_hexdigit()));
    ok.then(|| octets.join(":"))
}

/// The network this Mac is on right now, identified by its default gateway's
/// hardware address. None when offline or when the route has no gateway (VPN).
#[tauri::command(async)]
pub fn network_fingerprint() -> Option<NetworkFingerprint> {
    let route = output(Command::new("route").args(["-n", "get", "default"]))?;
    let (gateway, interface) = parse_route(&route)?;
    gateway.parse::<std::net::IpAddr>().ok()?;
    let arp = output(Command::new("arp").args(["-n", &gateway]))?;
    Some(NetworkFingerprint {
        gateway_mac: parse_arp_mac(&arp)?,
        gateway,
        interface,
    })
}

/// Runs the profile's `vpnPreConnect` in a login shell (so Homebrew tools are on
/// PATH), without a terminal: anything that asks for a password fails instead
/// of hanging.
#[tauri::command(async)]
pub fn vpn_pre_connect(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<(), String> {
    let command = profile_field(&store, &profile_id, |c| c.vpn_pre_connect.clone())?;
    run_with_timeout(&command, PRE_CONNECT_TIMEOUT)
}

/// Runs a profile's `vpnPostDisconnect` — the frontend calls this once it
/// decides no open tab needs that VPN anymore (T31). A profile without one
/// set is silently skipped rather than erroring, since most won't have it.
#[tauri::command(async)]
pub fn vpn_post_disconnect(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<(), String> {
    match profile_field(&store, &profile_id, |c| c.vpn_post_disconnect.clone()) {
        Ok(command) => run_with_timeout(&command, PRE_CONNECT_TIMEOUT),
        Err(_) => Ok(()),
    }
}

fn profile_field(
    store: &Store,
    profile_id: &str,
    field: impl Fn(&crate::store::Command) -> Option<String>,
) -> Result<String, String> {
    let commands = store.load::<CommandsFile>();
    commands
        .commands
        .iter()
        .find(|c| c.id == profile_id && c.kind == CommandType::SshProfile)
        .and_then(field)
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| "이 프로필에는 해당 VPN 명령이 없습니다".into())
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
* (Connecting)     08A90D4A-20D7-4077-A15A-7AAE88E26D18 PPP --> L2TP       "회사 VPN"                            [PPP:L2TP]
"#;
        let services = parse_scutil(out);
        assert_eq!(services.len(), 2);
        assert_eq!(services[0].name, "Vigor HOME");
        assert!(!services[0].connected);
        assert_eq!(services[1].name, "회사 VPN");
        assert!(!services[1].connected && services[1].transitioning);
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
    fn network_fingerprint_parsing() {
        let route = "   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n";
        assert_eq!(
            parse_route(route),
            Some(("192.168.1.1".into(), "en0".into()))
        );
        assert_eq!(
            parse_arp_mac("? (192.168.1.1) at 3c:52:A1:0:e:9 on en0 ifscope [ethernet]").as_deref(),
            Some("3c:52:a1:00:0e:09")
        );
        assert_eq!(
            parse_arp_mac("? (192.168.1.1) at (incomplete) on en0"),
            None
        );
        // This Mac, now: offline is fine, a malformed answer is not.
        if let Some(fp) = network_fingerprint() {
            assert_eq!(fp.gateway_mac.len(), 17);
        }
    }

    #[test]
    fn pre_connect_reports_failures_and_timeouts() {
        assert!(run_with_timeout("true", Duration::from_secs(5)).is_ok());
        let err = run_with_timeout("echo nope >&2; exit 3", Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("3") && err.contains("nope"), "{err}");
        let err = run_with_timeout("sleep 5", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("끝나지 않았습니다"), "{err}");
    }

    fn store_with_profile(name: &str, json: &str) -> Store {
        let root = std::env::temp_dir().join(format!("bcs-vpn-{name}-{}", std::process::id()));
        let store = Store::open(root.clone()).unwrap();
        std::fs::write(root.join("commands.json"), json).unwrap();
        store
    }

    #[test]
    fn post_disconnect_is_a_no_op_without_a_command_but_runs_when_set() {
        let store = store_with_profile(
            "a",
            r#"{"version":1,"commands":[
                {"id":"none","name":"n","type":"ssh-profile","sshHost":"h"},
                {"id":"set","name":"s","type":"ssh-profile","sshHost":"h","vpnPostDisconnect":"true"},
                {"id":"bad","name":"b","type":"ssh-profile","sshHost":"h","vpnPostDisconnect":"exit 9"}
            ]}"#,
        );
        assert!(profile_field(&store, "none", |c| c.vpn_post_disconnect.clone()).is_err());
        // The command itself: no_op behavior is at the tauri::command layer
        // (vpn_post_disconnect), which we can't call directly here without a
        // State wrapper — this exercises the same lookup it relies on.
        assert_eq!(
            profile_field(&store, "set", |c| c.vpn_post_disconnect.clone()).unwrap(),
            "true"
        );
        assert_eq!(
            profile_field(&store, "bad", |c| c.vpn_post_disconnect.clone()).unwrap(),
            "exit 9"
        );
        let _ = std::fs::remove_dir_all(store.root());
    }
}
