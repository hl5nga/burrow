//! JSON files under `~/.burrow` (override with `BURROW_HOME`).
//!
//! Writes are atomic (temp file → fsync → rename) so a crash never leaves a
//! half-written file. A file that no longer parses is moved to `<file>.bak`
//! and recreated from defaults; the frontend is told via `store_take_recoveries`.
//! Stats change on every command, so they live in memory and are flushed at most
//! every [`STATS_FLUSH_INTERVAL`].

mod model;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub use model::*;
use serde::Serialize;
use serde_json::Value;

pub const STATS_FLUSH_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Recovery {
    pub file: String,
    pub backup: String,
    pub error: String,
}

pub struct Store {
    root: PathBuf,
    stats: Mutex<StatsFile>,
    stats_dirty: AtomicBool,
    recoveries: Mutex<Vec<Recovery>>,
    tmp_counter: AtomicU64,
}

pub fn default_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("BURROW_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").unwrap_or_else(|| ".".into());
    Path::new(&home).join(".burrow")
}

impl Store {
    pub fn open(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        // Stats hold command history, so keep the directory private.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let store = Self {
            root,
            stats: Mutex::new(StatsFile::default()),
            stats_dirty: AtomicBool::new(false),
            recoveries: Mutex::new(Vec::new()),
            tmp_counter: AtomicU64::new(0),
        };
        store.remove_stale_temp_files();
        *store.stats.lock().unwrap() = store.load::<StatsFile>();
        // Touch every file once so missing ones get their presets and damaged ones
        // are reported at launch rather than whenever a feature first reads them.
        store.load::<CommandsFile>();
        store.load::<ConfigFile>();
        store.load::<AgentPatternsFile>();
        store.load::<GuardrailsFile>();
        store.load::<SecretsPatternsFile>();
        store.load::<KeybindingsFile>();
        Ok(store)
    }

    /// Temp files are only left behind when a write was killed mid-way.
    fn remove_stale_temp_files(&self) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') && name.ends_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// Reads a file, creating it from defaults when missing or unreadable.
    pub fn load<T: StoreFile>(&self) -> T {
        let path = self.path(T::FILE_NAME);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let value = T::default();
                if let Err(e) = self.save(&value) {
                    eprintln!("store: cannot create {}: {e}", path.display());
                }
                return value;
            }
            Err(e) => return self.recover(T::FILE_NAME, e.to_string()),
        };
        match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(e) => self.recover(T::FILE_NAME, e.to_string()),
        }
    }

    fn recover<T: StoreFile>(&self, name: &str, error: String) -> T {
        let path = self.path(name);
        let backup = self.path(&format!("{name}.bak"));
        let _ = fs::rename(&path, &backup);
        let value = T::default();
        if let Err(e) = self.save(&value) {
            eprintln!("store: cannot recreate {}: {e}", path.display());
        }
        self.recoveries.lock().unwrap().push(Recovery {
            file: path.display().to_string(),
            backup: backup.display().to_string(),
            error,
        });
        value
    }

    pub fn save<T: StoreFile>(&self, value: &T) -> std::io::Result<()> {
        let mut json = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
        json.push(b'\n');
        self.write_atomic(T::FILE_NAME, &json)
    }

    fn write_atomic(&self, name: &str, bytes: &[u8]) -> std::io::Result<()> {
        let n = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
        let tmp = self.path(&format!(".{name}.{}.{n}.tmp", std::process::id()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, self.path(name))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    pub fn update_stats(&self, f: impl FnOnce(&mut StatsFile)) {
        f(&mut self.stats.lock().unwrap());
        self.stats_dirty.store(true, Ordering::Release);
    }

    pub fn stats(&self) -> StatsFile {
        self.stats.lock().unwrap().clone()
    }

    pub fn flush_stats(&self) -> std::io::Result<()> {
        if !self.stats_dirty.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let snapshot = self.stats();
        self.save(&snapshot).inspect_err(|_| {
            self.stats_dirty.store(true, Ordering::Release);
        })
    }

    pub fn start_stats_flusher(self: &Arc<Self>) {
        let store = Arc::clone(self);
        thread::spawn(move || loop {
            thread::sleep(STATS_FLUSH_INTERVAL);
            if let Err(e) = store.flush_stats() {
                eprintln!("store: cannot write stats: {e}");
            }
        });
    }

    pub fn take_recoveries(&self) -> Vec<Recovery> {
        std::mem::take(&mut self.recoveries.lock().unwrap())
    }

    pub fn get_json(&self, kind: &str) -> Result<Value, String> {
        let value = match kind {
            "commands" => serde_json::to_value(self.load::<CommandsFile>()),
            "stats" => serde_json::to_value(self.stats()),
            "config" => serde_json::to_value(self.load::<ConfigFile>()),
            "agent-patterns" => {
                let mut file = self.load::<AgentPatternsFile>();
                // Files written before the presets existed (T14) have none.
                if file.tools.is_empty() {
                    file.tools = model::agent_presets();
                }
                // Newer built-in phrases (the AI CLIs' wording drifts) reach
                // existing files once; without this an old file never detects
                // a screen the presets have learned to read.
                if file.absorb_presets() {
                    if let Err(e) = self.save(&file) {
                        eprintln!("store: cannot update agent-patterns.json: {e}");
                    }
                }
                serde_json::to_value(file)
            }
            "guardrails" => serde_json::to_value(self.load::<GuardrailsFile>()),
            "secrets-patterns" => serde_json::to_value(self.load::<SecretsPatternsFile>()),
            "keybindings" => serde_json::to_value(self.load::<KeybindingsFile>()),
            "tasks" => serde_json::to_value(self.load::<TasksFile>()),
            _ => return Err(format!("unknown store file: {kind}")),
        };
        value.map_err(|e| e.to_string())
    }

    pub fn put_json(&self, kind: &str, value: Value) -> Result<(), String> {
        fn put<T: StoreFile>(store: &Store, value: Value) -> Result<(), String> {
            let parsed: T = serde_json::from_value(value).map_err(|e| e.to_string())?;
            store.save(&parsed).map_err(|e| e.to_string())
        }
        match kind {
            "commands" => put::<CommandsFile>(self, value),
            "stats" => {
                let parsed: StatsFile = serde_json::from_value(value).map_err(|e| e.to_string())?;
                *self.stats.lock().unwrap() = parsed;
                self.stats_dirty.store(true, Ordering::Release);
                self.flush_stats().map_err(|e| e.to_string())
            }
            "config" => put::<ConfigFile>(self, value),
            "agent-patterns" => put::<AgentPatternsFile>(self, value),
            "guardrails" => put::<GuardrailsFile>(self, value),
            "secrets-patterns" => put::<SecretsPatternsFile>(self, value),
            "keybindings" => put::<KeybindingsFile>(self, value),
            "tasks" => put::<TasksFile>(self, value),
            _ => Err(format!("unknown store file: {kind}")),
        }
    }
}

#[tauri::command]
pub fn store_get(store: tauri::State<'_, Arc<Store>>, kind: String) -> Result<Value, String> {
    store.get_json(&kind)
}

#[tauri::command]
pub fn store_put(
    store: tauri::State<'_, Arc<Store>>,
    kind: String,
    value: Value,
) -> Result<(), String> {
    store.put_json(&kind, value)?;
    // Open shells pick the new rules up at their next prompt.
    if kind == "guardrails" {
        crate::guardrails::write_local(&store).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every action's built-in binding; files from older builds lack newer actions.
#[tauri::command]
pub fn keybinding_defaults() -> Vec<Keybinding> {
    KeybindingsFile::default().bindings
}

#[tauri::command]
pub fn store_take_recoveries(store: tauri::State<'_, Arc<Store>>) -> Vec<Recovery> {
    store.take_recoveries()
}

#[cfg(test)]
mod tests;
