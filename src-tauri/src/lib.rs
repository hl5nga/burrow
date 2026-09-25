#[cfg(debug_assertions)]
mod devctl;
mod pty;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .setup(|_app| {
            #[cfg(debug_assertions)]
            devctl::start(_app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
                #[cfg(debug_assertions)]
                let _ = std::fs::remove_file(devctl::socket_path());
            }
        });
}
