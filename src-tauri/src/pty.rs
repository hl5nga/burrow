use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

const READ_BUF: usize = 16 * 1024;
const MAX_BATCH: usize = 256 * 1024;
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

/// Opt-in diagnostics (`open --env BURROW_TRACE_INPUT=1 Burrow.app`): appends
/// every byte sent to a terminal process, escaped, to
/// `$TMPDIR/burrow-input-trace.log` — for finding out where a stray key comes from.
pub(crate) fn trace_input(id: u32, data: &[u8]) {
    use std::io::Write as _;
    if std::env::var_os("BURROW_TRACE_INPUT").is_none() {
        return;
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let text: String = data
        .iter()
        .flat_map(|b| std::ascii::escape_default(*b))
        .map(char::from)
        .collect();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("burrow-input-trace.log"))
    {
        let _ = writeln!(f, "{ms} session={id} {text}");
    }
}

impl PtyState {
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("unknown session")?;
        trace_input(id, data);
        session.writer.write_all(data).map_err(|e| e.to_string())
    }

    /// Like `write`, but for a secret (a password): it is never part of the
    /// opt-in input trace.
    pub fn write_secret(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("unknown session")?;
        session.writer.write_all(data).map_err(|e| e.to_string())
    }

    #[cfg(debug_assertions)]
    pub fn ids(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.killer.kill();
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into())
}

static HOOK_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Directory holding the zsh wrappers from `hooks::install`.
pub fn set_hook_dir(dir: PathBuf) {
    let _ = HOOK_DIR.set(dir);
}

fn build_command() -> CommandBuilder {
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.env_remove("BURROW_USER_ZDOTDIR");
    if let Some(dir) = HOOK_DIR.get().filter(|_| shell.ends_with("zsh")) {
        if let Some(user) = std::env::var_os("ZDOTDIR") {
            cmd.env("BURROW_USER_ZDOTDIR", user);
        }
        cmd.env("ZDOTDIR", dir);
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    base_env(&mut cmd);
    cmd
}

// Mirrors Terminal.app: follow the macOS region setting when a UTF-8 variant exists.
fn system_utf8_locale() -> &'static str {
    static LOCALE: OnceLock<String> = OnceLock::new();
    LOCALE.get_or_init(|| {
        std::process::Command::new("defaults")
            .args(["read", "-g", "AppleLocale"])
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|raw| raw.trim().split('@').next().map(|s| format!("{s}.UTF-8")))
            .filter(|name| {
                std::path::Path::new("/usr/share/locale")
                    .join(name)
                    .exists()
            })
            .unwrap_or_else(|| "en_US.UTF-8".into())
    })
}

// Small reads (keystroke echo) go out immediately; a full read buffer means bulk
// output is streaming, so wait briefly to coalesce it into fewer IPC messages.
fn forward_output(rx: mpsc::Receiver<Vec<u8>>, on_output: &Channel<InvokeResponseBody>) {
    while let Ok(mut batch) = rx.recv() {
        if batch.len() >= READ_BUF {
            let deadline = Instant::now() + COALESCE_WINDOW;
            while batch.len() < MAX_BATCH {
                let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match rx.recv_timeout(wait) {
                    Ok(chunk) => batch.extend_from_slice(&chunk),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        }
        while let Ok(chunk) = rx.try_recv() {
            batch.extend_from_slice(&chunk);
            if batch.len() >= MAX_BATCH {
                break;
            }
        }
        if on_output.send(InvokeResponseBody::Raw(batch)).is_err() {
            break;
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    spawn(app, &state, build_command(), cols, rows, on_output, None)
}

/// Environment every session gets, local shell or ssh client alike.
pub fn base_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Burrow");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Apps launched from Finder get no LANG, which breaks CJK input in zsh.
    if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
        cmd.env("LANG", system_utf8_locale());
    }
}

/// How long after starting an ssh session its login password prompt is still
/// answered or asked for; later "password:" lines belong to the remote shell
/// (sudo and the like) and are never touched.
const PASSWORD_WINDOW: Duration = Duration::from_secs(90);

/// What the watch wants done with a login password prompt.
enum PromptAction {
    /// A saved password: type it, once.
    Answer(String),
    /// None saved: ask the user (the webview shows a dialog).
    Ask,
    /// The prompt came back after an answer: the password was wrong.
    Rejected { used_saved: bool },
}

/// Watches the start of an ssh/mosh session for its login password prompt.
pub struct PasswordWatch {
    profile_id: String,
    saved: Option<String>,
    used_saved: bool,
    prompts: u32,
    started: Instant,
    tail: String,
}

impl PasswordWatch {
    pub fn new(profile_id: String, saved: Option<String>) -> Self {
        Self {
            profile_id,
            saved,
            used_saved: false,
            prompts: 0,
            started: Instant::now(),
            tail: String::new(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Option<PromptAction> {
        if self.started.elapsed() > PASSWORD_WINDOW {
            return None;
        }
        self.tail.push_str(&String::from_utf8_lossy(bytes));
        if self.tail.len() > 400 {
            let cut = self.tail.len() - 300;
            let cut = (cut..self.tail.len())
                .find(|&i| self.tail.is_char_boundary(i))
                .unwrap_or(self.tail.len());
            self.tail.drain(..cut);
        }
        if !looks_like_password_prompt(&self.tail) {
            return None;
        }
        self.tail.clear();
        self.prompts += 1;
        match self.prompts {
            1 => match self.saved.take() {
                Some(password) => {
                    self.used_saved = true;
                    Some(PromptAction::Answer(password))
                }
                None => Some(PromptAction::Ask),
            },
            2 => Some(PromptAction::Rejected {
                used_saved: self.used_saved,
            }),
            _ => None,
        }
    }
}

/// ssh's login prompt: `user@host's password: ` (or `Password:` from
/// keyboard-interactive). Not a key's "Enter passphrase for …", and not
/// sudo's "[sudo] password for user:".
pub(crate) fn looks_like_password_prompt(tail: &str) -> bool {
    let last = tail.rsplit(['\n', '\r']).next().unwrap_or(tail).trim_end();
    last.len() < 160 && last.to_ascii_lowercase().ends_with("password:")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasswordEvent {
    id: u32,
    profile_id: String,
    used_saved: bool,
}

pub fn spawn(
    app: AppHandle,
    state: &PtyState,
    command: CommandBuilder,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    watch: Option<PasswordWatch>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    // The reader only sees EOF once every handle to the slave side is closed.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reader_app = app.clone();
    let mut watch = watch;
    thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(w) = watch.as_mut() {
                        if let Some(action) = w.feed(&buf[..n]) {
                            handle_prompt(&reader_app, id, w, action);
                        }
                    }
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    thread::spawn(move || {
        forward_output(rx, &on_output);
        let code = child.wait().ok().map(|status| status.exit_code());
        app.state::<PtyState>().sessions.lock().unwrap().remove(&id);
        let _ = app.emit("pty-exit", PtyExit { id, code });
    });

    Ok(id)
}

fn handle_prompt(app: &AppHandle, id: u32, watch: &PasswordWatch, action: PromptAction) {
    let event = |used_saved| PasswordEvent {
        id,
        profile_id: watch.profile_id.clone(),
        used_saved,
    };
    match action {
        PromptAction::Answer(password) => {
            let _ = app
                .state::<PtyState>()
                .write_secret(id, format!("{password}\r").as_bytes());
        }
        PromptAction::Ask => {
            let _ = app.emit("ssh-password-prompt", event(false));
        }
        PromptAction::Rejected { used_saved } => {
            // A saved password that no longer works is dropped, so a reconnect
            // loop can't keep retrying it against the account.
            if used_saved {
                crate::secret::delete(&watch.profile_id);
            }
            let _ = app.emit("ssh-password-rejected", event(used_saved));
        }
    }
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    state.write(id, data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("unknown session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[test]
    fn recognises_ssh_login_prompts_only() {
        assert!(looks_like_password_prompt("felix@home's password: "));
        assert!(looks_like_password_prompt("Last login...\r\nPassword: "));
        assert!(looks_like_password_prompt("(felix@home) Password:"));
        // Not login passwords.
        assert!(!looks_like_password_prompt(
            "Enter passphrase for key '/Users/x/.ssh/id': "
        ));
        assert!(!looks_like_password_prompt("[sudo] password for felix: "));
        assert!(!looks_like_password_prompt("Verification code: "));
        assert!(!looks_like_password_prompt(
            "the password: is in the doc\r\n$ "
        ));
    }

    #[test]
    fn answers_once_asks_when_nothing_saved_and_reports_a_second_prompt() {
        let mut saved = PasswordWatch::new("p".into(), Some("hunter2".into()));
        assert!(saved.feed(b"banner\r\nfelix@h's pass").is_none());
        match saved.feed(b"word: ") {
            Some(PromptAction::Answer(p)) => assert_eq!(p, "hunter2"),
            _ => panic!("expected the saved password to be sent"),
        }
        // Wrong password: ssh asks again → rejected, and it says it was the saved one.
        match saved.feed(b"\r\nPermission denied, please try again.\r\nfelix@h's password: ") {
            Some(PromptAction::Rejected { used_saved }) => assert!(used_saved),
            _ => panic!("expected a rejection"),
        }
        // A third prompt is left to the user at the terminal.
        assert!(saved.feed(b"\r\nfelix@h's password: ").is_none());

        let mut none = PasswordWatch::new("p".into(), None);
        assert!(matches!(
            none.feed(b"felix@h's password: "),
            Some(PromptAction::Ask)
        ));
        assert!(matches!(
            none.feed(b"\r\nfelix@h's password: "),
            Some(PromptAction::Rejected { used_saved: false })
        ));
    }

    #[test]
    fn ordinary_output_is_ignored_and_the_window_closes() {
        let mut w = PasswordWatch::new("p".into(), Some("x".into()));
        assert!(w.feed("한글 출력 only\r\n$ ls".as_bytes()).is_none());
        w.started = Instant::now() - PASSWORD_WINDOW - Duration::from_secs(1);
        assert!(w.feed(b"felix@h's password: ").is_none());
    }
}
