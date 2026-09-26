//! Hook events for Mosh tabs. Mosh's terminal emulator drops unknown OSC
//! sequences, so the hooks also append each event to a per-tab log on the host
//! (`BURROW_EVENT_LOG`), and this module tails it over the SSH side channel.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;

use crate::remote;
use crate::store::Store;

struct Stream {
    child: Child,
    /// Held open: the remote side ends its tail when this closes (see script).
    _stdin: Option<std::process::ChildStdin>,
    profile_id: String,
    session: String,
}

#[derive(Default)]
pub struct EventStreams {
    next: AtomicU32,
    streams: Mutex<HashMap<u32, Stream>>,
}

/// Sent when the tail's ssh exits; hook payloads always contain ';'.
pub const STREAM_ENDED: &str = "burrow:stream-ended";

/// Log files older than a day belong to tabs that went away without cleaning up.
const PRUNE_MINUTES: u32 = 24 * 60;

/// Starts tailing a tab's event log; each line ("<event>;<base64>", the same
/// payload as the OSC event) goes to `on_event`.
#[tauri::command(async)]
pub fn remote_event_stream(
    store: tauri::State<'_, Arc<Store>>,
    streams: tauri::State<'_, EventStreams>,
    profile_id: String,
    session: String,
    on_event: Channel<String>,
) -> Result<u32, String> {
    if !remote::valid_session_id(&session) {
        return Err(format!("잘못된 세션 id: {session}"));
    }
    let profile = remote::load_profile(&store, &profile_id)?;
    let log = remote::event_log_path(&session);
    // The hooks only append to an existing file, so creating it switches them
    // on; `tail -F` keeps following across the truncation.
    let script = format!(
        "d=\"$HOME/.burrow/events\"; mkdir -p \"$d\" && chmod 700 \"$d\"; \
         find \"$d\" -name '*.log' -mmin +{PRUNE_MINUTES} -delete 2>/dev/null; \
         : > \"{log}\"; tail -n 0 -F \"{log}\" 2>/dev/null & t=$!; \
         cat >/dev/null; kill $t 2>/dev/null"
    );
    let mut child = remote::side_ssh(&store, &profile)?
        .arg(script)
        // tail -F only notices a dead connection when it writes, so the script
        // watches stdin instead: when ssh goes away for any reason it hits EOF.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ssh를 실행하지 못했습니다: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stdin = child.stdin.take();
    let id = streams.next.fetch_add(1, Ordering::Relaxed) + 1;
    let mut map = streams.streams.lock().unwrap();
    // Streams whose ssh already exited (replaced after a network change).
    map.retain(|_, s| matches!(s.child.try_wait(), Ok(None)));
    map.insert(
        id,
        Stream {
            child,
            _stdin: stdin,
            profile_id,
            session,
        },
    );
    drop(map);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains(';') && on_event.send(line).is_err() {
                return; // the page went away
            }
        }
        // ssh ended: a network change killed the side channel even though Mosh
        // kept the session. The tab starts a new stream.
        let _ = on_event.send(STREAM_ENDED.into());
    });
    Ok(id)
}

/// Stops the tail and removes the log, which also stops the hooks writing.
#[tauri::command(async)]
pub fn remote_event_stop(
    store: tauri::State<'_, Arc<Store>>,
    streams: tauri::State<'_, EventStreams>,
    id: u32,
) -> Result<(), String> {
    let Some(mut stream) = streams.streams.lock().unwrap().remove(&id) else {
        return Ok(());
    };
    let _ = stream.child.kill();
    let _ = stream.child.wait();
    let profile = remote::load_profile(&store, &stream.profile_id)?;
    // The remote tail may outlive the killed ssh client until its next write.
    let log = remote::event_log_path(&stream.session);
    let script = format!(
        "rm -f \"{log}\"; pkill -f \"tail -n 0 -F $HOME/.burrow/events/{}.log\" 2>/dev/null; true",
        stream.session
    );
    remote::side_command(&store, &profile, &script, None).map(|_| ())
}

impl EventStreams {
    /// App exit or page reload: stop the local ssh processes.
    pub fn kill_all(&self) {
        for (_, mut s) in self.streams.lock().unwrap().drain() {
            let _ = s.child.kill();
        }
    }
}
