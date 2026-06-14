use std::collections::HashMap;
use std::sync::{mpsc, Mutex};

pub enum VncMsg {
    KeyEvent { down: bool, key: u32 },
    PointerEvent { buttons: u8, x: u16, y: u16 },
    CutText { text: String },
    Disconnect,
}

pub struct VncSession {
    pub width: u32,
    pub height: u32,
    pub tx: mpsc::SyncSender<VncMsg>,
}

pub type VncSessionMap = Mutex<HashMap<String, VncSession>>;

pub fn new_vnc_sessions() -> VncSessionMap {
    Mutex::new(HashMap::new())
}
