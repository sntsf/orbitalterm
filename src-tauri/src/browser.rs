// Simple HTTP-CONNECT proxy used to apply per-connection custom hosts to the
// embedded browser window.  Each browser session gets its own proxy on a
// random loopback port so sessions are fully isolated.

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

// ── Session map ───────────────────────────────────────────────────────────────

pub struct BrowserSession {
    pub proxy_port: u16,
    stop: Arc<AtomicBool>,
}

pub type BrowserSessionMap = Mutex<HashMap<String, BrowserSession>>;

pub fn new_browser_sessions() -> BrowserSessionMap {
    Mutex::new(HashMap::new())
}

// ── Proxy lifecycle ───────────────────────────────────────────────────────────

/// Start a CONNECT proxy for the given custom-hosts text.
/// Returns the port the proxy is listening on.
pub fn start_proxy(custom_hosts_text: &str) -> Result<BrowserSession, String> {
    let hosts = Arc::new(parse_hosts(custom_hosts_text));

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        loop {
            if stop_clone.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((client, _)) => {
                    client.set_nonblocking(false).ok();
                    let h = hosts.clone();
                    thread::spawn(move || handle_connection(client, h));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });

    Ok(BrowserSession { proxy_port: port, stop })
}

pub fn stop_proxy(session: BrowserSession) {
    session.stop.store(true, Ordering::Relaxed);
    // Wake up the accept loop with a quick connection attempt
    let _ = TcpStream::connect(format!("127.0.0.1:{}", session.proxy_port));
}

// ── Connection handler ────────────────────────────────────────────────────────

fn handle_connection(mut client: TcpStream, hosts: Arc<HashMap<String, String>>) {
    // Read the first line of the HTTP request
    let mut first_line = String::new();
    let mut one = [0u8; 1];
    loop {
        match client.read(&mut one) {
            Ok(1) => {
                first_line.push(one[0] as char);
                if first_line.ends_with("\r\n") || first_line.ends_with('\n') {
                    break;
                }
                if first_line.len() > 4096 {
                    return;
                }
            }
            _ => return,
        }
    }

    let parts: Vec<&str> = first_line.trim().splitn(3, ' ').collect();
    if parts.len() < 2 {
        return;
    }

    if parts[0].eq_ignore_ascii_case("CONNECT") {
        handle_connect(client, parts[1], &hosts);
    } else {
        // Plain HTTP – rare for admin consoles, but handle it
        let remaining = drain_headers(&mut client);
        handle_http(client, parts[0], parts[1], &first_line, &remaining, &hosts);
    }
}

/// Read and discard remaining HTTP headers, returning them as a byte vec.
fn drain_headers(client: &mut TcpStream) -> Vec<u8> {
    let mut headers = Vec::new();
    let mut one = [0u8; 1];
    loop {
        match client.read(&mut one) {
            Ok(1) => {
                headers.push(one[0]);
                // Check for \r\n\r\n or \n\n
                let n = headers.len();
                if (n >= 4 && &headers[n - 4..] == b"\r\n\r\n")
                    || (n >= 2 && &headers[n - 2..] == b"\n\n")
                {
                    break;
                }
                if headers.len() > 32768 {
                    break;
                }
            }
            _ => break,
        }
    }
    headers
}

fn resolve(host: &str, hosts: &HashMap<String, String>) -> String {
    hosts.get(host).cloned().unwrap_or_else(|| host.to_owned())
}

fn handle_connect(mut client: TcpStream, target: &str, hosts: &HashMap<String, String>) {
    // target = "hostname:port"
    let (hostname, port_str) = target.rfind(':').map_or((target, "443"), |i| {
        (&target[..i], &target[i + 1..])
    });
    let port: u16 = port_str.parse().unwrap_or(443);
    let ip = resolve(hostname, hosts);

    // Drain remaining headers
    drain_headers(&mut client);

    match TcpStream::connect(format!("{ip}:{port}")) {
        Ok(server) => {
            let _ = client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
            relay(client, server);
        }
        Err(_) => {
            let _ = client.write_all(b"HTTP/1.1 503 Service Unavailable\r\n\r\n");
        }
    }
}

fn handle_http(
    mut client: TcpStream,
    method: &str,
    url: &str,
    first_line: &str,
    rest_headers: &[u8],
    hosts: &HashMap<String, String>,
) {
    // Extract host from URL or Host header in rest_headers
    let host_hdr = String::from_utf8_lossy(rest_headers);
    let hostname = host_hdr
        .lines()
        .find(|l| l.to_lowercase().starts_with("host:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .map(|h| h.trim().split(':').next().unwrap_or("").to_owned())
        .unwrap_or_default();

    let port: u16 = host_hdr
        .lines()
        .find(|l| l.to_lowercase().starts_with("host:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .and_then(|h| h.trim().splitn(2, ':').nth(1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(80);

    if hostname.is_empty() {
        let _ = client.write_all(b"HTTP/1.0 400 Bad Request\r\n\r\n");
        return;
    }

    let ip = resolve(&hostname, hosts);
    match TcpStream::connect(format!("{ip}:{port}")) {
        Ok(mut server) => {
            // Re-send the request as-is (using HTTP/1.0 to avoid chunked encoding complexity)
            let req = format!("{} {} HTTP/1.0\r\n", method, url);
            let _ = server.write_all(req.as_bytes());
            let _ = server.write_all(rest_headers);

            let mut buf = [0u8; 8192];
            loop {
                match server.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if client.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        }
        Err(_) => {
            let _ = client.write_all(b"HTTP/1.0 503 Service Unavailable\r\n\r\n");
        }
    }
    let _ = first_line; // suppress unused warning
}

/// Bidirectional relay between two TCP streams.
fn relay(client: TcpStream, server: TcpStream) {
    let client2 = match client.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let server2 = match server.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };

    let mut c = client;
    let mut s = server;
    let mut c2 = client2;
    let mut s2 = server2;

    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match s2.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if c2.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut buf = [0u8; 65536];
    loop {
        match c.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if s.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
}

// ── Hosts file parser ─────────────────────────────────────────────────────────

pub fn parse_hosts(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw_line in text.lines() {
        // Strip inline comments
        let line = if let Some(pos) = raw_line.find('#') {
            &raw_line[..pos]
        } else {
            raw_line
        };
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let ip = parts[0];
            for hostname in &parts[1..] {
                map.insert((*hostname).to_owned(), ip.to_owned());
            }
        }
    }
    map
}
