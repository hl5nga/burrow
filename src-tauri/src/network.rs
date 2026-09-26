//! Whether this Mac has internet access at all — independent of any SSH
//! profile. The startup connection list uses this to decide whether SSH rows
//! can be tried; a profile's own host reachability (T12) is a separate,
//! per-host question answered elsewhere.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Well-known public resolvers, reached by raw IP so the check never depends
/// on DNS working (DNS failing is itself just one way to be offline, and we
/// don't want a broken resolver to read as "no internet" when the network is
/// actually fine).
const PROBES: &[(&str, u16)] = &[("1.1.1.1", 443), ("8.8.8.8", 443), ("9.9.9.9", 443)];
const TIMEOUT: Duration = Duration::from_millis(1200);

#[tauri::command(async)]
pub fn network_online() -> bool {
    PROBES.iter().any(|(ip, port)| {
        let Ok(addr) = format!("{ip}:{port}").parse::<SocketAddr>() else {
            return false;
        };
        TcpStream::connect_timeout(&addr, TIMEOUT).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_addresses_are_well_formed() {
        for (ip, port) in PROBES {
            format!("{ip}:{port}")
                .parse::<SocketAddr>()
                .unwrap_or_else(|e| panic!("{ip}:{port} does not parse: {e}"));
        }
    }

    #[test]
    fn network_online_runs_without_panicking() {
        // Doesn't assert the real result (this sandbox may have no outbound
        // network at all), just that the function runs to completion quickly.
        let _ = network_online();
    }
}
