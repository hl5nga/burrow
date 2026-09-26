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
            let Some((command, session)) = tail.split_once("::burrow::") else {
                continue;
            };
            panes.push(Pane {
                id: id.into(),
                session: session.into(),
                window: window.parse().unwrap_or(0),
                index: index.parse().unwrap_or(0),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_panes_and_their_screens() {
        let out = "Welcome\nburrow:pane %0 0 0 1 1 claude::burrow::my work\nburrow:pane %3 1 0 1 0 zsh::burrow::my work\n\
                   burrow:capture %0\n|> fix it\n|  ? for shortcuts\n|\n|\nburrow:capture %3\n|$ ls\n";
        let TmuxPanes::Panes { panes } = parse(out) else {
            panic!("no panes")
        };
        assert_eq!(panes.len(), 2);
        assert_eq!(panes[0].command, "claude");
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
