// OrbitalRdpHost.exe — WinForms RDP host for OrbitalTerm
//
// Usage:
//   OrbitalRdpHost.exe --server <host> --port <port> --user <user>
//                      [--parent <HWND>] [--admin] [--width <w>] [--height <h>]
//
// "user" can be:  DOMAIN\user  |  user@domain  |  plain user
// Password is read from stdin (first line).
//
// Stdout protocol:
//   STATE:connecting
//   STATE:connected
//   EVENT:OnLoginComplete
//   STATE:disconnected:<discReason>
//   ERROR:<msg>

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Windows.Forms;
using Microsoft.Win32;

// ── COM event interface (outgoing events from mstscax) ────────────────────────
[ComVisible(true)]
[Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IMsTscAxEvents
{
    [DispId(1)]  void OnConnecting();
    [DispId(2)]  void OnConnected();
    [DispId(3)]  void OnLoginComplete();
    [DispId(4)]  void OnDisconnected(int discReason);
    [DispId(10)] void OnFatalError(int errorCode);
    [DispId(11)] void OnWarning(int warningCode);
    [DispId(23)] void OnLogonError(int lError);
}

// ── IMsTscNonScriptable — password injection interface ────────────────────────
[ComImport]
[Guid("C1E6743A-41C1-4A74-832A-0DD06C1C7A0E")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMsTscNonScriptable
{
    void put_ClearTextPassword([MarshalAs(UnmanagedType.BStr)] string pass);
}

// ── Thin AxHost subclass ──────────────────────────────────────────────────────
// Inheriting AxHost provides a full OLE in-place site so ClearTextPassword works.
public sealed class RdpAxControl : AxHost
{
    public RdpAxControl(string clsidNoBraces) : base(clsidNoBraces) { }
    public object GetOcxObject() { return GetOcx(); }
}

// ── COM event sink ────────────────────────────────────────────────────────────
[ComVisible(true)]
public sealed class EventSink : IMsTscAxEvents
{
    static void Emit(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }

    public Action OnConnectedCallback;
    public Action<int> OnDisconnectedCallback;

    public void OnConnecting()                    { Emit("STATE:connecting"); }
    public void OnConnected()                     { if (OnConnectedCallback != null) OnConnectedCallback(); }
    public void OnLoginComplete()                 { Emit("EVENT:OnLoginComplete"); }
    public void OnFatalError(int errorCode)       { Emit("ERROR:OnFatalError code=" + errorCode); }
    public void OnWarning(int warningCode)        { /* ignore */ }
    public void OnLogonError(int lError)          { Emit("ERROR:OnLogonError lError=" + lError); }
    public void OnDisconnected(int discReason)
    {
        if (OnDisconnectedCallback != null) OnDisconnectedCallback(discReason);
    }
}

// ── Native helpers ────────────────────────────────────────────────────────────
static class Native
{
    public const int GWL_STYLE = -16;
    public const int WS_CHILD    = unchecked((int)0x40000000);
    public const int WS_POPUP    = unchecked((int)0x80000000);
    public const int WS_CAPTION  = 0x00C00000;
    public const int WS_THICKFRAME = 0x00040000;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_NOZORDER    = 0x0004;
    public const uint SWP_NOACTIVATE  = 0x0010;
    public const int SW_SHOW = 5;

    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWnd, IntPtr hParent);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(
        IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int nIndex, int v);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int nIndex);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}

// ── Main program ──────────────────────────────────────────────────────────────
static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // Parse arguments
        string server = null, user = null, domain = "", password = "", security = "";
        IntPtr parentHwnd = IntPtr.Zero;
        bool adminMode = false;
        int port = 3389, width = 1280, height = 800;

        for (int i = 0; i < args.Length; i++)
        {
            if (i + 1 < args.Length)
            {
                switch (args[i].ToLower())
                {
                    case "--server": server = args[++i]; break;
                    case "--port":   port   = int.Parse(args[++i]); break;
                    case "--width":  width  = int.Parse(args[++i]); break;
                    case "--height": height = int.Parse(args[++i]); break;
                    case "--parent":   parentHwnd = new IntPtr(long.Parse(args[++i])); break;
                    case "--security": security  = args[++i]; break;
                    case "--user":
                        string raw = args[++i];
                        if (raw.Contains("\\"))
                        {
                            int bs = raw.IndexOf('\\');
                            domain = raw.Substring(0, bs);
                            user   = raw.Substring(bs + 1);
                        }
                        else if (raw.Contains("@"))
                        {
                            int at = raw.IndexOf('@');
                            user   = raw.Substring(0, at);
                            domain = raw.Substring(at + 1);
                        }
                        else { user = raw; }
                        break;
                }
            }
            if (args[i].ToLower() == "--admin") adminMode = true;
        }

        if (server == null || user == null)
        {
            Console.Error.WriteLine(
                "Usage: OrbitalRdpHost --server <host> --port <port> --user <user>");
            return 1;
        }

        // Read password from stdin (Rust writes it and closes stdin immediately)
        try { password = Console.In.ReadLine() ?? ""; } catch { password = ""; }

        // Pick the best available CLSID
        string clsid = PickClsid();
        if (clsid == null)
        {
            Console.WriteLine("ERROR:no mstscax.dll control found in registry");
            return 2;
        }

        // Suppress KB5057577 clipboard/redirection warning
        SuppressRedirectWarning(server);

        // Build and run the form
        var form = new RdpHostForm(
            server, port, user, domain, password,
            parentHwnd, adminMode, width, height, clsid);
        Application.Run(form);
        return 0;
    }

    // ── CLSID selection ───────────────────────────────────────────────────────
    // Non-redistributable controls work; redistributable ones (e.g. C0EFA91A =
    // redist-v11) self-cancel with discReason=7943 on some Windows builds.
    static string PickClsid()
    {
        string env = Environment.GetEnvironmentVariable("ORB_CLSID");
        if (!string.IsNullOrEmpty(env)) return env;

        string[] preferred = {
            "{1DF7C823-B2D4-4B54-975A-F2AC5D7CF8B8}", // v12 — confirmed working
            "{A0C63C30-F08D-4AB4-907C-34905D770C7D}", // v11
            "{8B918B82-7985-4C24-89DF-C33AD2BBFBCD}", // v10
            "{A3BC03A0-041D-42E3-AD22-882B7865C9C5}", // v9
            "{54D38BF7-B1EF-4479-9674-1BD6EA465258}", // v8
            "{3F859AA3-C2D4-4FAA-B0E4-FD0C9C4E5E3A}", // v13
        };

        RegistryKey hkcr = Registry.ClassesRoot.OpenSubKey("CLSID", false);
        if (hkcr == null) return null;

        try
        {
            foreach (string clsid in preferred)
            {
                string sub = clsid.Trim('{', '}');
                RegistryKey k = hkcr.OpenSubKey(sub + "\\InprocServer32", false);
                if (k == null) continue;
                string path = k.GetValue(null) as string ?? "";
                k.Close();
                if (path.IndexOf("mstscax.dll", StringComparison.OrdinalIgnoreCase) >= 0)
                    return sub; // AxHost constructor wants the GUID without braces
            }

            // Fallback: scan all CLSIDs
            foreach (string name in hkcr.GetSubKeyNames())
            {
                RegistryKey k = hkcr.OpenSubKey(name + "\\InprocServer32", false);
                if (k == null) continue;
                string path = k.GetValue(null) as string ?? "";
                k.Close();
                if (path.IndexOf("mstscax.dll", StringComparison.OrdinalIgnoreCase) >= 0)
                    return name.Trim('{', '}');
            }
        }
        finally { hkcr.Close(); }

        return null;
    }

    static void SuppressRedirectWarning(string server)
    {
        try
        {
            RegistryKey k = Registry.CurrentUser.CreateSubKey(
                @"SOFTWARE\Microsoft\Terminal Server Client\LocalDevices", true);
            if (k != null)
            {
                k.SetValue(server, 0x4D, RegistryValueKind.DWord);
                k.Close();
            }
        }
        catch { /* best-effort */ }
    }
}

// ── Host form ─────────────────────────────────────────────────────────────────
public sealed class RdpHostForm : Form
{
    readonly string _server, _user, _domain, _password, _clsid;
    readonly IntPtr _parentHwnd;
    readonly bool _adminMode;
    readonly int _port, _rdpWidth, _rdpHeight;

    RdpAxControl _ax;
    IConnectionPoint _cp;
    int _cpCookie;
    EventSink _sink;
    dynamic _rdp;

    static void Emit(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }

    public RdpHostForm(string server, int port, string user, string domain,
                       string password, IntPtr parentHwnd, bool adminMode,
                       int width, int height, string clsid)
    {
        _server    = server;
        _port      = port;
        _user      = user;
        _domain    = domain;
        _password  = password;
        _parentHwnd = parentHwnd;
        _adminMode = adminMode;
        _rdpWidth  = width;
        _rdpHeight = height;
        _clsid     = clsid;

        Text            = "OrbitalRdpHost";
        FormBorderStyle = FormBorderStyle.None;
        ClientSize      = new Size(width, height);
        BackColor       = Color.Black;
        ShowInTaskbar   = (parentHwnd == IntPtr.Zero);
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        // Reparent into the Rust host WS_POPUP window if requested
        if (_parentHwnd != IntPtr.Zero)
        {
            Native.SetParent(Handle, _parentHwnd);
            int style = Native.GetWindowLong(Handle, Native.GWL_STYLE);
            style &= ~Native.WS_POPUP;
            style &= ~Native.WS_CAPTION;
            style &= ~Native.WS_THICKFRAME;
            style |= Native.WS_CHILD;
            Native.SetWindowLong(Handle, Native.GWL_STYLE, style);
            Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, _rdpWidth, _rdpHeight,
                Native.SWP_FRAMECHANGED | Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
            Native.ShowWindow(Handle, Native.SW_SHOW);
        }

        try
        {
            _ax = new RdpAxControl(_clsid);
            _ax.Dock     = DockStyle.Fill;
            _ax.TabIndex = 0;
            Controls.Add(_ax);
            _ax.CreateControl();

            _rdp = _ax.GetOcxObject();
            if (_rdp == null) throw new Exception("GetOcx() returned null");

            // Subscribe to COM events via IConnectionPoint
            _sink = new EventSink();
            _sink.OnConnectedCallback    = HandleConnected;
            _sink.OnDisconnectedCallback = HandleDisconnected;

            IConnectionPointContainer cpc = (IConnectionPointContainer)_rdp;
            Guid eventsIid = typeof(IMsTscAxEvents).GUID;
            cpc.FindConnectionPoint(ref eventsIid, out _cp);
            _cp.Advise(_sink, out _cpCookie);

            // Server and credentials
            _rdp.Server   = _server;
            _rdp.UserName = _user;
            _rdp.Domain   = _domain;

            // Password via AdvancedSettings (NLA/CredSSP)
            try { _rdp.AdvancedSettings9.ClearTextPassword = _password; } catch { }
            try { _rdp.AdvancedSettings8.ClearTextPassword = _password; } catch { }
            try { _rdp.AdvancedSettings7.ClearTextPassword = _password; } catch { }
            try { _rdp.AdvancedSettings2.ClearTextPassword = _password; } catch { }

            // Password via IMsTscNonScriptable (legacy/RDP-security path)
            try
            {
                IMsTscNonScriptable ns = (IMsTscNonScriptable)_rdp;
                ns.put_ClearTextPassword(_password);
            }
            catch { }

            // Security
            try { _rdp.AdvancedSettings9.AuthenticationLevel    = 2; } catch { }
            try { _rdp.AdvancedSettings9.EnableCredSspSupport   = true; } catch { }
            try { _rdp.AdvancedSettings9.NegotiateSecurityLayer = true; } catch { }
            try { _rdp.AdvancedSettings9.EncryptionEnabled      = 1; } catch { }

            // Port
            try { _rdp.AdvancedSettings9.RDPPort = _port; } catch
            {
                try { _rdp.AdvancedSettings2.RDPPort = _port; } catch { }
            }

            // Desktop size
            try { _rdp.DesktopWidth  = _rdpWidth; } catch { }
            try { _rdp.DesktopHeight = _rdpHeight; } catch { }

            if (_adminMode)
                try { _rdp.AdvancedSettings9.ConnectToAdministerServer = true; } catch { }

            Emit("STATE:connecting");
            _rdp.Connect();
        }
        catch (Exception ex)
        {
            Emit("ERROR:" + ex.Message);
            Close();
        }
    }

    void HandleConnected()
    {
        Emit("STATE:connected");
    }

    void HandleDisconnected(int reason)
    {
        Emit("STATE:disconnected:" + reason);
        if (InvokeRequired)
            BeginInvoke(new Action(Close));
        else
            Close();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (_cp != null && _cpCookie != 0)
        {
            try { _cp.Unadvise(_cpCookie); } catch { }
            _cp = null; _cpCookie = 0;
        }
        try { if (_rdp != null) _rdp.Disconnect(); } catch { }
        if (_ax != null) { _ax.Dispose(); _ax = null; }
        base.OnFormClosed(e);
    }
}
