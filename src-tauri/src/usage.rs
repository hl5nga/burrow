//! Claude Code's subscription usage (5-hour and weekly limits) for the top chip.
//!
//! The only supported source is Claude Code's status-line command, which is
//! piped a JSON blob containing `rate_limits`. "Install" points that setting
//! at a tiny script that keeps the latest blob in `~/.burrow/usage.json`; the
//! app then reads the file — locally, or over the SSH side channel.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use crate::remote;
use crate::store::Store;

const STATUSLINE_SCRIPT: &str = include_str!("scripts/usage-statusline.sh");
const READ_SCRIPT: &str = include_str!("scripts/usage-read.sh");
const MARKER: &str = "usage-statusline.sh";
const STATUSLINE_COMMAND: &str = "sh \"$HOME/.burrow/usage-statusline.sh\"";

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// 0–100 (can exceed 100 behind a spend-limited gateway).
    pub percent: f64,
    /// Unix seconds when this window resets.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSample {
    /// The status-line hook is set up on that host.
    pub installed: bool,
    /// Seconds since Claude Code last refreshed the numbers.
    pub age_secs: Option<i64>,
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    /// The hook wrote data, but without rate limits (API-key login).
    pub no_limits: bool,
}

fn window(v: &Value) -> Option<Window> {
    let percent = v.get("used_percentage")?.as_f64()?;
    Some(Window {
        percent,
        resets_at: v.get("resets_at").and_then(Value::as_i64),
    })
}

fn parse(out: &str) -> UsageSample {
    let mut sample = UsageSample::default();
    let (mut now, mut mtime) = (None, None);
    for line in out.lines() {
        let Some((key, value)) = line
            .trim()
            .strip_prefix("burrow:")
            .and_then(|l| l.split_once(':'))
        else {
            continue;
        };
        match key {
            "installed" => sample.installed = value == "1",
            "now" => now = value.parse::<i64>().ok(),
            "mtime" => mtime = value.parse::<i64>().ok(),
            "json" => {
                if let Ok(json) = serde_json::from_str::<Value>(value) {
                    match json.get("rate_limits") {
                        Some(limits) => {
                            sample.five_hour = limits.get("five_hour").and_then(window);
                            sample.seven_day = limits.get("seven_day").and_then(window);
                        }
                        None => sample.no_limits = true,
                    }
                }
            }
            _ => {}
        }
    }
    if let (Some(now), Some(mtime)) = (now, mtime) {
        sample.age_secs = Some((now - mtime).max(0));
    }
    sample
}

fn run_local(script: &str) -> Result<String, String> {
    let mut child = Command::new("/bin/sh")
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(script.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Runs `script` on this Mac (profile_id None) or the profile's host.
fn run(store: &Store, profile_id: &Option<String>, script: &str) -> Result<String, String> {
    match profile_id {
        None => run_local(script),
        Some(id) => {
            let profile = remote::load_profile(store, id)?;
            remote::side_command(store, &profile, "sh -s", Some(script.as_bytes()))
        }
    }
}

#[tauri::command(async)]
pub fn usage_sample(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<UsageSample, String> {
    Ok(parse(&run(&store, &profile_id, READ_SCRIPT)?))
}

/// `settings.json` with Burrow's `statusLine` added. Refuses to touch an
/// existing status line that isn't Burrow's own.
fn with_statusline(existing: &str) -> Result<String, String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing)
            .map_err(|e| format!("settings.json을 읽을 수 없습니다: {e}"))?
    };
    let obj = root
        .as_object_mut()
        .ok_or("settings.json이 JSON 객체가 아닙니다")?;
    if let Some(current) = obj.get("statusLine") {
        let ours = current
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| c.contains(MARKER));
        if !ours {
            return Err("이미 다른 statusLine 설정이 있어 덮어쓰지 않았습니다".into());
        }
    }
    obj.insert(
        "statusLine".into(),
        json!({ "type": "command", "command": STATUSLINE_COMMAND }),
    );
    serde_json::to_string_pretty(&root)
        .map(|s| s + "\n")
        .map_err(|e| e.to_string())
}

/// `settings.json` without Burrow's `statusLine` (anything else is left alone).
fn without_statusline(existing: &str) -> Result<String, String> {
    let mut root: Value = serde_json::from_str(existing)
        .map_err(|e| format!("settings.json을 읽을 수 없습니다: {e}"))?;
    if let Some(obj) = root.as_object_mut() {
        let ours = obj
            .get("statusLine")
            .and_then(|s| s.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|c| c.contains(MARKER));
        if ours {
            obj.remove("statusLine");
        }
    }
    serde_json::to_string_pretty(&root)
        .map(|s| s + "\n")
        .map_err(|e| e.to_string())
}

const SETTINGS_PATH: &str = "$HOME/.claude/settings.json";

/// Reads the host's settings.json ("" if none), so it can be merged here.
fn read_settings(store: &Store, profile_id: &Option<String>) -> Result<String, String> {
    let out = run(
        store,
        profile_id,
        &format!("cat \"{SETTINGS_PATH}\" 2>/dev/null; true"),
    )?;
    // Login banners can precede the file on some hosts; the file starts at "{".
    Ok(match out.find('{') {
        Some(i) => out[i..].to_string(),
        None => String::new(),
    })
}

fn write_settings(store: &Store, profile_id: &Option<String>, body: &str) -> Result<(), String> {
    let script = format!(
        "set -e; mkdir -p \"$HOME/.claude\"; f=\"{SETTINGS_PATH}\"; \
         [ -f \"$f\" ] && cp -p \"$f\" \"$f.burrow-backup\"; \
         cat > \"$f.burrow-tmp\" <<'BURROW_SETTINGS_EOF'\n{body}BURROW_SETTINGS_EOF\n\
         mv \"$f.burrow-tmp\" \"$f\"\n"
    );
    run(store, profile_id, &script).map(|_| ())
}

#[tauri::command(async)]
pub fn usage_install(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<(), String> {
    // Check the settings first: nothing is written if the merge is refused.
    let merged = with_statusline(&read_settings(&store, &profile_id)?)?;
    let script = format!(
        "set -e; d=\"$HOME/.burrow\"; mkdir -p \"$d\"; chmod 700 \"$d\"; \
         cat > \"$d/usage-statusline.sh\" <<'BURROW_USAGE_EOF'\n{}BURROW_USAGE_EOF\n\
         chmod 755 \"$d/usage-statusline.sh\"\n",
        STATUSLINE_SCRIPT
    );
    run(&store, &profile_id, &script)?;
    write_settings(&store, &profile_id, &merged)
}

#[tauri::command(async)]
pub fn usage_uninstall(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let existing = read_settings(&store, &profile_id)?;
    if !existing.trim().is_empty() {
        write_settings(&store, &profile_id, &without_statusline(&existing)?)?;
    }
    run(
        &store,
        &profile_id,
        "rm -f \"$HOME/.burrow/usage-statusline.sh\" \"$HOME/.burrow/usage.json\"",
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rate_limits_and_age() {
        let out = "Last login: x\nburrow:installed:1\nburrow:now:1000\nburrow:mtime:940\n\
            burrow:json:{\"cost\":{},\"rate_limits\":{\"five_hour\":{\"used_percentage\":23.5,\"resets_at\":1738425600},\"seven_day\":{\"used_percentage\":41.2,\"resets_at\":1738857600}}}\n";
        let s = parse(out);
        assert!(s.installed && !s.no_limits);
        assert_eq!(s.age_secs, Some(60));
        assert_eq!(
            s.five_hour,
            Some(Window {
                percent: 23.5,
                resets_at: Some(1738425600)
            })
        );
        assert_eq!(s.seven_day.unwrap().percent, 41.2);
    }

    #[test]
    fn api_key_login_has_no_limits() {
        let s =
            parse("burrow:installed:1\nburrow:now:5\nburrow:mtime:5\nburrow:json:{\"cost\":{}}\n");
        assert!(s.no_limits && s.five_hour.is_none());
        assert!(!parse("burrow:installed:0\nburrow:now:5\n").installed);
    }

    #[test]
    fn install_adds_statusline_and_keeps_other_settings() {
        let out = with_statusline("{\"model\":\"opus\"}").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["statusLine"]["command"], STATUSLINE_COMMAND);
        // Idempotent for our own entry, and empty files work.
        assert!(with_statusline(&out).is_ok());
        assert!(with_statusline("").is_ok());
    }

    #[test]
    fn install_never_overwrites_someone_elses_statusline() {
        let theirs = "{\"statusLine\":{\"type\":\"command\",\"command\":\"~/my.sh\"}}";
        assert!(with_statusline(theirs).is_err());
        // ...and uninstall leaves it alone too.
        let v: Value = serde_json::from_str(&without_statusline(theirs).unwrap()).unwrap();
        assert_eq!(v["statusLine"]["command"], "~/my.sh");
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let ours = with_statusline("{\"model\":\"opus\"}").unwrap();
        let v: Value = serde_json::from_str(&without_statusline(&ours).unwrap()).unwrap();
        assert!(v.get("statusLine").is_none());
        assert_eq!(v["model"], "opus");
    }

    #[test]
    fn status_script_stores_stdin_atomically() {
        let home = std::env::temp_dir().join(format!("burrow-usage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(STATUSLINE_SCRIPT)
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"rate_limits\":{}}")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.stdout.is_empty());
        let saved = std::fs::read_to_string(home.join(".burrow/usage.json")).unwrap();
        assert_eq!(saved, "{\"rate_limits\":{}}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
