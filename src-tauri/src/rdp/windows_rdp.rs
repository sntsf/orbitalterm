#![cfg(target_os = "windows")]

//! Embedded RDP on Windows via COM in-process hosting of mstscax.dll.
//!
//! We load MsRdpClient10 (`mstscax.dll`) directly in-process using COM
//! ActiveX, identical to how mRemoteNG embeds RDP.  No mstsc.exe is launched.
//!
//! Architecture:
//!   - A dedicated STA COM thread owns the Win32 host window and all COM objects.
//!   - The public API communicates with that thread via an `mpsc` channel.
//!   - The STA thread runs a Win32 message loop; COM events are dispatched there.

use std::sync::mpsc;
use std::time::Duration;

use windows::Win32::Foundation::{E_NOTIMPL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::*;
use windows::Win32::System::Variant::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{implement, w, BOOL, BSTR, GUID, IUnknown, Interface, OutRef, Ref, PCWSTR};

// ── CLSID ─────────────────────────────────────────────────────────────────────

// MsRdpClient10 shipped in mstscax.dll
const CLSID_MSTSC: GUID = GUID::from_values(
    0xC0EFA91A,
    0xEEB7,
    0x41C7,
    [0x97, 0xFA, 0xF0, 0xED, 0x64, 0x5E, 0xFB, 0x24],
);

// ── Command channel ───────────────────────────────────────────────────────────

enum ComCmd {
    Reposition { x: i32, y: i32, width: i32, height: i32 },
    Show,
    Hide,
    Disconnect,
}

// ── Session (public handle) ───────────────────────────────────────────────────

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

// ── OLE site ──────────────────────────────────────────────────────────────────

#[implement(IOleClientSite, IOleInPlaceSite, IOleInPlaceFrame)]
struct RdpSite {
    hwnd: HWND,
}

impl IOleClientSite_Impl for RdpSite_Impl {
    fn SaveObject(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetMoniker(
        &self,
        _dwassign: &OLEGETMONIKER,
        _dwwhichmoniker: &OLEWHICHMK,
    ) -> windows::core::Result<IMoniker> {
        Err(E_NOTIMPL.into())
    }
    fn GetContainer(&self) -> windows::core::Result<IOleContainer> {
        Err(E_NOTIMPL.into())
    }
    fn ShowObject(&self) -> windows::core::Result<()> { Ok(()) }
    fn OnShowWindow(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn RequestNewObjectLayout(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
}

impl IOleWindow_Impl for RdpSite_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> {
        Ok(self.hwnd)
    }
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
            ppframe.write(None);
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

impl IOleInPlaceUIWindow_Impl for RdpSite_Impl {
    fn GetBorder(&self) -> windows::core::Result<RECT> {
        Err(E_NOTIMPL.into())
    }
    fn RequestBorderSpace(&self, _: *const BORDERWIDTHS) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn SetBorderSpace(&self, _: *const BORDERWIDTHS) -> windows::core::Result<()> { Ok(()) }
    fn SetActiveObject(
        &self,
        _: Ref<'_, IOleInPlaceActiveObject>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> { Ok(()) }
}

impl IOleInPlaceFrame_Impl for RdpSite_Impl {
    fn InsertMenus(
        &self,
        _: HMENU,
        _: *mut OLEMENUGROUPWIDTHS,
    ) -> windows::core::Result<()> { Ok(()) }
    fn SetMenu(&self, _: HMENU, _: isize, _: HWND) -> windows::core::Result<()> { Ok(()) }
    fn RemoveMenus(&self, _: HMENU) -> windows::core::Result<()> { Ok(()) }
    fn SetStatusText(&self, _: &PCWSTR) -> windows::core::Result<()> { Ok(()) }
    fn EnableModeless(&self, _: BOOL) -> windows::core::Result<()> { Ok(()) }
    fn TranslateAccelerator(&self, _: *const MSG, _: u16) -> windows::core::Result<()> {
        Err(windows::Win32::Foundation::S_FALSE.into())
    }
}

// ── IDispatch helpers ─────────────────────────────────────────────────────────

fn get_dispid(disp: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let bname = BSTR::from_wide(&wide[..wide.len() - 1])?;
    let mut name_ptr = bname.as_raw();
    let mut id = 0i32;
    unsafe {
        disp.GetIDsOfNames(&GUID::zeroed(), &mut name_ptr, 1, 0x0409, &mut id)?;
    }
    Ok(id)
}

fn put_bstr(disp: &IDispatch, name: &str, value: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    let bval = BSTR::from(value);
    let mut var = VARIANT::default();
    unsafe {
        let inner = var.as_raw_mut();
        (*inner).Anonymous.Anonymous.vt = VT_BSTR;
        (*inner).Anonymous.Anonymous.Anonymous.bstrVal = std::mem::ManuallyDrop::new(bval);
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(
            id,
            &GUID::zeroed(),
            0x0409,
            DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None,
        )?;
    }
    Ok(())
}

fn put_i4(disp: &IDispatch, name: &str, value: i32) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    let mut var = VARIANT::default();
    unsafe {
        let inner = var.as_raw_mut();
        (*inner).Anonymous.Anonymous.vt = VT_I4;
        (*inner).Anonymous.Anonymous.Anonymous.lVal = value;
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(
            id,
            &GUID::zeroed(),
            0x0409,
            DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None,
        )?;
    }
    Ok(())
}

fn put_bool_prop(disp: &IDispatch, name: &str, value: bool) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    let mut var = VARIANT::default();
    unsafe {
        let inner = var.as_raw_mut();
        (*inner).Anonymous.Anonymous.vt = VT_BOOL;
        // VARIANT_BOOL: -1 = TRUE, 0 = FALSE
        (*inner).Anonymous.Anonymous.Anonymous.boolVal = if value { -1i16 } else { 0i16 };
        let mut named = DISPID_PROPERTYPUT;
        disp.Invoke(
            id,
            &GUID::zeroed(),
            0x0409,
            DISPATCH_PROPERTYPUT,
            &DISPPARAMS { rgvarg: &mut var, rgdispidNamedArgs: &mut named, cArgs: 1, cNamedArgs: 1 },
            None, None, None,
        )?;
    }
    Ok(())
}

fn get_dispatch_sub(disp: &IDispatch, name: &str) -> windows::core::Result<IDispatch> {
    let id = get_dispid(disp, name)?;
    let mut result = VARIANT::default();
    unsafe {
        disp.Invoke(
            id,
            &GUID::zeroed(),
            0x0409,
            DISPATCH_PROPERTYGET,
            &DISPPARAMS {
                rgvarg: std::ptr::null_mut(),
                rgdispidNamedArgs: std::ptr::null_mut(),
                cArgs: 0,
                cNamedArgs: 0,
            },
            Some(&mut result),
            None,
            None,
        )?;
        let vt = (*result.as_raw()).Anonymous.Anonymous.vt;
        if vt == VT_DISPATCH {
            let raw = (*result.as_raw()).Anonymous.Anonymous.Anonymous.pdispVal;
            if !raw.is_null() {
                let iface = IDispatch::from_raw(raw as *mut _);
                std::mem::forget(result);
                return Ok(iface);
            }
        }
    }
    Err(E_NOTIMPL.into())
}

fn call_no_args(disp: &IDispatch, name: &str) -> windows::core::Result<()> {
    let id = get_dispid(disp, name)?;
    unsafe {
        disp.Invoke(
            id,
            &GUID::zeroed(),
            0x0409,
            DISPATCH_METHOD,
            &DISPPARAMS {
                rgvarg: std::ptr::null_mut(),
                rgdispidNamedArgs: std::ptr::null_mut(),
                cArgs: 0,
                cNamedArgs: 0,
            },
            None, None, None,
        )?;
    }
    Ok(())
}

// ── Host window ───────────────────────────────────────────────────────────────

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
        RegisterClassW(&wc); // ignore "already registered" error
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

        let host_hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            HOST_CLASS,
            w!(""),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            params.x, params.y, w, h,
            Some(parent),
            None,
            Some(hmod.into()),
            None,
        );
        if host_hwnd.is_invalid() {
            let _ = result_tx.send(Err("CreateWindowExW failed".into()));
            CoUninitialize();
            return;
        }

        // Load mstscax.dll in-process
        let rdp_unk: IUnknown = match CoCreateInstance(&CLSID_MSTSC, None, CLSCTX_INPROC_SERVER) {
            Ok(u) => u,
            Err(e) => {
                let _ = result_tx.send(Err(format!(
                    "mstscax.dll no encontrado (CoCreateInstance: {e})\n\
                     Instala Remote Desktop Connection en Windows."
                )));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        let ole_obj: IOleObject = match rdp_unk.cast() {
            Ok(o) => o,
            Err(e) => {
                let _ = result_tx.send(Err(format!("IOleObject QI failed: {e}")));
                DestroyWindow(host_hwnd).ok();
                CoUninitialize();
                return;
            }
        };

        // Build OLE client site and attach
        let site: IOleClientSite = RdpSite { hwnd: host_hwnd }.into();

        if let Err(e) = ole_obj.SetClientSite(Some(&site)) {
            let _ = result_tx.send(Err(format!("SetClientSite failed: {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        // In-place activate → control renders into host_hwnd
        let mut rc = RECT::default();
        GetClientRect(host_hwnd, &mut rc).ok();
        let _ = ole_obj.DoVerb(
            OLEIVERB_INPLACEACTIVATE,
            None,
            Some(&site),
            0,
            Some(host_hwnd),
            Some(&rc),
        );

        // Configure via IDispatch
        let disp: IDispatch = match rdp_unk.cast() {
            Ok(d) => d,
            Err(e) => {
                let _ = result_tx.send(Err(format!("IDispatch QI failed: {e}")));
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

        // AdvancedSettings — try newest surface first
        let adv = get_dispatch_sub(&disp, "AdvancedSettings9")
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings7"))
            .or_else(|_| get_dispatch_sub(&disp, "AdvancedSettings2"));
        if let Ok(adv) = adv {
            if let Some(ref pw) = params.password {
                let _ = put_bstr(&adv, "ClearTextPassword", pw);
            }
            let _ = put_i4(&adv, "RDPPort", params.port as i32);
            let _ = put_bool_prop(&adv, "EnableCredSspSupport", true);
            let _ = put_bool_prop(&adv, "NegotiateSecurityLayer", true);
        }

        if let Err(e) = call_no_args(&disp, "Connect") {
            let _ = result_tx.send(Err(format!("RDP Connect() failed: {e}")));
            DestroyWindow(host_hwnd).ok();
            CoUninitialize();
            return;
        }

        // Hand back the command channel
        let (tx, rx) = mpsc::sync_channel::<ComCmd>(16);
        let _ = result_tx.send(Ok(tx));

        // Message + command loop
        let mut msg = MSG::default();
        'outer: loop {
            loop {
                match rx.try_recv() {
                    Ok(ComCmd::Reposition { x, y, width, height }) => {
                        SetWindowPos(
                            host_hwnd,
                            Some(HWND_TOP),
                            x, y, width, height,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        ).ok();
                    }
                    Ok(ComCmd::Show) => {
                        ShowWindow(host_hwnd, SW_SHOW);
                        SetWindowPos(
                            host_hwnd,
                            Some(HWND_TOP),
                            0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE,
                        ).ok();
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
        host: host.to_string(),
        port,
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
