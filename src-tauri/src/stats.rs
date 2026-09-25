//! Command usage counts per host and per directory (stats.json), and the
//! "frequently used" lists built from them.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::store::{ConfigFile, StatsFile, Store};

/// Commands the user deliberately kept out of history (leading space, as with
/// zsh HIST_IGNORE_SPACE) or that carry nothing to rank are not recorded.
pub fn normalize(raw: &str) -> Option<String> {
    if raw.starts_with(' ') {
        return None;
    }
    let cmd = raw.trim();
    (!cmd.is_empty()).then(|| cmd.to_string())
}

pub fn record(stats: &mut StatsFile, host: &str, cwd: &str, cmd: &str) {
    let host = stats.hosts.entry(host.to_string()).or_default();
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
        .filter(|(_, n)| *n >= threshold)
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
}
