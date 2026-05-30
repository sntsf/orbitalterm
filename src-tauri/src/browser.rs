// HTTP reverse proxy for browser connections.
// Each session starts a local TCP server on a random loopback port.
// The iframe loads http://127.0.0.1:<port>/<path>, which the proxy
// transparently forwards to the connection's target URL.
// Response headers that block iframe embedding (X-Frame-Options, CSP
// frame-ancestors) are stripped so the page renders correctly.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
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

// ── Target config ─────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct TargetConfig {
    /// "http" or "https"
    pub scheme: String,
    /// Original hostname as it appears in the connection URL
    pub host: String,
    /// Target port
    pub port: u16,
    /// custom_hosts overrides: hostname → IP
    pub hosts_map: HashMap<String, String>,
}

impl TargetConfig {
    /// Resolve the actual TCP address to connect to (applying custom hosts).
    pub fn resolved_addr(&self) -> String {
        let resolved = self
            .hosts_map
            .get(&self.host)
            .cloned()
            .unwrap_or_else(|| self.host.clone());
        format!("{}:{}", resolved, self.port)
    }

    /// Build a target URL for the given request path.
    pub fn target_url(&self, path: &str) -> String {
        format!("{}://{}:{}{}", self.scheme, self.host, self.port, path)
    }
}

// ── Proxy lifecycle ───────────────────────────────────────────────────────────

pub fn start_reverse_proxy(config: Arc<TargetConfig>) -> Result<BrowserSession, String> {
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
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).ok();
                    let cfg = config.clone();
                    thread::spawn(move || handle_request(stream, cfg, port));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(30));
                }
                Err(_) => break,
            }
        }
    });

    Ok(BrowserSession { proxy_port: port, stop })
}

pub fn stop_proxy(session: BrowserSession) {
    session.stop.store(true, Ordering::Relaxed);
    let _ = TcpStream::connect(format!("127.0.0.1:{}", session.proxy_port));
}

// ── Request handler ───────────────────────────────────────────────────────────

fn handle_request(mut stream: TcpStream, config: Arc<TargetConfig>, proxy_port: u16) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok();

    let mut reader = BufReader::new(stream.try_clone().expect("clone"));

    // Read request line
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
        return;
    }
    let request_line = request_line.trim().to_owned();
    let parts: Vec<&str> = request_line.splitn(3, ' ').collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0].to_uppercase();
    let path = parts[1].to_owned();

    // Read and collect request headers
    let mut req_headers: Vec<(String, String)> = Vec::new();
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let k = k.trim().to_owned();
            let v = v.trim().to_owned();
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.parse().unwrap_or(0);
            }
            req_headers.push((k, v));
        }
    }

    // Read request body if any
    let mut body: Vec<u8> = Vec::new();
    if content_length > 0 {
        body.resize(content_length, 0);
        reader.read_exact(&mut body).ok();
    }

    // Build target URL
    let target_url = config.target_url(&path);

    // Make the upstream request with reqwest::blocking
    let client = reqwest::blocking::Client::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let mut rb = match method.as_str() {
        "POST" => client.post(&target_url),
        "PUT" => client.put(&target_url),
        "DELETE" => client.delete(&target_url),
        "PATCH" => client.patch(&target_url),
        "HEAD" => client.head(&target_url),
        _ => client.get(&target_url),
    };

    // Forward request headers (skip hop-by-hop and Host — we set our own)
    for (k, v) in &req_headers {
        if skip_request_header(k) {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_str());
    }
    rb = rb.header("Host", format!("{}:{}", config.host, config.port));

    if !body.is_empty() {
        rb = rb.body(body);
    }

    let resp = match rb.send() {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Upstream error: {e}");
            let _ = write!(
                stream,
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{}",
                msg.len(),
                msg
            );
            return;
        }
    };

    let status = resp.status().as_u16();
    let mut out_headers: Vec<(String, String)> = Vec::new();

    for (name, value) in resp.headers() {
        let n = name.as_str();
        // Strip headers that block iframe embedding
        if n.eq_ignore_ascii_case("x-frame-options")
            || n.eq_ignore_ascii_case("content-security-policy")
            || n.eq_ignore_ascii_case("cross-origin-opener-policy")
            || n.eq_ignore_ascii_case("cross-origin-embedder-policy")
            || n.eq_ignore_ascii_case("cross-origin-resource-policy")
        {
            continue;
        }
        // Rewrite Location headers so redirects stay inside the proxy
        if n.eq_ignore_ascii_case("location") {
            if let Ok(loc) = value.to_str() {
                let rewritten = rewrite_location(loc, &config, proxy_port);
                out_headers.push(("Location".to_owned(), rewritten));
                continue;
            }
        }
        if let Ok(v) = value.to_str() {
            out_headers.push((n.to_owned(), v.to_owned()));
        }
    }

    // Add CORS header so the page can make same-origin requests through the proxy
    out_headers.push(("Access-Control-Allow-Origin".to_owned(), "*".to_owned()));

    let resp_body = resp.bytes().unwrap_or_default();

    let mut header_block = format!("HTTP/1.1 {} \r\n", status);
    for (k, v) in &out_headers {
        header_block += &format!("{}: {}\r\n", k, v);
    }
    header_block += &format!("Content-Length: {}\r\n\r\n", resp_body.len());

    let _ = stream.write_all(header_block.as_bytes());
    let _ = stream.write_all(&resp_body);
}

/// Convert an upstream absolute Location URL to a proxy-relative URL.
fn rewrite_location(loc: &str, config: &TargetConfig, proxy_port: u16) -> String {
    // If it looks like an absolute URL pointing to the same host, strip origin
    if let Ok(u) = reqwest::Url::parse(loc) {
        let same_host = u.host_str().map_or(false, |h| h == config.host);
        let same_port = u.port().unwrap_or(if u.scheme() == "https" { 443 } else { 80 })
            == config.port;
        if same_host && same_port {
            let path_and_query = u.path().to_owned()
                + u.query().map(|q| format!("?{q}")).unwrap_or_default().as_str();
            return format!("http://127.0.0.1:{}{}", proxy_port, path_and_query);
        }
    }
    loc.to_owned()
}

/// Returns true for hop-by-hop request headers we should not forward.
fn skip_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

// ── Hosts file parser ─────────────────────────────────────────────────────────

pub fn parse_hosts(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw_line in text.lines() {
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
