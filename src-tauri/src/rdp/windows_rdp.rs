#![cfg(target_os = "windows")]

//! Embedded RDP on Windows via COM in-process hosting of mstscax.dll.
//! No mstsc.exe process is launched — identical to mRemoteNG's approach.
//!
//! ## Z-order and WebView2
//! WebView2 renders via DirectComposition (DComp). Traditional WS_CHILD windows
//! exist in the Win32 z-order which lies BELOW the DComp layer — they appear
//! as black rectangles regardless of HWND_TOP. The fix is to use a WS_POPUP
//! window (not WS_CHILD) owned by the Tauri window so it floats above the DComp
//! layer while still allowing other applications to be brought to the foreground.
//!
//! ## Reparenting and deadlocks
//! SetWindowLongPtrW(GWLP_HWNDPARENT) sends a synchronous cross-thread Win32
//! message that deadlocks the COM STA thread. We therefore never call it after
//! creation. Tearout/dock-back just updates the tracked parent variable so
//! canvas_to_screen() uses the correct reference window for positioning.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use tauri::Emitter;
use windows::Win32::Foundation::{E_NOTIMPL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{implement, w, BOOL, BSTR, GUID, IUnknown, Interface, OutRef, Ref, PCWSTR};

// IID of the DMsRdpClientEvents / IMsTscAxEvents outbound dispatch interface.
// This is the connection-point IID passed to IConnectionPointContainer::FindConnectionPoint.
// Defined in the Windows SDK as DIID_IMsTscAxEvents (mstsclib.h).
const IID_DMSRDPCLIENTEVENTS: GUID = GUID::from_values(
    0x209D4C07, 0x9325, 0x11D1,
    [0xA9, 0xE5, 0x00, 0xC0, 0x4F, 0xC9, 0x9C, 0x1D],
);

// ── Manual COM event sink ─────────────────────────────────────────────────────
//
// mstscax::IConnectionPoint::Advise internally calls
//   QueryInterface(pUnkSink, cp_iid, &ppv)
// before storing the pointer.  The standard #[implement(IDispatch)] responds
// YES only to IID_IUnknown and IID_IDispatch; it does NOT respond to the
// actual CP IID {336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6} that this version of
// mstscax exposes → CONNECT_E_CANNOTCONNECT (0x80040202).
//
// Fix: build the COM object manually so QueryInterface responds YES to:
//   • IID_IUnknown        (00000000-…)
//   • IID_IDispatch       (00020400-…)
//   • {336D5562-…}        actual CP IID enumerated at runtime
//   • {209D4C07-…}        DIID_IMsTscAxEvents (standard IID, used on newer Windows)
//
// All four IIDs share the same IDispatch vtable layout (the events interface is
// dispatch-based), so returning `this` for every successful QI is safe.
// mstscax delivers OnConnected (DISPID 2) and OnDisconnected (DISPID 4) through
// IDispatch::Invoke once Advise succeeds.

const IID_IUNKNOWN_S: GUID = GUID::from_values(
    0x00000000, 0x0000, 0x0000,
    [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
);
const IID_IDISPATCH_S: GUID = GUID::from_values(
    0x00020400, 0x0000, 0x0000,
    [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
);
// CP IID that this mstscax.dll version actually exposes (enumerated at runtime).
const IID_MSTSCAX_EVENTS: GUID = GUID::from_values(
    0x336D5562, 0xEFA8, 0x482E,
    [0x8C, 0xB3, 0xC5, 0xC0, 0xFC, 0x7A, 0x7D, 0xB6],
);

// ── CBT hook: auto-dismiss mstscax dialog windows ────────────────────────────
//
// mstscax creates Win32 dialogs (#32770) on the STA thread for:
//   • Certificate security warnings (untrusted cert)
//   • Clipboard / device-redirection security warnings (post-KB5057577)
//
// We install a WH_CBT thread-local hook before calling Connect() so that
// HCBT_ACTIVATE fires synchronously when any dialog is about to gain focus.
// We use DM_GETDEFID to find the default button (the "Accept/Allow/Connect" one)
// and post WM_COMMAND to it so the dialog's own message loop dismisses it.

static RDP_AUTO_DISMISS_HOOK: AtomicIsize = AtomicIsize::new(0);

// ── Cross-thread dialog watcher ───────────────────────────────────────────────
//
// The CBT thread hook only catches dialogs on the STA thread.  mstscax may
// create clipboard/credential warning dialogs on worker threads.  This watcher
// polls EnumWindows (all threads, our process) every 150 ms and auto-dismisses
// any visible #32770 dialog with a default button.
//
// WATCHER_PID is set to our process ID before the watcher thread starts and
// cleared when it exits so the EnumWindows callback can filter safely.

static WATCHER_PID: AtomicU32 = AtomicU32::new(0);
// HWND of the dialog we already sent a dismiss to.  We skip re-dismissing
// this HWND until it actually closes, avoiding a spam loop caused by the
// asynchronous gap between PostMessage and the dialog's message loop.
static WATCHER_PENDING: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn watcher_dismiss_cb(hwnd: HWND, _: LPARAM) -> BOOL {
    let our_pid = WATCHER_PID.load(Ordering::Relaxed);
    if our_pid == 0 { return BOOL(0); }

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != our_pid { return BOOL(1); }
    if !IsWindowVisible(hwnd).as_bool() { return BOOL(1); }

    let mut cls = [0u16; 16];
    GetClassNameW(hwnd, &mut cls);
    // "#32770" in UTF-16: [35, 51, 50, 55, 55, 48, 0]
    if !(cls[0] == 35 && cls[1] == 51 && cls[2] == 50
        && cls[3] == 55 && cls[4] == 55 && cls[5] == 48 && cls[6] == 0)
    {
        return BOOL(1);
    }

    // Skip a dialog we've already dismissed — wait for it to actually close.
    if WATCHER_PENDING.load(Ordering::Relaxed) == hwnd.0 as isize {
        return BOOL(1);
    }

    let mut title = [0u16; 256];
    GetWindowTextW(hwnd, &mut title);
    let title_s = String::from_utf16_lossy(&title);
    let title_trimmed = title_s.trim_end_matches('\0');
    eprintln!("[rdp] watcher: visible dialog '{title_trimmed}'");

    // Log buttons for diagnosis
    unsafe extern "system" fn log_btn_w(child: HWND, _: LPARAM) -> BOOL {
        let mut cls2 = [0u16; 32];
        GetClassNameW(child, &mut cls2);
        if String::from_utf16_lossy(&cls2).trim_end_matches('\0').eq_ignore_ascii_case("Button") {
            let mut t = [0u16; 64];
            let n = GetWindowTextW(child, &mut t);
            let text = if n > 0 { String::from_utf16_lossy(&t[..n as usize]) } else { String::new() };
            eprintln!("[rdp] watcher btn id={}: '{text}'", GetDlgCtrlID(child));
        }
        BOOL(1)
    }
    EnumChildWindows(Some(hwnd), Some(log_btn_w), LPARAM(0));

    // Determine which button to click: DM_GETDEFID first, then IDOK fallback.
    let r = SendMessageW(hwnd, 0x400u32, Some(WPARAM(0)), Some(LPARAM(0)));
    let hi = ((r.0 as usize) >> 16) & 0xFFFF;
    let lo = (r.0 as usize) & 0xFFFF;
    let btn_id: i32 = if hi == 0xDC00 && lo > 0 { lo as i32 }
                      else if GetDlgItem(Some(hwnd), 1).is_ok() { 1 }
                      else { 0 };

    if btn_id > 0 {
        if let Ok(btn) = GetDlgItem(Some(hwnd), btn_id) {
            // Mark pending BEFORE clicking so subsequent polls skip this HWND.
            WATCHER_PENDING.store(hwnd.0 as isize, Ordering::Relaxed);
            // BM_CLICK (0x00F5) on the button HWND simulates a full click;
            // more reliable for custom mstscax dialogs than WM_COMMAND on parent.
            PostMessageW(Some(btn), BM_CLICK, WPARAM(0), LPARAM(0)).ok();
            eprintln!("[rdp] watcher: dismissed '{title_trimmed}' btn_id={btn_id}");
        }
    } else {
        eprintln!("[rdp] watcher: WARN no dismiss button for '{title_trimmed}'");
    }
    BOOL(1)
}

unsafe extern "system" fn log_and_find_btn(child: HWND, _: LPARAM) -> BOOL {
    let mut cls = [0u16; 32];
    GetClassNameW(child, &mut cls);
    let cls_s = String::from_utf16_lossy(&cls);
    if cls_s.trim_end_matches('\0').eq_ignore_ascii_case("Button") {
        let mut txt = [0u16; 64];
        let n = GetWindowTextW(child, &mut txt);
        let text = if n > 0 { String::from_utf16_lossy(&txt[..n as usize]) } else { String::new() };
        let id = GetDlgCtrlID(child);
        eprintln!("[rdp] dialog btn id={id}: '{text}'");
    }
    BOOL(1)
}

unsafe extern "system" fn rdp_auto_dismiss_proc(
    ncode: i32, wparam: WPARAM, lparam: LPARAM,
) -> LRESULT {
    // HCBT_ACTIVATE (5) fires just before a window gains focus.
    if ncode == 5 {
        let hwnd = HWND(wparam.0 as *mut _);
        let mut cls = [0u16; 16];
        GetClassNameW(hwnd, &mut cls);
        // "#32770" in UTF-16: [35, 51, 50, 55, 55, 48, 0]
        if cls[0] == 35 && cls[1] == 51 && cls[2] == 50
            && cls[3] == 55 && cls[4] == 55 && cls[5] == 48 && cls[6] == 0
        {
            let mut title = [0u16; 256];
            GetWindowTextW(hwnd, &mut title);
            let title_s = String::from_utf16_lossy(&title);
            let title_trimmed = title_s.trim_end_matches('\0');
            eprintln!("[rdp] HCBT_ACTIVATE dialog: '{title_trimmed}'");

            // Log all buttons so we know the layout.
            EnumChildWindows(Some(hwnd), Some(log_and_find_btn), LPARAM(0));

            // Strategy 1: DM_GETDEFID (WM_USER+0 = 0x400) returns the default button ID.
            // The default button is always "Accept/Allow/Connect" in warning dialogs.
            // DC_HASDEFID = 0xDC00 in the high word signals a valid default button.
            let r = SendMessageW(hwnd, 0x400u32, Some(WPARAM(0)), Some(LPARAM(0)));
            let hi = ((r.0 as usize) >> 16) & 0xFFFF;
            let lo = (r.0 as usize) & 0xFFFF;
            if hi == 0xDC00 && lo > 0 {
                let _ = PostMessageW(Some(hwnd), WM_COMMAND, WPARAM(lo), LPARAM(0));
                eprintln!("[rdp] auto-dismissed via DM_GETDEFID id={lo}: '{title_trimmed}'");
            } else if GetDlgItem(Some(hwnd), 6).is_ok() {
                // Fallback: IDYES (6)
                let _ = PostMessageW(Some(hwnd), WM_COMMAND, WPARAM(6), LPARAM(0));
                eprintln!("[rdp] auto-dismissed via IDYES(6): '{title_trimmed}'");
            } else if GetDlgItem(Some(hwnd), 1).is_ok() {
                // Fallback: IDOK (1) — only if DM_GETDEFID didn't work
                let _ = PostMessageW(Some(hwnd), WM_COMMAND, WPARAM(1), LPARAM(0));
                eprintln!("[rdp] auto-dismissed via IDOK(1): '{title_trimmed}'");
            } else {
                eprintln!("[rdp] WARN: could not find dismiss button for '{title_trimmed}'");
            }
        }
    }
    let hook = HHOOK(RDP_AUTO_DISMISS_HOOK.load(Ordering::Relaxed) as *mut _);
    CallNextHookEx(Some(hook), ncode, wparam, lparam)
}

// IDispatch vtable layout (IUnknown × 3 + IDispatch × 4 = 7 entries).
#[repr(C)]
struct EvSinkVtbl {
    qi:      unsafe extern "system" fn(*mut EvSinkInner, *const GUID, *mut *mut core::ffi::c_void) -> i32,
    addref:  unsafe extern "system" fn(*mut EvSinkInner) -> u32,
    release: unsafe extern "system" fn(*mut EvSinkInner) -> u32,
    gtc:     unsafe extern "system" fn(*mut EvSinkInner, *mut u32) -> i32,
    gti:     unsafe extern "system" fn(*mut EvSinkInner, u32, u32, *mut *mut core::ffi::c_void) -> i32,
    gidn:    unsafe extern "system" fn(*mut EvSinkInner, *const GUID, *const *const u16, u32, u32, *mut i32) -> i32,
    invoke:  unsafe extern "system" fn(*mut EvSinkInner, i32, *const GUID, u32, u16, *const core::ffi::c_void, *mut core::ffi::c_void, *mut core::ffi::c_void, *mut u32) -> i32,
}

#[repr(C)]
struct EvSinkInner {
    vtbl:         *const EvSinkVtbl,
    ref_count:    AtomicU32,
    logged_in:    Arc<AtomicBool>, // DISPID 3 = OnLoginComplete
    disconnected: Arc<AtomicBool>, // DISPID 4 = OnDisconnected
}

// SAFETY: only ever accessed on the COM STA thread; Arc fields are Send+Sync.
unsafe impl Sync for EvSinkVtbl {}
unsafe impl Send for EvSinkInner {}
unsafe impl Sync for EvSinkInner {}

static EV_SINK_VTBL: EvSinkVtbl = EvSinkVtbl {
    qi:      ev_sink_qi,
    addref:  ev_sink_addref,
    release: ev_sink_release,
    gtc:     ev_sink_gtc,
    gti:     ev_sink_gti,
    gidn:    ev_sink_gidn,
    invoke:  ev_sink_invoke,
};

unsafe extern "system" fn ev_sink_qi(
    this: *mut EvSinkInner, iid: *const GUID, ppv: *mut *mut core::ffi::c_void,
) -> i32 {
    // Accept any IID that shares this vtable layout (IDispatch-based interfaces).
    if *iid == IID_IUNKNOWN_S
        || *iid == IID_IDISPATCH_S
        || *iid == IID_MSTSCAX_EVENTS
        || *iid == IID_DMSRDPCLIENTEVENTS
    {
        *ppv = this as *mut _;
        ev_sink_addref(this);
        0 // S_OK
    } else {
        *ppv = core::ptr::null_mut();
        -2147467262i32 // E_NOINTERFACE (0x80004002)
    }
}

unsafe extern "system" fn ev_sink_addref(this: *mut EvSinkInner) -> u32 {
    (*this).ref_count.fetch_add(1, Ordering::SeqCst) + 1
}

unsafe extern "system" fn ev_sink_release(this: *mut EvSinkInner) -> u32 {
    let prev = (*this).ref_count.fetch_sub(1, Ordering::SeqCst);
    if prev == 1 {
        drop(Box::from_raw(this));
    }
    prev - 1
}

unsafe extern "system" fn ev_sink_gtc(_: *mut EvSinkInner, pct: *mut u32) -> i32 {
    *pct = 0; 0
}
unsafe extern "system" fn ev_sink_gti(
    _: *mut EvSinkInner, _: u32, _: u32, _: *mut *mut core::ffi::c_void,
) -> i32 {
    -2147467263i32 // E_NOTIMPL
}
unsafe extern "system" fn ev_sink_gidn(
    _: *mut EvSinkInner, _: *const GUID, _: *const *const u16,
    _: u32, _: u32, _: *mut i32,
) -> i32 {
    -2147467263i32 // E_NOTIMPL
}

unsafe extern "system" fn ev_sink_invoke(
    this: *mut EvSinkInner,
    dispid: i32,
    _: *const GUID, _: u32, _: u16,
    _: *const core::ffi::c_void, _: *mut core::ffi::c_void,
    _: *mut core::ffi::c_void, _: *mut u32,
) -> i32 {
    let inner = &*this;
    eprintln!("[rdp-event] DISPID {dispid}");
    match dispid {
        3 => {
            // DISPID 3 = OnLoginComplete: the Windows session login succeeded.
            // This fires only after a real interactive login — NOT during NLA
            // handshake or failed auth.  We use it (rather than DISPID 2 /
            // polling) to set ever_connected because all events can arrive in a
            // single message-pump pass before the first polling tick runs.
            inner.logged_in.store(true, Ordering::SeqCst);
            eprintln!("[rdp-event] OnLoginComplete — session ready");
        }
        4 => {
            // DISPID 4 = OnDisconnected: session ended (logoff, network drop).
            inner.disconnected.store(true, Ordering::SeqCst);
            eprintln!("[rdp-event] OnDisconnected");
        }
        _ => {}
    }
    0 // S_OK
}

// Create a COM event sink that responds to QI for both the mstscax-specific
// events IID and the standard IDispatch IID, then wraps it as IUnknown.
// ref_count starts at 1; mstscax's Advise will AddRef → 2, our drop → 1,
// Unadvise → 0 → Box freed.
fn new_event_sink(logged_in: Arc<AtomicBool>, disconnected: Arc<AtomicBool>) -> IUnknown {
    let inner = Box::new(EvSinkInner {
        vtbl: &EV_SINK_VTBL,
        ref_count: AtomicU32::new(1),
        logged_in,
        disconnected,
    });
    unsafe { <IUnknown as Interface>::from_raw(Box::into_raw(inner) as *mut _) }
}

// MsRdpClient10 (Windows 10+); MsRdpClient9 used as fallback
const CLSID_MSTSC_10: GUID = GUID::from_values(
    0xC0EFA91A, 0xEEB7, 0x41C7,
    [0x97, 0xFA, 0xF0, 0xED, 0x64, 0x5E, 0xFB, 0x24],
);
const CLSID_MSTSC_9: GUID = GUID::from_values(
    0x8B918B82, 0x7985, 0x4C24,
    [0x89, 0xDF, 0xC3, 0x3A, 0xD2, 0xBB, 0xFB, 0xCD],
);

// ── Command channel ───────────────────────────────────────────────────────────

enum ComCmd {
    Reposition { x: i32, y: i32, width: i32, height: i32 },
    Show,
    Hide,
    Disconnect,
    Reparent { new_parent: isize, rel_x: i32, rel_y: i32, width: i32, height: i32 },
}

// ── Session ───────────────────────────────────────────────────────────────────

pub struct WindowsRdpSession {
    tx: mpsc::SyncSender<ComCmd>,
}

unsafe impl Send for WindowsRdpSession {}
unsafe impl Sync for WindowsRdpSession {}

impl Drop for WindowsRdpSession {
    fn drop(&mut self) {
        let _ = self.tx.send(ComCmd::Disconnect);
    }
}

// ── OLE Frame ─────────────────────────────────────────────────────────────────
//
// IOleInPlaceFrame represents the outermost application window.
// Its GetWindow() MUST return the top-level frame (Tauri main window), NOT the
// container child window — mstscax uses this to know the app boundary.
// If we return the wrong HWND here, DoVerb(-5) silently fails → black screen.

#[implement(IOleInPlaceFrame)]
struct RdpFrame {
    hwnd: HWND, // top-level application window (Tauri main window)
}

impl IOleWindow_Impl for RdpFrame_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> { Ok(self.hwnd) }
    fn ContextSensitiveHelp(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceUIWindow_Impl for RdpFrame_Impl {
    fn GetBorder(&self) -> windows::core::Result<RECT> { Err(E_NOTIMPL.into()) }
    fn RequestBorderSpace(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
    fn SetBorderSpace(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
    fn SetActiveObject(
        &self,
        _: Ref<'_, IOleInPlaceActiveObject>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceFrame_Impl for RdpFrame_Impl {
    fn InsertMenus(&self, _: HMENU, _: *mut OLEMENUGROUPWIDTHS) -> windows::core::Result<()> { Ok(()) }
    fn SetMenu(&self, _: HMENU, _: isize, _: HWND) -> windows::core::Result<()> { Ok(()) }
    fn RemoveMenus(&self, _: HMENU) -> windows::core::Result<()> { Ok(()) }
    fn SetStatusText(&self, _: &PCWSTR) -> windows::core::Result<()> { Ok(()) }
    fn EnableModeless(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn TranslateAccelerator(&self, _: *const MSG, _: u16) -> windows::core::Result<()> {
        // S_FALSE tells the control the container didn't handle it → control processes it
        Err(windows::Win32::Foundation::S_FALSE.into())
    }
}

// ── OLE Site ──────────────────────────────────────────────────────────────────
//
// IOleClientSite + IOleInPlaceSite represent the immediate container window
// (host_hwnd). GetWindow() here returns host_hwnd (the popup we own).

#[implement(IOleClientSite, IOleInPlaceSite)]
struct RdpSite {
    hwnd: HWND,              // container popup window (host_hwnd)
    frame: IOleInPlaceFrame, // top-level frame (kept alive for GetWindowContext)
}

// SAFETY: used exclusively on the dedicated STA COM thread
unsafe impl Send for RdpSite {}

impl IOleClientSite_Impl for RdpSite_Impl {
    fn SaveObject(&self) -> windows::core::Result<()> { Err(E_NOTIMPL.into()) }
    fn GetMoniker(&self, _: &OLEGETMONIKER, _: &OLEWHICHMK) -> windows::core::Result<IMoniker> {
        Err(E_NOTIMPL.into())
    }
    fn GetContainer(&self) -> windows::core::Result<IOleContainer> { Err(E_NOTIMPL.into()) }
    fn ShowObject(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnShowWindow(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn RequestNewObjectLayout(&self) -> windows::core::Result<()> { Err(E_NOTIMPL.into()) }
}

impl IOleWindow_Impl for RdpSite_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> { Ok(self.hwnd) }
    fn ContextSensitiveHelp(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceSite_Impl for RdpSite_Impl {
    fn CanInPlaceActivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnInPlaceActivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnUIActivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn GetWindowContext(
        &self,
        ppframe: OutRef<'_, IOleInPlaceFrame>,
        ppdoc: OutRef<'_, IOleInPlaceUIWindow>,
        lprcposrect: *mut RECT,
        lprccliprect: *mut RECT,
        lpframeinfo: *mut OLEINPLACEFRAMEINFO,
    ) -> windows::core::Result<()> {
        unsafe {
            // ppframe → top-level app frame (critical — must be non-null)
            ppframe.write(Some(self.frame.clone()));
            // ppdoc → null for SDI (no separate document window)
            ppdoc.write(None);
            let mut rc = RECT::default();
            GetClientRect(self.hwnd, &mut rc).ok();
            if !lprcposrect.is_null()  { *lprcposrect  = rc; }
            if !lprccliprect.is_null() { *lprccliprect = rc; }
            if !lpframeinfo.is_null() {
                (*lpframeinfo).cb            = std::mem::size_of::<OLEINPLACEFRAMEINFO>() as u32;
                (*lpframeinfo).fMDIApp       = BOOL(0);
                (*lpframeinfo).hwndFrame     = self.hwnd;
                (*lpframeinfo).haccel        = HACCEL::default();
                (*lpframeinfo).cAccelEntries = 0;
            }
        }
        Ok(())
    }
    fn Scroll(&self, _: &windows::Win32::Foundation::SIZE) -> windows::core::Result<()> { Ok(()) }
    fn OnUIDeactivate(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn OnInPlaceDeactivate(&self) -> windows::core::Result<()> { Ok(()) }
    fn DiscardUndoState(&self) -> windows::core::Result<()> { Ok(()) }
    fn DeactivateAndUndo(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnPosRectChange(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
}

// ── IDispatch helpers ─────────────────────────────────────────────────────────

fn get_dispid(disp: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let pcwstr = PCWSTR(wide.as_ptr());
    let mut id = 0i32;
    unsafe { disp.GetIDsOfNames(&GUID::zeroed(), &pcwstr, 1, 0x0409, &mut id)?; }
    Ok(id)
}

// VARIANT on Win64: u16 vt + u16[3] reserved + 8-byte data = 16 bytes total.
#[repr(C)]
union VarData { bstrVal: *mut u16, lVal: i32, boolVal: i16, pdispVal: *mut core::ffi::c_void }
#[repr(C)]
struct VarRaw { vt: u16, _r: [u16; 3], data: VarData }

fn put_bstr(disp: &IDispatch, name: &str, value: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    let bval = std::mem::ManuallyDrop::new(BSTR::from(value));
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 8; (*r).data.bstrVal = bval.as_ptr() as *mut u16; }
        let mut named = DISPID_PROPERTYPUT;
        let res = disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None);
        VariantClear(&mut var).ok();
        res
    }
}

fn put_i4(disp: &IDispatch, name: &str, value: i32) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 3; (*r).data.lVal = value; }
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None)
    }
}

fn put_bool_prop(disp: &IDispatch, name: &str, value: bool) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut var: VARIANT = std::mem::zeroed();
        { let r = &mut var as *mut VARIANT as *mut VarRaw; (*r).vt = 11; (*r).data.boolVal = if value { -1i16 } else { 0i16 }; }
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None)
    }
}

fn get_dispatch_sub(disp: &IDispatch, name: &str) -> windows::core::Result<IDispatch> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut result: VARIANT = std::mem::zeroed();
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYGET,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            Some(&mut result), None, None)?;
        let r = &result as *const VARIANT as *const VarRaw;
        if (*r).vt == 9 {
            let raw = (*r).data.pdispVal;
            if !raw.is_null() {
                (*(r as *mut VarRaw)).vt = 0;
                return Ok(IDispatch::from_raw(raw));
            }
        }
        VariantClear(&mut result).ok();
        Err(E_NOTIMPL.into())
    }
}

fn get_i4(disp: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let id = get_dispid(disp, name)?;
    unsafe {
        let mut result: VARIANT = std::mem::zeroed();
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_PROPERTYGET,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            Some(&mut result), None, None)?;
        let r = &result as *const VARIANT as *const VarRaw;
        let val = if (*r).vt == 3 { (*r).data.lVal } else { 0 };
        VariantClear(&mut result).ok();
        Ok(val)
    }
}

// Write credentials directly into Windows Credential Manager via CredWriteW.
// More reliable than spawning cmdkey.exe (no process creation, no UAC, no
// quoting issues). NLA/CredSSP picks these up automatically during Connect().
fn store_rdp_credential(host: &str, port: u16, username: &str, domain: &str, password: &str) {
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_DOMAIN_PASSWORD, CRED_TYPE_GENERIC,
    };
    use windows::core::PWSTR;

    // Build the set of (target, username) pairs to store.
    // CredSSP looks up TERMSRV/<host> with type CRED_TYPE_GENERIC.
    // For local accounts (no domain), also store with the ".\username" prefix
    // that Windows uses internally so CredSSP finds the credential regardless
    // of which username format it resolves to.
    let user_plain = if domain.is_empty() {
        username.to_owned()
    } else {
        format!("{}\\{}", domain, username)
    };
    let user_dot = if domain.is_empty() {
        Some(format!(".\\{}", username))
    } else {
        None
    };

    let mut base_targets = vec![
        format!("TERMSRV/{}", host),
        format!("TERMSRV/{}:{}", host, port), // always store both forms
    ];

    // Credential blob is the password as UTF-16LE with no null terminator.
    let pw_blob: Vec<u8> = password
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();

    for target in &base_targets {
        let mut target_wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        // Build the list of username variants to store for this target.
        let mut user_variants: Vec<String> = vec![user_plain.clone()];
        if let Some(ref dot) = user_dot { user_variants.push(dot.clone()); }
        for user_str in &user_variants {
            let mut user_wide: Vec<u16> = user_str.encode_utf16().chain(Some(0)).collect();
            // mstsc.exe stores as CRED_TYPE_GENERIC; CredSSP reads GENERIC.
            // DOMAIN_PASSWORD is kept for fallback on domain-joined targets.
            for cred_type in [CRED_TYPE_GENERIC, CRED_TYPE_DOMAIN_PASSWORD] {
                let cred = CREDENTIALW {
                    Flags: CRED_FLAGS(0),
                    Type: cred_type,
                    TargetName: PWSTR(target_wide.as_mut_ptr()),
                    Comment: PWSTR::null(),
                    LastWritten: unsafe { std::mem::zeroed() },
                    CredentialBlobSize: pw_blob.len() as u32,
                    CredentialBlob: pw_blob.as_ptr() as *mut u8,
                    Persist: CRED_PERSIST_LOCAL_MACHINE,
                    AttributeCount: 0,
                    Attributes: std::ptr::null_mut(),
                    TargetAlias: PWSTR::null(),
                    UserName: PWSTR(user_wide.as_mut_ptr()),
                };
                let ok = unsafe { CredWriteW(&cred, 0).is_ok() };
                eprintln!("[rdp] CredWriteW {target} user={user_str} type={} ok={ok}", cred_type.0);
            }
        }
    }
}

// Write HKCU\...\Terminal Services\Client\RedirectionWarningDialogVersion=1.
// The April-2026 security update (KB5057577) introduced a new per-connection
// redirection warning dialog that overrides the old WarnAbout* COM properties.
// Setting this registry value (documented for IT admins) reverts the dialog
// behavior to the pre-update version where WarnAbout*=FALSE is honored.
// HKCU requires no elevation; Windows reads both HKCU and HKLM for this key.
fn set_rdp_warning_dialog_version() {
    use windows::Win32::System::Registry::{
        RegCreateKeyExW, RegSetValueExW, RegCloseKey,
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_DWORD,
    };
    let subkey: Vec<u16> = "Software\\Policies\\Microsoft\\Windows NT\\Terminal Services\\Client"
        .encode_utf16().chain(Some(0)).collect();
    let vname: Vec<u16> = "RedirectionWarningDialogVersion"
        .encode_utf16().chain(Some(0)).collect();
    let mut hkey = HKEY::default();
    unsafe {
        if RegCreateKeyExW(
            HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), Some(0), PCWSTR::null(),
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut hkey, None,
        ).is_ok() {
            let v: u32 = 1;
            let ok = RegSetValueExW(hkey, PCWSTR(vname.as_ptr()), Some(0), REG_DWORD,
                Some(&v.to_ne_bytes())).is_ok();
            eprintln!("[rdp] HKCU RedirectionWarningDialogVersion=1 ok={ok}");
            RegCloseKey(hkey);
        }
    }
}

// Write per-server registry values under
//   HKCU\Software\Microsoft\Terminal Server Client\servers\<host>
// mstscax reads these before showing any warning dialogs and uses UsernameHint
// to select the right Credential Manager entry for automatic authentication.
fn suppress_rdp_server_registry(host: &str, port: u16, username: &str, domain: &str) {
    use windows::Win32::System::Registry::{
        RegCreateKeyExW, RegSetValueExW, RegCloseKey,
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_DWORD, REG_SZ,
    };

    let user_hint = if domain.is_empty() {
        username.to_owned()
    } else {
        format!("{}\\{}", domain, username)
    };

    // Write under both host-only and host:port forms so whichever key mstscax
    // resolves to gets the suppression values.
    let mut server_keys = vec![host.to_owned()];
    server_keys.push(format!("{}:{}", host, port));

    // Write the global (non-per-server) suppression values first.
    // On some mstscax versions the global key takes precedence over per-server.
    let global_subkey: Vec<u16> = "Software\\Microsoft\\Terminal Server Client"
        .encode_utf16().chain(Some(0)).collect();
    let mut global_hkey = HKEY::default();
    unsafe {
        if RegCreateKeyExW(
            HKEY_CURRENT_USER, PCWSTR(global_subkey.as_ptr()), Some(0), PCWSTR::null(),
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut global_hkey, None,
        ).is_ok() {
            let zero: u32 = 0;
            for name in &["WarnAboutClipboardRedirection", "WarnAboutSendingCredentials",
                           "WarnAboutPrintRedirection"] {
                let vname: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                let _ = RegSetValueExW(global_hkey, PCWSTR(vname.as_ptr()), Some(0), REG_DWORD,
                    Some(&zero.to_ne_bytes()));
            }
            let _ = RegCloseKey(global_hkey);
        }
    }

    for server in &server_keys {
        let subkey_str = format!("Software\\Microsoft\\Terminal Server Client\\servers\\{}", server);
        let subkey: Vec<u16> = subkey_str.encode_utf16().chain(Some(0)).collect();
        let mut hkey = HKEY::default();
        unsafe {
            if RegCreateKeyExW(
                HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), Some(0), PCWSTR::null(),
                REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut hkey, None,
            ).is_ok() {
                let zero: u32 = 0;
                for name in &["WarnAboutClipboardRedirection", "WarnAboutSendingCredentials",
                               "WarnAboutPrintRedirection"] {
                    let vname: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                    let _ = RegSetValueExW(hkey, PCWSTR(vname.as_ptr()), Some(0), REG_DWORD,
                        Some(&zero.to_ne_bytes()));
                }
                // UsernameHint: mstscax uses this to locate the Credential Manager
                // entry for NLA pre-authentication without prompting.
                let hint_name: Vec<u16> = "UsernameHint".encode_utf16().chain(Some(0)).collect();
                let hint_bytes: Vec<u8> = user_hint.encode_utf16()
                    .flat_map(|c| c.to_le_bytes()).chain([0u8, 0u8]).collect();
                let _ = RegSetValueExW(hkey, PCWSTR(hint_name.as_ptr()), Some(0), REG_SZ,
                    Some(&hint_bytes));
                let _ = RegCloseKey(hkey);
            }
        }
    }
    eprintln!("[rdp] per-server registry suppression written for {host} hint={user_hint}");
}

// Suppress the two dialogs that appear on every RDP connection:
//   1. Clipboard/redirect security warning (reverted by registry key above)
//   2. "Windows Security – enter credentials" credential prompt
unsafe fn suppress_rdp_dialogs(rdp_unk: &IUnknown) {
    // Only NS3 is accessed via vtable; NS4/NS5 are skipped (see comment below).
    const IID_NS3: GUID = GUID::from_values(
        0xB3378D90, 0x0728, 0x45C7,
        [0x8E, 0xD7, 0xB6, 0x15, 0x9F, 0xB9, 0x22, 0x19],
    );

    type QIFn    = unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> i32;
    type PutBool = unsafe extern "system" fn(*mut core::ffi::c_void, i16) -> i32;
    type RelFn   = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;

    let raw = rdp_unk.as_raw() as *mut core::ffi::c_void;
    let unk_vtbl: *const usize = *(raw as *const *const usize);
    let qi: QIFn = core::mem::transmute(*unk_vtbl.add(0));

    // ── NS3: WarnAboutClipboardRedirection + WarnAboutSendingCredentials ──────
    // Flat vtable offsets (NS3 pointer):
    //   [0-2]  IUnknown
    //   [3-4]  NS1: NotifyRedirectDeviceChange, SendKeys
    //   [5-16] NS2 (inherited): UIParentWindowHandle(2), ShowRedirectionWarningDialog(2),
    //               PromptForCredentials(2), NegotiateSecurityLayer(2),
    //               EnableCredSspSupport(2), AuthenticationServiceClass(2)
    //   [17] get_WarnAboutSendingCredentials
    //   [18] put_WarnAboutSendingCredentials
    //   [19] get_WarnAboutClipboardRedirection
    //   [20] put_WarnAboutClipboardRedirection
    //   [21] get_ConnectionBarText
    //   [22] put_ConnectionBarText
    let mut ns3: *mut core::ffi::c_void = core::ptr::null_mut();
    if qi(raw, &IID_NS3, &mut ns3) >= 0 && !ns3.is_null() {
        let v: *const usize = *(ns3 as *const *const usize);
        let put_show_redir:   PutBool = core::mem::transmute(*v.add(8));  // ShowRedirectionWarningDialog (NS2)
        let put_prompt_creds: PutBool = core::mem::transmute(*v.add(10)); // PromptForCredentials (NS2)
        let put_neg_sec:      PutBool = core::mem::transmute(*v.add(12)); // NegotiateSecurityLayer (NS2)
        let put_warn_creds:   PutBool = core::mem::transmute(*v.add(18)); // WarnAboutSendingCredentials (NS3)
        let put_warn_clip:    PutBool = core::mem::transmute(*v.add(20)); // WarnAboutClipboardRedirection (NS3)
        let release: RelFn            = core::mem::transmute(*v.add(2));
        let h1 = put_show_redir(ns3, 0i16);
        let h2 = put_prompt_creds(ns3, 0i16);
        let h3 = put_neg_sec(ns3, -1i16);
        let h4 = put_warn_creds(ns3, 0i16);
        let h5 = put_warn_clip(ns3, 0i16);
        eprintln!("[rdp] NS2 ShowRedirectionWarningDialog=0  hr=0x{:08X}", h1 as u32);
        eprintln!("[rdp] NS2 PromptForCredentials=0          hr=0x{:08X}", h2 as u32);
        eprintln!("[rdp] NS2 NegotiateSecurityLayer=1         hr=0x{:08X}", h3 as u32);
        eprintln!("[rdp] NS3 WarnAboutSendingCredentials=0   hr=0x{:08X}", h4 as u32);
        eprintln!("[rdp] NS3 WarnAboutClipboardRedirection=0  hr=0x{:08X}", h5 as u32);
        release(ns3);
    }

    // NS4 and NS5 vtable access is intentionally skipped.
    // On this mstscax build QI(NS4) returns S_OK but maps to the NS3 vtable
    // (no extra entries), causing an access violation at offset [28]+.
    // NS5 may exhibit the same pattern at offset [35].
    // The per-server registry approach handles all credential/prompt suppression
    // more reliably without vtable hackery.
}

fn call_no_args(disp: &IDispatch, name: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_METHOD,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            None, None, None)
    }
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

/// Map a point in `hwnd`'s client coordinates to screen coordinates.
///
/// `ClientToScreen` is not exposed by the `windows` crate bindings, so we
/// derive the same result from `GetWindowRect` (outer position) and
/// `GetClientRect` (client size).  For standard Win32 windows:
///   left_border == right_border == bottom_border  (symmetric frame)
///   top_border = outer_height - client_height - left_border
///
/// This is exact for Tauri windows because WebView2 fills the whole client area
/// and there is no custom client-area padding.
unsafe fn canvas_to_screen(hwnd: HWND, cx: i32, cy: i32) -> (i32, i32) {
    let mut outer = RECT::default();
    let mut inner = RECT::default();
    GetWindowRect(hwnd, &mut outer).ok();
    GetClientRect(hwnd, &mut inner).ok();
    let outer_w = outer.right - outer.left;
    let outer_h = outer.bottom - outer.top;
    let client_w = inner.right;  // GetClientRect top-left is always (0,0)
    let client_h = inner.bottom;
    let bx = (outer_w - client_w) / 2;  // left/right frame
    let by = outer_h - client_h - bx;   // top = title bar + top frame
    (outer.left + bx + cx, outer.top + by + cy)
}

// ── Host window class ─────────────────────────────────────────────────────────

const HOST_CLASS: PCWSTR = w!("OrbRdpHostWnd");

unsafe extern "system" fn host_wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn register_host_class() {
    unsafe {
        let hmod = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(host_wnd_proc),
            lpszClassName: HOST_CLASS,
            hInstance: hmod.into(),
            ..Default::default()
        };
        RegisterClassW(&wc);
    }
}

// ── STA thread ────────────────────────────────────────────────────────────────

struct LaunchParams {
    app: tauri::AppHandle,
    session_id: String,
    parent_hwnd: isize,
    host: String,
    port: u16,
    username: String,
    domain: String,
    password: Option<String>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    admin_mode: bool,
}

fn sta_thread(
    params: LaunchParams,
    result_tx: mpsc::SyncSender<Result<mpsc::SyncSender<ComCmd>, String>>,
) {
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            let _ = result_tx.send(Err("CoInitializeEx failed".into()));
            return;
        }

        register_host_class();

        // Write registry suppression values and credentials BEFORE creating the COM
        // object so mstscax reads them at activation time (DoVerb/Connect).
        // mstscax reads WarnAbout* and UsernameHint during control initialization,
        // not at Connect() time — writing after DoVerb is too late.
        if let Some(ref pw) = params.password {
            store_rdp_credential(&params.host, params.port, &params.username, &params.domain, pw);
        }
        set_rdp_warning_dialog_version();
        suppress_rdp_server_registry(&params.host, params.port, &params.username, &params.domain);

        let hmod = GetModuleHandleW(None).unwrap_or_default();
        // parent = Tauri main window (top-level application frame)
        let mut parent = HWND(params.parent_hwnd as *mut _);
        let w = params.width.max(640);
        let h = params.height.max(480);

        // Convert canvas-relative coords to screen coords.
        // The params x/y are relative to the Tauri window's client area.
        let (sx, sy) = canvas_to_screen(parent, params.x, params.y);

        // WS_POPUP (not WS_CHILD): floats above WebView2's DirectComposition layer.
        // WS_CHILD windows sit below DComp and appear black regardless of z-order.
        // WS_EX_TOOLWINDOW: suppress taskbar entry for this auxiliary window.
        // Passing `parent` as hWndParent sets the Win32 owner at creation time —
        // owned popups stay above their owner in z-order but are NOT topmost,
        // so other applications can be brought to the foreground normally.
        // Never change the owner at runtime via SetWindowLongPtrW(GWLP_HWNDPARENT):
        // that sends a synchronous cross-thread Win32 message which deadlocks.
        let host_hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW,
            HOST_CLASS, w!(""),
            WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            sx, sy, w, h,
            Some(parent), None, Some(hmod.into()), None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                let _ = result_tx.send(Err(format!("CreateWindowExW: {e}")));
                CoUninitialize();
                return;
            }
        };

        // HWND_TOP: owned popup (owner set in CreateWindowExW) stays above its
        // owner (Tauri) in z-order but is NOT always-on-top, so other applications
        // can be brought to the foreground normally.
        // Start hidden: shown by the tick once ConnectionState == 2, so no white
        // flash appears during NLA/cert authentication dialogs.
        SetWindowPos(host_hwnd, Some(HWND_TOP), sx, sy, w, h,
            SWP_NOACTIVATE).ok();

        // Try MsRdpClient10 first, fall back to MsRdpClient9 for older Windows
        let rdp_unk: IUnknown = match CoCreateInstance(&CLSID_MSTSC_10, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CLSID_MSTSC_9, None, CLSCTX_INPROC_SERVER))
        {
            Ok(u) => u,
            Err(e) => {
                let _ = result_tx.send(Err(format!(
                    "mstscax.dll no encontrado ({e})\nInstala Remote Desktop Connection."
                )));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        let ole_obj: IOleObject = match rdp_unk.cast() {
            Ok(o) => o,
            Err(e) => {
                let _ = result_tx.send(Err(format!("IOleObject QI: {e}")));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        // frame → top-level application window (Tauri main window).
        // IOleInPlaceFrame::GetWindow MUST return the top-level frame, not the
        // container. mstscax validates this to create its rendering surface.
        let frame: IOleInPlaceFrame = RdpFrame { hwnd: parent }.into();
        let site: IOleClientSite = RdpSite { hwnd: host_hwnd, frame: frame.clone() }.into();

        if let Err(e) = ole_obj.SetClientSite(Some(&site)) {
            let _ = result_tx.send(Err(format!("SetClientSite: {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        let _ = OleSetContainedObject(&rdp_unk, true);
        let _ = ole_obj.SetHostNames(w!("OrbitalTerm"), w!(""));

        // NegotiateSecurityLayer must be set before DoVerb (vtable[12] on NS3).
        // All other NS3/NS5 dialog-suppression calls happen after DoVerb in
        // suppress_rdp_dialogs — calling them before activation crashes (AV).
        {
            const IID_NS3: GUID = GUID::from_values(0xB3378D90, 0x0728, 0x45C7, [0x8E, 0xD7, 0xB6, 0x15, 0x9F, 0xB9, 0x22, 0x19]);
            type QIFn    = unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> i32;
            type PutBool = unsafe extern "system" fn(*mut core::ffi::c_void, i16) -> i32;
            type RelFn   = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;
            let raw = rdp_unk.as_raw() as *mut core::ffi::c_void;
            let qi: QIFn = core::mem::transmute(*(*(raw as *const *const usize)).add(0));
            let mut ns3: *mut core::ffi::c_void = core::ptr::null_mut();
            if qi(raw, &IID_NS3, &mut ns3) >= 0 && !ns3.is_null() {
                let v: *const usize = *(ns3 as *const *const usize);
                let put_neg_sec: PutBool = core::mem::transmute(*v.add(12));
                let release: RelFn       = core::mem::transmute(*v.add(2));
                let h = put_neg_sec(ns3, -1i16);
                eprintln!("[rdp] pre-DoVerb NegotiateSecurityLayer=1 hr=0x{:08X}", h as u32);
                release(ns3);
            }
        }

        let mut rc = RECT { left: 0, top: 0, right: w, bottom: h };

        let dv_result = ole_obj.DoVerb(-5i32, std::ptr::null(), &site, 0, host_hwnd, &rc);
        if dv_result.is_err() {
            let _ = ole_obj.DoVerb(-1i32, std::ptr::null(), &site, 0, host_hwnd, &rc);
        }

        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
            let _ = ipo.SetObjectRects(&rc, &rc);
        }

        let disp: IDispatch = match rdp_unk.cast() {
            Ok(d) => d,
            Err(e) => {
                let _ = result_tx.send(Err(format!("IDispatch QI: {e}")));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        // ── RDP properties ────────────────────────────────────────────────────
        let _ = put_bstr(&disp, "Server", &params.host);
        let _ = put_i4(&disp, "RDPPort", params.port as i32);
        let _ = put_bstr(&disp, "UserName", &params.username);
        if !params.domain.is_empty() {
            let _ = put_bstr(&disp, "Domain", &params.domain);
        }
        let _ = put_i4(&disp, "DesktopWidth", w);
        let _ = put_i4(&disp, "DesktopHeight", h);
        let _ = put_bool_prop(&disp, "FullScreen", false);
        // IMsRdpClient5::AuthenticationLevel = 0 → connect without certificate warning.
        // Setting it here on the main client AND on AdvancedSettings ensures both
        // interfaces suppress the "Precaución: conexión remota desconocida" dialog.
        let _ = put_i4(&disp, "AuthenticationLevel", 0);

        // AdvancedSettings: password, security layer, and AuthenticationLevel.
        // AuthenticationLevel MUST be set on AdvancedSettings (not the main
        // client object) to actually suppress the "unknown certificate" warning.
        let adv_names = ["AdvancedSettings9","AdvancedSettings7","AdvancedSettings5","AdvancedSettings2"];
        let adv = adv_names.iter().find_map(|name| {
            get_dispatch_sub(&disp, name).ok().map(|d| { eprintln!("[rdp] AdvancedSettings: {name}"); d })
        });
        if let Some(ref adv) = adv {
            if let Some(ref pw) = params.password {
                let r = put_bstr(adv, "ClearTextPassword", pw);
                eprintln!("[rdp] ClearTextPassword hr=0x{:08X}", r.as_ref().err()
                    .map(|e| e.code().0 as u32).unwrap_or(0));
            }
            let _ = put_i4(adv, "RDPPort", params.port as i32);
            let _ = put_bool_prop(adv, "EnableCredSspSupport", true);
            let _ = put_bool_prop(adv, "SmartSizing", true);
            // 0 = always connect even if cert doesn't match → suppresses warning dialog
            let _ = put_i4(adv, "AuthenticationLevel", 0);
            // Enable clipboard redirect explicitly so WarnAboutClipboardRedirection
            // can be set to FALSE below without returning E_INVALIDARG.
            let _ = put_bool_prop(adv, "RedirectClipboard", true);
            if params.admin_mode {
                let _ = put_i4(adv, "ConnectToAdministerServer", 1);
            }
        }

        // WarnAbout* suppression via COM (best-effort; registry writes above are primary).
        suppress_rdp_dialogs(&rdp_unk);

        // Install thread-local CBT hook to auto-dismiss any #32770 dialogs with
        // an IDYES button (redirect/security warnings) before the user sees them.
        // Installed just before Connect() so it's active during the whole session.
        {
            use windows::Win32::System::Threading::GetCurrentThreadId;
            match SetWindowsHookExW(WH_CBT, Some(rdp_auto_dismiss_proc), None, GetCurrentThreadId()) {
                Ok(hook) => {
                    RDP_AUTO_DISMISS_HOOK.store(hook.0 as isize, Ordering::Relaxed);
                    eprintln!("[rdp] CBT hook installed");
                }
                Err(e) => eprintln!("[rdp] CBT hook failed: {e:?}"),
            }
        }

        // Cross-thread dialog watcher: polls EnumWindows every 150 ms so that
        // clipboard/credential warning dialogs created on mstscax worker threads
        // are also auto-dismissed (the CBT hook above only fires on this thread).
        use windows::Win32::System::Threading::GetCurrentProcessId;
        WATCHER_PID.store(GetCurrentProcessId(), Ordering::Relaxed);
        let watcher_done = Arc::new(AtomicBool::new(false));
        {
            let done = watcher_done.clone();
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    unsafe { EnumWindows(Some(watcher_dismiss_cb), LPARAM(0)).ok() };
                    // Once a dismissed dialog is fully gone, clear the pending slot
                    // so new dialogs (new HWNDs) are not skipped.
                    let p = WATCHER_PENDING.load(Ordering::Relaxed);
                    if p != 0 {
                        let h = HWND(p as *mut _);
                        if !unsafe { IsWindow(Some(h)) }.as_bool() {
                            WATCHER_PENDING.store(0, Ordering::Relaxed);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                WATCHER_PID.store(0, Ordering::Relaxed);
                WATCHER_PENDING.store(0, Ordering::Relaxed);
                eprintln!("[rdp] watcher thread exited");
            });
        }
        eprintln!("[rdp] cross-thread watcher started");

        if let Err(e) = call_no_args(&disp, "Connect") {
            let _ = result_tx.send(Err(format!("RDP Connect(): {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        // ── COM connection point: subscribe to mstscax events ────────────────
        // DISPID 3 (OnLoginComplete) and DISPID 4 (OnDisconnected) arrive
        // synchronously on this STA thread during DispatchMessageW.
        // All events in a session (connect → login → disconnect) can arrive in a
        // single message-pump pass before the first 100ms polling tick fires, so
        // ever_connected must be set from the event (DISPID 3), not only from polling.
        let event_logged_in    = Arc::new(AtomicBool::new(false));
        let event_disconnected = Arc::new(AtomicBool::new(false));
        // Vec of (connection_point, advise_cookie) kept alive until after loop.
        let mut cp_registrations: Vec<(IConnectionPoint, u32)> = Vec::new();

        if let Ok(cpc) = rdp_unk.cast::<IConnectionPointContainer>() {
            // Build the event sink once; it will be Advise-d to whichever
            // connection point(s) mstscax exposes.  new_event_sink responds to
            // QI for both the mstscax-specific CP IID and standard IDispatch,
            // so Advise succeeds regardless of which IID mstscax checks.
            let sink_unk = new_event_sink(event_logged_in.clone(), event_disconnected.clone());

            // Try the well-known DIID_IMsTscAxEvents IID first.
            // If it fails (different mstscax version / connection point layout),
            // enumerate all available connection points and subscribe to every one.
            // Our Invoke only acts on DISPID 2 and 4, so extra CPs are harmless.
            let candidates: Vec<IConnectionPoint> =
                match cpc.FindConnectionPoint(&IID_DMSRDPCLIENTEVENTS) {
                    Ok(cp) => {
                        eprintln!("[rdp] FindConnectionPoint(DIID_IMsTscAxEvents) ok");
                        vec![cp]
                    }
                    Err(e) => {
                        eprintln!("[rdp] FindConnectionPoint failed ({e:?}), enumerating...");
                        let mut all = Vec::new();
                        if let Ok(enum_cp) = cpc.EnumConnectionPoints() {
                            loop {
                                let mut cp_arr = [None::<IConnectionPoint>; 1];
                                let mut fetched: u32 = 0;
                                // Next(slice, *mut u32) → HRESULT:
                                //   S_OK(0) = more items; S_FALSE(1) = end; <0 = error
                                let hr = enum_cp.Next(&mut cp_arr, &mut fetched);
                                if fetched == 0 { break; }
                                if let Some(cp) = cp_arr[0].take() {
                                    if let Ok(iid) = cp.GetConnectionInterface() {
                                        eprintln!("[rdp] Available CP IID: {iid:?}");
                                    }
                                    all.push(cp);
                                }
                                if hr.0 != 0 { break; } // S_FALSE(1) or error = end
                            }
                        } else {
                            eprintln!("[rdp] EnumConnectionPoints also failed");
                        }
                        all
                    }
                };

            for cp in candidates {
                match cp.Advise(&sink_unk) {
                    Ok(cookie) => {
                        eprintln!("[rdp] Advise ok cookie={cookie}");
                        cp_registrations.push((cp, cookie));
                    }
                    Err(e) => eprintln!("[rdp] Advise failed: {e:?}"),
                }
            }
            if cp_registrations.is_empty() {
                eprintln!("[rdp] No CPs registered — falling back to polling only");
            }
        } else {
            eprintln!("[rdp] QI IConnectionPointContainer failed");
        }

        let (tx, rx) = mpsc::sync_channel::<ComCmd>(16);
        let _ = result_tx.send(Ok(tx));

        // Track canvas-relative position so we can re-apply ClientToScreen
        // when the parent moves (e.g. window drag).
        let mut rel_x = params.x;
        let mut rel_y = params.y;
        let mut last_parent_rect = RECT::default();
        GetWindowRect(parent, &mut last_parent_rect).ok();
        // Gate visibility on session-connected so the blank host window never
        // appears during NLA / cert authentication dialogs.
        let mut rdp_connected   = false; // true once the session is established
        let mut ever_connected  = false; // latch: true once connected, never reset
        let mut show_pending    = false; // Show arrived before rdp_connected
        let mut dispatch_errors = 0u32; // consecutive get_i4 errors after connected

        // ── Message / command loop ─────────────────────────────────────────────
        let mut msg = MSG::default();
        let mut tick = 0u32;
        'outer: loop {
            // Drain the command channel
            loop {
                match rx.try_recv() {
                    Ok(ComCmd::Reposition { x, y, width, height }) => {
                        rel_x = x;
                        rel_y = y;
                        let (sx, sy) = canvas_to_screen(parent, x, y);
                        // No SWP_SHOWWINDOW: never reveal during auth dialogs.
                        // Visibility is controlled exclusively by Show/Hide and the
                        // connect/disconnect handlers below.
                        SetWindowPos(host_hwnd, Some(HWND_TOP), sx, sy, width, height,
                            SWP_NOACTIVATE).ok();
                        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
                            let r = RECT { left: 0, top: 0, right: width, bottom: height };
                            let _ = ipo.SetObjectRects(&r, &r);
                        }
                    }
                    Ok(ComCmd::Show) => {
                        if rdp_connected {
                            let _ = ShowWindow(host_hwnd, SW_SHOW);
                            SetWindowPos(host_hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();
                        } else {
                            show_pending = true;
                        }
                    }
                    Ok(ComCmd::Hide) => {
                        show_pending = false;
                        let _ = ShowWindow(host_hwnd, SW_HIDE);
                    }
                    Ok(ComCmd::Reparent { new_parent, rel_x: new_rel_x, rel_y: new_rel_y, width, height }) => {
                        let new_hwnd = HWND(new_parent as *mut _);
                        // Update the tracked parent for canvas_to_screen calculations.
                        // Do NOT call SetWindowLongPtrW(GWLP_HWNDPARENT) — it sends a
                        // synchronous cross-thread Win32 message that deadlocks this STA thread.
                        // HWND_TOP keeps the WS_POPUP above the new window's DComp layer.
                        parent = new_hwnd;
                        GetWindowRect(parent, &mut last_parent_rect).ok();
                        rel_x = new_rel_x;
                        rel_y = new_rel_y;
                        let (sx, sy) = canvas_to_screen(parent, rel_x, rel_y);
                        SetWindowPos(host_hwnd, Some(HWND_TOP), sx, sy, width, height,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW).ok();
                        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
                            let r = RECT { left: 0, top: 0, right: width, bottom: height };
                            let _ = ipo.SetObjectRects(&r, &r);
                        }
                    }
                    Ok(ComCmd::Disconnect) | Err(mpsc::TryRecvError::Disconnected) => {
                        let _ = call_no_args(&disp, "Disconnect");
                        PostQuitMessage(0);
                        break 'outer;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }

            // Pump the COM STA message queue.
            // mstscax fires IMsTscAxEvents (OnConnected, OnDisconnected, …) as
            // window messages on this thread; DispatchMessageW delivers them to
            // our ev_sink_invoke synchronously.
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT { break 'outer; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // ── COM event checks (every tick = 16 ms) ────────────────────────
            // Process in order: logged_in first so a same-tick login+disconnect
            // is handled correctly (ever_connected set before disconnect check).

            // DISPID 3 = OnLoginComplete: Windows session login succeeded.
            // This is our primary ever_connected signal because all events —
            // including both DISPID 3 and DISPID 4 — can arrive in a single
            // message-pump pass before the first 100ms polling tick fires.
            if event_logged_in.load(Ordering::SeqCst) {
                event_logged_in.store(false, Ordering::SeqCst);
                ever_connected = true;
                eprintln!("[rdp] login complete — session armed for disconnect detection");
            }

            // DISPID 4 = OnDisconnected: session ended — hide popup and exit loop.
            // Guard with ever_connected so a failed/rejected connection attempt
            // (no DISPID 3) doesn't close the tab; the user can retry.
            if ever_connected && event_disconnected.load(Ordering::SeqCst) {
                eprintln!("[rdp] OnDisconnected event — closing session");
                rdp_connected = false;
                show_pending  = false;
                let _ = ShowWindow(host_hwnd, SW_HIDE);
                break 'outer;
            }

            // ── Slow path (every ~100 ms): parent liveness + polling fallback ─
            tick += 1;
            if tick % 6 == 0 {
                // If the owner window (Tauri) was destroyed (e.g. detached window
                // closed without going through disconnect_rdp), clean up and exit
                // so the WS_POPUP doesn't orphan on the screen.
                if !IsWindow(Some(parent)).as_bool() {
                    let _ = call_no_args(&disp, "Disconnect");
                    PostQuitMessage(0);
                    break 'outer;
                }

                // ConnectionState polling: primary use is detecting the initial
                // connection (state 2 → show window) for the case where OnConnected
                // fired before Advise was called. Also acts as a fallback disconnect
                // guard when the event sink was not registered.
                match get_i4(&disp, "ConnectionState") {
                    Ok(2) if !rdp_connected => {
                        dispatch_errors = 0;
                        rdp_connected  = true;
                        ever_connected = true;
                        if show_pending {
                            show_pending = false;
                            let _ = ShowWindow(host_hwnd, SW_SHOW);
                            SetWindowPos(host_hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();
                        }
                    }
                    // States 0 (NOT_CONNECTED) or 3 (DISCONNECTING) after being connected
                    Ok(0) | Ok(3) if rdp_connected => {
                        rdp_connected = false;
                        show_pending  = false;
                        let _ = ShowWindow(host_hwnd, SW_HIDE);
                        break 'outer;
                    }
                    Ok(_) => { dispatch_errors = 0; }
                    Err(_) if rdp_connected => {
                        // COM error while connected: count consecutive failures.
                        dispatch_errors += 1;
                        if dispatch_errors >= 3 {
                            rdp_connected = false;
                            show_pending  = false;
                            let _ = ShowWindow(host_hwnd, SW_HIDE);
                            break 'outer;
                        }
                    }
                    Err(_) => {}
                }

                let mut cur = RECT::default();
                GetWindowRect(parent, &mut cur).ok();
                if cur.left != last_parent_rect.left || cur.top != last_parent_rect.top {
                    let (sx, sy) = canvas_to_screen(parent, rel_x, rel_y);
                    SetWindowPos(host_hwnd, None, sx, sy, 0, 0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE).ok();
                    last_parent_rect = cur;
                }
            }

            std::thread::sleep(Duration::from_millis(16));
        }

        // Remove the CBT hook now that the session is ending.
        let hook_raw = RDP_AUTO_DISMISS_HOOK.swap(0, Ordering::Relaxed);
        if hook_raw != 0 {
            let _ = UnhookWindowsHookEx(HHOOK(hook_raw as *mut std::ffi::c_void));
        }

        // Signal the cross-thread watcher to stop.
        watcher_done.store(true, Ordering::Relaxed);

        // Unregister all COM event sink registrations before releasing.
        for (cp, cookie) in &cp_registrations {
            let _ = cp.Unadvise(*cookie);
        }
        drop(cp_registrations);

        // Notify the frontend regardless of WHY the loop exited (user log-off,
        // WM_QUIT from mstscax, parent window destroyed, explicit Disconnect cmd).
        // The listener in RdpPane is already unregistered if the tab was manually
        // closed, so this is a no-op in that case.
        if ever_connected {
            params.app.emit(
                &format!("rdp-disconnected-{}", params.session_id),
                (),
            ).ok();
        }

        let _ = ole_obj.SetClientSite(None);
        DestroyWindow(host_hwnd).ok();
        drop(disp);
        drop(ole_obj);
        drop(site);
        drop(frame);
        CoUninitialize();
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn launch(
    app: tauri::AppHandle,
    session_id: &str,
    parent_hwnd: HWND,
    host: &str,
    port: u16,
    username: &str,
    domain: &str,
    password: Option<&str>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    admin_mode: bool,
) -> Result<WindowsRdpSession, String> {
    let params = LaunchParams {
        app,
        session_id: session_id.to_string(),
        parent_hwnd: parent_hwnd.0 as isize,
        host: host.to_string(),
        port,
        username: username.to_string(),
        domain: domain.to_string(),
        password: password.map(str::to_string),
        x, y, width, height,
        admin_mode,
    };
    let (result_tx, result_rx) = mpsc::sync_channel::<Result<mpsc::SyncSender<ComCmd>, String>>(1);
    std::thread::spawn(move || sta_thread(params, result_tx));
    let tx = result_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "El hilo COM-RDP no respondió a tiempo".to_string())??;
    Ok(WindowsRdpSession { tx })
}

pub fn reposition(session: &WindowsRdpSession, x: i32, y: i32, width: i32, height: i32) {
    let _ = session.tx.try_send(ComCmd::Reposition { x, y, width, height });
}

pub fn show(session: &WindowsRdpSession) {
    let _ = session.tx.try_send(ComCmd::Show);
}

pub fn hide(session: &WindowsRdpSession) {
    let _ = session.tx.try_send(ComCmd::Hide);
}

pub fn reparent(session: &WindowsRdpSession, new_parent: HWND, rel_x: i32, rel_y: i32, width: i32, height: i32) {
    let _ = session.tx.try_send(ComCmd::Reparent {
        new_parent: new_parent.0 as isize,
        rel_x, rel_y, width, height,
    });
}
