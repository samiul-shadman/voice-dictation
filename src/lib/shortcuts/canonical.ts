export type ActionId = "voiceNote" | "record";
export type Trigger = "hold" | "toggle";
export type UiPlatform = "macos" | "windows" | "linux" | "other";

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  "⌃": "ctrl",
  "⌥": "alt",
  "⇧": "shift",
  "⌘": "meta",
};

export function detectPlatform(): UiPlatform {
  const nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator;
  const navLike = nav as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const haystack = `${navLike?.userAgentData?.platform ?? ""} ${navLike?.platform ?? ""} ${
    navLike?.userAgent ?? ""
  }`.toLowerCase();
  if (haystack.includes("mac")) return "macos";
  if (haystack.includes("win")) return "windows";
  if (haystack.includes("linux") || haystack.includes("x11")) return "linux";
  return "other";
}

const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  escape: "esc",
  return: "enter",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  del: "delete",
  pgup: "pageup",
  pgdn: "pagedown",
  scrolllock: "scrolllock",
};

const BARE_MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "ContextMenu",
  "Hyper",
  "Super",
  "Fn",
  "FnLock",
  "Symbol",
  "SymbolLock",
]);

const PUNCTUATION_TO_CODE: Record<string, string> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
};

const NAMED_KEY_TO_CODE: Record<string, string> = {
  space: "Space",
  esc: "Escape",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  printscreen: "PrintScreen",
  contextmenu: "ContextMenu",
};

function canonicalKey(rawKey: string): string {
  const key = rawKey.trim().toLowerCase();
  if (key in KEY_ALIASES) return KEY_ALIASES[key];
  let stripped = key;
  if (stripped.startsWith("key") && stripped.length > 3) stripped = stripped.slice(3);
  else if (stripped.startsWith("digit") && stripped.length > 5) stripped = stripped.slice(5);
  else if (stripped.startsWith("numpad") && stripped.length > 6) stripped = stripped.slice(6);
  return stripped;
}

export function canonicalCombo(raw: string): string {
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  const modifiers = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      key = canonicalKey(part);
    }
  }
  if (!key) return "";
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key].join("+");
}

export function comboFromKeyboardEvent(e: KeyboardEvent): string | null {
  if (BARE_MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  const code = e.code;
  if (code.startsWith("Key") && code.length === 4) {
    parts.push(code.slice(3).toLowerCase());
  } else if (code.startsWith("Digit") && code.length === 6) {
    parts.push(code.slice(5));
  } else if (code.startsWith("Numpad") && code.length > 6) {
    parts.push(canonicalKey(code));
  } else if (code === "Space") {
    parts.push("space");
  } else {
    parts.push(canonicalKey(e.key));
  }
  return canonicalCombo(parts.join("+"));
}

const NUMPAD_KEY_TO_CODE: Record<string, string> = {
  add: "NumpadAdd",
  subtract: "NumpadSubtract",
  multiply: "NumpadMultiply",
  divide: "NumpadDivide",
  decimal: "NumpadDecimal",
};

function keyToAcceleratorPart(key: string): string {
  if (key in NAMED_KEY_TO_CODE) return NAMED_KEY_TO_CODE[key];
  if (key in NUMPAD_KEY_TO_CODE) return NUMPAD_KEY_TO_CODE[key];
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  if (key.length === 1 && /[a-z]/.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /\d/.test(key)) return `Digit${key}`;
  if (key in PUNCTUATION_TO_CODE) return PUNCTUATION_TO_CODE[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function toAccelerator(canon: string, platform: UiPlatform = detectPlatform()): string {
  const parts = canon.split("+").filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => {
    switch (m) {
      case "ctrl":
        return "Control";
      case "alt":
        return "Alt";
      case "shift":
        return "Shift";
      case "meta":
        return platform === "macos" ? "Meta" : "Super";
      default:
        return m;
    }
  });
  return [...modifiers, keyToAcceleratorPart(key)].join("+");
}

const HUMAN_MODIFIERS_LINUX: Record<Modifier, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Super",
};

const HUMAN_MODIFIERS_MACOS: Record<Modifier, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};

const HUMAN_MODIFIERS_WINDOWS: Record<Modifier, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Win",
};

function humanModifiers(platform: UiPlatform): Record<Modifier, string> {
  if (platform === "macos") return HUMAN_MODIFIERS_MACOS;
  if (platform === "windows") return HUMAN_MODIFIERS_WINDOWS;
  return HUMAN_MODIFIERS_LINUX;
}

const HUMAN_KEYS: Record<string, string> = {
  space: "Space",
  esc: "Esc",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  capslock: "Caps Lock",
  numlock: "Num Lock",
  scrolllock: "Scroll Lock",
  printscreen: "Print Screen",
  contextmenu: "Menu",
};

function humanKey(key: string): string {
  if (key in HUMAN_KEYS) return HUMAN_KEYS[key];
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function humanize(canon: string, platform: UiPlatform = detectPlatform()): string {
  const parts = canon.split("+").filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => {
    const modifier = MODIFIER_ALIASES[m];
    return modifier ? humanModifiers(platform)[modifier] : humanKey(m);
  });
  return [...modifiers, humanKey(key)].join(" + ");
}
