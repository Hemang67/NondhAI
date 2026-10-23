// vd-input: global chord hotkeys (with key-up, for push-to-talk) and paste injection for Nondh AI.
//
// stdin  (one command per line):
//   BIND <name> <spec>   spec = modifiers joined by '+', optionally ending in one key:
//                        ctrl+win, ctrl+win+t, ctrl+alt+space, ctrl+shift+f9, ctrl+win+vk:0x4D
//   CLEAR                remove all bindings
//   PASTE [shift]        wait for modifiers to be released, then send Ctrl+V (Ctrl+Shift+V with "shift")
//   COPY                 same wait, then send Ctrl+C
//   FG                   report the foreground window
//   QUIT
// stdout (one event per line):
//   READY | DOWN <name> | UP <name> | CANCEL <name> | ESC
//   PASTED ok|modifiers-held | COPIED ok|modifiers-held | FG <pid>\t<exe path>\t<title> | ERR <msg>
//
// Only bound chords and Esc are ever reported; other keystrokes never leave this process.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define MOD_CTRL_BIT 1
#define MOD_ALT_BIT 2
#define MOD_SHIFT_BIT 4
#define MOD_WIN_BIT 8
#define MAX_BINDINGS 32
#define DUMMY_VK 0xE8 // unassigned; used to stop a lone Win release from opening Start
#define VD_MARKER 0x56444B31 // dwExtraInfo on events we inject

typedef struct {
  char name[32];
  int mods;
  int key; // 0 = modifier-only chord
} Binding;

static Binding g_bindings[MAX_BINDINGS];
static int g_count = 0;
static CRITICAL_SECTION g_lock; // guards bindings and stdout
static HHOOK g_hook;
static BOOL g_down[256];
static int g_active = -1;         // index of the chord currently held
static int g_swallowedKey = 0;    // non-modifier key whose down we swallowed (swallow its up too)
static BOOL g_winUsed = FALSE;    // a chord fired during this Win press
static BOOL g_acceptInjected = FALSE; // --accept-injected: for automated tests only

static void emit(const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n > (int)sizeof(buf) - 2) n = (int)sizeof(buf) - 2;
  buf[n++] = '\n';
  EnterCriticalSection(&g_lock);
  DWORD written;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), buf, (DWORD)n, &written, NULL);
  LeaveCriticalSection(&g_lock);
}

static int modBit(int vk) {
  switch (vk) {
    case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL: return MOD_CTRL_BIT;
    case VK_MENU: case VK_LMENU: case VK_RMENU: return MOD_ALT_BIT;
    case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT: return MOD_SHIFT_BIT;
    case VK_LWIN: case VK_RWIN: return MOD_WIN_BIT;
    default: return 0;
  }
}

static int currentMods(void) {
  int m = 0;
  if (g_down[VK_LCONTROL] || g_down[VK_RCONTROL]) m |= MOD_CTRL_BIT;
  if (g_down[VK_LMENU] || g_down[VK_RMENU]) m |= MOD_ALT_BIT;
  if (g_down[VK_LSHIFT] || g_down[VK_RSHIFT]) m |= MOD_SHIFT_BIT;
  if (g_down[VK_LWIN] || g_down[VK_RWIN]) m |= MOD_WIN_BIT;
  return m;
}

static int findBinding(int mods, int key) {
  for (int i = 0; i < g_count; i++)
    if (g_bindings[i].mods == mods && g_bindings[i].key == key) return i;
  return -1;
}

static void sendKey(WORD vk, BOOL up) {
  INPUT in = {0};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  in.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
  in.ki.dwExtraInfo = VD_MARKER;
  SendInput(1, &in, sizeof(INPUT));
}

static LRESULT CALLBACK hookProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code != HC_ACTION) return CallNextHookEx(g_hook, code, wParam, lParam);
  KBDLLHOOKSTRUCT *k = (KBDLLHOOKSTRUCT *)lParam;
  // Our own SendInput events are tagged with this marker and always ignored.
  if (k->dwExtraInfo == VD_MARKER) return CallNextHookEx(g_hook, code, wParam, lParam);
  if ((k->flags & LLKHF_INJECTED) && !g_acceptInjected) return CallNextHookEx(g_hook, code, wParam, lParam);

  int vk = (int)(k->vkCode & 0xFF);
  BOOL isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
  BOOL repeat = isDown && g_down[vk];
  int bit = modBit(vk);
  BOOL swallow = FALSE;

  EnterCriticalSection(&g_lock);
  if (isDown) {
    g_down[vk] = TRUE;
    if (vk == VK_ESCAPE) emit("ESC");
    int mods = currentMods();
    if (!repeat) {
      if (g_active >= 0) {
        if (!bit) {
          int up = findBinding(mods, vk);
          if (up >= 0 && up != g_active && g_bindings[g_active].key == 0) {
            g_active = up; // chord extended: ctrl+win -> ctrl+win+t
            g_swallowedKey = vk;
            swallow = TRUE;
            emit("DOWN %s", g_bindings[up].name);
          } else if (vk != g_bindings[g_active].key) {
            emit("CANCEL %s", g_bindings[g_active].name); // chord was part of another shortcut
            g_active = -1;
          }
        } else if (mods != g_bindings[g_active].mods) {
          emit("CANCEL %s", g_bindings[g_active].name);
          g_active = -1;
        }
      } else {
        int i = bit ? findBinding(mods, 0) : findBinding(mods, vk);
        if (i >= 0) {
          g_active = i;
          if (!bit) { g_swallowedKey = vk; swallow = TRUE; }
          if (mods & MOD_WIN_BIT) g_winUsed = TRUE;
          emit("DOWN %s", g_bindings[i].name);
        }
      }
      if (g_active >= 0 && (g_bindings[g_active].mods & MOD_WIN_BIT)) g_winUsed = TRUE;
    } else if (vk == g_swallowedKey) {
      swallow = TRUE; // auto-repeat of the chord key
    }
  } else {
    g_down[vk] = FALSE;
    if (vk == g_swallowedKey) { swallow = TRUE; g_swallowedKey = 0; }
    if (g_active >= 0) {
      Binding *b = &g_bindings[g_active];
      if ((bit & b->mods) || vk == b->key) {
        emit("UP %s", b->name);
        g_active = -1;
      }
    }
    if ((vk == VK_LWIN || vk == VK_RWIN) && g_winUsed) {
      g_winUsed = FALSE;
      // Windows opens Start when Win goes up with no key in between; give it one.
      sendKey(DUMMY_VK, FALSE);
      sendKey(DUMMY_VK, TRUE);
    }
  }
  LeaveCriticalSection(&g_lock);
  if (swallow) return 1;
  return CallNextHookEx(g_hook, code, wParam, lParam);
}

static int parseKey(const char *tok) {
  if (_strnicmp(tok, "vk:", 3) == 0) return (int)strtol(tok + 3, NULL, 0);
  size_t n = strlen(tok);
  if (n == 1) {
    char c = tok[0];
    if (c >= 'a' && c <= 'z') return c - 'a' + 'A';
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
  }
  if ((tok[0] == 'f' || tok[0] == 'F') && n <= 3) {
    int f = atoi(tok + 1);
    if (f >= 1 && f <= 24) return VK_F1 + f - 1;
  }
  if (_stricmp(tok, "space") == 0) return VK_SPACE;
  if (_stricmp(tok, "pause") == 0) return VK_PAUSE;
  if (_stricmp(tok, "insert") == 0) return VK_INSERT;
  if (_stricmp(tok, "scrolllock") == 0) return VK_SCROLL;
  return -1;
}

static BOOL parseSpec(char *spec, int *mods, int *key) {
  *mods = 0;
  *key = 0;
  for (char *tok = strtok(spec, "+"); tok; tok = strtok(NULL, "+")) {
    if (_stricmp(tok, "ctrl") == 0 || _stricmp(tok, "control") == 0) *mods |= MOD_CTRL_BIT;
    else if (_stricmp(tok, "alt") == 0) *mods |= MOD_ALT_BIT;
    else if (_stricmp(tok, "shift") == 0) *mods |= MOD_SHIFT_BIT;
    else if (_stricmp(tok, "win") == 0 || _stricmp(tok, "super") == 0) *mods |= MOD_WIN_BIT;
    else {
      int k = parseKey(tok);
      if (k <= 0 || *key) return FALSE;
      *key = k;
    }
  }
  return *mods != 0 || *key != 0;
}

static BOOL waitForModifiersReleased(DWORD timeoutMs) {
  const int vks[] = {VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LSHIFT, VK_RSHIFT, VK_LWIN, VK_RWIN};
  DWORD start = GetTickCount();
  for (;;) {
    BOOL any = FALSE;
    for (int i = 0; i < 8; i++)
      if (GetAsyncKeyState(vks[i]) & 0x8000) any = TRUE;
    if (!any) return TRUE;
    if (GetTickCount() - start > timeoutMs) return FALSE;
    Sleep(10);
  }
}

static void sendChord(WORD key, BOOL withShift) {
  INPUT in[6] = {0};
  int n = 0;
  WORD seq[3] = {VK_CONTROL, withShift ? VK_SHIFT : 0, key};
  for (int i = 0; i < 3; i++) {
    if (!seq[i]) continue;
    in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = seq[i]; in[n].ki.dwExtraInfo = VD_MARKER; n++;
  }
  for (int i = 2; i >= 0; i--) {
    if (!seq[i]) continue;
    in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = seq[i]; in[n].ki.dwFlags = KEYEVENTF_KEYUP; in[n].ki.dwExtraInfo = VD_MARKER; n++;
  }
  SendInput(n, in, sizeof(INPUT));
}

static void reportForeground(void) {
  HWND h = GetForegroundWindow();
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  WCHAR path[MAX_PATH] = L"";
  WCHAR title[512] = L"";
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (p) {
    DWORD len = MAX_PATH;
    QueryFullProcessImageNameW(p, 0, path, &len);
    CloseHandle(p);
  }
  GetWindowTextW(h, title, 512);
  for (WCHAR *c = title; *c; c++) if (*c == L'\t' || *c == L'\n' || *c == L'\r') *c = L' ';
  char p8[MAX_PATH * 3], t8[512 * 3];
  WideCharToMultiByte(CP_UTF8, 0, path, -1, p8, sizeof(p8), NULL, NULL);
  WideCharToMultiByte(CP_UTF8, 0, title, -1, t8, sizeof(t8), NULL, NULL);
  emit("FG %lu\t%s\t%s", (unsigned long)pid, p8, t8);
}

static DWORD WINAPI stdinThread(LPVOID arg) {
  DWORD mainThread = (DWORD)(UINT_PTR)arg;
  char line[512];
  while (fgets(line, sizeof(line), stdin)) {
    line[strcspn(line, "\r\n")] = 0;
    if (strncmp(line, "BIND ", 5) == 0) {
      char name[32], spec[128];
      if (sscanf(line + 5, "%31s %127s", name, spec) != 2) { emit("ERR bad BIND"); continue; }
      int mods, key;
      if (!parseSpec(spec, &mods, &key)) { emit("ERR bad spec %s", name); continue; }
      EnterCriticalSection(&g_lock);
      if (g_count < MAX_BINDINGS) {
        strcpy(g_bindings[g_count].name, name);
        g_bindings[g_count].mods = mods;
        g_bindings[g_count].key = key;
        g_count++;
      }
      LeaveCriticalSection(&g_lock);
    } else if (strcmp(line, "CLEAR") == 0) {
      EnterCriticalSection(&g_lock);
      g_count = 0;
      g_active = -1;
      LeaveCriticalSection(&g_lock);
    } else if (strncmp(line, "PASTE", 5) == 0) {
      if (!waitForModifiersReleased(1500)) { emit("PASTED modifiers-held"); continue; }
      sendChord('V', strstr(line, "shift") != NULL);
      emit("PASTED ok");
    } else if (strcmp(line, "COPY") == 0) {
      if (!waitForModifiersReleased(1500)) { emit("COPIED modifiers-held"); continue; }
      sendChord('C', FALSE);
      emit("COPIED ok");
    } else if (strcmp(line, "FG") == 0) {
      reportForeground();
    } else if (strcmp(line, "QUIT") == 0) {
      break;
    }
  }
  PostThreadMessage(mainThread, WM_QUIT, 0, 0); // stdin closed: parent is gone
  return 0;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++)
    if (strcmp(argv[i], "--accept-injected") == 0) g_acceptInjected = TRUE;
  InitializeCriticalSection(&g_lock);
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, hookProc, GetModuleHandleW(NULL), 0);
  if (!g_hook) { emit("ERR hook %lu", GetLastError()); return 1; }
  CreateThread(NULL, 0, stdinThread, (LPVOID)(UINT_PTR)GetCurrentThreadId(), 0, NULL);
  emit("READY");
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  UnhookWindowsHookEx(g_hook);
  return 0;
}
