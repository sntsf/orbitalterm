/*
 * orb_rdp_bridge.c – libfreerdp3 bridge for OrbitalTerm
 *
 * Implements the API declared in orb_rdp_bridge.h.
 * Compiles with:
 *   cc -std=c11 $(pkg-config --cflags freerdp3 freerdp-client3) \
 *      orb_rdp_bridge.c -o orb_rdp_bridge.o \
 *      $(pkg-config --libs freerdp3 freerdp-client3 winpr3)
 */

#include "orb_rdp_bridge.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/channels.h>
#include <freerdp/channels/channels.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/log.h>

/* DISP channel for dynamic resize */
#include <freerdp/client/disp.h>

/* Clipboard channel */
#include <freerdp/client/cliprdr.h>
#include <freerdp/channels/cliprdr.h>

/* winpr threading primitives (used by freerdp itself) */
#include <winpr/synch.h>
#include <winpr/thread.h>

/* -------------------------------------------------------------------------
 * Extended client context
 * ------------------------------------------------------------------------- */

typedef struct {
    /* Must be first – freerdp casts between rdpClientContext and rdpContext */
    rdpClientContext base;

    /* Our additions */
    orb_frame_fn  on_frame;
    orb_error_fn  on_error;
    void         *user_ctx;

    /* Clipboard text pending push to remote (NULL = nothing pending) */
    char         *pending_clipboard;
    pthread_mutex_t clipboard_mutex;

    /* Set to 1 to request the event loop to exit */
    volatile int  stop_requested;

    /* The owning OrbRdpSession (set before connect) */
    struct OrbRdpSession *session;

    /* DISP virtual channel handle */
    DispClientContext *disp;

    /* Cliprdr virtual channel handle */
    CliprdrClientContext *cliprdr;

} OrbContext;

/* -------------------------------------------------------------------------
 * Public session struct
 * ------------------------------------------------------------------------- */

struct OrbRdpSession {
    freerdp     *instance;
    pthread_t    thread;
    volatile int alive; /* 1 while thread is running */
};

/* -------------------------------------------------------------------------
 * Helper: fire error callback and mark session dead
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

/* -------------------------------------------------------------------------
 * EndPaint – called by FreeRDP GDI after each frame is rendered
 * ------------------------------------------------------------------------- */

static BOOL orb_end_paint(rdpContext *context)
{
    OrbContext *ctx = (OrbContext *)context;
    rdpGdi     *gdi = context->gdi;

    if (!gdi || !gdi->primary_buffer)
        return TRUE;

    if (ctx->on_frame) {
        ctx->on_frame(
            ctx->user_ctx,
            gdi->primary_buffer,
            (uint32_t)gdi->width,
            (uint32_t)gdi->height,
            (uint32_t)gdi->stride
        );
    }
    return TRUE;
}

/* -------------------------------------------------------------------------
 * DISP channel callbacks
 * ------------------------------------------------------------------------- */

static UINT orb_disp_caps(DispClientContext *disp,
                            UINT32 maxNumMonitors,
                            UINT32 maxMonitorAreaFactorA,
                            UINT32 maxMonitorAreaFactorB)
{
    (void)disp; (void)maxNumMonitors;
    (void)maxMonitorAreaFactorA; (void)maxMonitorAreaFactorB;
    return CHANNEL_RC_OK;
}

/* -------------------------------------------------------------------------
 * Clipboard channel callbacks (minimal – text push only)
 * ------------------------------------------------------------------------- */

static UINT orb_cliprdr_monitor_ready(CliprdrClientContext *cliprdr,
                                       const CLIPRDR_MONITOR_READY *monitorReady)
{
    (void)monitorReady;
    OrbContext *ctx = (OrbContext *)cliprdr->custom;

    /* Announce we can provide CF_UNICODETEXT */
    CLIPRDR_CAPABILITIES caps = { 0 };
    CLIPRDR_GENERAL_CAPABILITY_SET genCap = { 0 };
    genCap.capabilitySetType = CB_CAPSTYPE_GENERAL;
    genCap.capabilitySetLength = 12;
    genCap.version = CB_CAPS_VERSION_2;
    genCap.generalFlags = CB_USE_LONG_FORMAT_NAMES;
    caps.cCapabilitiesSets = 1;
    caps.capabilitySets = (CLIPRDR_CAPABILITY_SET *)&genCap;
    cliprdr->ClientCapabilities(cliprdr, &caps);

    /* If there is already pending clipboard text, advertise it now */
    pthread_mutex_lock(&ctx->clipboard_mutex);
    int has_pending = (ctx->pending_clipboard != NULL);
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    if (has_pending) {
        CLIPRDR_FORMAT_LIST fmt = { 0 };
        CLIPRDR_FORMAT entry = { CF_UNICODETEXT, NULL };
        fmt.numFormats = 1;
        fmt.formats = &entry;
        cliprdr->ClientFormatList(cliprdr, &fmt);
    }

    return CHANNEL_RC_OK;
}

static UINT orb_cliprdr_format_list(CliprdrClientContext *cliprdr,
                                     const CLIPRDR_FORMAT_LIST *formatList)
{
    /* Remote is advertising its formats – just acknowledge */
    (void)formatList;
    CLIPRDR_FORMAT_LIST_RESPONSE resp = { 0 };
    resp.msgFlags = CB_RESPONSE_OK;
    cliprdr->ClientFormatListResponse(cliprdr, &resp);
    return CHANNEL_RC_OK;
}

static UINT orb_cliprdr_format_data_request(CliprdrClientContext *cliprdr,
                                              const CLIPRDR_FORMAT_DATA_REQUEST *req)
{
    OrbContext *ctx = (OrbContext *)cliprdr->custom;

    if (req->requestedFormatId != CF_UNICODETEXT) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        resp.msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        return CHANNEL_RC_OK;
    }

    pthread_mutex_lock(&ctx->clipboard_mutex);
    char *text = ctx->pending_clipboard ? strdup(ctx->pending_clipboard) : NULL;
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    if (!text) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        resp.msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        return CHANNEL_RC_OK;
    }

    /* Convert UTF-8 → UTF-16LE */
    size_t len_utf8 = strlen(text);
    /* worst-case: each char → 2 UTF-16 code units + NUL */
    size_t buf_size = (len_utf8 + 1) * 2;
    BYTE *utf16 = calloc(1, buf_size);
    if (utf16) {
        size_t written = 0;
        const char *src = text;
        WCHAR *dst = (WCHAR *)utf16;
        /* Simple ASCII fast-path (good enough for most clipboard text) */
        while (*src && written < buf_size / 2 - 1) {
            *dst++ = (WCHAR)(unsigned char)*src++;
            written++;
        }
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        resp.msgFlags = CB_RESPONSE_OK;
        resp.requestedFormatData = utf16;
        resp.dataLen = (UINT32)((written + 1) * 2); /* include NUL */
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        free(utf16);
    }

    free(text);
    return CHANNEL_RC_OK;
}

/* -------------------------------------------------------------------------
 * Channel lifecycle – called by freerdp when VCs open/close
 * ------------------------------------------------------------------------- */

static void orb_channel_connected(freerdp *instance,
                                   ChannelConnectedEventArgs *e)
{
    OrbContext *ctx = (OrbContext *)instance->context;

    if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        ctx->disp = (DispClientContext *)e->pInterface;
        ctx->disp->DisplayControlCaps = orb_disp_caps;
    } else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        ctx->cliprdr = (CliprdrClientContext *)e->pInterface;
        ctx->cliprdr->custom = ctx;
        ctx->cliprdr->MonitorReady        = orb_cliprdr_monitor_ready;
        ctx->cliprdr->ServerFormatList    = orb_cliprdr_format_list;
        ctx->cliprdr->ServerFormatDataRequest = orb_cliprdr_format_data_request;
    }

    freerdp_client_OnChannelConnectedEventHandler(instance->context, e);
}

static void orb_channel_disconnected(freerdp *instance,
                                      ChannelDisconnectedEventArgs *e)
{
    OrbContext *ctx = (OrbContext *)instance->context;

    if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0)
        ctx->disp = NULL;
    else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0)
        ctx->cliprdr = NULL;

    freerdp_client_OnChannelDisconnectedEventHandler(instance->context, e);
}

/* -------------------------------------------------------------------------
 * PreConnect – configure settings before connecting
 * ------------------------------------------------------------------------- */

static BOOL orb_pre_connect(freerdp *instance)
{
    rdpSettings *settings = instance->settings;

    /* Request virtual channels */
    freerdp_client_load_addins(instance->context->channels, settings);

    /* NLA / TLS negotiation – allow both for compatibility */
    freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity,   TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity,   TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity,   TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);

    /* Use RemoteFX / GFX if server supports it; fall back to basic RDP */
    freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RemoteFxCodec,  TRUE);
    freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth,   32);

    /* Disable audio (we don't handle it) */
    freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, FALSE);
    freerdp_settings_set_bool(settings, FreeRDP_AudioCapture,  FALSE);

    /* Register channel event handlers */
    PubSub_SubscribeChannelConnected(
        instance->context->pubSub,
        (pChannelConnectedEventHandler)orb_channel_connected);
    PubSub_SubscribeChannelDisconnected(
        instance->context->pubSub,
        (pChannelDisconnectedEventHandler)orb_channel_disconnected);

    return TRUE;
}

/* -------------------------------------------------------------------------
 * PostConnect – initialise GDI / EndPaint after connection is established
 * ------------------------------------------------------------------------- */

static BOOL orb_post_connect(freerdp *instance)
{
    if (!gdi_init(instance, PIXEL_FORMAT_BGRX32))
        return FALSE;

    /* Hook our EndPaint into the update chain */
    instance->context->update->EndPaint = orb_end_paint;

    return TRUE;
}

/* -------------------------------------------------------------------------
 * PostDisconnect – clean up GDI
 * ------------------------------------------------------------------------- */

static void orb_post_disconnect(freerdp *instance)
{
    gdi_free(instance);
}

/* -------------------------------------------------------------------------
 * Event-loop thread
 * ------------------------------------------------------------------------- */

static void *orb_event_loop(void *arg)
{
    OrbRdpSession *sess = (OrbRdpSession *)arg;
    freerdp       *instance = sess->instance;
    OrbContext    *ctx = (OrbContext *)instance->context;

    /* Connect (blocks until connected or failed) */
    BOOL ok = freerdp_connect(instance);
    if (!ok) {
        UINT32 err = freerdp_get_last_error(instance->context);
        char msg[256];
        snprintf(msg, sizeof(msg),
                 "RDP connect failed: %s",
                 freerdp_get_last_error_string(err));
        report_error(ctx, "%s", msg);
        sess->alive = 0;
        return NULL;
    }

    /* Pump events until disconnect requested or server closes */
    while (!ctx->stop_requested) {
        HANDLE handles[64];
        DWORD  count = freerdp_get_event_handles(instance->context,
                                                  handles, 64);
        if (count == 0)
            break;

        DWORD status = WaitForMultipleObjects(count, handles, FALSE, 100 /* ms */);
        (void)status;

        if (!freerdp_check_event_handles(instance->context)) {
            if (freerdp_get_disconnect_ultimatum(instance->context) ==
                    Disconnect_Ultimatum_provider_initiated) {
                /* Server disconnected us */
                UINT32 err = freerdp_error_info(instance);
                char msg[256];
                snprintf(msg, sizeof(msg),
                         "RDP disconnected by server (error 0x%08X)", err);
                report_error(ctx, "%s", msg);
            }
            break;
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
    OrbRdpSession *sess = calloc(1, sizeof(*sess));
    if (!sess) return NULL;

    /* Allocate freerdp instance with our extended context */
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

    /* Initialise our custom fields */
    OrbContext *ctx = (OrbContext *)instance->context;
    ctx->on_frame  = on_frame;
    ctx->on_error  = on_error;
    ctx->user_ctx  = user_ctx;
    ctx->session   = sess;
    pthread_mutex_init(&ctx->clipboard_mutex, NULL);

    /* Apply connection settings */
    rdpSettings *settings = instance->settings;
    freerdp_settings_set_string(settings, FreeRDP_ServerHostname, host);
    freerdp_settings_set_uint32(settings, FreeRDP_ServerPort,     port);
    freerdp_settings_set_string(settings, FreeRDP_Username,       username);
    freerdp_settings_set_string(settings, FreeRDP_Password,       password);
    if (domain && domain[0])
        freerdp_settings_set_string(settings, FreeRDP_Domain, domain);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth,   width);
    freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight,  height);

    if (console_mode)
        freerdp_settings_set_bool(settings, FreeRDP_ConsoleSession, TRUE);

    /* Enable DISP and clipboard VCs */
    freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard,     TRUE);

    /* Initialize the channels subsystem */
    freerdp_client_context_new((rdpClientContext *)instance->context);

    sess->instance = instance;
    sess->alive    = 1;

    /* Launch the event-loop on a dedicated thread */
    if (pthread_create(&sess->thread, NULL, orb_event_loop, sess) != 0) {
        freerdp_context_free(instance);
        freerdp_free(instance);
        pthread_mutex_destroy(&ctx->clipboard_mutex);
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

    freerdp_client_context_free((rdpClientContext *)session->instance->context);
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
    layout.Flags       = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Left        = 0;
    layout.Top         = 0;
    layout.Width       = width;
    layout.Height      = height;
    layout.Orientation = ORIENTATION_LANDSCAPE;
    layout.DesktopScaleFactor = 100;
    layout.DeviceScaleFactor  = 100;
    layout.PhysicalWidth      = width;
    layout.PhysicalHeight     = height;

    ctx->disp->SendMonitorLayout(ctx->disp, 1, &layout);
}

void orb_set_clipboard(OrbRdpSession *session, const char *text)
{
    if (!session || !text) return;
    OrbContext *ctx = (OrbContext *)session->instance->context;

    pthread_mutex_lock(&ctx->clipboard_mutex);
    free(ctx->pending_clipboard);
    ctx->pending_clipboard = strdup(text);
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    /* If cliprdr is already up, advertise the new format immediately */
    if (ctx->cliprdr && session->alive) {
        CLIPRDR_FORMAT_LIST fmt = { 0 };
        CLIPRDR_FORMAT entry = { CF_UNICODETEXT, NULL };
        fmt.numFormats = 1;
        fmt.formats = &entry;
        ctx->cliprdr->ClientFormatList(ctx->cliprdr, &fmt);
    }
}
