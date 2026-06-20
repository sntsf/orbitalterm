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

/* RDPGFX (Graphics Pipeline) — modern codecs (RemoteFX Progressive, H.264).
 * gdi_graphics_pipeline_init bridges decoded GFX surfaces into the GDI
 * primary buffer so our EndPaint/dirty-rect path keeps working unchanged. */
#include <freerdp/client/rdpgfx.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/gdi/gfx.h>

/* Clipboard channel */
#include <freerdp/client/cliprdr.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/version.h>

/* FreeRDP 2/3 compatibility.
 * FreeRDP 3 moved the common message header fields (msgType, msgFlags,
 * dataLen) into a nested `.common` sub-struct on clipboard message structs.
 * FreeRDP 2 has those fields directly on the struct itself.
 * CLIP_HDR(r) resolves to either (r).common or (r) so the same code
 * compiles against both versions. */
#if FREERDP_VERSION_MAJOR >= 3
#  define CLIP_HDR(r) (r).common
#else
#  include <freerdp/client.h>   /* freerdp_client_load_addins on FreeRDP 2 */
#  define CLIP_HDR(r) (r)
#endif

/* winpr threading */
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/wlog.h>

/* -------------------------------------------------------------------------
 * Extended context  (rdpContext MUST be the first member)
 * ------------------------------------------------------------------------- */

typedef struct {
    rdpContext base; /* freerdp casts context pointers — keep this first */

    orb_frame_fn     on_frame;
    orb_error_fn     on_error;
    orb_clipboard_fn on_clipboard;
    void            *user_ctx;

    char          *pending_clipboard;
    pthread_mutex_t clipboard_mutex;
    /* Set by orb_set_clipboard (any thread); consumed by the event-loop thread,
     * which is the only thread allowed to write to the cliprdr channel. */
    volatile int   clipboard_dirty;

    volatile int   stop_requested;

    struct timespec last_frame_ts; /* for 60fps rate-limiter */

    struct OrbRdpSession *session;

    DispClientContext    *disp;
    CliprdrClientContext *cliprdr;
    RdpgfxClientContext  *gfx;
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
 * DesktopResize – fired when the server applies a new resolution (e.g. after
 * we send a monitor layout via orb_resize).  Without this hook FreeRDP never
 * resizes its framebuffer, so the canvas stays black until the next
 * server-initiated EndPaint happens to arrive — exactly the "goes black, then
 * recovers after a while" symptom seen when maximizing the window.
 * ------------------------------------------------------------------------- */

static BOOL orb_desktop_resize(rdpContext *context)
{
    OrbContext  *ctx      = (OrbContext *)context;
    rdpGdi      *gdi      = context->gdi;
    rdpSettings *settings = context->settings;

    UINT32 w = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);

    if (!gdi_resize(gdi, w, h))
        return FALSE;

    /* The framebuffer was just reallocated at the new size — push a full frame
     * immediately so the canvas repaints now instead of showing black until
     * the server's next EndPaint. */
    if (gdi->primary_buffer && ctx->on_frame) {
        ctx->on_frame(ctx->user_ctx, gdi->primary_buffer,
                      0, 0, (uint32_t)gdi->width, (uint32_t)gdi->height,
                      (uint32_t)gdi->stride);
        clock_gettime(CLOCK_MONOTONIC, &ctx->last_frame_ts);
    }
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
    fprintf(stderr, "[orb-clip] monitor_ready\n");

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
    /* Acknowledge remote format advertisement */
    CLIPRDR_FORMAT_LIST_RESPONSE resp = { 0 };
    CLIP_HDR(resp).msgFlags = CB_RESPONSE_OK;
    cliprdr->ClientFormatListResponse(cliprdr, &resp);

    /* Remote → local: if the server is offering Unicode text, request it now so
     * we can mirror it into this machine's clipboard (the data arrives in
     * orb_cliprdr_format_data_response). */
    BOOL has_text = FALSE;
    for (UINT32 i = 0; i < list->numFormats; i++) {
        if (list->formats[i].formatId == CF_UNICODETEXT) { has_text = TRUE; break; }
    }
    fprintf(stderr, "[orb-clip] server format list: numFormats=%u has_text=%d\n",
            list->numFormats, has_text);
    if (has_text) {
        CLIPRDR_FORMAT_DATA_REQUEST req = { 0 };
        req.requestedFormatId = CF_UNICODETEXT;
        cliprdr->ClientFormatDataRequest(cliprdr, &req);
    }
    return CHANNEL_RC_OK;
}

/* Minimal, correct UTF-8 → UTF-16LE converter.  Returns a malloc'd,
 * NUL-terminated WCHAR buffer and writes the unit count (excluding NUL) to
 * *out_units.  Handles 1–4 byte sequences and emits surrogate pairs for code
 * points above the BMP; malformed bytes become U+FFFD.  Replaces the previous
 * byte-cast fast-path, which corrupted any non-ASCII text (accents, ñ, …). */
static WCHAR *orb_utf8_to_utf16(const char *s, size_t *out_units)
{
    size_t len = strlen(s);
    /* ASCII is the worst case at 1 unit/byte; multi-byte sequences only ever
     * produce fewer units than bytes, so len+1 units is always enough. */
    WCHAR *out = (WCHAR *)calloc(len + 1, sizeof(WCHAR));
    if (!out) { if (out_units) *out_units = 0; return NULL; }

    size_t o = 0;
    const unsigned char *p   = (const unsigned char *)s;
    const unsigned char *end = p + len;
    while (p < end) {
        unsigned int  cp;
        unsigned char c     = *p;
        size_t        avail = (size_t)(end - p);

        if (c < 0x80) {
            cp = c; p += 1;
        } else if ((c >> 5) == 0x6 && avail >= 2 && (p[1] & 0xC0) == 0x80) {
            cp = ((c & 0x1Fu) << 6) | (p[1] & 0x3Fu); p += 2;
        } else if ((c >> 4) == 0xE && avail >= 3 &&
                   (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
            cp = ((c & 0x0Fu) << 12) | ((p[1] & 0x3Fu) << 6) | (p[2] & 0x3Fu); p += 3;
        } else if ((c >> 3) == 0x1E && avail >= 4 &&
                   (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 &&
                   (p[3] & 0xC0) == 0x80) {
            cp = ((c & 0x07u) << 18) | ((p[1] & 0x3Fu) << 12) |
                 ((p[2] & 0x3Fu) << 6) | (p[3] & 0x3Fu); p += 4;
        } else {
            cp = 0xFFFD; p += 1;
        }

        if (cp <= 0xFFFF) {
            out[o++] = (WCHAR)cp;
        } else {
            cp -= 0x10000;
            out[o++] = (WCHAR)(0xD800 + (cp >> 10));
            out[o++] = (WCHAR)(0xDC00 + (cp & 0x3FF));
        }
    }
    out[o] = 0;
    if (out_units) *out_units = o;
    return out;
}

static UINT orb_cliprdr_format_data_request(CliprdrClientContext *cliprdr,
                                              const CLIPRDR_FORMAT_DATA_REQUEST *req)
{
    OrbContext *ctx = (OrbContext *)cliprdr->custom;
    fprintf(stderr, "[orb-clip] server requested our clipboard (format=%u)\n",
            req->requestedFormatId);

    if (req->requestedFormatId != CF_UNICODETEXT) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        CLIP_HDR(resp).msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        return CHANNEL_RC_OK;
    }

    pthread_mutex_lock(&ctx->clipboard_mutex);
    char *text = ctx->pending_clipboard ? strdup(ctx->pending_clipboard) : NULL;
    pthread_mutex_unlock(&ctx->clipboard_mutex);

    if (!text) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        CLIP_HDR(resp).msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        return CHANNEL_RC_OK;
    }

    /* Convert UTF-8 → UTF-16LE (full Unicode: accents, ñ, emoji, …). */
    size_t units = 0;
    WCHAR *utf16 = orb_utf8_to_utf16(text, &units);
    if (utf16) {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        CLIP_HDR(resp).msgFlags    = CB_RESPONSE_OK;
        CLIP_HDR(resp).dataLen     = (UINT32)((units + 1) * 2); /* +1 for NUL */
        resp.requestedFormatData = (BYTE *)utf16;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
        free(utf16);
    } else {
        CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
        CLIP_HDR(resp).msgFlags = CB_RESPONSE_FAIL;
        cliprdr->ClientFormatDataResponse(cliprdr, &resp);
    }

    free(text);
    return CHANNEL_RC_OK;
}

/* Minimal UTF-16LE → UTF-8 converter.  `units` is the number of WCHARs (a
 * trailing NUL, if present, should not be counted by the caller).  Returns a
 * malloc'd, NUL-terminated UTF-8 string; caller frees. */
static char *orb_utf16_to_utf8(const WCHAR *w, size_t units)
{
    /* Each UTF-16 unit yields at most 3 UTF-8 bytes (BMP); a surrogate pair
     * (2 units) yields 4 bytes, so 3 bytes/unit is a safe upper bound. */
    char *out = (char *)malloc(units * 3 + 1);
    if (!out) return NULL;

    size_t o = 0;
    for (size_t i = 0; i < units; i++) {
        unsigned int cp = (unsigned int)(uint16_t)w[i];

        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < units) {
            unsigned int lo = (unsigned int)(uint16_t)w[i + 1];
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                i++;
            }
        }

        if (cp < 0x80) {
            out[o++] = (char)cp;
        } else if (cp < 0x800) {
            out[o++] = (char)(0xC0 | (cp >> 6));
            out[o++] = (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out[o++] = (char)(0xE0 | (cp >> 12));
            out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[o++] = (char)(0x80 | (cp & 0x3F));
        } else {
            out[o++] = (char)(0xF0 | (cp >> 18));
            out[o++] = (char)(0x80 | ((cp >> 12) & 0x3F));
            out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[o++] = (char)(0x80 | (cp & 0x3F));
        }
    }
    out[o] = 0;
    return out;
}

/* Remote → local: the server sent us the clipboard text we requested in
 * orb_cliprdr_format_list.  Decode it and hand it to Rust, which writes it to
 * this machine's clipboard. */
static UINT orb_cliprdr_format_data_response(
    CliprdrClientContext *cliprdr,
    const CLIPRDR_FORMAT_DATA_RESPONSE *response)
{
    OrbContext *ctx = (OrbContext *)cliprdr->custom;

    if ((CLIP_HDR(*response).msgFlags & CB_RESPONSE_OK) == 0)
        return CHANNEL_RC_OK;

    const BYTE *data = response->requestedFormatData;
    UINT32      len  = CLIP_HDR(*response).dataLen; /* bytes */
    fprintf(stderr, "[orb-clip] received remote clipboard data: %u bytes\n", len);
    if (!data || len < 2 || !ctx->on_clipboard)
        return CHANNEL_RC_OK;

    size_t units = len / 2;
    /* Drop a trailing NUL unit if present so we don't emit a stray \0. */
    const WCHAR *w = (const WCHAR *)data;
    if (units > 0 && w[units - 1] == 0)
        units--;

    char *utf8 = orb_utf16_to_utf8(w, units);
    if (utf8) {
        ctx->on_clipboard(ctx->user_ctx, utf8);
        free(utf8);
    }
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

    if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        /* Bridge the Graphics Pipeline into the GDI so decoded GFX surfaces
         * land in primary_buffer and flow through our normal EndPaint path. */
        ctx->gfx = (RdpgfxClientContext *)e->pInterface;
        gdi_graphics_pipeline_init(context->gdi, ctx->gfx);
    } else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        ctx->disp = (DispClientContext *)e->pInterface;
        ctx->disp->DisplayControlCaps = orb_disp_caps;
    } else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        fprintf(stderr, "[orb-clip] cliprdr channel CONNECTED\n");
        ctx->cliprdr = (CliprdrClientContext *)e->pInterface;
        ctx->cliprdr->custom                  = ctx;
        ctx->cliprdr->MonitorReady             = orb_cliprdr_monitor_ready;
        ctx->cliprdr->ServerFormatList         = orb_cliprdr_format_list;
        ctx->cliprdr->ServerFormatDataRequest  = orb_cliprdr_format_data_request;
        ctx->cliprdr->ServerFormatDataResponse = orb_cliprdr_format_data_response;
    }
}

static void orb_channel_disconnected(rdpContext *context,
                                      ChannelDisconnectedEventArgs *e)
{
    OrbContext *ctx = (OrbContext *)context;

    if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        if (ctx->gfx) {
            gdi_graphics_pipeline_uninit(context->gdi, ctx->gfx);
            ctx->gfx = NULL;
        }
    } else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0)
        ctx->disp = NULL;
    else if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0)
        ctx->cliprdr = NULL;
}

/* -------------------------------------------------------------------------
 * PreConnect
 * ------------------------------------------------------------------------- */

/* LoadChannels – FreeRDP 3 moved channel loading here from PreConnect. This is
 * the correct place to register channel addins; doing it in PreConnect leaves
 * static channels (like cliprdr) unconnected. */
static BOOL orb_load_channels(freerdp *instance)
{
    rdpContext  *context  = instance->context;
    rdpSettings *settings = context->settings;

    /* cliprdr is a STATIC virtual channel; register it before loading addins. */
    if (freerdp_settings_get_bool(settings, FreeRDP_RedirectClipboard)) {
        const char *cliprdr_argv[] = { "cliprdr" };
        freerdp_client_add_static_channel(settings, 1, cliprdr_argv);
    }

    BOOL ok = freerdp_client_load_addins(context->channels, settings);
    fprintf(stderr, "[orb-clip] load_channels: RedirectClipboard=%d load_addins=%d\n",
            freerdp_settings_get_bool(settings, FreeRDP_RedirectClipboard), ok);
    return ok;
}

static BOOL orb_pre_connect(freerdp *instance)
{
    OrbContext   *ctx      = (OrbContext *)instance->context;
    rdpSettings  *settings = orb_settings(ctx);

    /* NOTE: channel addins are loaded in orb_load_channels (the LoadChannels
     * callback), NOT here. FreeRDP 3 moved channel loading out of PreConnect;
     * loading static channels (cliprdr) here is too late and they never
     * connect. */

    /* Security: allow NLA, TLS, classic RDP; ignore cert errors */
    freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity,       TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity,       TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity,       TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);

    /* Video pipeline */
    freerdp_settings_set_bool(settings,   FreeRDP_SupportGraphicsPipeline, TRUE);
    freerdp_settings_set_bool(settings,   FreeRDP_RemoteFxCodec,           TRUE);
    freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth,              32);

    /* Graphics Pipeline codecs. Progressive (RFX) is pure-software in FreeRDP
     * and always available — a big step up from legacy bitmap updates for
     * scrolling/redraw. H.264/AVC444 give the smoothest video but are only
     * negotiated when both the server AND this FreeRDP build support them
     * (FreeRDP silently falls back to progressive otherwise), so enabling them
     * is safe. These take effect only because the RDPGFX channel is now wired
     * to the GDI in orb_channel_connected(). */
    freerdp_settings_set_bool(settings, FreeRDP_GfxProgressive, TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_GfxH264,        TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444,      TRUE);

    /* Let FreeRDP measure RTT/bandwidth and adapt update aggressiveness to the
     * link.  On a LAN this keeps latency low; on slower links it avoids
     * flooding the channel with updates the client can't keep up with. */
    freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, TRUE);

    /* Performance flags — ask the server NOT to send the expensive desktop
     * eye-candy that constantly repaints large regions.  Disabling wallpaper,
     * full-window drag, menu animations and desktop composition is by far the
     * biggest win for perceived fluidity: it slashes the number and size of
     * dirty-rect updates we have to encode and ship to the canvas.
     *
     * Themes are intentionally left ON (not disabled) so the desktop still
     * looks modern; they cost very little compared to the items above. */
    freerdp_settings_set_bool(settings, FreeRDP_DisableWallpaper,        TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_DisableFullWindowDrag,   TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_DisableMenuAnims,        TRUE);
    freerdp_settings_set_bool(settings, FreeRDP_AllowDesktopComposition, FALSE);
    freerdp_settings_set_bool(settings, FreeRDP_AllowFontSmoothing,      TRUE);
    /* Build the PERF_* bitmask the server reads from the booleans set above. */
    freerdp_performance_flags_make(settings);

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

    instance->context->update->EndPaint     = orb_end_paint;
    instance->context->update->DesktopResize = orb_desktop_resize;
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

        /* Local → remote clipboard: orb_set_clipboard (called from the Tauri
         * command thread) only stores the text and raises this flag.  The
         * actual cliprdr channel write MUST happen on this thread, so advertise
         * the new format list here. */
        if (ctx->clipboard_dirty && ctx->cliprdr) {
            ctx->clipboard_dirty = 0;
            fprintf(stderr, "[orb-clip] advertising CF_UNICODETEXT to server\n");
            CLIPRDR_FORMAT entry = { CF_UNICODETEXT, NULL };
            CLIPRDR_FORMAT_LIST fmt = { 0 };
            fmt.numFormats = 1;
            fmt.formats    = &entry;
            ctx->cliprdr->ClientFormatList(ctx->cliprdr, &fmt);
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
                                int           security_mode,
                                uint16_t      color_depth,
                                orb_frame_fn  on_frame,
                                orb_error_fn  on_error,
                                orb_clipboard_fn on_clipboard,
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
    instance->LoadChannels   = orb_load_channels;
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

    ctx->on_frame     = on_frame;
    ctx->on_error     = on_error;
    ctx->on_clipboard = on_clipboard;
    ctx->user_ctx     = user_ctx;
    ctx->session      = sess;
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

    /* Security mode */
    switch (security_mode) {
        case ORB_SEC_NLA:
            freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity,  TRUE);
            freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity,  FALSE);
            freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity,  FALSE);
            break;
        case ORB_SEC_TLS:
            freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity,  FALSE);
            freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity,  TRUE);
            freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity,  FALSE);
            break;
        case ORB_SEC_RDP:
            freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity,         FALSE);
            freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity,         FALSE);
            freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity,         TRUE);
            freerdp_settings_set_bool(settings, FreeRDP_UseRdpSecurityLayer, TRUE);
            break;
        default: /* ORB_SEC_NEGOTIATE: let FreeRDP negotiate */
            break;
    }

    /* Color depth */
    if (color_depth >= 8 && color_depth <= 32)
        freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, color_depth);

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

    /* Only store the text and raise a flag. The cliprdr channel write happens
     * on the event-loop thread (see orb_event_loop) — calling ClientFormatList
     * directly from this (Tauri command) thread races the FreeRDP I/O and
     * silently fails to advertise to the server. */
    fprintf(stderr, "[orb-clip] orb_set_clipboard: %zu bytes (cliprdr=%p)\n",
            strlen(text), (void *)ctx->cliprdr);
    pthread_mutex_lock(&ctx->clipboard_mutex);
    free(ctx->pending_clipboard);
    ctx->pending_clipboard = strdup(text);
    ctx->clipboard_dirty   = 1;
    pthread_mutex_unlock(&ctx->clipboard_mutex);
}
