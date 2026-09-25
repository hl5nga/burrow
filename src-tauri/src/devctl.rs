//! Debug-build-only control socket so the running app can be driven by
//! scripts/devctl during development (macOS blocks synthetic keystrokes).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::thread;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, LogicalSize, Manager};

use crate::pty::PtyState;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Request {
    Sessions,
    Write {
        id: u32,
        data: String,
    },
    WindowSize {
        width: f64,
        height: f64,
    },
    /// Runs JavaScript in the main webview (fire-and-forget) to drive DOM UI.
    Eval {
        js: String,
    },
    Quit,
}

pub fn log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("burrow-dev-events.log")
}

/// Frontend diagnostics (e.g. raw IME event sequences) appended to [`log_path`].
#[tauri::command]
pub fn dev_log(line: String) {
    use std::fs::OpenOptions;
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "{line}");
    }
}

pub fn socket_path() -> std::path::PathBuf {
    std::env::temp_dir().join("burrow-dev.sock")
}

pub fn start(app: AppHandle) {
    let path = socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("devctl: cannot bind {}: {e}", path.display());
            return;
        }
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || serve(app, stream));
        }
    });
}

fn serve(app: AppHandle, stream: UnixStream) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => handle(&app, req),
            Err(e) => json!({ "error": e.to_string() }),
        };
        if writeln!(writer, "{reply}").is_err() {
            break;
        }
    }
}

fn handle(app: &AppHandle, req: Request) -> Value {
    let pty = app.state::<PtyState>();
    let result = match req {
        Request::Sessions => return json!({ "ok": pty.ids() }),
        Request::Write { id, data } => pty.write(id, data.as_bytes()),
        Request::Eval { js } => app
            .get_webview_window("main")
            .ok_or_else(|| "no main window".to_string())
            .and_then(|w| w.eval(&js).map_err(|e| e.to_string())),
        Request::Quit => {
            app.exit(0);
            Ok(())
        }
        Request::WindowSize { width, height } => app
            .get_webview_window("main")
            .ok_or_else(|| "no main window".to_string())
            .and_then(|w| {
                w.set_size(LogicalSize::new(width, height))
                    .map_err(|e| e.to_string())
            }),
    };
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "error": e }),
    }
}
