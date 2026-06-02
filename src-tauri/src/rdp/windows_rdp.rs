#![cfg(target_os = "windows")]

//! Embedded RDP on Windows via COM in-process hosting of mstscax.dll.
//! No mstsc.exe process is launched — identical to mRemoteNG's approach.

use std::sync::mpsc;
use std::time::Duration;

use windows::Win32::Foundation::{E_NOTIMPL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{implement, w, BOOL, BSTR, GUID, IUnknown, Interface, OutRef, Ref, PCWSTR};

const CLSID_MSTSC: GUID = GUID::from_values(
    0xC0EFA91A, 0xEEB7, 0x41C7,
    [0x97, 0xFA, 0xF0, 0xED, 0x64, 0x5E, 0xFB, 0x24],
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
// mstscax requires a valid IOleInPlaceFrame from GetWindowContext to create
// its rendering surface.  Without it DoVerb(-5) silently fails and the
// control connects over TCP but never draws anything (black screen).

#[implement(IOleInPlaceFrame)]
struct RdpFrame {
    hwnd: HWND,
}

impl IOleWindow_Impl for RdpFrame_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> { Ok(self.hwnd) }
    fn ContextSensitiveHelp(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceUIWindow_Impl for RdpFrame_Impl {
    fn GetBorder(&self) -> windows::core::Result<RECT> { Err(E_NOTIMPL.into()) }
    // BORDERWIDTHS is a typedef for RECT in the Win32 SDK; windows 0.61 exposes it as RECT
    fn RequestBorderSpace(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
    fn SetBorderSpace(&self, _: *const RECT) -> windows::core::Result<()> { Ok(()) }
    fn SetActiveObject(&self, _: Ref<'_, IOleInPlaceActiveObject>, _: &PCWSTR) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceFrame_Impl for RdpFrame_Impl {
    fn InsertMenus(&self, _: HMENU, _: *mut OLEMENUGROUPWIDTHS) -> windows::core::Result<()> { Ok(()) }
    fn SetMenu(&self, _: HMENU, _: isize, _: HWND) -> windows::core::Result<()> { Ok(()) }
    fn RemoveMenus(&self, _: HMENU) -> windows::core::Result<()> { Ok(()) }
    fn SetStatusText(&self, _: &PCWSTR) -> windows::core::Result<()> { Ok(()) }
    fn EnableModeless(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn TranslateAccelerator(&self, _: *const MSG, _: u16) -> windows::core::Result<()> {
        // S_FALSE = "not handled by container" → let the control process it
        Err(windows::Win32::Foundation::S_FALSE.into())
    }
}

// ── OLE Site ──────────────────────────────────────────────────────────────────

#[implement(IOleClientSite, IOleInPlaceSite)]
struct RdpSite {
    hwnd: HWND,
    frame: IOleInPlaceFrame,
}

// SAFETY: used only on the STA COM thread
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
            ppframe.write(Some(self.frame.clone()));
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
                (*(r as *mut VarRaw)).vt = 0; // zero vt so VariantClear won't Release
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
    password: Option<String>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
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
        let parent = HWND(params.parent_hwnd as *mut _);
        let w = params.width.max(640);
        let h = params.height.max(480);

        let host_hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            HOST_CLASS, w!(""),
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            params.x, params.y, w, h,
            Some(parent), None, Some(hmod.into()), None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                let _ = result_tx.send(Err(format!("CreateWindowExW: {e}")));
                CoUninitialize();
                return;
            }
        };

        // Bring above WebView2 before the control activates
        SetWindowPos(host_hwnd, Some(HWND_TOP), params.x, params.y, w, h,
            SWP_SHOWWINDOW | SWP_NOACTIVATE).ok();

        let rdp_unk: IUnknown = match CoCreateInstance(&CLSID_MSTSC, None, CLSCTX_INPROC_SERVER) {
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

        // Build site + frame — frame must be non-null for DoVerb to succeed
        let frame: IOleInPlaceFrame = RdpFrame { hwnd: host_hwnd }.into();
        let site: IOleClientSite = RdpSite { hwnd: host_hwnd, frame: frame.clone() }.into();

        if let Err(e) = ole_obj.SetClientSite(Some(&site)) {
            let _ = result_tx.send(Err(format!("SetClientSite: {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        let mut rc = RECT::default();
        GetClientRect(host_hwnd, &mut rc).ok();

        // OLEIVERB_INPLACEACTIVATE = -5: creates the rendering surface inside host_hwnd
        let dv_result = ole_obj.DoVerb(-5i32, std::ptr::null(), &site, 0, host_hwnd, &rc);
        if dv_result.is_err() {
            // Fall back to OLEIVERB_SHOW = -1 if in-place activation fails
            let _ = ole_obj.DoVerb(-1i32, std::ptr::null(), &site, 0, host_hwnd, &rc);
        }

        // Tell the control its exact rendering rectangle
        if let Ok(ipo) = rdp_unk.cast::<IOleInPlaceObject>() {
            let _ = ipo.SetObjectRects(&rc as *const RECT, &rc as *const RECT);
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

        let _ = put_bstr(&disp, "Server", &params.host);
        let _ = put_i4(&disp, "RDPPort", params.port as i32);
        let _ = put_bstr(&disp, "UserName", &params.username);
        let _ = put_i4(&disp, "DesktopWidth", w);
        let _ = put_i4(&disp, "DesktopHeight", h);
        let _ = put_bool_prop(&disp, "FullScreen", false);

        let adv = get_dispatch_sub(&disp, "AdvancedSettings9")
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings7"))
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings2"));
        if let Ok(adv) = adv {
            if let Some(ref pw) = params.password {
                let _ = put_bstr(&adv, "ClearTextPassword", pw);
            }
            let _ = put_i4(&adv, "RDPPort", params.port as i32);
            let _ = put_bool_prop(&adv, "EnableCredSspSupport", true);
        }

        if let Err(e) = call_no_args(&disp, "Connect") {
            let _ = result_tx.send(Err(format!("RDP Connect(): {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        let (tx, rx) = mpsc::sync_channel::<ComCmd>(16);
        let _ = result_tx.send(Ok(tx));

        let mut msg = MSG::default();
        'outer: loop {
            loop {
                match rx.try_recv() {
                    Ok(ComCmd::Reposition { x, y, width, height }) => {
                        SetWindowPos(host_hwnd, Some(HWND_TOP), x, y, width, height,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW).ok();
                        // Keep the OLE in-place object sized to match
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
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT { break 'outer; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(16));
        }

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
    password: Option<&str>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    _admin_mode: bool,
) -> Result<WindowsRdpSession, String> {
    let params = LaunchParams {
        parent_hwnd: parent_hwnd.0 as isize,
        host: host.to_string(), port,
        username: username.to_string(),
        password: password.map(str::to_string),
        x, y, width, height,
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
