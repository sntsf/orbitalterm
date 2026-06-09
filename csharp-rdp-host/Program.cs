// OrbitalRdpHost.exe — minimal WinForms RDP host for OrbitalTerm
//
// Usage:
//   OrbitalRdpHost.exe --server <host> --port <port> --user <user[@domain]|\domain\user>
//                      [--parent <HWND>] [--admin] [--width <w>] [--height <h>]
//
// Password is read from stdin (first line).
// State changes are emitted on stdout:
//   STATE:connecting  STATE:connected  EVENT:OnLoginComplete
//   STATE:disconnected:<discReason>   ERROR:<msg>

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Security.Permissions.SecurityPermission(
    System.Security.PermissionState.Unrestricted)]

static class Program
{
    // ── Win32 ─────────────────────────────────────────────────────────────────
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr hWnd, IntPtr hParent);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after,
        int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern long SetWindowLong(IntPtr h, int nIndex, long v);
    [DllImport("user32.dll")] static extern long GetWindowLong(IntPtr h, int nIndex);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

    const int GWL_STYLE = -16;
    const long WS_CHILD = 0x40000000L;
    const long WS_POPUP = 0x80000000L;
    const long WS_CAPTION = 0x00C00000L;
    const long WS_THICKFRAME = 0x00040000L;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const int SW_SHOW = 5;

    // ── Entry ─────────────────────────────────────────────────────────────────
    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var opts = ParseArgs(args);
        if (opts.Server == null)
        {
            Console.Error.WriteLine("Usage: OrbitalRdpHost --server <host> --port <port> --user <user>");
            return 1;
        }

        // Read password from stdin (non-blocking — if none given, use empty string)
        string password = "";
        try
        {
            // Set stdin to non-blocking so we don't hang if no password is piped
            using var cts = new System.Threading.CancellationTokenSource(500);
            var t = Task_ReadLine(cts.Token);
            t.Wait(600);
            if (t.IsCompleted && t.Result != null) password = t.Result;
        }
        catch { /* no password provided */ }

        string clsid = PickClsid();
        if (clsid == null)
        {
            Console.WriteLine("ERROR:no mstscax.dll control found in registry");
            return 2;
        }

        // Suppress KB5057577 clipboard/redirection warning dialog
        SuppressRedirectWarning(opts.Server);

        var form = new RdpForm(opts, clsid, password);
        Application.Run(form);
        return 0;
    }

    // Simple async stdin readline so we can timeout
    static System.Threading.Tasks.Task<string> Task_ReadLine(System.Threading.CancellationToken ct)
        => System.Threading.Tasks.Task.Run(() => Console.ReadLine(), ct);

    // ── Argument parsing ──────────────────────────────────────────────────────
    class Options
    {
        public string Server;
        public int Port = 3389;
        public string User;
        public string Domain;
        public IntPtr ParentHwnd = IntPtr.Zero;
        public bool AdminMode;
        public int Width = 1280;
        public int Height = 800;
    }

    static Options ParseArgs(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i].ToLower())
            {
                case "--server": o.Server = args[++i]; break;
                case "--port":   o.Port   = int.Parse(args[++i]); break;
                case "--user":
                    string raw = args[++i];
                    // domain\user  or  user@domain  or  plain user
                    if (raw.Contains("\\"))
                    {
                        var parts = raw.Split(new[] { '\\' }, 2);
                        o.Domain = parts[0];
                        o.User   = parts[1];
                    }
                    else if (raw.Contains("@"))
                    {
                        var parts = raw.Split('@');
                        o.User   = parts[0];
                        o.Domain = parts[1];
                    }
                    else
                    {
                        o.User = raw;
                    }
                    break;
                case "--parent":
                    o.ParentHwnd = new IntPtr(long.Parse(args[++i]));
                    break;
                case "--width":  o.Width  = int.Parse(args[++i]); break;
                case "--height": o.Height = int.Parse(args[++i]); break;
                case "--admin":  o.AdminMode = true; break;
            }
        }
        // last arg without a value could be --admin
        if (args.Length > 0 && args[args.Length - 1].ToLower() == "--admin")
            o.AdminMode = true;
        return o;
    }

    // ── CLSID selection ───────────────────────────────────────────────────────
    // Enumerate HKCR\CLSID for entries whose InprocServer32 points to mstscax.dll.
    // The NotSafeForScripting coclasses have no ProgID, so ProgID lookup always fails.
    static string PickClsid()
    {
        // Allow override for testing / compatibility
        string env = Environment.GetEnvironmentVariable("ORB_CLSID");
        if (!string.IsNullOrEmpty(env)) return env;

        // Ordered list: non-redistributable variants work; redistributable ones
        // (e.g. C0EFA91A = redist-v11) self-cancel with discReason=7943.
        string[] preferred = {
            "1DF7C823-B2D4-4B54-975A-F2AC5D7CF8B8", // v12 — confirmed working
            "A0C63C30-F08D-4AB4-907C-34905D770C7D", // v11
            "8B918B82-7985-4C24-89DF-C33AD2BBFBCD", // v10
            "A3BC03A0-041D-42E3-AD22-882B7865C9C5", // v9
            "54D38BF7-B1EF-4479-9674-1BD6EA465258", // v8
            "3F859AA3-C2D4-4FAA-B0E4-FD0C9C4E5E3A", // v13
        };

        // Find which of these are actually registered on this machine
        using var hkcr = Registry.ClassesRoot.OpenSubKey("CLSID", false);
        if (hkcr == null) return null;

        foreach (string clsid in preferred)
        {
            string keyPath = "{" + clsid + "}\\InprocServer32";
            using var k = hkcr.OpenSubKey(keyPath, false);
            if (k == null) continue;
            string path = k.GetValue(null) as string ?? "";
            if (path.IndexOf("mstscax.dll", StringComparison.OrdinalIgnoreCase) >= 0)
                return "{" + clsid + "}";
        }

        // Fallback: scan all CLSIDs for mstscax.dll
        foreach (string name in hkcr.GetSubKeyNames())
        {
            using var k = hkcr.OpenSubKey(name + "\\InprocServer32", false);
            if (k == null) continue;
            string path = k.GetValue(null) as string ?? "";
            if (path.IndexOf("mstscax.dll", StringComparison.OrdinalIgnoreCase) >= 0)
                return name; // already has braces from registry
        }

        return null;
    }

    // ── KB5057577 clipboard warning suppression ───────────────────────────────
    static void SuppressRedirectWarning(string server)
    {
        try
        {
            string key = @"SOFTWARE\Microsoft\Terminal Server Client\LocalDevices";
            using var k = Registry.CurrentUser.CreateSubKey(key, true);
            k?.SetValue(server, 0x4D, RegistryValueKind.DWord);
        }
        catch { /* best-effort */ }
    }
}

// ── RDP host form ─────────────────────────────────────────────────────────────
class RdpForm : Form
{
    // COM interface IIDs
    static readonly Guid IID_IMsTscNonScriptable = new Guid("c1e6743a-41c1-4a74-832a-0dd06c1c7a0e");

    readonly Program.Options _opts;
    readonly string _clsid;
    readonly string _password;
    AxRdpHost _ax;

    public RdpForm(Program.Options opts, string clsid, string password)
    {
        _opts     = opts;
        _clsid    = clsid;
        _password = password;

        Text            = "OrbitalRdpHost";
        FormBorderStyle = FormBorderStyle.None;
        ClientSize      = new Size(opts.Width, opts.Height);
        BackColor       = Color.Black;
        ShowInTaskbar   = opts.ParentHwnd == IntPtr.Zero;

        Load += OnLoad;
    }

    void OnLoad(object sender, EventArgs e)
    {
        // Reparent into the Rust WS_POPUP host window if requested
        if (_opts.ParentHwnd != IntPtr.Zero)
        {
            Program.SetParent(Handle, _opts.ParentHwnd);
            long style = Program.GetWindowLong(Handle, Program.GWL_STYLE);
            style &= ~Program.WS_POPUP;
            style &= ~Program.WS_CAPTION;
            style &= ~Program.WS_THICKFRAME;
            style |= Program.WS_CHILD;
            Program.SetWindowLong(Handle, Program.GWL_STYLE, style);
            Program.SetWindowPos(Handle, IntPtr.Zero, 0, 0,
                _opts.Width, _opts.Height,
                Program.SWP_FRAMECHANGED | Program.SWP_NOZORDER | Program.SWP_NOACTIVATE);
            Program.ShowWindow(Handle, Program.SW_SHOW);
        }

        try
        {
            _ax = new AxRdpHost(_clsid, _opts, _password, Handle, OnConnected, OnDisconnected);
            _ax.Dock     = DockStyle.Fill;
            _ax.TabIndex = 0;
            Controls.Add(_ax);
            _ax.CreateControl();
            _ax.Connect();
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERROR:" + ex.Message);
            Close();
        }
    }

    void OnConnected()
    {
        Console.WriteLine("STATE:connected");
        Console.Out.Flush();
    }

    void OnDisconnected(int reason)
    {
        Console.WriteLine("STATE:disconnected:" + reason);
        Console.Out.Flush();
        BeginInvoke(new Action(() => Close()));
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        base.OnFormClosed(e);
        _ax?.Dispose();
    }
}

// ── AxHost wrapper ────────────────────────────────────────────────────────────
// Inheriting AxHost is the only way to get a full OLE in-place site that lets
// ClearTextPassword and IMsTscNonScriptable work (plain CreateInstance does not
// provide an IOleClientSite, so the control refuses to accept credentials).
class AxRdpHost : AxHost
{
    static readonly Guid IID_IMsTscNonScriptable = new Guid("c1e6743a-41c1-4a74-832a-0dd06c1c7a0e");

    readonly string _clsid;
    readonly Program.Options _opts;
    readonly string _password;
    readonly IntPtr _formHwnd;
    readonly Action _onConnected;
    readonly Action<int> _onDisconnected;

    dynamic _rdp; // late-bound IDispatch; avoids dependency on typed interop

    public AxRdpHost(string clsid, Program.Options opts, string password,
                     IntPtr formHwnd, Action onConnected, Action<int> onDisconnected)
        : base(clsid)
    {
        _clsid         = clsid;
        _opts          = opts;
        _password      = password;
        _formHwnd      = formHwnd;
        _onConnected   = onConnected;
        _onDisconnected = onDisconnected;
    }

    public void Connect()
    {
        _rdp = GetOcx();
        if (_rdp == null)
            throw new InvalidOperationException("GetOcx() returned null — control not created");

        // Server & credentials
        _rdp.Server   = _opts.Server;
        _rdp.Domain   = _opts.Domain ?? "";
        _rdp.UserName = _opts.User   ?? "";

        // Password injection via AdvancedSettings (NLA / CredSSP path)
        try { _rdp.AdvancedSettings9.ClearTextPassword = _password; } catch { }
        try { _rdp.AdvancedSettings8.ClearTextPassword = _password; } catch { }
        try { _rdp.AdvancedSettings7.ClearTextPassword = _password; } catch { }
        try { _rdp.AdvancedSettings2.ClearTextPassword = _password; } catch { }

        // Password injection via IMsTscNonScriptable (legacy / RDP security path)
        try
        {
            var ns = Marshal.GetComInterfaceForObject(_rdp, typeof(object));
            // We can't use typed IID query without interop DLL, so try dynamic property
            _rdp.ClearTextPassword = _password;
        }
        catch { }

        // Security settings
        try { _rdp.AdvancedSettings9.AuthenticationLevel      = 2; } catch { }
        try { _rdp.AdvancedSettings9.EnableCredSspSupport     = true; } catch { }
        try { _rdp.AdvancedSettings9.EncryptionEnabled        = 1; } catch { }
        try { _rdp.AdvancedSettings9.NegotiateSecurityLayer   = true; } catch { }

        // Port
        try { _rdp.AdvancedSettings9.RDPPort = _opts.Port; } catch
        {
            try { _rdp.AdvancedSettings2.RDPPort = _opts.Port; } catch { }
        }

        // Desktop size
        try { _rdp.DesktopWidth  = _opts.Width;  } catch { }
        try { _rdp.DesktopHeight = _opts.Height; } catch { }

        // Admin/console mode
        if (_opts.AdminMode)
            try { _rdp.AdvancedSettings9.ConnectToAdministerServer = true; } catch { }

        // Hook events
        try
        {
            _rdp.OnConnected     += new EventHandler(HandleConnected);
            _rdp.OnDisconnected  += new EventHandler<dynamic>(HandleDisconnected);
            _rdp.OnLoginComplete += new EventHandler(HandleLoginComplete);
        }
        catch { /* some versions use different event signatures — best-effort */ }

        Console.WriteLine("STATE:connecting");
        Console.Out.Flush();

        _rdp.Connect();
    }

    void HandleConnected(object sender, EventArgs e)
    {
        _onConnected();
    }

    void HandleLoginComplete(object sender, EventArgs e)
    {
        Console.WriteLine("EVENT:OnLoginComplete");
        Console.Out.Flush();
    }

    void HandleDisconnected(object sender, dynamic e)
    {
        int reason = 0;
        try { reason = (int)e.discReason; } catch { }
        _onDisconnected(reason);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && _rdp != null)
        {
            try { _rdp.Disconnect(); } catch { }
            Marshal.ReleaseComObject(_rdp);
            _rdp = null;
        }
        base.Dispose(disposing);
    }
}
