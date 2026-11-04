//! Command usage counts per host and per directory (stats.json), and the
//! "frequently used" lists built from them.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::store::{ConfigFile, RecentCommand, SavedCommand, SavedCommandsFile, StatsFile, Store};

/// Distinct commands remembered per host for the "recent" list.
const RECENT_KEEP: usize = 60;

/// Commands the user deliberately kept out of history (leading space, as with
/// zsh HIST_IGNORE_SPACE) or that carry nothing to rank are not recorded.
pub fn normalize(raw: &str) -> Option<String> {
    if raw.starts_with(' ') {
        return None;
    }
    let cmd = raw.trim();
    (!cmd.is_empty()).then(|| cmd.to_string())
}

/// Recorded like any command, but too trivial to be worth a slot in the
/// frequently-used lists. `cd` only counts as trivial on its own: `cd app &&
/// ./start.sh` is the real command with a prefix.
fn is_noise(cmd: &str) -> bool {
    if cmd.contains("&&") || cmd.contains(';') || cmd.contains('|') {
        return false;
    }
    matches!(
        cmd,
        "ls" | "ll" | "la" | "clear" | "exit" | "pwd" | "cd -" | "cd .."
    ) || cmd == "cd"
        || cmd.starts_with("cd ")
}

/// Fewest uses before a launcher-type command is promoted, whatever the
/// configured threshold: these are typed rarely but are exactly what is
/// wanted again (and they differ by one argument, so counts split).
const LAUNCHER_THRESHOLD: u64 = 2;

/// Commands that start something long-lived: tmux, shell scripts (services,
/// start-up scripts), and AI coding agents. Looks at each part of a `a && b`
/// line, past `sudo`/`nohup`/`VAR=x` prefixes.
fn is_launcher(cmd: &str) -> bool {
    cmd.split(['&', ';', '|']).any(|part| {
        let mut words = part
            .split_whitespace()
            .skip_while(|w| w.contains('=') && !w.starts_with(['.', '/', '-']))
            .skip_while(|w| matches!(*w, "sudo" | "nohup" | "exec" | "time" | "env" | "command"));
        let Some(first) = words.next() else {
            return false;
        };
        let name = first.rsplit('/').next().unwrap_or(first);
        let is_script = |w: &str| w.trim_matches(['"', '\'']).ends_with(".sh");
        match name {
            "tmux" | "screen" | "claude" | "codex" | "gemini" => true,
            "bash" | "sh" | "zsh" | "source" | "." => words.any(is_script),
            _ => is_script(first),
        }
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn record(stats: &mut StatsFile, host: &str, cwd: &str, cmd: &str) {
    record_at(stats, host, cwd, cmd, now_ms());
}

pub fn record_at(stats: &mut StatsFile, host: &str, cwd: &str, cmd: &str, at: u64) {
    let host = stats.hosts.entry(host.to_string()).or_default();
    host.recent.retain(|r| r.command != cmd);
    host.recent.insert(
        0,
        RecentCommand {
            command: cmd.to_string(),
            cwd: cwd.to_string(),
            at,
        },
    );
    host.recent.truncate(RECENT_KEEP);
    *host.global.entry(cmd.to_string()).or_default() += 1;
    *host
        .by_dir
        .entry(cwd.to_string())
        .or_default()
        .entry(cmd.to_string())
        .or_default() += 1;
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// This host, this directory.
    Dir,
    /// This host, any directory.
    Host,
    /// Every host.
    All,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Ranked {
    pub command: String,
    pub count: u64,
}

pub fn top(
    stats: &StatsFile,
    host: &str,
    cwd: &str,
    scope: Scope,
    threshold: u64,
    limit: usize,
) -> Vec<Ranked> {
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut add = |map: &HashMap<String, u64>| {
        for (cmd, n) in map {
            *counts.entry(cmd.clone()).or_default() += n;
        }
    };
    match scope {
        Scope::Dir => {
            if let Some(dir) = stats.hosts.get(host).and_then(|h| h.by_dir.get(cwd)) {
                add(dir);
            }
        }
        Scope::Host => {
            if let Some(h) = stats.hosts.get(host) {
                add(&h.global);
            }
        }
        Scope::All => stats.hosts.values().for_each(|h| add(&h.global)),
    }
    let mut ranked: Vec<Ranked> = counts
        .into_iter()
        .filter(|(cmd, n)| {
            let needed = if is_launcher(cmd) {
                threshold.min(LAUNCHER_THRESHOLD)
            } else {
                threshold
            };
            *n >= needed && !is_noise(cmd)
        })
        .map(|(command, count)| Ranked { command, count })
        .collect();
    // Ties are broken alphabetically so the list order is stable between refreshes.
    ranked.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.command.cmp(&b.command))
    });
    ranked.truncate(limit);
    ranked
}

/// The last distinct commands run in `scope`, newest first, skipping the
/// trivial ones and anything in `skip` (already shown elsewhere).
pub fn recent(
    stats: &StatsFile,
    host: &str,
    cwd: &str,
    scope: Scope,
    skip: &dyn Fn(&str) -> bool,
    limit: usize,
) -> Vec<RecentCommand> {
    let mut all: Vec<&RecentCommand> = match scope {
        Scope::Dir => stats
            .hosts
            .get(host)
            .map(|h| h.recent.iter().filter(|r| r.cwd == cwd).collect())
            .unwrap_or_default(),
        Scope::Host => stats
            .hosts
            .get(host)
            .map(|h| h.recent.iter().collect())
            .unwrap_or_default(),
        Scope::All => stats.hosts.values().flat_map(|h| h.recent.iter()).collect(),
    };
    all.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.command.cmp(&b.command)));
    let mut seen = std::collections::HashSet::new();
    all.into_iter()
        .filter(|r| !is_noise(&r.command) && !skip(&r.command) && seen.insert(r.command.clone()))
        .take(limit)
        .cloned()
        .collect()
}

/// Pinned commands that apply on `host`: its own plus the ones for every host.
pub fn saved_for(file: &SavedCommandsFile, host: &str) -> Vec<SavedCommand> {
    file.commands
        .iter()
        .filter(|c| c.host.as_deref().is_none_or(|h| h == host))
        .cloned()
        .collect()
}

#[tauri::command]
pub fn stats_record(store: tauri::State<'_, Arc<Store>>, host: String, cwd: String, cmd: String) {
    if let Some(cmd) = normalize(&cmd) {
        store.update_stats(|stats| record(stats, &host, &cwd, &cmd));
    }
}

#[tauri::command]
pub fn stats_top(
    store: tauri::State<'_, Arc<Store>>,
    host: String,
    cwd: String,
    scope: Scope,
    limit: usize,
) -> Vec<Ranked> {
    let threshold = u64::from(store.load::<ConfigFile>().promotion_threshold);
    top(&store.stats(), &host, &cwd, scope, threshold, limit)
}

#[tauri::command]
pub fn stats_recent(
    store: tauri::State<'_, Arc<Store>>,
    host: String,
    cwd: String,
    scope: Scope,
    exclude: Vec<String>,
    limit: usize,
) -> Vec<RecentCommand> {
    recent(
        &store.stats(),
        &host,
        &cwd,
        scope,
        &|c| exclude.iter().any(|e| e == c),
        limit,
    )
}

#[tauri::command]
pub fn saved_list(store: tauri::State<'_, Arc<Store>>, host: String) -> Vec<SavedCommand> {
    saved_for(&store.load::<SavedCommandsFile>(), &host)
}

/// Pins `command`. `host` None = on every host. Pinning the same command twice
/// for the same scope returns the existing entry.
#[tauri::command]
pub fn saved_add(
    store: tauri::State<'_, Arc<Store>>,
    command: String,
    host: Option<String>,
) -> Result<SavedCommand, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("empty command".into());
    }
    let mut file = store.load::<SavedCommandsFile>();
    if let Some(existing) = file
        .commands
        .iter()
        .find(|c| c.command == command && c.host == host)
    {
        return Ok(existing.clone());
    }
    let entry = SavedCommand {
        id: format!("{:x}-{}", now_ms(), file.commands.len()),
        command,
        host,
    };
    file.commands.push(entry.clone());
    store.save(&file).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub fn saved_remove(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    let mut file = store.load::<SavedCommandsFile>();
    file.commands.retain(|c| c.id != id);
    store.save(&file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> StatsFile {
        let mut s = StatsFile::default();
        let run = |s: &mut StatsFile, host: &str, cwd: &str, cmd: &str, times: u32| {
            for _ in 0..times {
                record(s, host, cwd, cmd);
            }
        };
        run(&mut s, "local", "/p/burrow", "npm test", 6);
        run(&mut s, "local", "/p/burrow", "git status", 5);
        run(&mut s, "local", "/p/other", "git status", 4);
        run(&mut s, "local", "/p/other", "make", 2);
        run(&mut s, "prod", "/var/www", "docker ps", 7);
        run(&mut s, "prod", "/var/www", "git status", 1);
        s
    }

    #[test]
    fn normalize_skips_blank_and_space_prefixed_commands() {
        assert_eq!(normalize("git status\n").as_deref(), Some("git status"));
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize(""), None);
        assert_eq!(normalize(" export TOKEN=abc"), None);
    }

    #[test]
    fn record_counts_per_host_globally_and_per_directory() {
        let s = sample();
        let local = &s.hosts["local"];
        assert_eq!(local.global["git status"], 9);
        assert_eq!(local.by_dir["/p/burrow"]["git status"], 5);
        assert_eq!(local.by_dir["/p/other"]["git status"], 4);
        assert_eq!(s.hosts["prod"].global["docker ps"], 7);
    }

    #[test]
    fn top_respects_scope_threshold_order_and_limit() {
        let s = sample();
        let names = |v: Vec<Ranked>| v.into_iter().map(|r| r.command).collect::<Vec<_>>();

        assert_eq!(
            names(top(&s, "local", "/p/burrow", Scope::Dir, 5, 10)),
            ["npm test", "git status"]
        );
        // /p/other has git status only 4 times: below the threshold of 5.
        assert!(top(&s, "local", "/p/other", Scope::Dir, 5, 10).is_empty());
        assert_eq!(
            top(&s, "local", "/p/other", Scope::Host, 5, 10),
            [
                Ranked {
                    command: "git status".into(),
                    count: 9
                },
                Ranked {
                    command: "npm test".into(),
                    count: 6
                },
            ]
        );
        assert_eq!(
            names(top(&s, "local", "/", Scope::All, 5, 10)),
            ["git status", "docker ps", "npm test"]
        );
        assert_eq!(
            names(top(&s, "local", "/", Scope::All, 5, 1)),
            ["git status"]
        );
        assert!(top(&s, "unknown", "/", Scope::Host, 1, 10).is_empty());
    }

    #[test]
    fn navigation_and_cleanup_commands_are_not_ranked() {
        let mut s = StatsFile::default();
        for cmd in [
            "cd /tmp",
            "cd",
            "ls",
            "clear",
            "exit",
            "pwd",
            "lsof -i :3000",
        ] {
            for _ in 0..5 {
                record(&mut s, "local", "/", cmd);
            }
        }
        let ranked: Vec<_> = top(&s, "local", "/", Scope::Host, 1, 10)
            .into_iter()
            .map(|r| r.command)
            .collect();
        assert_eq!(ranked, ["lsof -i :3000"]);
        assert_eq!(s.hosts["local"].global["cd /tmp"], 5, "still recorded");
    }

    #[test]
    fn ties_are_ordered_alphabetically() {
        let mut s = StatsFile::default();
        for cmd in ["zed", "ab", "mid"] {
            record(&mut s, "local", "/", cmd);
        }
        let order: Vec<_> = top(&s, "local", "/", Scope::Host, 1, 10)
            .into_iter()
            .map(|r| r.command)
            .collect();
        assert_eq!(order, ["ab", "mid", "zed"]);
    }

    #[test]
    fn recent_lists_distinct_commands_newest_first() {
        let mut s = StatsFile::default();
        record_at(&mut s, "local", "/a", "make", 1);
        record_at(&mut s, "local", "/b", "git pull", 2);
        record_at(&mut s, "local", "/a", "make", 3);
        record_at(&mut s, "local", "/a", "cd /tmp", 4);
        let names = |v: Vec<RecentCommand>| v.into_iter().map(|r| r.command).collect::<Vec<_>>();
        let none = |_: &str| false;

        assert_eq!(
            names(recent(&s, "local", "/a", Scope::Host, &none, 10)),
            ["make", "git pull"],
            "re-running moves a command to the front without duplicating it"
        );
        assert_eq!(
            names(recent(&s, "local", "/b", Scope::Dir, &none, 10)),
            ["git pull"]
        );
        assert_eq!(
            names(recent(&s, "local", "/a", Scope::Host, &|c| c == "make", 10)),
            ["git pull"]
        );
        assert_eq!(
            names(recent(&s, "local", "/a", Scope::Host, &none, 1)),
            ["make"]
        );
    }

    #[test]
    fn recent_is_capped_per_host() {
        let mut s = StatsFile::default();
        for i in 0..(RECENT_KEEP + 20) {
            record_at(&mut s, "local", "/", &format!("cmd {i}"), i as u64);
        }
        assert_eq!(s.hosts["local"].recent.len(), RECENT_KEEP);
        assert_eq!(
            s.hosts["local"].recent[0].command,
            format!("cmd {}", RECENT_KEEP + 19)
        );
    }

    #[test]
    fn saved_commands_apply_to_their_host_and_to_all_hosts() {
        let file = SavedCommandsFile {
            commands: vec![
                SavedCommand {
                    id: "1".into(),
                    command: "htop".into(),
                    host: None,
                },
                SavedCommand {
                    id: "2".into(),
                    command: "docker ps".into(),
                    host: Some("prod".into()),
                },
                SavedCommand {
                    id: "3".into(),
                    command: "make".into(),
                    host: Some("local".into()),
                },
            ],
            ..Default::default()
        };
        let cmds = |h: &str| {
            saved_for(&file, h)
                .into_iter()
                .map(|c| c.command)
                .collect::<Vec<_>>()
        };
        assert_eq!(cmds("prod"), ["htop", "docker ps"]);
        assert_eq!(cmds("local"), ["htop", "make"]);
        assert_eq!(cmds("other"), ["htop"]);
    }

    #[test]
    fn launchers_are_recognised_through_prefixes_and_chains() {
        for cmd in [
            "tmux attach -t imacfx",
            "tmux new -A -s orch-ngals",
            "claude --dangerously-skip-permissions",
            "codex",
            "./start.sh",
            "~/svc/run-server.sh --port 80",
            "bash scripts/deploy.sh prod",
            "sudo ./restart.sh",
            "nohup ./serve.sh &",
            "source env.sh",
            "NODE_ENV=prod ./start.sh",
            "cd ~/app && tmux new -A -s app",
            "cd ngals && claude",
            "/usr/bin/tmux ls",
        ] {
            assert!(is_launcher(cmd), "{cmd}");
        }
        for cmd in [
            "git status",
            "npm test",
            "ls -la",
            "cat notes.sh.txt",
            "echo tmux",
        ] {
            assert!(!is_launcher(cmd), "{cmd}");
        }
    }

    #[test]
    fn launchers_are_promoted_sooner_and_cd_prefixed_lines_are_kept() {
        let mut s = StatsFile::default();
        for cmd in [
            "tmux attach -t work",
            "cd ~/svc && ./start.sh",
            "git status",
        ] {
            for _ in 0..2 {
                record(&mut s, "local", "/", cmd);
            }
        }
        let names: Vec<_> = top(&s, "local", "/", Scope::Host, 5, 10)
            .into_iter()
            .map(|r| r.command)
            .collect();
        assert_eq!(names, ["cd ~/svc && ./start.sh", "tmux attach -t work"]);
        // A threshold below the launcher floor is respected.
        assert_eq!(top(&s, "local", "/", Scope::Host, 1, 10).len(), 3);
    }
}
