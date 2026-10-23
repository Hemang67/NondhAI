// vd-audio: meeting audio capture for Nondh AI.
//
// Captures the default microphone and (unless --no-loopback) the default speaker output via
// WASAPI loopback, converts both to 16 kHz mono, keeps them on one timeline, and optionally runs
// speexdsp's echo canceller so the other side's voice, played through speakers and picked up
// by the mic, is removed from the mic track.
//
// Usage: vd-audio [--no-loopback] [--aec]
// stdout: binary frames  'A' <channel u8: 0 mic, 1 system> <count u16 LE> <count x int16 LE>
//         one 10 ms frame (160 samples) per channel per tick, mic and system interleaved in step.
// stderr: one JSON object per line: started | level | device-changed | error | stopped
// stdin:  closing it (or the line "QUIT") stops capture.
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <io.h>
#include <fcntl.h>
#include "speex/speex_echo.h"
#include "speex/speex_preprocess.h"
#include "speex/speex_resampler.h"

// COM ids, defined here because C builds have no import library for them.
DEFINE_GUID(VD_CLSID_MMDeviceEnumerator, 0xBCDE0395, 0xE52F, 0x467C, 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E);
DEFINE_GUID(VD_IID_IMMDeviceEnumerator, 0xA95664D2, 0x9614, 0x4F35, 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6);
DEFINE_GUID(VD_IID_IAudioClient, 0x1CB9AD4C, 0xDBFA, 0x4C32, 0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2);
DEFINE_GUID(VD_IID_IAudioCaptureClient, 0xC8ADBD64, 0xE71E, 0x48A0, 0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17);
DEFINE_GUID(VD_SUBTYPE_IEEE_FLOAT, 0x00000003, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71);

#define RATE 16000
#define FRAME 160               // 10 ms
#define AEC_TAIL (RATE * 3 / 10) // 300 ms echo tail
#define FIFO_CAP (RATE * 4)

typedef struct {
  float buf[FIFO_CAP];
  int head, len;
} Fifo;

static void fifo_push(Fifo *f, const float *x, int n) {
  for (int i = 0; i < n; i++) {
    if (f->len == FIFO_CAP) { f->head = (f->head + 1) % FIFO_CAP; f->len--; } // drop oldest
    f->buf[(f->head + f->len) % FIFO_CAP] = x[i];
    f->len++;
  }
}
static int fifo_pop(Fifo *f, float *out, int n) {
  if (f->len < n) return 0;
  for (int i = 0; i < n; i++) { out[i] = f->buf[f->head]; f->head = (f->head + 1) % FIFO_CAP; }
  f->len -= n;
  return 1;
}

typedef struct {
  const char *name;
  IMMDevice *dev;
  IAudioClient *client;
  IAudioCaptureClient *capture;
  WAVEFORMATEX *fmt;
  int isFloat, channels, bits;
  SpeexResamplerState *rs;
  Fifo fifo;
  double rmsAcc; int rmsN;
  LONGLONG samplesOut; // 16 kHz samples delivered on the timeline
} Stream;

static volatile LONG g_stop = 0;
static IMMDeviceEnumerator *g_enum = NULL;

static void jsonEvent(const char *fmt, ...) {
  char buf[1024];
  va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
  fprintf(stderr, "%s\n", buf);
  fflush(stderr);
}

static void deviceName(IMMDevice *dev, char *out, int cap) {
  IPropertyStore *ps = NULL;
  out[0] = 0;
  if (FAILED(IMMDevice_OpenPropertyStore(dev, STGM_READ, &ps))) return;
  PROPVARIANT v; PropVariantInit(&v);
  if (SUCCEEDED(IPropertyStore_GetValue(ps, &PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) {
    WideCharToMultiByte(CP_UTF8, 0, v.pwszVal, -1, out, cap, NULL, NULL);
    for (char *c = out; *c; c++) if (*c == '"' || *c == '\\') *c = '\'';
  }
  PropVariantClear(&v);
  IPropertyStore_Release(ps);
}

static void closeStream(Stream *s) {
  if (s->client) IAudioClient_Stop(s->client);
  if (s->capture) { IAudioCaptureClient_Release(s->capture); s->capture = NULL; }
  if (s->client) { IAudioClient_Release(s->client); s->client = NULL; }
  if (s->fmt) { CoTaskMemFree(s->fmt); s->fmt = NULL; }
  if (s->dev) { IMMDevice_Release(s->dev); s->dev = NULL; }
  if (s->rs) { speex_resampler_destroy(s->rs); s->rs = NULL; }
}

static HRESULT openStream(Stream *s, EDataFlow flow, int loopback) {
  HRESULT hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(g_enum, flow, flow == eCapture ? eCommunications : eConsole, &s->dev);
  if (FAILED(hr)) return hr;
  hr = IMMDevice_Activate(s->dev, &VD_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&s->client);
  if (FAILED(hr)) return hr;
  hr = IAudioClient_GetMixFormat(s->client, &s->fmt);
  if (FAILED(hr)) return hr;
  s->channels = s->fmt->nChannels;
  s->bits = s->fmt->wBitsPerSample;
  s->isFloat = s->fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
               (s->fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
                IsEqualGUID(&((WAVEFORMATEXTENSIBLE *)s->fmt)->SubFormat, &VD_SUBTYPE_IEEE_FLOAT));
  hr = IAudioClient_Initialize(s->client, AUDCLNT_SHAREMODE_SHARED, loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0,
                               2000000 /* 200 ms */, 0, s->fmt, NULL);
  if (FAILED(hr)) return hr;
  hr = IAudioClient_GetService(s->client, &VD_IID_IAudioCaptureClient, (void **)&s->capture);
  if (FAILED(hr)) return hr;
  int err = 0;
  s->rs = speex_resampler_init(1, s->fmt->nSamplesPerSec, RATE, 5, &err);
  hr = IAudioClient_Start(s->client);
  return hr;
}

static float sampleAt(Stream *s, const BYTE *data, UINT32 frame, int ch) {
  int idx = frame * s->channels + ch;
  if (s->isFloat) return ((const float *)data)[idx];
  if (s->bits == 16) return ((const short *)data)[idx] / 32768.0f;
  if (s->bits == 32) return ((const int *)data)[idx] / 2147483648.0f;
  if (s->bits == 24) {
    const BYTE *p = data + idx * 3;
    int v = (p[0] << 8) | (p[1] << 16) | (p[2] << 24);
    return v / 2147483648.0f;
  }
  return 0;
}

// Drain WASAPI packets into the stream's 16 kHz FIFO. Returns an HRESULT (device loss).
static HRESULT pump(Stream *s) {
  static float mono[48000], out[16000];
  for (;;) {
    UINT32 packet = 0;
    HRESULT hr = IAudioCaptureClient_GetNextPacketSize(s->capture, &packet);
    if (FAILED(hr)) return hr;
    if (!packet) return S_OK;
    BYTE *data; UINT32 frames; DWORD flags;
    hr = IAudioCaptureClient_GetBuffer(s->capture, &data, &frames, &flags, NULL, NULL);
    if (FAILED(hr)) return hr;
    UINT32 n = frames > 48000 ? 48000 : frames;
    for (UINT32 i = 0; i < n; i++) {
      float acc = 0;
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT))
        for (int c = 0; c < s->channels; c++) acc += sampleAt(s, data, i, c);
      mono[i] = acc / s->channels;
    }
    IAudioCaptureClient_ReleaseBuffer(s->capture, frames);
    spx_uint32_t inLen = n, outLen = 16000;
    speex_resampler_process_float(s->rs, 0, mono, &inLen, out, &outLen);
    fifo_push(&s->fifo, out, (int)outLen);
  }
}

static void writeFrame(int channel, const float *x) {
  static BYTE buf[4 + FRAME * 2];
  buf[0] = 'A'; buf[1] = (BYTE)channel; buf[2] = FRAME & 0xFF; buf[3] = FRAME >> 8;
  short *pcm = (short *)(buf + 4);
  for (int i = 0; i < FRAME; i++) {
    float v = x[i] * 32767.0f;
    pcm[i] = (short)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
  }
  fwrite(buf, 1, sizeof buf, stdout);
}

static DWORD WINAPI stdinWatch(LPVOID arg) {
  char line[64];
  while (fgets(line, sizeof line, stdin)) if (strncmp(line, "QUIT", 4) == 0) break;
  InterlockedExchange(&g_stop, 1);
  return 0;
}

// Offline mode for tests: echo-cancel mic.wav against ref.wav (both 16 kHz mono 16-bit).
static short *readWav16(const char *path, int *n) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END); long size = ftell(f); fseek(f, 44, SEEK_SET);
  *n = (int)((size - 44) / 2);
  short *x = malloc(sizeof(short) * (*n + FRAME));
  fread(x, 2, *n, f); fclose(f);
  return x;
}
static void writeWav16(const char *path, const short *x, int n) {
  FILE *f = fopen(path, "wb");
  int bytes = n * 2, rate = RATE, br = RATE * 2, v32; short v16;
  fwrite("RIFF", 1, 4, f); v32 = 36 + bytes; fwrite(&v32, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
  v32 = 16; fwrite(&v32, 4, 1, f); v16 = 1; fwrite(&v16, 2, 1, f); fwrite(&v16, 2, 1, f);
  fwrite(&rate, 4, 1, f); fwrite(&br, 4, 1, f); v16 = 2; fwrite(&v16, 2, 1, f); v16 = 16; fwrite(&v16, 2, 1, f);
  fwrite("data", 1, 4, f); fwrite(&bytes, 4, 1, f); fwrite(x, 2, n, f); fclose(f);
}
static int aecFile(const char *micPath, const char *refPath, const char *outPath) {
  int nm, nr;
  short *m = readWav16(micPath, &nm), *r = readWav16(refPath, &nr);
  if (!m || !r) { fprintf(stderr, "cannot read input\n"); return 1; }
  int n = nm < nr ? nm : nr;
  n -= n % FRAME;
  short *out = malloc(sizeof(short) * n);
  SpeexEchoState *echo = speex_echo_state_init(FRAME, AEC_TAIL);
  int rate = RATE;
  speex_echo_ctl(echo, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
  SpeexPreprocessState *pre = speex_preprocess_state_init(FRAME, RATE);
  speex_preprocess_ctl(pre, SPEEX_PREPROCESS_SET_ECHO_STATE, echo);
  int off = 0;
  speex_preprocess_ctl(pre, SPEEX_PREPROCESS_SET_DENOISE, &off);
  for (int i = 0; i < n; i += FRAME) {
    speex_echo_cancellation(echo, m + i, r + i, out + i);
    speex_preprocess_run(pre, out + i);
  }
  writeWav16(outPath, out, n);
  return 0;
}

// --sessions: print one line per process that has an *active* microphone stream right now,
// "<pid>\t<exe path>", across every capture device. Used for meeting detection: Windows' own
// privacy registry misses many apps, the audio engine's session list does not.
DEFINE_GUID(VD_IID_IAudioSessionManager2, 0x77AA99A0, 0x1BD6, 0x484F, 0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F);
DEFINE_GUID(VD_IID_IAudioSessionControl2, 0xBFB7FF88, 0x7239, 0x4FC9, 0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D);

static int listSessions(void) {
  IMMDeviceCollection *devs = NULL;
  if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(g_enum, eCapture, DEVICE_STATE_ACTIVE, &devs))) return 1;
  UINT count = 0;
  IMMDeviceCollection_GetCount(devs, &count);
  for (UINT d = 0; d < count; d++) {
    IMMDevice *dev = NULL;
    if (FAILED(IMMDeviceCollection_Item(devs, d, &dev))) continue;
    IAudioSessionManager2 *mgr = NULL;
    if (SUCCEEDED(IMMDevice_Activate(dev, &VD_IID_IAudioSessionManager2, CLSCTX_ALL, NULL, (void **)&mgr))) {
      IAudioSessionEnumerator *en = NULL;
      if (SUCCEEDED(IAudioSessionManager2_GetSessionEnumerator(mgr, &en))) {
        int n = 0;
        IAudioSessionEnumerator_GetCount(en, &n);
        for (int i = 0; i < n; i++) {
          IAudioSessionControl *ctl = NULL;
          if (FAILED(IAudioSessionEnumerator_GetSession(en, i, &ctl))) continue;
          AudioSessionState st;
          IAudioSessionControl2 *ctl2 = NULL;
          if (SUCCEEDED(IAudioSessionControl_GetState(ctl, &st)) && st == AudioSessionStateActive &&
              SUCCEEDED(IAudioSessionControl_QueryInterface(ctl, &VD_IID_IAudioSessionControl2, (void **)&ctl2))) {
            DWORD pid = 0;
            IAudioSessionControl2_GetProcessId(ctl2, &pid);
            WCHAR path[MAX_PATH] = L"";
            HANDLE p = pid ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : NULL;
            if (p) {
              DWORD len = MAX_PATH;
              QueryFullProcessImageNameW(p, 0, path, &len);
              CloseHandle(p);
            }
            char p8[MAX_PATH * 3];
            WideCharToMultiByte(CP_UTF8, 0, path, -1, p8, sizeof p8, NULL, NULL);
            if (pid) printf("%lu\t%s\n", (unsigned long)pid, p8);
            IAudioSessionControl2_Release(ctl2);
          }
          IAudioSessionControl_Release(ctl);
        }
        IAudioSessionEnumerator_Release(en);
      }
      IAudioSessionManager2_Release(mgr);
    }
    IMMDevice_Release(dev);
  }
  IMMDeviceCollection_Release(devs);
  fflush(stdout);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "--aec-file")) return aecFile(argv[2], argv[3], argv[4]);
  if (argc == 2 && !strcmp(argv[1], "--sessions")) {
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(CoCreateInstance(&VD_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &VD_IID_IMMDeviceEnumerator, (void **)&g_enum))) return 1;
    return listSessions();
  }
  int loopback = 1, aec = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--no-loopback")) loopback = 0;
    else if (!strcmp(argv[i], "--aec")) aec = 1;
  }
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, NULL, _IOFBF, 1 << 16);
  CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(CoCreateInstance(&VD_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &VD_IID_IMMDeviceEnumerator, (void **)&g_enum))) {
    jsonEvent("{\"event\":\"error\",\"message\":\"no audio device enumerator\"}");
    return 1;
  }

  Stream mic = {0}, sys = {0};
  mic.name = "mic"; sys.name = "system";
  HRESULT hr = openStream(&mic, eCapture, 0);
  if (FAILED(hr)) { jsonEvent("{\"event\":\"error\",\"message\":\"cannot open microphone\",\"hr\":%ld}", hr); return 2; }
  if (loopback) {
    hr = openStream(&sys, eRender, 1);
    if (FAILED(hr)) { jsonEvent("{\"event\":\"error\",\"message\":\"cannot open system audio\",\"hr\":%ld}", hr); return 3; }
  }
  char micName[256], sysName[256] = "";
  deviceName(mic.dev, micName, sizeof micName);
  if (loopback) deviceName(sys.dev, sysName, sizeof sysName);
  jsonEvent("{\"event\":\"started\",\"mic\":\"%s\",\"micRate\":%lu,\"system\":\"%s\",\"systemRate\":%lu,\"aec\":%s}",
            micName, mic.fmt->nSamplesPerSec, sysName, loopback ? sys.fmt->nSamplesPerSec : 0, aec ? "true" : "false");

  SpeexEchoState *echo = NULL;
  SpeexPreprocessState *pre = NULL;
  if (aec && loopback) {
    echo = speex_echo_state_init(FRAME, AEC_TAIL);
    int rate = RATE;
    speex_echo_ctl(echo, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
    pre = speex_preprocess_state_init(FRAME, RATE);
    speex_preprocess_ctl(pre, SPEEX_PREPROCESS_SET_ECHO_STATE, echo);
    int off = 0;
    speex_preprocess_ctl(pre, SPEEX_PREPROCESS_SET_DENOISE, &off); // keep the voice natural for ASR
  }

  CreateThread(NULL, 0, stdinWatch, NULL, 0, NULL);
  LARGE_INTEGER freq, t0, now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t0);
  DWORD lastLevel = GetTickCount();
  float m[FRAME], s[FRAME], outf[FRAME];
  short mi[FRAME], si[FRAME], oi[FRAME];

  while (!g_stop) {
    Sleep(5);
    HRESULT h1 = pump(&mic);
    HRESULT h2 = loopback ? pump(&sys) : S_OK;
    if (h1 == AUDCLNT_E_DEVICE_INVALIDATED || h2 == AUDCLNT_E_DEVICE_INVALIDATED) {
      // Default device changed (headset plugged in, etc.): reopen on the new default.
      Stream *bad = h1 == AUDCLNT_E_DEVICE_INVALIDATED ? &mic : &sys;
      Fifo keep = bad->fifo;
      closeStream(bad);
      memset(bad, 0, sizeof *bad);
      bad->name = (bad == &mic) ? "mic" : "system";
      bad->fifo = keep;
      Sleep(200);
      if (FAILED(openStream(bad, bad == &mic ? eCapture : eRender, bad == &sys))) {
        jsonEvent("{\"event\":\"error\",\"message\":\"lost %s device\"}", bad->name);
        break;
      }
      char nm[256]; deviceName(bad->dev, nm, sizeof nm);
      jsonEvent("{\"event\":\"device-changed\",\"stream\":\"%s\",\"name\":\"%s\"}", bad->name, nm);
      continue;
    }
    if (FAILED(h1) || FAILED(h2)) { jsonEvent("{\"event\":\"error\",\"message\":\"capture failed\",\"hr\":%ld}", FAILED(h1) ? h1 : h2); break; }

    // Loopback delivers nothing while no app is playing; fill silence so the system track keeps
    // time with the mic track. Allow 150 ms of slack for packets that are merely late.
    if (loopback) {
      QueryPerformanceCounter(&now);
      LONGLONG expected = (now.QuadPart - t0.QuadPart) * RATE / freq.QuadPart;
      LONGLONG have = sys.samplesOut + sys.fifo.len;
      LONGLONG gap = expected - have - RATE * 15 / 100;
      if (gap > 0) {
        static float zeros[RATE];
        while (gap > 0) { int n = gap > RATE ? RATE : (int)gap; fifo_push(&sys.fifo, zeros, n); gap -= n; }
      }
    }

    while (mic.fifo.len >= FRAME && (!loopback || sys.fifo.len >= FRAME)) {
      fifo_pop(&mic.fifo, m, FRAME);
      mic.samplesOut += FRAME;
      if (loopback) { fifo_pop(&sys.fifo, s, FRAME); sys.samplesOut += FRAME; }
      if (echo) {
        for (int i = 0; i < FRAME; i++) {
          mi[i] = (short)(fmaxf(-1, fminf(1, m[i])) * 32767);
          si[i] = (short)(fmaxf(-1, fminf(1, s[i])) * 32767);
        }
        speex_echo_cancellation(echo, mi, si, oi);
        speex_preprocess_run(pre, oi);
        for (int i = 0; i < FRAME; i++) outf[i] = oi[i] / 32768.0f;
        writeFrame(0, outf);
      } else {
        writeFrame(0, m);
      }
      if (loopback) writeFrame(1, s);
      for (int i = 0; i < FRAME; i++) { mic.rmsAcc += m[i] * m[i]; if (loopback) sys.rmsAcc += s[i] * s[i]; }
      mic.rmsN += FRAME; sys.rmsN += FRAME;
    }
    fflush(stdout);

    if (GetTickCount() - lastLevel >= 250) {
      lastLevel = GetTickCount();
      jsonEvent("{\"event\":\"level\",\"mic\":%.4f,\"system\":%.4f}",
                mic.rmsN ? sqrt(mic.rmsAcc / mic.rmsN) : 0.0, sys.rmsN ? sqrt(sys.rmsAcc / sys.rmsN) : 0.0);
      mic.rmsAcc = sys.rmsAcc = 0; mic.rmsN = sys.rmsN = 0;
    }
  }

  closeStream(&mic);
  if (loopback) closeStream(&sys);
  if (echo) { speex_preprocess_state_destroy(pre); speex_echo_state_destroy(echo); }
  jsonEvent("{\"event\":\"stopped\"}");
  return 0;
}
