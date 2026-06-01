/*
 * orb_rdp_bridge.c – libfreerdp3 bridge for OrbitalTerm
 *
 * Implements the API declared in orb_rdp_bridge.h.
 * Build requires: sudo apt install libfreerdp-dev3 libfreerdp-client-dev3
 */

#include "orb_rdp_bridge.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <time.h>

#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/client/channels.h>
#include <freerdp/channels/channels.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>

/* DISP channel for dynamic resize */
#include <freerdp/client/disp.h>

/* Clipboard channel */
#include <freerdp/client/cliprdr.h>
#include <freerdp/channels/cliprdr.h>

/* winpr threading */
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/wlog.h>

/* -------------------------------------------------------------------------
 * Extended context  (rdpContext MUST be the first member)
 * ------------------------------------------------------------------------- */

typedef struct {
    rdpContext base; /* freerdp casts context pointers — keep this first */

    orb_frame_fn  on_frame;
    orb_error_fn  on_error;
    void         *user_ctx;

    char          *pending_clipboard;
    pthread_mutex_t clipboard_mutex;

    volatile int   stop_requested;

    struct timespec last_frame_ts; /* for 60fps rate-limiter */

    struct OrbRdpSession *session;

    DispClientContext    *disp;
    CliprdrClientContext *cliprdr;
} OrbContext;

/* -------------------------------------------------------------------------
 * Public session struct
 * ------------------------------------------------------------------------- */

struct OrbRdpSession {
    freerdp     *instance;
    pthread_t    thread;
    volatile int alive;
};

/* -------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

static void report_error(OrbContext *ctx, const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (ctx->on_error)
        ctx->on_error(ctx->user_ctx, buf);
}

/* Convenience: get settings from context (works after freerdp_context_new) */
static inline rdpSettings *orb_settings(OrbContext *ctx)
{
    return ctx->base.settings;
}

/* -------------------------------------------------------------------------
 * EndPaint – called by FreeRDP GDI after each frame is rendered
 * ------------------------------------------------------------------------- */

static BOOL orb_end_paint(rdpContext *context)
{
    OrbContext *ctx = (OrbContext *)context;
    rdpGdi     *gdi = context->gdi;

    if (!gdi || !gdi->primary_buffer || !ctx->on_frame)
        return TRUE;

    /* Rate-limit to 60 fps: skip frames that arrive within 16 ms of the last. */
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    int64_t elapsed_us =
        (int64_t)(now.tv_sec  - ctx->last_frame_ts.tv_sec)  * 1000000LL +
        (int64_t)(now.tv_nsec - ctx->last_frame_ts.tv_nsec) / 1000LL;
    if (elapsed_us < 16000) {
        /* Skip this frame — leave the dirty rect untouched so FreeRDP
         * automatically merges subsequent updates into it.  The next
         * processed frame will cover the union of all skipped dirty rects,
         * ensuring no screen region is permanently missed. */
        return TRUE;
    }
    ctx->last_frame_ts = now;

    /* Determine dirty rectangle.
     * FreeRDP tracks the region modified since the previous EndPaint call
     * in gdi->primary->hdc->hwnd->invalid (gdiBitmap → hdc → hwnd → invalid).
     * Fall back to the full frame if the region is not available or null. */
    uint32_t dx = 0, dy = 0;
    uint32_t dw = (uint32_t)gdi->width;
    uint32_t dh = (uint32_t)gdi->height;

    if (gdi->primary && gdi->primary->hdc && gdi->primary->hdc->hwnd) {
        HGDI_RGN inv = gdi->primary->hdc->hwnd->invalid;
        if (inv && !inv->null && inv->w > 0 && inv->h > 0) {
            dx = (uint32_t)(inv->x > 0 ? inv->x : 0);
            dy = (uint32_t)(inv->y > 0 ? inv->y : 0);
            dw = (uint32_t)inv->w;
            dh = (uint32_t)inv->h;
            /* Clamp to framebuffer bounds */
            if (dx + dw > (uint32_t)gdi->width)
                dw = (uint32_t)gdi->width > dx ? (uint32_t)gdi->width - dx : 0;
            if (dy + dh > (uint32_t)gdi->height)
                dh = (uint32_t)gdi->height > dy ? (uint32_t)gdi->height - dy : 0;
        }
        /* Reset dirty rect — FreeRDP merges into it; we own the reset now. */
        if (inv) { inv->x = 0; inv->y = 0; inv->w = 0; inv->h = 0; inv->null = TRUE; }
    }

    if (dw == 0 || dh == 0)
        return TRUE;

    ctx->on_frame(
        ctx->user_ctx,
        gdi->primary_buffer,
        dx, dy, dw, dh,
        (uint32_t)gdi->stride
    );
    return TRUE;
}

/* -------------------------------------------------------------------------
 * DISP channel
 * ------------------------------------------------------------------------- */

static UINT orb_disp_caps(DispClientContext *disp,
                           UINT32 maxMonitors,
                           UINT32 factorA, UINT32 factorB)
{
    (void)disp; (void)maxMonitors; (void)factorA; (void)factorB;
    return CHANNEL_RC_OK;
}

/* -------------------------------------------------------------------------
 * Clipboard channel callbacks
 * ------------------------------------------------------------------------- */

static UINT orb_cliprdr_monitor_ready(CliprdrClientContext *cliprdr,
                                       const CLIPRDR_MONITOR_READY *ev)
{
    (void)ev;
    OrbContext *ctx = (OrbContext *)cliprdr->custom;

    /* Announce capabilities */
    CLIPRDR_GENERAL_CAPABILITY_SET genCap = { 0 };
    genCap.capabilitySetType   = CB_CAPSTYPE_GENERAL;
    genCap.capabilitySetLength = 12;
    genCap.version             = CB_CAPS_VERSION_2;
    genCap.generalFlags        = CB_USE_LONG_FORMAT_NAMES;

    CLIPRDR_CAPABILITIES caps = { 0 };
    caps.cCapabilitiesSets = 1;
    caps.capabilitySets    = (CLIPRDR_CAPABILITY_SET *)&genCap;
    cliprdr->ClientCapabilities(cliprdr, &caps);

    /* Advertise CF_UNICODETEXT if we already have pending text */
    pthread_mutex_lock(&ctx->clipboard_mutex);
    int has_pending = (ctx->pending_clipboard != NULL);
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    if (has_pending) {
        CLIPRDR_FORMAT entry = { CF_UNICODETEXT, NULL };
        CLIPRDR_FORMAT_LIST fmt = { 0 };
        fmt.numFormats = 1;
        fmt.formats    = &entry;
        cliprdr->ClientFormatList(cliprdr, &fmt);
    }

    return CHANNEL_RC_OK;
}

static UINT orb_cliprdr_format_list(CliprdrClientContext *cliprdr,
                                     const CLIPRDR_FORMAT_LIST *list)
{
    (void)list;
    /* Acknowledge remote format advertisement */
    CLIPRDR_FORMAT_LIST_RESPONSE resp = { 0 };
    resp.common.msgFlags = CB_RESPONSE_OK;
    cliprdr->ClientFormatListResponse(cliprdr, &resp);
    return CHANNEL_RC_OK;
}

static UINT orb_cliprdr_format_data_request(CliprdrClientContext *cliprdr,
                                              const CLIPRDR_FORMAT_DATA_REQUEST *req)
{
    OrbContext *ctx = (OrbContext *)cliprdr->custom;

    if (req->requestedFormatId != CF_UNICODETEXT) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        resp.common.msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        return CHANNEL_RC_OK;
    }

    pthread_mutex_lock(&ctx->clipboard_mutex);
    char *text = ctx->pending_clipboard ? strdup(ctx->pending_clipboard) : NULL;
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    if (!text) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        resp.common.msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        return CHANNEL_RC_OK;
    }

    /* Convert UTF-8 → UTF-16LE (ASCII fast-path, good enough for typical text) */
    size_t len_utf8 = strlen(text);
    size_t buf_bytes = (len_utf8 + 1) * 2; /* +1 for NUL, *2 for UTF-16 */
    BYTE *utf16 = (BYTE *)calloc(1, buf_bytes);
    if (utf16) {
        const unsigned char *src = (const unsigned char *)text;
        WCHAR *dst = (WCHAR *)utf16;
        size_t n = 0;
        while (*src && n < len_utf8) { *dst++ = (WCHAR)*src++; n++; }
        *dst = 0; /* NUL-terminate */

        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        resp.common.msgFlags    = CB_RESPONSE_OK;
        resp.common.dataLen     = (UINT32)((n + 1) * 2);
        resp.requestedFormatData = utf16;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        free(utf16);
    }

    free(text);
    return CHANNEL_RC_OK;
}

/* -------------------------------------------------------------------------
 * Channel lifecycle – wired up via PubSub in PreConnect
 * The handler signature changed in FreeRDP 3: first arg is rdpContext*.
 * ------------------------------------------------------------------------- */

static void orb_channel_connected(rdpContext *context,
                                   ChannelConnectedEventArgs *e)
{
    OrbContext *ctx = (OrbContext *)context;

    if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        ctx->disp = (DispClientContext *)e->pInterface;
        ctx->disp->DisplayControlCaps = orb_disp_caps;
    } else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        ctx->cliprdr = (CliprdrClientContext *)e->pInterface;
        ctx->cliprdr->custom                  = ctx;
        ctx->cliprdr->MonitorReady            = orb_cliprdr_monitor_ready;
        ctx->cliprdr->ServerFormatList        = orb_cliprdr_format_list;
        ctx->cliprdr->ServerFormatDataRequest = orb_cliprdr_format_data_request;
    }
}

static void orb_channel_disconnected(rdpContext *context,
                                      ChannelDisconnectedEventArgs *e)
{
    OrbContext *ctx = (OrbContext *)context;

    if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0)
        ctx->disp = NULL;
    else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0)
        ctx->cliprdr = NULL;
}

/* -------------------------------------------------------------------------
 * PreConnect
 * ------------------------------------------------------------------------- */

static BOOL orb_pre_connect(freerdp *instance)
{
    OrbContext   *ctx      = (OrbContext *)instance->context;
    rdpSettings  *settings = orb_settings(ctx);

    /* Load channel plugins (cliprdr, disp, …) based on settings flags */
    freerdp_client_load_addins(instance->context->channels, settings);

    /* Security: allow NLA, TLS, classic RDP; ignore cert errors */
    freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity,       TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity,       TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity,       TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);

    /* Video pipeline */
    freerdp_settings_set_bool(settings,   FreeRDP_SupportGraphicsPipeline, TRUE);
    freerdp_settings_set_bool(settings,   FreeRDP_RemoteFxCodec,           TRUE);
    freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth,              32);

    /* No audio */
    freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, FALSE);
    freerdp_settings_set_bool(settings, FreeRDP_AudioCapture,  FALSE);

    /* Subscribe to channel open/close events */
    PubSub_SubscribeChannelConnected(
        instance->context->pubSub,
        (pChannelConnectedEventHandler)orb_channel_connected);
    PubSub_SubscribeChannelDisconnected(
        instance->context->pubSub,
        (pChannelDisconnectedEventHandler)orb_channel_disconnected);

    return TRUE;
}

/* -------------------------------------------------------------------------
 * PostConnect
 * ------------------------------------------------------------------------- */

static BOOL orb_post_connect(freerdp *instance)
{
    if (!gdi_init(instance, PIXEL_FORMAT_BGRX32))
        return FALSE;

    instance->context->update->EndPaint = orb_end_paint;
    return TRUE;
}

/* -------------------------------------------------------------------------
 * PostDisconnect
 * ------------------------------------------------------------------------- */

static void orb_post_disconnect(freerdp *instance)
{
    gdi_free(instance);
}

/* -------------------------------------------------------------------------
 * Event-loop thread
 * ------------------------------------------------------------------------- */

/* ERRINFO_LOGOFF_BY_USER (0x0000000C): user voluntarily ended the session.
 * Note: in FreeRDP headers ERRINFO_RPC_INITIATED_DISCONNECT = 0x00000001,
 * not 0x0000000C — do NOT confuse the two. */
#define ERRINFO_LOGOFF_BY_USER 0x0000000C

static void *orb_event_loop(void *arg)
{
    OrbRdpSession *sess     = (OrbRdpSession *)arg;
    freerdp       *instance = sess->instance;
    OrbContext    *ctx      = (OrbContext *)instance->context;

    if (!freerdp_connect(instance)) {
        UINT32 err = freerdp_get_last_error(instance->context);
        char msg[256];
        snprintf(msg, sizeof(msg), "RDP connect failed: %s",
                 freerdp_get_last_error_string(err));
        report_error(ctx, "%s", msg);
        sess->alive = 0;
        return NULL;
    }

    while (!ctx->stop_requested) {
        HANDLE handles[64];
        DWORD  count = freerdp_get_event_handles(instance->context, handles, 64);
        if (count == 0) break;

        WaitForMultipleObjects(count, handles, FALSE, 100);

        if (!freerdp_check_event_handles(instance->context)) {
            UINT32 err = freerdp_error_info(instance);

            if (err == ERRINFO_LOGOFF_BY_USER) {
                /* Clean user logoff — notify frontend with a neutral message,
                 * no error UI, just "session ended". */
                report_error(ctx, "SESSION_ENDED");
            } else if (err && err != 0xFFFF) {
                char msg[128];
                snprintf(msg, sizeof(msg),
                         "RDP sesión terminada por el servidor (0x%08X)", err);
                report_error(ctx, "%s", msg);
            }
            /* err == 0: clean disconnect with no explicit code — no message */
            break;
        }

        /* Flush any stale dirty rect the rate-limiter may have skipped.
         *
         * Windows stops sending EndPaint events once rendering is complete.
         * If the rate-limiter skipped the last EndPaint in a burst (e.g. after
         * opening a folder), the dirty rect stays in FreeRDP's state forever —
         * visible only after the user clicks (which triggers a new EndPaint).
         *
         * Fix: on each event-loop iteration (≤100 ms apart) check whether a
         * non-null dirty rect is still sitting in FreeRDP's state.  If yes,
         * clear the rate-limiter timestamp so orb_end_paint treats the call as
         * a fresh frame and forwards it immediately. */
        rdpGdi *gdi = instance->context->gdi;
        if (gdi && gdi->primary && gdi->primary->hdc && gdi->primary->hdc->hwnd) {
            HGDI_RGN inv = gdi->primary->hdc->hwnd->invalid;
            if (inv && !inv->null && inv->w > 0 && inv->h > 0) {
                memset(&ctx->last_frame_ts, 0, sizeof(ctx->last_frame_ts));
                orb_end_paint(instance->context);
            }
        }
    }

    freerdp_disconnect(instance);
    sess->alive = 0;
    return NULL;
}

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

OrbRdpSession *orb_session_new(const char   *host,
                                uint16_t      port,
                                const char   *username,
                                const char   *password,
                                const char   *domain,
                                uint16_t      width,
                                uint16_t      height,
                                bool          console_mode,
                                orb_frame_fn  on_frame,
                                orb_error_fn  on_error,
                                void         *user_ctx)
{
    /* Silence expected-but-harmless warnings that appear on every connection:
     * - com.winpr.library: optional rdpdr plugin not installed (drive redirect)
     * - com.winpr.sspi.Kerberos: Kerberos unavailable, NTLM used instead */
    WLog_SetLogLevel(WLog_Get("com.winpr.library"),       WLOG_OFF);
    WLog_SetLogLevel(WLog_Get("com.winpr.sspi.Kerberos"), WLOG_OFF);

    OrbRdpSession *sess = (OrbRdpSession *)calloc(1, sizeof(*sess));
    if (!sess) return NULL;

    freerdp *instance = freerdp_new();
    if (!instance) { free(sess); return NULL; }

    instance->ContextSize    = sizeof(OrbContext);
    instance->PreConnect     = orb_pre_connect;
    instance->PostConnect    = orb_post_connect;
    instance->PostDisconnect = orb_post_disconnect;

    if (!freerdp_context_new(instance)) {
        freerdp_free(instance);
        free(sess);
        return NULL;
    }

    OrbContext  *ctx      = (OrbContext *)instance->context;
    rdpSettings *settings = orb_settings(ctx);

    ctx->on_frame  = on_frame;
    ctx->on_error  = on_error;
    ctx->user_ctx  = user_ctx;
    ctx->session   = sess;
    pthread_mutex_init(&ctx->clipboard_mutex, NULL);

    freerdp_settings_set_string(settings, FreeRDP_ServerHostname, host);
    freerdp_settings_set_uint32(settings, FreeRDP_ServerPort,     port);
    freerdp_settings_set_string(settings, FreeRDP_Username,       username);
    freerdp_settings_set_string(settings, FreeRDP_Password,       password);
    if (domain && domain[0])
        freerdp_settings_set_string(settings, FreeRDP_Domain, domain);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth,  width);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, height);

    if (console_mode)
        freerdp_settings_set_bool(settings, FreeRDP_ConsoleSession, TRUE);

    freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard,     TRUE);

    sess->instance = instance;
    sess->alive    = 1;

    if (pthread_create(&sess->thread, NULL, orb_event_loop, sess) != 0) {
        pthread_mutex_destroy(&ctx->clipboard_mutex);
        freerdp_context_free(instance);
        freerdp_free(instance);
        free(sess);
        return NULL;
    }

    return sess;
}

void orb_session_free(OrbRdpSession *session)
{
    if (!session) return;

    OrbContext *ctx = (OrbContext *)session->instance->context;
    ctx->stop_requested = 1;

    pthread_join(session->thread, NULL);

    pthread_mutex_lock(&ctx->clipboard_mutex);
    free(ctx->pending_clipboard);
    ctx->pending_clipboard = NULL;
    pthread_mutex_unlock(&ctx->clipboard_mutex);
    pthread_mutex_destroy(&ctx->clipboard_mutex);

    freerdp_context_free(session->instance);
    freerdp_free(session->instance);
    free(session);
}

void orb_send_mouse(OrbRdpSession *session, uint16_t flags,
                    uint16_t x, uint16_t y)
{
    if (!session || !session->alive) return;
    freerdp_input_send_mouse_event(
        session->instance->context->input, flags, x, y);
}

void orb_send_key(OrbRdpSession *session, uint16_t flags, uint8_t scancode)
{
    if (!session || !session->alive) return;
    freerdp_input_send_keyboard_event(
        session->instance->context->input, flags, scancode);
}

void orb_resize(OrbRdpSession *session, uint16_t width, uint16_t height)
{
    if (!session || !session->alive) return;
    OrbContext *ctx = (OrbContext *)session->instance->context;
    if (!ctx->disp) return;

    DISPLAY_CONTROL_MONITOR_LAYOUT layout = { 0 };
    layout.Flags              = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Width              = width;
    layout.Height             = height;
    layout.Orientation        = ORIENTATION_LANDSCAPE;
    layout.DesktopScaleFactor = 100;
    layout.DeviceScaleFactor  = 100;
    layout.PhysicalWidth      = width;
    layout.PhysicalHeight     = height;

    ctx->disp->SendMonitorLayout(ctx->disp, 1, &layout);
}

void orb_refresh(OrbRdpSession *session)
{
    if (!session || !session->alive) return;
    freerdp  *instance = session->instance;
    OrbContext *ctx    = (OrbContext *)instance->context;
    rdpGdi   *gdi      = instance->context->gdi;
    if (!gdi || !gdi->primary_buffer || gdi->width == 0 || gdi->height == 0 || !ctx->on_frame)
        return;

    /* Push the full current framebuffer directly to the encoder without
     * waiting for a server-initiated EndPaint.  This gives instant results
     * when the canvas becomes visible after a tab switch — no network
     * round-trip required because FreeRDP already has the screen in memory. */
    ctx->on_frame(
        ctx->user_ctx,
        gdi->primary_buffer,
        0, 0,
        (uint32_t)gdi->width,
        (uint32_t)gdi->height,
        (uint32_t)gdi->stride
    );
    /* Update rate-limiter so the forced frame doesn't block the next EndPaint. */
    clock_gettime(CLOCK_MONOTONIC, &ctx->last_frame_ts);
}

void orb_set_clipboard(OrbRdpSession *session, const char *text)
{
    if (!session || !text) return;
    OrbContext *ctx = (OrbContext *)session->instance->context;

    pthread_mutex_lock(&ctx->clipboard_mutex);
    free(ctx->pending_clipboard);
    ctx->pending_clipboard = strdup(text);
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    if (ctx->cliprdr && session->alive) {
        CLIPRDR_FORMAT entry = { CF_UNICODETEXT, NULL };
        CLIPRDR_FORMAT_LIST fmt = { 0 };
        fmt.numFormats = 1;
        fmt.formats    = &entry;
        ctx->cliprdr->ClientFormatList(ctx->cliprdr, &fmt);
    }
}
