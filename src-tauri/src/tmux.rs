//! Tier 2 of the agent dashboard: every pane of the host's tmux server, read
//! over the SSH side channel (`list-panes` + `capture-pane`). This only asks
//! the tmux server for text, so nothing needs to pass through the panes.

use std::sync::Arc;

use serde::Serialize;

use crate::remote;
use crate::store::Store;

const SCRIPT: &str = include_str!("scripts/tmux-panes.sh");

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    /// tmux's `%N` id, stable for the pane's lifetime.
    pub id: String,
    pub session: String,
    pub window: u32,
    pub index: u32,
    /// The tmux window's name (`#{window_name}` — user-set via
    /// `tmux rename-window`, or defaulted to the running command).
    pub window_name: String,
    /// What runs in the pane now, e.g. "claude", "node", "zsh".
    pub command: String,
    /// The active pane of the session's active window.
    pub active: bool,
    /// The bottom of the pane's screen, joined lines, no colors.
    pub screen: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum TmuxPanes {
    Panes {
        panes: Vec<Pane>,
    },
    /// No tmux, or no server running: the dashboard just shows Tier 1.
    None,
}

fn parse(out: &str) -> TmuxPanes {
    let mut panes: Vec<Pane> = Vec::new();
    let mut capturing: Option<usize> = None;
    for line in out.lines() {
        if matches!(line, "burrow:no-tmux" | "burrow:no-server") {
            return TmuxPanes::None;
        }
        if let Some(rest) = line.strip_prefix("burrow:pane ") {
            let mut f = rest.splitn(6, ' ');
            let (
                Some(id),
                Some(window),
                Some(index),
                Some(pane_active),
                Some(window_active),
                Some(tail),
            ) = (f.next(), f.next(), f.next(), f.next(), f.next(), f.next())
            else {
                continue;
            };
            let mut t = tail.splitn(3, "::burrow::");
            let (Some(command), Some(window_name), Some(session)) = (t.next(), t.next(), t.next())
            else {
                continue;
            };
            panes.push(Pane {
                id: id.into(),
                session: session.into(),
                window: window.parse().unwrap_or(0),
                index: index.parse().unwrap_or(0),
                window_name: window_name.into(),
                command: command.into(),
                active: pane_active == "1" && window_active == "1",
                screen: String::new(),
            });
            capturing = None;
        } else if let Some(id) = line.strip_prefix("burrow:capture ") {
            capturing = panes.iter().position(|p| p.id == id);
        } else if let (Some(i), Some(text)) = (capturing, line.strip_prefix('|')) {
            let screen = &mut panes[i].screen;
            if !screen.is_empty() {
                screen.push('\n');
            }
            screen.push_str(text);
        }
    }
    // capture-pane includes the empty rows below the cursor.
    for p in &mut panes {
        p.screen.truncate(p.screen.trim_end().len());
    }
    TmuxPanes::Panes { panes }
}

#[tauri::command(async)]
pub fn tmux_panes(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
) -> Result<TmuxPanes, String> {
    let profile = remote::load_profile(&store, &profile_id)?;
    let out = remote::side_command(&store, &profile, "sh -s", Some(SCRIPT.as_bytes()))?;
    Ok(parse(&out))
}

/// Pane ids come back from the webview, and go into a remote command.
fn valid_pane_id(id: &str) -> bool {
    id.len() > 1 && id.starts_with('%') && id[1..].chars().all(|c| c.is_ascii_digit())
}

/// Makes the pane current in its session, so a Burrow tab attached to that
/// session shows it.
#[tauri::command(async)]
pub fn tmux_select_pane(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
    pane_id: String,
) -> Result<(), String> {
    if !valid_pane_id(&pane_id) {
        return Err(format!("잘못된 pane id: {pane_id}"));
    }
    let profile = remote::load_profile(&store, &profile_id)?;
    let script = format!(
        "T=$(command -v tmux || ls /opt/homebrew/bin/tmux /usr/local/bin/tmux 2>/dev/null | head -1); \
         \"$T\" select-window -t {pane_id} && \"$T\" select-pane -t {pane_id}"
    );
    remote::side_command(&store, &profile, &script, None).map(|_| ())
}

/// Longest prompt Assign will paste into a pane.
const MAX_PROMPT_BYTES: usize = 64 * 1024;

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Shell script (for `sh -s` on the host) that pastes `text` into the pane as
/// one bracketed paste and optionally presses Enter. The text travels as
/// base64 and through tmux's buffer on stdin, never as a command-line
/// argument, so multi-line and non-English text arrive byte for byte.
fn send_script(pane_id: &str, text: &str, submit: bool) -> String {
    let b64 = base64(text.as_bytes());
    // -p: bracketed paste, so newlines in the text don't submit early.
    // -r: keep LF as LF instead of turning it into CR.
    // -d: drop the buffer afterwards.
    let enter = if submit {
        format!("sleep 0.4; \"$T\" send-keys -t {pane_id} Enter\n")
    } else {
        String::new()
    };
    format!(
        "T=$(command -v tmux 2>/dev/null); \
         [ -n \"$T\" ] || for d in /opt/homebrew/bin /usr/local/bin; do [ -x \"$d/tmux\" ] && T=$d/tmux && break; done; \
         [ -n \"$T\" ] || {{ echo 'tmux를 찾을 수 없습니다' >&2; exit 1; }}\n\
         printf '%s' '{b64}' | {{ base64 -d 2>/dev/null || base64 -D; }} | \"$T\" load-buffer -b burrow-assign - || exit 1\n\
         \"$T\" paste-buffer -p -r -d -b burrow-assign -t {pane_id} || exit 1\n\
         {enter}"
    )
}

/// Sends a task prompt into a tmux pane of the profile's host.
#[tauri::command(async)]
pub fn tmux_send_prompt(
    store: tauri::State<'_, Arc<Store>>,
    profile_id: String,
    pane_id: String,
    text: String,
    submit: bool,
) -> Result<(), String> {
    if !valid_pane_id(&pane_id) {
        return Err(format!("잘못된 pane id: {pane_id}"));
    }
    if text.trim().is_empty() {
        return Err("보낼 내용이 비어 있습니다".into());
    }
    if text.len() > MAX_PROMPT_BYTES {
        return Err("내용이 너무 깁니다 (64KB 이하)".into());
    }
    let profile = remote::load_profile(&store, &profile_id)?;
    let script = send_script(&pane_id, &text, submit);
    remote::side_command(&store, &profile, "sh -s", Some(script.as_bytes())).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_panes_and_their_screens() {
        let out = "Welcome\nburrow:pane %0 0 0 1 1 claude::burrow::cpo::burrow::my work\nburrow:pane %3 1 0 1 0 zsh::burrow::be::burrow::my work\n\
                   burrow:capture %0\n|> fix it\n|  ? for shortcuts\n|\n|\nburrow:capture %3\n|$ ls\n";
        let TmuxPanes::Panes { panes } = parse(out) else {
            panic!("no panes")
        };
        assert_eq!(panes.len(), 2);
        assert_eq!(panes[0].command, "claude");
        assert_eq!(panes[0].window_name, "cpo");
        assert_eq!(panes[1].window_name, "be");
        assert_eq!(panes[0].session, "my work");
        assert!(panes[0].active);
        assert!(!panes[1].active, "active pane of an inactive window");
        assert_eq!(panes[0].screen, "> fix it\n  ? for shortcuts");
        assert_eq!(panes[1].screen, "$ ls");
    }

    #[test]
    fn missing_tmux_is_not_an_error() {
        assert_eq!(parse("burrow:no-tmux\n"), TmuxPanes::None);
        assert_eq!(parse("burrow:no-server\n"), TmuxPanes::None);
    }

    /// Runs the real script against a throwaway local tmux server.
    #[test]
    fn prompt_arrives_whole_in_the_pane() {
        use std::process::Command;
        let Ok(tmux) = Command::new("sh").args(["-c", "command -v tmux"]).output() else {
            return;
        };
        let tmux = String::from_utf8_lossy(&tmux.stdout).trim().to_string();
        if tmux.is_empty() {
            return; // no tmux here: nothing to test against
        }
        let dir = std::env::temp_dir().join(format!("burrow-tmux-send-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new(&tmux)
                .args(args)
                .env("TMUX_TMPDIR", &dir)
                .output()
                .unwrap()
        };
        run(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "t",
            "-x",
            "120",
            "-y",
            "30",
            "cat",
        ]);
        let pane = String::from_utf8_lossy(&run(&["list-panes", "-a", "-F", "#{pane_id}"]).stdout)
            .trim()
            .to_string();
        let text =
            "다음 작업을 진행해줘: Copy Equipment 범위\n- 첫째 줄 'quote' \"dq\" $HOME\n- 둘째 줄";
        for submit in [true, false] {
            let script = send_script(&pane, text, submit);
            let out = Command::new("sh")
                .args(["-c", &script])
                .env("TMUX_TMPDIR", &dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            std::thread::sleep(std::time::Duration::from_millis(900));
            let screen = String::from_utf8_lossy(&run(&["capture-pane", "-p", "-t", &pane]).stdout)
                .to_string();
            assert!(
                screen.contains("다음 작업을 진행해줘: Copy Equipment 범위"),
                "{screen}"
            );
            assert!(
                screen.contains("- 첫째 줄 'quote' \"dq\" $HOME"),
                "{screen}"
            );
            assert!(screen.contains("- 둘째 줄"), "{screen}");
        }
        run(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("한글".as_bytes()), "7ZWc6riA");
    }

    #[test]
    fn pane_ids_are_checked() {
        assert!(valid_pane_id("%12"));
        for bad in ["", "%", "12", "%1;rm -rf ~", "%-1", "$(id)"] {
            assert!(!valid_pane_id(bad), "{bad}");
        }
    }

    #[test]
    fn script_runs_without_tmux_server() {
        // Must exist and be empty: when TMUX_TMPDIR names a path that can't be
        // used at all, tmux silently falls back to the default socket instead
        // of erroring, which would find a real session under it (any is a
        // false pass here) rather than exercising the "no server" branch.
        let dir =
            std::env::temp_dir().join(format!("burrow-no-tmux-server-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = std::process::Command::new("sh")
            .args(["-c", SCRIPT])
            .env("TMUX_TMPDIR", &dir)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(parse(&text), TmuxPanes::None, "{text}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
