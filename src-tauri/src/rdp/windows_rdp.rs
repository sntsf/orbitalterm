#![cfg(target_os = "windows")]

//! Embedded RDP on Windows via COM in-process hosting of mstscax.dll.
//! No mstsc.exe process is launched — identical to mRemoteNG's approach.
//!
//! ## Z-order and WebView2
//! WebView2 renders via DirectComposition (DComp). Traditional WS_CHILD windows
//! exist in the Win32 z-order which lies BELOW the DComp layer — they appear
//! as black rectangles regardless of HWND_TOP. The fix is to use a WS_POPUP
//! window (not WS_CHILD) with an owner relationship (GWLP_HWNDPARENT) so it
//! sits above the DComp layer while still minimizing/restoring with Tauri.

use std::sync::mpsc;
use std::time::Duration;

use windows::Win32::Foundation::{E_NOTIMPL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{implement, w, BOOL, BSTR, GUID, IUnknown, Interface, OutRef, Ref, PCWSTR};

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

fn call_no_args(disp: &IDispatch, name: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        disp.Invoke(id, &GUID::zeroed(), 0x0409, DISPATCH_METHOD,
            &DISPPARAMS { rgvarg: std::ptr::null_mut(), rgdispidNamedArgs: std::ptr::null_mut(), cArgs: 0, cNamedArgs: 0 },
            None, None, None)
    }
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

        let hmod = GetModuleHandleW(None).unwrap_or_default();
        // parent = Tauri main window (top-level application frame)
        let parent = HWND(params.parent_hwnd as *mut _);
        let w = params.width.max(640);
        let h = params.height.max(480);

        // Convert canvas-relative coords to screen coords.
        // The params x/y are relative to the Tauri window's client area.
        let mut screen_origin = POINT { x: params.x, y: params.y };
        ClientToScreen(parent, &mut screen_origin);

        // WS_POPUP (not WS_CHILD): floats above WebView2's DirectComposition layer.
        // WS_CHILD windows sit below DComp and appear black regardless of z-order.
        // WS_EX_TOOLWINDOW: suppress taskbar entry for this auxiliary window.
        let host_hwnd = match CreateWindowExW(
            WS_EX_TOOLWINDOW,
            HOST_CLASS, w!(""),
            WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            screen_origin.x, screen_origin.y, w, h,
            None, None, Some(hmod.into()), None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                let _ = result_tx.send(Err(format!("CreateWindowExW: {e}")));
                CoUninitialize();
                return;
            }
        };

        // Owner relationship: popup minimizes/restores/always-on-top with Tauri.
        // This is the GWLP_HWNDPARENT trick — not the same as WS_CHILD parent.
        SetWindowLongPtrW(host_hwnd, GWLP_HWNDPARENT, parent.0 as isize);

        SetWindowPos(host_hwnd, Some(HWND_TOP), screen_origin.x, screen_origin.y, w, h,
            SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();

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

        // ── Store credentials in Windows Credential Manager ───────────────────
        // NLA/CredSSP reads from Credential Manager to suppress the credential
        // prompt even when ClearTextPassword is also set.
        if let Some(ref pw) = params.password {
            let target = format!("TERMSRV/{}", params.host);
            let user = if params.domain.is_empty() {
                params.username.clone()
            } else {
                format!("{}\\{}", params.domain, params.username)
            };
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("cmdkey")
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .args([
                        &format!("/add:{}", target),
                        &format!("/user:{}", user),
                        &format!("/pass:{}", pw),
                    ])
                    .status();
            }
        }

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

        // AdvancedSettings: password, security layer, and AuthenticationLevel.
        // AuthenticationLevel MUST be set on AdvancedSettings (not the main
        // client object) to actually suppress the "unknown certificate" warning.
        let adv = get_dispatch_sub(&disp, "AdvancedSettings9")
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings7"))
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings5"))
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings2"));
        if let Ok(ref adv) = adv {
            if let Some(ref pw) = params.password {
                let _ = put_bstr(adv, "ClearTextPassword", pw);
            }
            let _ = put_i4(adv, "RDPPort", params.port as i32);
            let _ = put_bool_prop(adv, "EnableCredSspSupport", true);
            let _ = put_bool_prop(adv, "SmartSizing", true);
            // 0 = always connect even if cert doesn't match → suppresses warning dialog
            let _ = put_i4(adv, "AuthenticationLevel", 0);
            if params.admin_mode {
                let _ = put_i4(adv, "ConnectToAdministerServer", 1);
            }
        }

        if let Err(e) = call_no_args(&disp, "Connect") {
            let _ = result_tx.send(Err(format!("RDP Connect(): {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        let (tx, rx) = mpsc::sync_channel::<ComCmd>(16);
        let _ = result_tx.send(Ok(tx));

        // Track canvas-relative position so we can re-apply ClientToScreen
        // when the parent moves (e.g. window drag).
        let mut rel_x = params.x;
        let mut rel_y = params.y;
        let mut last_parent_rect = RECT::default();
        GetWindowRect(parent, &mut last_parent_rect).ok();

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
                        let mut pt = POINT { x, y };
                        ClientToScreen(parent, &mut pt);
                        SetWindowPos(host_hwnd, Some(HWND_TOP), pt.x, pt.y, width, height,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW).ok();
                        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
                            let r = RECT { left: 0, top: 0, right: width, bottom: height };
                            let _ = ipo.SetObjectRects(&r, &r);
                        }
                    }
                    Ok(ComCmd::Show) => {
                        ShowWindow(host_hwnd, SW_SHOW);
                        SetWindowPos(host_hwnd, Some(HWND_TOP), 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();
                    }
                    Ok(ComCmd::Hide) => { ShowWindow(host_hwnd, SW_HIDE); }
                    Ok(ComCmd::Disconnect) | Err(mpsc::TryRecvError::Disconnected) => {
                        let _ = call_no_args(&disp, "Disconnect");
                        PostQuitMessage(0);
                        break 'outer;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }

            // Pump the COM STA message queue
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT { break 'outer; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Every ~100ms reposition the popup if the parent window moved.
            // Required because WS_POPUP doesn't automatically follow its owner.
            tick += 1;
            if tick % 6 == 0 {
                let mut cur = RECT::default();
                GetWindowRect(parent, &mut cur).ok();
                if cur.left != last_parent_rect.left || cur.top != last_parent_rect.top {
                    let mut pt = POINT { x: rel_x, y: rel_y };
                    ClientToScreen(parent, &mut pt);
                    let mut host_rect = RECT::default();
                    GetWindowRect(host_hwnd, &mut host_rect).ok();
                    let hw = host_rect.right - host_rect.left;
                    let hh = host_rect.bottom - host_rect.top;
                    SetWindowPos(host_hwnd, None, pt.x, pt.y, hw, hh,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE).ok();
                    last_parent_rect = cur;
                }
            }

            std::thread::sleep(Duration::from_millis(16));
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
