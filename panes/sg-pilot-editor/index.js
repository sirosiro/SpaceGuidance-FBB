export const minApiVersion = 1;

// =============================================================================
// Module-Scope Persistent Store (Survives Dock <-> Pop-out React Portal Remount)
// =============================================================================
const AI_PREFS_KEY = 'sg_pilot_ai_prefs_v1';
const aiSessionStore = {
  chatMessages: [],       // [{ id, role: 'user'|'assistant', content, model?, timestamp }]
  aiBarOpen: false,       // Web AI / Copilot bar or Ollama split panel open state
  aiSplitRatio: 0.56,     // Left editor width fraction in Ollama split mode (0.35 ~ 0.75)
  prevCodeBeforeAi: null, // 1-step Undo snapshot before last AI Smart Apply
  aiIncludeTelemetry: true,
  aiPromptDraft: ''
};

function loadAiPrefs() {
  try {
    const raw = localStorage.getItem(AI_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        provider: ['gemini', 'chatgpt', 'ollama'].includes(parsed.provider) ? parsed.provider : 'gemini',
        ollamaModel: typeof parsed.ollamaModel === 'string' ? parsed.ollamaModel : ''
      };
    }
  } catch (e) {}
  return { provider: 'gemini', ollamaModel: '' };
}

function saveAiPrefs(prefs) {
  try {
    localStorage.setItem(AI_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {}
}

// =============================================================================
// Pure Helpers: Section Extraction, Code Block Extraction, Diff & Chat Parser
// =============================================================================
function extractSections(src) {
  const lines = src.split('\n');
  const zones = [];
  const seenLines = new Set();
  const dividerRe = /^\s*#\s*(?:={3,}|-{3,})\s*$/;
  const inlineBannerRe = /^\s*#\s*(?:={2,}|-{3,})\s*(.+?)\s*(?:={2,}|-{3,})?\s*$/;
  const tuneZoneRe = /(?:===|🎯|⚡|\b)\s*(TUNE ZONE[^\n=]*)/i;

  const addZone = (lineIdx, rawLabel) => {
    if (seenLines.has(lineIdx)) return;
    let label = rawLabel.replace(/^(?:={2,}|-{3,})\s*|\s*(?:={2,}|-{3,})$/g, '').trim();
    if (!label || /^[=-]+$/.test(label)) return;
    if (label.length > 56) label = label.substring(0, 53) + '...';
    seenLines.add(lineIdx);
    zones.push({ line: lineIdx, label });
  };

  lines.forEach((line, idx) => {
    // Skip bulleted challenge list items in header docstrings (e.g. "#   1. TUNE ZONE 1: ...")
    if (/^\s*#\s+\d+\.\s*TUNE\b/i.test(line)) return;

    // 1. Inline "# === Title ===" or "#=== Title ===" (or "# --- Title ---")
    if (!dividerRe.test(line)) {
      const bannerMatch = line.match(inlineBannerRe);
      if (bannerMatch) {
        addZone(idx, bannerMatch[1]);
        return;
      }
    }

    // 2. 3-line banner block (# ====\n# Title\n# ==== or # ----\n# Title\n# ----)
    if (
      idx > 0 &&
      idx + 1 < lines.length &&
      dividerRe.test(lines[idx - 1]) &&
      dividerRe.test(lines[idx + 1]) &&
      !dividerRe.test(line)
    ) {
      const commentMatch = line.match(/^\s*#\s*(.+)$/);
      if (commentMatch) {
        addZone(idx, commentMatch[1]);
        return;
      }
    }

    // 3. Explicit TUNE ZONE marker lines (e.g. "# 🎯 TUNE ZONE ...", "# ⚡ TUNE ZONE ...")
    if (!line.trim().startsWith('#   ')) {
      const tzMatch = line.match(tuneZoneRe);
      if (tzMatch) {
        addZone(idx, tzMatch[1]);
      }
    }
  });

  return zones;
}

function extractCodeBlocks(rawText) {
  if (!rawText || !rawText.trim()) return [];
  const blocks = [];
  const fenceRe = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(rawText)) !== null) {
    const lang = (m[1] || 'code').toLowerCase();
    const content = m[2].replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (content.trim()) {
      blocks.push({
        lang,
        code: content,
        lines: content.split('\n').length
      });
    }
  }
  if (blocks.length > 0) {
    // Prioritize python blocks first while keeping original order among ties
    const pyBlocks = blocks.filter(b => b.lang === 'python' || b.lang === 'py');
    const otherBlocks = blocks.filter(b => b.lang !== 'python' && b.lang !== 'py');
    return [...pyBlocks, ...otherBlocks];
  }

  // Fallback: Raw pasted code without markdown fences
  const normalized = rawText.replace(/\r\n/g, '\n').trimEnd();
  if (normalized.trim()) {
    return [{
      lang: 'raw',
      code: normalized,
      lines: normalized.split('\n').length
    }];
  }
  return [];
}

function computeLineDiff(oldText, newText) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');

  // Guard against O(N*M) blowup on unusually huge files
  if (a.length * b.length > 400000) {
    return {
      added: Math.max(0, b.length - a.length),
      removed: Math.max(0, a.length - b.length),
      oldLines: a.length,
      newLines: b.length,
      preview: [
        { type: 'info', text: `File too large for line-by-line diff (${a.length} -> ${b.length} lines).` }
      ]
    };
  }

  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', oldLine: i + 1, text: a[i] });
      removed++;
      i++;
    } else {
      ops.push({ type: 'add', newLine: j + 1, text: b[j] });
      added++;
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', oldLine: i + 1, text: a[i] });
    removed++;
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', newLine: j + 1, text: b[j] });
    added++;
    j++;
  }

  // Filter to compact changed hunks (with 2 lines of context)
  const keep = new Uint8Array(ops.length);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'eq') {
      for (let c = Math.max(0, k - 2); c <= Math.min(ops.length - 1, k + 2); c++) {
        keep[c] = 1;
      }
    }
  }

  const preview = [];
  let skipping = false;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      skipping = false;
      preview.push(ops[k]);
    } else if (!skipping) {
      skipping = true;
      preview.push({ type: 'sep', text: '...' });
    }
  }

  return { added, removed, oldLines: n, newLines: m, preview };
}

function parseChatSegments(raw) {
  if (!raw) return [];
  let text = raw;
  const segments = [];

  // 1. Extract optional <think>...</think> blocks (supports streaming unclosed <think>)
  const thinkRe = /<think>([\s\S]*?)(?:<\/think>|$)/g;
  let lastIdx = 0;
  let tm;
  const parts = [];
  while ((tm = thinkRe.exec(text)) !== null) {
    if (tm.index > lastIdx) {
      parts.push({ kind: 'normal', text: text.slice(lastIdx, tm.index) });
    }
    const thinkBody = tm[1].trim();
    if (thinkBody) {
      parts.push({ kind: 'think', text: thinkBody, closed: tm[0].endsWith('</think>') });
    }
    lastIdx = tm.index + tm[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ kind: 'normal', text: text.slice(lastIdx) });
  }

  // 2. Inside normal parts, split fenced code blocks
  const fenceRe = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  for (const part of parts) {
    if (part.kind === 'think') {
      segments.push(part);
      continue;
    }
    let idx = 0;
    let fm;
    fenceRe.lastIndex = 0;
    while ((fm = fenceRe.exec(part.text)) !== null) {
      if (fm.index > idx) {
        const plain = part.text.slice(idx, fm.index).trim();
        if (plain) segments.push({ kind: 'text', text: plain });
      }
      segments.push({
        kind: 'code',
        lang: (fm[1] || 'text').toLowerCase(),
        code: fm[2].replace(/\r\n/g, '\n').replace(/\n$/, ''),
        closed: fm[0].endsWith('```')
      });
      idx = fm.index + fm[0].length;
    }
    if (idx < part.text.length) {
      const rem = part.text.slice(idx).trim();
      if (rem) segments.push({ kind: 'text', text: rem });
    }
  }
  return segments;
}

function formatTelemetrySummary(tlm) {
  if (!tlm || typeof tlm !== 'object') return '';
  const fmt = (v, digits = 2) => (typeof v === 'number' && !isNaN(v)) ? v.toFixed(digits) : '-';
  const lines = [];
  const tag = tlm.isHistorical ? ' (Time-Travel Snapshot)' : ' (Latest Live)';
  lines.push(`### Telemetry Summary${tag}`);
  if (tlm.official_grade !== undefined || tlm.score !== undefined) {
    lines.push(`- **Grade / Score**: ${tlm.official_grade || 'IN_FLIGHT'} / ${fmt(tlm.score, 1)} pts (Gates: ${tlm.passed_checkpoints ?? '-'} / ${tlm.total_checkpoints ?? '-'})`);
  }
  lines.push(`- **Position (m)**: X=${fmt(tlm.pos_x)}, Y=${fmt(tlm.pos_y)}, Z=${fmt(tlm.pos_z)}`);
  lines.push(`- **Velocity (m/s)**: Vx=${fmt(tlm.vel_x)}, Vy=${fmt(tlm.vel_y)}, Vz=${fmt(tlm.vel_z)}`);
  lines.push(`- **Attitude / Error**: Yaw=${fmt(tlm.angle, 3)} rad, Roll=${fmt(tlm.roll, 3)} rad, CrossTrackErr=${fmt(tlm.cross_track_err, 3)} m`);
  lines.push(`- **Resources**: Fuel=${fmt(tlm.fuel, 1)}%, RW-Z=${fmt(tlm.wheel_rpm, 0)} RPM (X=${fmt(tlm.wheel_rpm_x, 0)}, Y=${fmt(tlm.wheel_rpm_y, 0)})`);
  const fdirNames = ['Nominal (0)', 'LOS / Recovery (1)', 'Safe / Fault (2)'];
  const fdirLabel = fdirNames[tlm.fdir_mode] || `Mode ${tlm.fdir_mode ?? 0}`;
  const flags = [];
  if (tlm.carrier_lost) flags.push('CARRIER_LOST');
  if (tlm.sensor_raw === 0xFFFFFFFF) flags.push('SENSOR_SATURATED');
  lines.push(`- **FDIR / Events**: ${fdirLabel}${flags.length ? ` [${flags.join(', ')}]` : ''}${tlm.last_event ? ` | Last Event: ${tlm.last_event}` : ''}`);
  return lines.join('\n');
}

export default function PilotCodeEditor() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef, useMemo } = window.FBB?.hooks || React;

  const initialPrefs = useMemo(() => loadAiPrefs(), []);

  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const [fileName, setFileName] = useState('pilot.py');
  const [scenarioName, setScenarioName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('info'); // info, success, error
  const [syntaxError, setSyntaxError] = useState(null);

  // Search & Replace state
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  // Jump to Zone & Line state
  const [jumpOpen, setJumpOpen] = useState(false);
  const [targetLineInput, setTargetLineInput] = useState('');

  // Hybrid AI Copilot state (synced with module-scope store for Dock <-> Pop-out persistence)
  const [aiBarOpen, setAiBarOpen] = useState(aiSessionStore.aiBarOpen);
  const [aiProvider, setAiProvider] = useState(initialPrefs.provider); // 'gemini' | 'chatgpt' | 'ollama'
  const [ollamaStatus, setOllamaStatus] = useState({ checked: false, available: false, models: [], host: '' });
  const [ollamaModel, setOllamaModel] = useState(initialPrefs.ollamaModel);
  const [aiIncludeTelemetry, setAiIncludeTelemetry] = useState(aiSessionStore.aiIncludeTelemetry);
  const [aiIntent, setAiIntent] = useState('tune'); // 'tune' | 'fix' | 'explain' | 'custom'
  const [aiCustomNote, setAiCustomNote] = useState(aiSessionStore.aiPromptDraft);
  const [chatMessages, setChatMessages] = useState(aiSessionStore.chatMessages);
  const [chatInput, setChatInput] = useState('');
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiSplitRatio, setAiSplitRatio] = useState(aiSessionStore.aiSplitRatio);
  const [prevCodeBeforeAi, setPrevCodeBeforeAi] = useState(aiSessionStore.prevCodeBeforeAi);
  const [hasTelemetry, setHasTelemetry] = useState(false);

  // Inline Modals (Portal-safe: zero window.confirm / window.alert)
  const [smartApplyModal, setSmartApplyModal] = useState(null); // { rawText, selectedBlockIdx }
  const [manualPromptModal, setManualPromptModal] = useState(null); // { promptText, url, providerLabel, reason }
  const [confirmModal, setConfirmModal] = useState(null); // { title, message, confirmLabel, onConfirm }

  const rootRef = useRef(null);
  const workspaceRef = useRef(null);
  const textareaRef = useRef(null);
  const preRef = useRef(null);
  const gutterRef = useRef(null);
  const searchInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const jumpLineInputRef = useRef(null);
  const chatScrollRef = useRef(null);
  const abortControllerRef = useRef(null);
  const telemetryRef = useRef(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const isComposingRef = useRef(false);
  const lastCompositionEndRef = useRef(0);

  // Cross-browser Japanese IME composition guard (Chrome/Firefox/Edge + macOS Safari WebKit)
  const imeCompositionProps = {
    onCompositionStart: () => { isComposingRef.current = true; },
    onCompositionEnd: () => {
      isComposingRef.current = false;
      lastCompositionEndRef.current = Date.now();
    }
  };
  const isImeComposing = (e) => {
    if (e.nativeEvent?.isComposing || e.isComposing) return true;
    if (e.keyCode === 229 || e.which === 229 || e.nativeEvent?.keyCode === 229) return true;
    if (isComposingRef.current) return true;
    // macOS Safari WebKit fires compositionend immediately before the confirming Enter keydown
    if (Date.now() - lastCompositionEndRef.current < 80) return true;
    return false;
  };

  // Sync AI session store so Dock <-> Pop-out remounts never lose chat or state
  useEffect(() => { aiSessionStore.chatMessages = chatMessages; }, [chatMessages]);
  useEffect(() => { aiSessionStore.aiBarOpen = aiBarOpen; }, [aiBarOpen]);
  useEffect(() => { aiSessionStore.aiSplitRatio = aiSplitRatio; }, [aiSplitRatio]);
  useEffect(() => { aiSessionStore.prevCodeBeforeAi = prevCodeBeforeAi; }, [prevCodeBeforeAi]);
  useEffect(() => { aiSessionStore.aiIncludeTelemetry = aiIncludeTelemetry; }, [aiIncludeTelemetry]);
  useEffect(() => { aiSessionStore.aiPromptDraft = aiCustomNote; }, [aiCustomNote]);

  // Helper: Resolve active window & document dynamically (React Portal Pop-out safe!)
  const getActiveWinDoc = () => {
    const doc = rootRef.current?.ownerDocument || document;
    const win = doc.defaultView || window;
    return { win, doc };
  };

  // Portal-safe Clipboard Copy (activeWin -> activeDoc execCommand fallback)
  const copyTextSafe = async (text) => {
    const { win, doc } = getActiveWinDoc();
    try {
      if (win.navigator?.clipboard?.writeText) {
        await win.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      doc.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = doc.execCommand('copy');
      doc.body.removeChild(ta);
      return Boolean(ok);
    } catch (e) {
      return false;
    }
  };

  // Portal-safe Clipboard Read (returns null when permission denied or unsupported)
  const readClipboardSafe = async () => {
    const { win } = getActiveWinDoc();
    try {
      if (win.navigator?.clipboard?.readText) {
        const txt = await win.navigator.clipboard.readText();
        return txt || '';
      }
    } catch (e) {}
    return null;
  };

  // Portal-safe Synchronous Right-Half Window Launcher (MUST be called BEFORE any await!)
  const openWebAiWindowSync = (targetProvider) => {
    const { win } = getActiveWinDoc();
    const url = targetProvider === 'chatgpt'
      ? 'https://chatgpt.com/'
      : 'https://gemini.google.com/app';
    const scr = win.screen || window.screen || {};
    const availW = scr.availWidth || 1440;
    const availH = scr.availHeight || 900;
    const availL = typeof scr.availLeft === 'number' ? scr.availLeft : 0;
    const availT = typeof scr.availTop === 'number' ? scr.availTop : 0;
    const w = Math.max(480, Math.floor(availW * 0.48));
    const h = Math.max(600, Math.floor(availH * 0.92));
    const left = Math.round(availL + availW - w);
    const top = Math.round(availT + Math.floor((availH - h) / 2));
    const features = `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    let opened = null;
    try {
      opened = win.open(url, 'sg_ai_copilot', features);
      if (opened && typeof opened.focus === 'function') opened.focus();
    } catch (e) {}
    return { opened, url };
  };

  // Passive Telemetry Listener (zero 30Hz re-render overhead on editor)
  useEffect(() => {
    const updateTlm = (j, historical = false) => {
      if (!j || (j.type && j.type !== 'space_guidance')) return;
      telemetryRef.current = { ...j, isHistorical: Boolean(historical || j.isHistorical) };
      setHasTelemetry(prev => (prev ? prev : true));
    };

    let sock = window.FBB?.socket;
    if (!sock && window.FBB?.useDashboard) {
      try { sock = window.FBB.useDashboard().socket; } catch (e) {}
    }
    const onLive = (j) => updateTlm(j, false);
    if (sock) sock.on('scenario:telemetry', onLive);

    const onEffective = (e) => {
      if (e?.detail) updateTlm(e.detail, Boolean(e.detail.isHistorical));
    };
    window.addEventListener('fbb:telemetry:effective', onEffective);

    let syncChannel;
    try {
      if ('BroadcastChannel' in window) {
        syncChannel = new BroadcastChannel('fbb_dashboard_sync');
        syncChannel.onmessage = (event) => {
          const { type, payload } = event.data || {};
          if (type === 'SYNC_TIME_TRAVEL' && payload?.snapshot?.telemetry) {
            updateTlm(payload.snapshot.telemetry, payload.isLive === false);
          }
        };
      }
    } catch (e) {}

    return () => {
      if (sock) sock.off('scenario:telemetry', onLive);
      window.removeEventListener('fbb:telemetry:effective', onEffective);
      try { syncChannel?.close(); } catch (e) {}
    };
  }, []);

  // Probe Local Ollama Availability (Progressive Enhancement)
  const checkOllamaStatus = async () => {
    try {
      const res = await fetch(`/api/ai/status?_t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const available = Boolean(data.available && Array.isArray(data.models) && data.models.length > 0);
        const models = available ? data.models : [];
        setOllamaStatus({ checked: true, available, models, host: data.host || '' });
        if (available) {
          setOllamaModel(prev => {
            const nextModel = (prev && models.includes(prev)) ? prev : models[0];
            saveAiPrefs({ provider: aiProvider, ollamaModel: nextModel });
            return nextModel;
          });
        } else {
          // Gracefully fall back to Gemini Web if user previously chose Ollama and it's now offline
          setAiProvider(prev => (prev === 'ollama' ? 'gemini' : prev));
        }
        return;
      }
    } catch (e) {}
    setOllamaStatus({ checked: true, available: false, models: [], host: '' });
    setAiProvider(prev => (prev === 'ollama' ? 'gemini' : prev));
  };

  useEffect(() => {
    checkOllamaStatus();
    return () => {
      if (abortControllerRef.current) {
        try { abortControllerRef.current.abort(); } catch (e) {}
      }
    };
  }, []);

  // Auto-scroll Ollama chat drawer on new tokens
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, aiStreaming]);

  const handleProviderChange = (nextProvider) => {
    if (nextProvider === 'ollama' && !ollamaStatus.available) return;
    setAiProvider(nextProvider);
    saveAiPrefs({ provider: nextProvider, ollamaModel });
    if (!aiBarOpen) setAiBarOpen(true);
  };

  const handleOllamaModelChange = (nextModel) => {
    setOllamaModel(nextModel);
    saveAiPrefs({ provider: aiProvider, ollamaModel: nextModel });
  };

  // Discover section headers & tune zones live via useMemo
  const tuneZones = useMemo(() => extractSections(code), [code]);

  // String escaping helpers
  const escapeHtml = (str) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const escapeRegex = (str) =>
    str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Load file from backend API
  const loadFile = async (targetFile) => {
    setLoading(true);
    setStatusMsg('Loading...');
    setStatusType('info');
    try {
      const res = await fetch(`/api/scenario/file?name=${encodeURIComponent(targetFile)}&_t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        setCode(data.content || '');
        setSavedCode(data.content || '');
        if (data.scenario) setScenarioName(data.scenario);
        setSyntaxError(null);
        setPrevCodeBeforeAi(null);
        setStatusMsg('Loaded');
        setStatusType('info');
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusMsg(`Failed to load: ${err.error || res.statusText}`);
        setStatusType('error');
      }
    } catch (e) {
      setStatusMsg(`Connection error: ${e.message}`);
      setStatusType('error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFile(fileName);
  }, [fileName]);

  // Listen to scenario switch events via Socket.IO
  useEffect(() => {
    let sock = window.FBB?.socket;
    if (!sock && window.FBB?.useDashboard) {
      try { sock = window.FBB.useDashboard().socket; } catch (e) {}
    }
    if (sock) {
      const handleScenarioStatus = (s) => {
        if (s && s.scenario && s.scenario !== scenarioName) {
          loadFile(fileName);
        }
      };
      sock.on('scenario:status', handleScenarioStatus);
      return () => sock.off('scenario:status', handleScenarioStatus);
    }
  }, [scenarioName, fileName]);

  // Calculate search matches across the entire code
  const matches = useMemo(() => {
    if (!searchQuery || !searchQuery.trim()) return [];
    const list = [];
    const flags = matchCase ? 'g' : 'gi';
    const re = new RegExp(escapeRegex(searchQuery), flags);
    let m;
    while ((m = re.exec(code)) !== null) {
      const prefix = code.substring(0, m.index);
      const lineIdx = (prefix.match(/\n/g) || []).length;
      list.push({
        index: m.index,
        length: m[0].length,
        line: lineIdx
      });
      if (m[0].length === 0) re.lastIndex++;
    }
    return list;
  }, [code, searchQuery, matchCase]);

  // Track editor selection continuously for context sharing & Smart Apply partial insert
  const captureSelection = () => {
    const ta = textareaRef.current;
    if (ta) {
      selectionRef.current = { start: ta.selectionStart || 0, end: ta.selectionEnd || 0 };
    }
  };

  // Scroll and highlight active match in textarea
  const jumpToMatch = (m, shouldFocus = false) => {
    if (!m || !textareaRef.current) return;
    const ta = textareaRef.current;
    if (shouldFocus) {
      ta.focus({ preventScroll: true });
    }
    ta.setSelectionRange(m.index, m.index + m.length);
    selectionRef.current = { start: m.index, end: m.index + m.length };
    const lineHeight = 20;
    const targetScroll = Math.max(0, m.line * lineHeight - 60);
    ta.scrollTop = targetScroll;
    if (preRef.current) preRef.current.scrollTop = targetScroll;
    if (gutterRef.current) gutterRef.current.scrollTop = targetScroll;
  };

  // Next / Previous match handlers
  const handleFindNext = (focusTa = false) => {
    if (matches.length === 0) return;
    const nextIdx = (currentMatchIdx + 1) % matches.length;
    setCurrentMatchIdx(nextIdx);
    jumpToMatch(matches[nextIdx], focusTa);
  };

  const handleFindPrev = (focusTa = false) => {
    if (matches.length === 0) return;
    const prevIdx = (currentMatchIdx - 1 + matches.length) % matches.length;
    setCurrentMatchIdx(prevIdx);
    jumpToMatch(matches[prevIdx], focusTa);
  };

  const handleSearchChange = (newQuery) => {
    setSearchQuery(newQuery);
    setCurrentMatchIdx(0);
    if (newQuery.trim()) {
      const flags = matchCase ? 'g' : 'gi';
      const re = new RegExp(escapeRegex(newQuery), flags);
      const m = re.exec(code);
      if (m) {
        const prefix = code.substring(0, m.index);
        const lineIdx = (prefix.match(/\n/g) || []).length;
        jumpToMatch({ index: m.index, length: m[0].length, line: lineIdx }, false);
      }
    }
  };

  const handleMatchCaseToggle = () => {
    const nextCase = !matchCase;
    setMatchCase(nextCase);
    setCurrentMatchIdx(0);
    if (searchQuery.trim()) {
      const flags = nextCase ? 'g' : 'gi';
      const re = new RegExp(escapeRegex(searchQuery), flags);
      const m = re.exec(code);
      if (m) {
        const prefix = code.substring(0, m.index);
        const lineIdx = (prefix.match(/\n/g) || []).length;
        jumpToMatch({ index: m.index, length: m[0].length, line: lineIdx }, false);
      }
    }
  };

  const handleReplace = () => {
    if (matches.length === 0 || currentMatchIdx >= matches.length) return;
    const m = matches[currentMatchIdx];
    const nextCode = code.substring(0, m.index) + replaceQuery + code.substring(m.index + m.length);
    setCode(nextCode);
    setStatusMsg('Replaced 1 match');
    setStatusType('info');
  };

  const handleReplaceAll = () => {
    if (matches.length === 0) return;
    const count = matches.length;
    const flags = matchCase ? 'g' : 'gi';
    const re = new RegExp(escapeRegex(searchQuery), flags);
    const nextCode = code.replace(re, replaceQuery);
    setCode(nextCode);
    setStatusMsg(`Replaced ${count} occurrences`);
    setStatusType('info');
  };

  const openSearch = (withReplace = false) => {
    setSearchOpen(true);
    setJumpOpen(false);
    if (withReplace) setReplaceOpen(true);
    const ta = textareaRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const sel = code.substring(ta.selectionStart, ta.selectionEnd).trim();
      if (sel && sel.length <= 60 && !sel.includes('\n')) {
        handleSearchChange(sel);
      }
    }
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 20);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setReplaceOpen(false);
    setSearchQuery('');
    setCurrentMatchIdx(0);
    const ta = textareaRef.current;
    if (ta) {
      const cursor = ta.selectionStart;
      ta.setSelectionRange(cursor, cursor);
      ta.focus({ preventScroll: true });
    }
  };

  // Save file to backend API
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setStatusMsg('Saving...');
    setStatusType('info');
    try {
      const res = await fetch('/api/scenario/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, content: code })
      });
      if (res.ok) {
        const data = await res.json();
        setSavedCode(code);
        if (data.scenario) setScenarioName(data.scenario);
        const now = new Date().toLocaleTimeString();
        if (data.syntaxError) {
          setSyntaxError(data.syntaxError);
          const errLine = data.syntaxError.line ? ` (Line ${data.syntaxError.line})` : '';
          setStatusMsg(`⚠️ Syntax Error${errLine}: ${data.syntaxError.message}`);
          setStatusType('error');
        } else {
          setSyntaxError(null);
          setStatusMsg(`Saved ✓ (${now})`);
          setStatusType('success');
        }
      } else {
        const err = await res.json().catch(() => ({}));
        setStatusMsg(`Save error: ${err.error || res.statusText}`);
        setStatusType('error');
      }
    } catch (e) {
      setStatusMsg(`Save error: ${e.message}`);
      setStatusType('error');
    } finally {
      setSaving(false);
    }
  };

  // Revert pilot.py to factory default (Portal-safe inline confirm modal)
  const executeRevertOriginal = async () => {
    setConfirmModal(null);
    setLoading(true);
    setStatusMsg('Reverting to original...');
    setStatusType('info');
    try {
      const defaultFile = fileName.replace(/\.py$/, '.default.py');
      const res = await fetch(`/api/scenario/file?name=${encodeURIComponent(defaultFile)}&_t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        const defaultContent = data.content || '';
        const saveRes = await fetch('/api/scenario/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fileName, content: defaultContent })
        });
        if (saveRes.ok) {
          setCode(defaultContent);
          setSavedCode(defaultContent);
          setSyntaxError(null);
          setPrevCodeBeforeAi(null);
          setStatusMsg('Reverted to original ✓');
          setStatusType('success');
        } else {
          const err = await saveRes.json().catch(() => ({}));
          setStatusMsg(`Revert save error: ${err.error || saveRes.statusText}`);
          setStatusType('error');
        }
      } else {
        setStatusMsg('Original baseline file not found');
        setStatusType('error');
      }
    } catch (e) {
      setStatusMsg(`Revert error: ${e.message}`);
      setStatusType('error');
    } finally {
      setLoading(false);
    }
  };

  const handleRevertOriginal = () => {
    setConfirmModal({
      title: '↩ Revert to Original Factory Code?',
      message: 'All current modifications in pilot.py will be replaced with the original baseline parameters.',
      confirmLabel: 'Revert Original',
      onConfirm: executeRevertOriginal
    });
  };

  const handleReload = () => {
    if (code !== savedCode) {
      setConfirmModal({
        title: '↺ Discard Unsaved Changes?',
        message: 'Reloading from disk will discard your current unsaved edits in the editor.',
        confirmLabel: 'Reload from Disk',
        onConfirm: () => {
          setConfirmModal(null);
          loadFile(fileName);
        }
      });
      return;
    }
    loadFile(fileName);
  };

  // ===========================================================================
  // Hybrid AI Copilot: Context Builder, Web AI Launcher, Smart Apply & Ollama
  // ===========================================================================
  const buildAiContextPrompt = ({ intent = aiIntent, customNote = aiCustomNote, priorHistory = null } = {}) => {
    const targetPath = scenarioName ? `${scenarioName}/${fileName}` : fileName;
    const intentGuideMap = {
      tune: 'Based on the current control script and telemetry below, propose concrete tuning improvements (gains, trajectory tracking, fuel efficiency, or stability) with updated Python code.',
      fix: 'Identify the root cause of any syntax error, bug, or control instability in the code below and provide a safe fixed Python implementation.',
      explain: 'Explain clearly how this control script (especially any selected snippet and core control laws) works and highlight key tuning levers.',
      custom: 'Answer the request below accurately using the provided code and telemetry context.'
    };

    const blocks = [];
    blocks.push(`# SpaceGuidance-FBB Autopilot Consultation (${targetPath})`);
    blocks.push('');
    blocks.push(`## Request`);
    blocks.push(intentGuideMap[intent] || intentGuideMap.tune);
    if (customNote && customNote.trim()) {
      blocks.push(`\n**Additional Note / Question:**\n${customNote.trim()}`);
    }

    if (syntaxError) {
      const errLineStr = syntaxError.line ? `Line ${syntaxError.line}` : 'Unknown line';
      blocks.push(`\n## ⚠️ Detected Syntax Error\n- ${errLineStr}: \`${syntaxError.message}\``);
    }

    if (aiIncludeTelemetry && telemetryRef.current) {
      const tlmSummary = formatTelemetrySummary(telemetryRef.current);
      if (tlmSummary) {
        blocks.push('\n' + tlmSummary);
      }
    }

    // Selected code slice if user highlighted a region in the editor
    const { start, end } = selectionRef.current || { start: 0, end: 0 };
    if (end > start && end <= code.length) {
      const selectedSnippet = code.slice(start, end);
      if (selectedSnippet.trim() && selectedSnippet.length < code.length) {
        const startLine = (code.slice(0, start).match(/\n/g) || []).length + 1;
        const endLine = (code.slice(0, end).match(/\n/g) || []).length + 1;
        blocks.push(`\n## Selected Code Focus (Lines ${startLine}-${endLine})\n\`\`\`python\n${selectedSnippet}\n\`\`\``);
      }
    }

    if (Array.isArray(priorHistory) && priorHistory.length > 0) {
      const recent = priorHistory.slice(-4);
      blocks.push('\n## Prior Local AI Discussion (Hand-off)');
      recent.forEach(msg => {
        const roleLabel = msg.role === 'user' ? 'User' : `Local AI (${msg.model || 'Ollama'})`;
        const cleanBody = (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const trimmed = cleanBody.length > 900 ? cleanBody.slice(0, 900) + '\n...(truncated)' : cleanBody;
        blocks.push(`**${roleLabel}:**\n${trimmed}\n`);
      });
    }

    blocks.push(`\n## Full Current \`${fileName}\`\n\`\`\`python\n${code}\n\`\`\``);
    blocks.push('\n---\nNote: When proposing code changes, output them inside a **```python ... ```** fenced code block so they can be auto-extracted and applied.');

    return blocks.join('\n');
  };

  // Launch Browser Web AI (Gemini / ChatGPT) — Synchronous open FIRST for Safari/Pop-out compliance!
  const handleLaunchWebAi = (targetProvider, opts = {}) => {
    const prov = targetProvider === 'chatgpt' ? 'chatgpt' : 'gemini';
    const providerLabel = prov === 'chatgpt' ? 'ChatGPT (Web)' : 'Gemini (Web)';
    const promptText = buildAiContextPrompt(opts);

    // 1. MUST open synchronously inside click gesture before any await!
    const { opened, url } = openWebAiWindowSync(prov);

    // 2. Copy prompt safely using activeWin / activeDoc
    copyTextSafe(promptText).then((copied) => {
      if (!opened) {
        setManualPromptModal({
          promptText,
          url,
          providerLabel,
          reason: copied
            ? 'Popup was blocked by the browser. The prompt is already copied to your clipboard — click the button below to open and paste (Ctrl+V / Cmd+V).'
            : 'Both popup and automatic clipboard copy were blocked. Copy the prompt below and click the button to open.'
        });
        setStatusMsg(`Popup blocked — opened fallback guide for ${providerLabel}`);
        setStatusType('info');
      } else if (!copied) {
        setManualPromptModal({
          promptText,
          url,
          providerLabel,
          reason: `Opened ${providerLabel} in the right window. Automatic clipboard copy was restricted — copy the prompt below and paste it there.`
        });
        setStatusMsg(`Opened ${providerLabel} (manual copy fallback)`);
        setStatusType('info');
      } else {
        setStatusMsg(`✓ Copied prompt & opened ${providerLabel} — Press Ctrl+V / Cmd+V to paste!`);
        setStatusType('success');
      }
    });
  };

  // Open Smart Apply Modal (reads clipboard or pre-fills provided code block)
  const handleOpenSmartApply = async (prefilledText = null) => {
    if (typeof prefilledText === 'string' && prefilledText.trim()) {
      setSmartApplyModal({ rawText: prefilledText, selectedBlockIdx: 0 });
      return;
    }
    const clip = await readClipboardSafe();
    setSmartApplyModal({
      rawText: clip || '',
      selectedBlockIdx: 0
    });
  };

  const applyCodeToEditor = (newSnippet, mode) => {
    setPrevCodeBeforeAi(code);
    if (mode === 'selection') {
      const ta = textareaRef.current;
      const start = ta ? ta.selectionStart : selectionRef.current.start;
      const end = ta ? ta.selectionEnd : selectionRef.current.end;
      const nextCode = code.substring(0, start) + newSnippet + code.substring(end);
      setCode(nextCode);
      setStatusMsg('✨ AI code inserted into selection (Ctrl+S to save)');
      setStatusType('success');
    } else {
      setCode(newSnippet);
      setStatusMsg('✨ AI code applied to editor (Ctrl+S to save, or Undo AI)');
      setStatusType('success');
    }
    setSmartApplyModal(null);
  };

  const handleUndoAiApply = () => {
    if (prevCodeBeforeAi === null) return;
    setCode(prevCodeBeforeAi);
    setPrevCodeBeforeAi(null);
    setStatusMsg('↩ Undid last AI code apply');
    setStatusType('info');
  };

  // Local Ollama Streaming Chat Handler
  const handleSendOllamaChat = async (overridePrompt = null, overrideIntent = null) => {
    if (aiStreaming || !ollamaStatus.available || !ollamaModel) return;
    const userText = (overridePrompt !== null ? overridePrompt : chatInput).trim();
    if (!userText && !overrideIntent) return;

    const displayUserMsg = userText || (
      overrideIntent === 'tune' ? '🔧 Suggest gain & control tuning improvements based on current code and telemetry.' :
      overrideIntent === 'fix' ? '🐛 Diagnose errors or instability and propose a safe fix.' :
      '📖 Explain how this control logic works and key areas to improve.'
    );

    const userMsgObj = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: displayUserMsg,
      timestamp: new Date().toLocaleTimeString()
    };
    const assistantId = `a_${Date.now() + 1}`;
    const assistantMsgObj = {
      id: assistantId,
      role: 'assistant',
      content: '',
      model: ollamaModel,
      timestamp: new Date().toLocaleTimeString()
    };

    const nextHistory = [...chatMessages, userMsgObj];
    setChatMessages([...nextHistory, assistantMsgObj]);
    if (overridePrompt === null) setChatInput('');
    setAiStreaming(true);

    const systemMsg = {
      role: 'system',
      content: [
        'You are an expert Space Guidance & Control (GNC) and Python autopilot engineer for SpaceGuidance-FBB.',
        'Respond concisely in the same language as the user (English or Japanese).',
        'When proposing code changes, output clean Python code inside ```python ... ``` fenced blocks so the user can apply it with one click.'
      ].join('\n')
    };

    // Build payload with recent conversation turns + fresh code/telemetry context on latest turn
    const recentTurns = nextHistory.slice(-6, -1).map(m => ({
      role: m.role,
      content: (m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    }));

    const enrichedLatestContent = buildAiContextPrompt({
      intent: overrideIntent || 'custom',
      customNote: displayUserMsg
    });

    const apiMessages = [
      systemMsg,
      ...recentTurns,
      { role: 'user', content: enrichedLatestContent }
    ];

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: apiMessages,
          stream: true
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        const data = await res.json();
        const content = data.message?.content || data.response || '(Empty response)';
        setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content } : m));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let accContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed);
            if (chunk.error) {
              throw new Error(chunk.error);
            }
            const delta = chunk.message?.content || '';
            if (delta) {
              accContent += delta;
              setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accContent } : m));
            }
          } catch (parseErr) {
            if (parseErr.message && !parseErr.message.includes('JSON')) {
              throw parseErr;
            }
          }
        }
      }
      if (!accContent.trim()) {
        setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: '(Empty response)' } : m));
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        setChatMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: (m.content ? m.content + '\n\n' : '') + '⏹ *(Generation cancelled)*' } : m
        ));
      } else {
        setChatMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `⚠️ Ollama error: ${e.message}\n\nUse [↗ Gemini] or [↗ ChatGPT] above to continue in Browser AI with full context.` } : m
        ));
      }
    } finally {
      abortControllerRef.current = null;
      setAiStreaming(false);
    }
  };

  const handleCancelOllama = () => {
    if (abortControllerRef.current) {
      try { abortControllerRef.current.abort(); } catch (e) {}
    }
  };

  // Draggable Splitter for Ollama Split Panel (uses activeWin for Pop-out compatibility!)
  const handleSplitterMouseDown = (e) => {
    e.preventDefault();
    const { win } = getActiveWinDoc();
    const ws = workspaceRef.current;
    if (!ws) return;
    const rect = ws.getBoundingClientRect();
    const onMove = (ev) => {
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      setAiSplitRatio(Math.min(0.75, Math.max(0.32, ratio)));
    };
    const onUp = () => {
      win.removeEventListener('mousemove', onMove);
      win.removeEventListener('mouseup', onUp);
    };
    win.addEventListener('mousemove', onMove);
    win.addEventListener('mouseup', onUp);
  };

  // Sync scrolling between textarea, syntax overlay, and line numbers gutter
  const handleScroll = (e) => {
    const top = e.target.scrollTop;
    const left = e.target.scrollLeft;
    if (preRef.current) {
      preRef.current.scrollTop = top;
      preRef.current.scrollLeft = left;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = top;
    }
  };

  // Keyboard handlers: Shortcuts for Save, Indentation, and Close
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      handleSave();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      setJumpOpen(prev => {
        const next = !prev;
        if (next) {
          setSearchOpen(false);
          setTimeout(() => {
            if (jumpLineInputRef.current) jumpLineInputRef.current.focus();
          }, 50);
        }
        return next;
      });
      return;
    }

    if (e.key === 'Escape') {
      if (smartApplyModal) { e.preventDefault(); setSmartApplyModal(null); return; }
      if (manualPromptModal) { e.preventDefault(); setManualPromptModal(null); return; }
      if (confirmModal) { e.preventDefault(); setConfirmModal(null); return; }
      if (jumpOpen) { e.preventDefault(); setJumpOpen(false); return; }
      if (searchOpen) { e.preventDefault(); closeSearch(); return; }
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const spaces = '    ';
      const nextCode = code.substring(0, start) + spaces + code.substring(end);
      setCode(nextCode);
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + spaces.length;
        selectionRef.current = { start: start + spaces.length, end: start + spaces.length };
      }, 0);
    }
  };

  // Jump to Tune Zone / Section
  const handleJumpToZone = (lineIdx) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const lines = code.split('\n');
    let charStart = 0;
    for (let i = 0; i < lineIdx && i < lines.length; i++) {
      charStart += lines[i].length + 1;
    }

    ta.focus({ preventScroll: true });
    ta.setSelectionRange(charStart, charStart);
    selectionRef.current = { start: charStart, end: charStart };

    const lineHeight = 20;
    const targetScroll = Math.max(0, lineIdx * lineHeight - 60);
    ta.scrollTop = targetScroll;

    if (preRef.current) preRef.current.scrollTop = targetScroll;
    if (gutterRef.current) gutterRef.current.scrollTop = targetScroll;

    setStatusMsg(`Jumped to line ${lineIdx + 1}`);
    setStatusType('info');
  };

  // Go to Line Number
  const handleGoToLine = (customLine) => {
    const rawVal = customLine !== undefined ? customLine : targetLineInput;
    const lineNum = parseInt(rawVal, 10);
    const lines = code.split('\n');
    if (isNaN(lineNum) || lineNum < 1) {
      setStatusMsg('Please enter a valid line number');
      setStatusType('error');
      return;
    }
    const clampedLine = Math.min(lines.length, Math.max(1, lineNum));
    handleJumpToZone(clampedLine - 1);
    setStatusMsg(`Jumped to line ${clampedLine} of ${lines.length}`);
    setStatusType('info');
  };

  // Lightweight Python Syntax Tokenizer + Search Highlight Overlay
  const renderHighlightedCode = (raw) => {
    const lines = raw.split('\n');
    const keywordRegex = /\b(def|class|import|from|return|if|elif|else|for|while|in|and|or|not|is|as|pass|break|continue|try|except|finally|raise|with|lambda|yield|True|False|None)\b/g;
    const numRegex = /\b(\d+\.?\d*|\d*\.?\d+)\b/g;

    let searchRe = null;
    if (searchOpen && searchQuery.trim()) {
      const flags = matchCase ? 'g' : 'gi';
      searchRe = new RegExp(`(<[^>]*>)|(${escapeRegex(escapeHtml(searchQuery))})`, flags);
    }

    const htmlLines = lines.map(line => {
      const commentIdx = line.indexOf('#');
      let codePart = commentIdx !== -1 ? line.substring(0, commentIdx) : line;
      let commentPart = commentIdx !== -1 ? line.substring(commentIdx) : '';

      let safeCode = escapeHtml(codePart);
      safeCode = safeCode.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|".*?"|'.*?')/g, '<span style="color:#86efac;">$1</span>');
      safeCode = safeCode.replace(keywordRegex, '<span style="color:#f472b6;font-weight:bold;">$1</span>');
      safeCode = safeCode.replace(/\b(hw|math|time|np|sys|os|print|float|int|len|abs|range|SpaceGuidanceHardware|UartTee)\b/g, '<span style="color:#38bdf8;">$1</span>');
      safeCode = safeCode.replace(numRegex, '<span style="color:#fde047;">$1</span>');

      const safeComment = commentPart ? `<span style="color:#64748b;font-style:italic;">${escapeHtml(commentPart)}</span>` : '';
      let fullLine = safeCode + safeComment;

      if (searchRe) {
        fullLine = fullLine.replace(searchRe, (m, tag, text) => {
          if (tag) return tag;
          return `<mark style="background:rgba(234, 179, 8, 0.45);color:inherit;border-radius:2px;outline:1px solid #eab308;padding:0 1px;">${text}</mark>`;
        });
      }

      return fullLine;
    });

    return htmlLines.join('\n');
  };

  // Derived Smart Apply Modal data
  const smartApplyBlocks = useMemo(() => {
    if (!smartApplyModal) return [];
    return extractCodeBlocks(smartApplyModal.rawText);
  }, [smartApplyModal?.rawText]);

  const activeApplyBlock = smartApplyBlocks[smartApplyModal?.selectedBlockIdx || 0] || smartApplyBlocks[0] || null;
  const smartApplyDiff = useMemo(() => {
    if (!activeApplyBlock) return null;
    return computeLineDiff(code, activeApplyBlock.code);
  }, [code, activeApplyBlock?.code]);

  const isDirty = code !== savedCode;
  const lineCount = (code.match(/\n/g) || []).length + 1;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);
  const displayTitle = scenarioName ? `${scenarioName}/${fileName}` : fileName;
  const showOllamaSplit = aiBarOpen && aiProvider === 'ollama' && ollamaStatus.available;

  return React.createElement('div', {
    ref: rootRef,
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      position: 'relative',
      background: '#090d16',
      color: '#e2e8f0',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: '12px',
      overflow: 'hidden'
    }
  },
    // Scoped CSS styles
    React.createElement('style', null, `
      .fbb-pilot-textarea::selection {
        background: rgba(56, 189, 248, 0.45) !important;
        color: transparent !important;
      }
      .fbb-find-input:focus {
        border-color: #38bdf8 !important;
        box-shadow: 0 0 0 1px #38bdf8 !important;
      }
      .fbb-ai-splitter:hover {
        background: #38bdf8 !important;
      }
    `),

    // Top Action & Status Toolbar
    React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        background: '#0f172a',
        borderBottom: '1px solid #1e293b',
        gap: '8px',
        flexShrink: 0,
        flexWrap: 'wrap'
      }
    },
      // Left: File Identity & Dirty Badge
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, '🐍'),
        React.createElement('span', { style: { fontWeight: 'bold', color: '#f1f5f9', letterSpacing: '0.5px' } }, displayTitle),
        isDirty
          ? React.createElement('span', {
              style: {
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '4px',
                background: 'rgba(245, 158, 11, 0.2)',
                color: '#f59e0b',
                border: '1px solid #d97706'
              }
            }, '● Unsaved')
          : React.createElement('span', {
              style: {
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '4px',
                background: 'rgba(34, 197, 94, 0.15)',
                color: '#4ade80',
                border: '1px solid #166534'
              }
            }, '✓ Synced'),
        statusMsg && React.createElement('span', {
          onClick: (syntaxError && syntaxError.line) ? () => handleJumpToZone(syntaxError.line - 1) : undefined,
          title: (syntaxError && syntaxError.line) ? `Click to jump to line ${syntaxError.line}` : undefined,
          style: {
            fontSize: '11px',
            color: statusType === 'success' ? '#4ade80' : statusType === 'error' ? '#ef4444' : '#94a3b8',
            marginLeft: '4px',
            cursor: (syntaxError && syntaxError.line) ? 'pointer' : 'default',
            textDecoration: (syntaxError && syntaxError.line) ? 'underline' : 'none'
          }
        }, statusMsg)
      ),

      // Right: AI Copilot, Find/Replace, Jump, Undo AI, Revert, Reload, Save
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        // AI Copilot Toggle Button
        React.createElement('button', {
          onClick: () => setAiBarOpen(prev => !prev),
          title: 'Hybrid AI Copilot (Gemini / ChatGPT Web + Local Ollama)',
          style: {
            background: aiBarOpen ? '#7c3aed' : '#1e1b4b',
            color: aiBarOpen ? '#ffffff' : '#c4b5fd',
            border: aiBarOpen ? '1px solid #a78bfa' : '1px solid #4c1d95',
            borderRadius: '4px',
            padding: '3px 9px',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            boxShadow: aiBarOpen ? '0 0 8px rgba(139, 92, 246, 0.45)' : 'none'
          }
        }, `🤖 AI Copilot${ollamaStatus.available ? ' ●' : ''}`),

        // Temporary Undo AI Apply Button
        prevCodeBeforeAi !== null && React.createElement('button', {
          onClick: handleUndoAiApply,
          title: 'Undo the last AI code apply',
          style: {
            background: '#422006',
            color: '#fde047',
            border: '1px solid #ca8a04',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer'
          }
        }, '↩ Undo AI'),

        // Find Toggle Button
        React.createElement('button', {
          onClick: () => {
            if (searchOpen && !replaceOpen) closeSearch();
            else {
              setReplaceOpen(false);
              openSearch(false);
            }
          },
          title: 'Find in file',
          style: {
            background: searchOpen && !replaceOpen ? '#0284c7' : '#1e293b',
            color: searchOpen && !replaceOpen ? '#ffffff' : '#cbd5e1',
            border: searchOpen && !replaceOpen ? '1px solid #38bdf8' : '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }
        }, '🔍 Find'),

        // Replace Toggle Button
        React.createElement('button', {
          onClick: () => {
            if (searchOpen && replaceOpen) closeSearch();
            else openSearch(true);
          },
          title: 'Find & Replace in file',
          style: {
            background: searchOpen && replaceOpen ? '#0284c7' : '#1e293b',
            color: searchOpen && replaceOpen ? '#ffffff' : '#cbd5e1',
            border: searchOpen && replaceOpen ? '1px solid #38bdf8' : '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }
        }, '⇄ Replace'),

        // Jump Menu Toggle Button
        React.createElement('button', {
          onClick: () => {
            const next = !jumpOpen;
            setJumpOpen(next);
            if (next) {
              setSearchOpen(false);
              setTimeout(() => {
                if (jumpLineInputRef.current) jumpLineInputRef.current.focus();
              }, 50);
            }
          },
          title: 'Jump to Section / Tune Zone or Line Number (Ctrl+G)',
          style: {
            background: jumpOpen ? '#0284c7' : '#1e293b',
            color: jumpOpen ? '#ffffff' : '#cbd5e1',
            border: jumpOpen ? '1px solid #38bdf8' : '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }
        }, '🎯 Jump / Line'),

        // Revert Original Button
        React.createElement('button', {
          onClick: handleRevertOriginal,
          disabled: loading || saving,
          title: 'Revert pilot.py to factory default baseline code',
          style: {
            background: '#1e293b',
            color: '#fca5a5',
            border: '1px solid #7f1d1d',
            borderRadius: '4px',
            padding: '4px 8px',
            fontSize: '11px',
            cursor: (loading || saving) ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }
        }, '↩ Revert Original'),

        // Reload Button
        React.createElement('button', {
          onClick: handleReload,
          title: 'Reload code from scenario disk',
          style: {
            background: '#1e293b',
            color: '#cbd5e1',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '4px 8px',
            fontSize: '11px',
            cursor: 'pointer'
          }
        }, '↺ Reload'),

        // Save Button
        React.createElement('button', {
          onClick: handleSave,
          disabled: saving,
          title: 'Save file to scenario (Ctrl + S)',
          style: {
            background: isDirty ? '#0284c7' : '#1e293b',
            color: isDirty ? '#ffffff' : '#94a3b8',
            border: isDirty ? '1px solid #38bdf8' : '1px solid #334155',
            borderRadius: '4px',
            padding: '4px 12px',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: saving ? 'wait' : 'pointer',
            boxShadow: isDirty ? '0 0 8px rgba(56, 189, 248, 0.4)' : 'none'
          }
        }, saving ? 'Saving...' : '💾 Save (Ctrl+S)')
      )
    ),

    // =========================================================================
    // Hybrid AI Copilot Control Bar (Web AI Launcher & Mode Switcher)
    // =========================================================================
    aiBarOpen && React.createElement('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        background: '#121026',
        borderBottom: '1px solid #312e81',
        padding: '7px 12px',
        gap: '6px',
        flexShrink: 0
      }
    },
      // Row 1: Provider Selector + Telemetry Toggle + Primary Action Buttons
      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
      },
        React.createElement('span', {
          style: { fontSize: '11px', color: '#a78bfa', fontWeight: 'bold', whiteSpace: 'nowrap' }
        }, '🤖 AI Target:'),

        // Provider Selector
        React.createElement('select', {
          value: aiProvider,
          onChange: (e) => handleProviderChange(e.target.value),
          title: ollamaStatus.available
            ? `Ollama detected at ${ollamaStatus.host} (${ollamaStatus.models.length} models)`
            : 'Ollama not detected locally; using Browser Web AI (Gemini / ChatGPT)',
          style: {
            background: '#1e1b4b',
            color: '#f8fafc',
            border: '1px solid #4c1d95',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer',
            outline: 'none'
          }
        },
          React.createElement('option', { value: 'gemini', style: { background: '#1e1b4b', color: '#f8fafc' } }, '✨ Gemini (Web)'),
          React.createElement('option', { value: 'chatgpt', style: { background: '#1e1b4b', color: '#f8fafc' } }, '💬 ChatGPT (Web)'),
          React.createElement('option', {
            value: 'ollama',
            disabled: !ollamaStatus.available,
            style: { background: '#1e1b4b', color: ollamaStatus.available ? '#4ade80' : '#64748b' }
          }, ollamaStatus.available ? `🦙 Ollama Local (${ollamaStatus.models.length} models)` : '🦙 Ollama Local (Offline)')
        ),

        // Telemetry Attachment Toggle
        React.createElement('label', {
          title: 'Include latest SpaceGuidance score, position, fuel, wheel RPM, and FDIR status in AI prompt',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            color: aiIncludeTelemetry ? '#38bdf8' : '#64748b',
            cursor: 'pointer',
            userSelect: 'none'
          }
        },
          React.createElement('input', {
            type: 'checkbox',
            checked: aiIncludeTelemetry,
            onChange: (e) => setAiIncludeTelemetry(e.target.checked),
            style: { margin: 0, cursor: 'pointer', accentColor: '#38bdf8' }
          }),
          hasTelemetry ? '📡 Attach TLM (LIVE)' : '📡 Attach TLM'
        ),

        // Web AI Primary Action Buttons (when Gemini or ChatGPT selected)
        aiProvider !== 'ollama' && React.createElement('button', {
          onClick: () => handleLaunchWebAi(aiProvider),
          title: 'Copy code + telemetry prompt and open Web AI in the right half of the current monitor',
          style: {
            background: aiProvider === 'chatgpt' ? '#059669' : '#2563eb',
            color: '#ffffff',
            border: aiProvider === 'chatgpt' ? '1px solid #34d399' : '1px solid #60a5fa',
            borderRadius: '4px',
            padding: '4px 10px',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }
        }, aiProvider === 'chatgpt' ? '↗ Copy & Open ChatGPT' : '↗ Copy & Open Gemini'),

        // Smart Apply Button (always accessible for pasting code back from Web AI)
        React.createElement('button', {
          onClick: () => handleOpenSmartApply(),
          title: 'Extract Python code block from clipboard / pasted AI answer and preview diff before applying',
          style: {
            background: '#1e293b',
            color: '#38bdf8',
            border: '1px solid #0284c7',
            borderRadius: '4px',
            padding: '4px 9px',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer'
          }
        }, '📋 Smart Apply'),

        // Re-check Ollama Status (subtle icon)
        React.createElement('button', {
          onClick: checkOllamaStatus,
          title: ollamaStatus.available
            ? `Ollama connected (${ollamaStatus.host}) — Click to refresh model list`
            : 'Re-scan for local Ollama server',
          style: {
            background: 'transparent',
            color: ollamaStatus.available ? '#4ade80' : '#64748b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '10px',
            cursor: 'pointer'
          }
        }, ollamaStatus.available ? '🦙 Online ↻' : '🦙 Detect ↻'),

        // Close AI Bar
        React.createElement('button', {
          onClick: () => setAiBarOpen(false),
          title: 'Close AI Copilot Bar',
          style: {
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '2px 6px',
            marginLeft: 'auto'
          }
        }, '✕')
      ),

      // Row 2 (Web AI Mode only): Quick Intent Chips + Optional Custom Note
      aiProvider !== 'ollama' && React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }
      },
        [
          { id: 'tune', label: '🔧 Tune Gains' },
          { id: 'fix', label: '🐛 Fix Bug / Error' },
          { id: 'explain', label: '📖 Explain Code' },
          { id: 'custom', label: '💬 Free Ask' }
        ].map(chip => React.createElement('button', {
          key: chip.id,
          onClick: () => setAiIntent(chip.id),
          style: {
            background: aiIntent === chip.id ? '#4c1d95' : '#1e293b',
            color: aiIntent === chip.id ? '#f5f3ff' : '#94a3b8',
            border: aiIntent === chip.id ? '1px solid #8b5cf6' : '1px solid #334155',
            borderRadius: '12px',
            padding: '2px 9px',
            fontSize: '10px',
            cursor: 'pointer'
          }
        }, chip.label)),
        React.createElement('input', {
          type: 'text',
          className: 'fbb-find-input',
          value: aiCustomNote,
          onChange: (e) => setAiCustomNote(e.target.value),
          ...imeCompositionProps,
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              if (isImeComposing(e)) return;
              e.preventDefault();
              handleLaunchWebAi(aiProvider);
            }
          },
          placeholder: 'Optional note (e.g. Oscillates at Gate 4 / Reduce fuel usage)... Press Enter to launch',
          style: {
            flex: 1,
            minWidth: '200px',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            color: '#f8fafc',
            fontSize: '11px',
            outline: 'none',
            fontFamily: 'inherit'
          }
        })
      )
    ),

    // Jump to Zone & Line Number Dock Panel
    jumpOpen && React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        background: '#0b1324',
        borderBottom: '1px solid #1e293b',
        padding: '6px 12px',
        gap: '12px',
        flexShrink: 0,
        flexWrap: 'wrap'
      }
    },
      tuneZones.length > 0 && React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '220px' }
      },
        React.createElement('span', {
          style: { fontSize: '11px', color: '#38bdf8', whiteSpace: 'nowrap', fontWeight: 'bold' }
        }, '🎯 Section / Zone:'),
        React.createElement('select', {
          onChange: (e) => {
            const idx = parseInt(e.target.value, 10);
            if (!isNaN(idx)) {
              handleJumpToZone(idx);
            }
          },
          value: '',
          style: {
            flex: 1,
            background: '#1e293b',
            color: '#f8fafc',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '4px 8px',
            fontSize: '11px',
            cursor: 'pointer',
            outline: 'none',
            maxWidth: '520px'
          }
        },
          React.createElement('option', { value: '', disabled: true, style: { background: '#1e293b', color: '#94a3b8' } }, '-- Select Section / Tune Zone to Jump --'),
          tuneZones.map((z, i) => React.createElement('option', { key: i, value: z.line, style: { background: '#1e293b', color: '#f8fafc' } }, `Line ${z.line + 1}: ${z.label}`))
        )
      ),

      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px' }
      },
        React.createElement('span', {
          style: { fontSize: '11px', color: '#94a3b8', whiteSpace: 'nowrap', fontWeight: 'bold' }
        }, 'Go to Line:'),
        React.createElement('input', {
          ref: jumpLineInputRef,
          type: 'number',
          min: 1,
          max: (code.split('\n').length || 1),
          value: targetLineInput,
          placeholder: `1 - ${code.split('\n').length || 1}`,
          onChange: (e) => setTargetLineInput(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleGoToLine();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setJumpOpen(false);
            }
          },
          style: {
            width: '72px',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            color: '#f8fafc',
            fontSize: '11px',
            outline: 'none',
            fontFamily: 'inherit'
          }
        }),
        React.createElement('button', {
          onClick: () => handleGoToLine(),
          title: 'Jump to specified line number (Enter)',
          style: {
            background: '#0284c7',
            color: '#ffffff',
            border: '1px solid #38bdf8',
            borderRadius: '4px',
            padding: '3px 10px',
            fontSize: '11px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }
        }, 'Go')
      ),

      React.createElement('button', {
        onClick: () => setJumpOpen(false),
        title: 'Close Jump Panel (Esc)',
        style: {
          background: 'transparent',
          border: 'none',
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: '12px',
          padding: '2px 6px',
          marginLeft: 'auto'
        }
      }, '✕')
    ),

    // Search & Replace Dock Panel
    searchOpen && React.createElement('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        background: '#0b1324',
        borderBottom: '1px solid #1e293b',
        padding: '6px 12px',
        gap: '6px',
        flexShrink: 0
      }
    },
      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px' }
      },
        React.createElement('button', {
          onClick: () => setReplaceOpen(!replaceOpen),
          title: replaceOpen ? 'Hide Replace' : 'Show Replace',
          style: {
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 4px'
          }
        }, replaceOpen ? '▼' : '▶'),

        React.createElement('input', {
          ref: searchInputRef,
          className: 'fbb-find-input',
          type: 'text',
          value: searchQuery,
          onChange: (e) => handleSearchChange(e.target.value),
          ...imeCompositionProps,
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              if (isImeComposing(e)) return;
              e.preventDefault();
              if (e.shiftKey) handleFindPrev();
              else handleFindNext();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeSearch();
            }
          },
          placeholder: 'Search (Enter: next, Shift+Enter: prev)...',
          style: {
            flex: 1,
            maxWidth: '280px',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            color: '#f8fafc',
            fontSize: '11px',
            outline: 'none',
            fontFamily: 'inherit'
          }
        }),

        React.createElement('span', {
          style: {
            fontSize: '11px',
            color: searchQuery ? (matches.length > 0 ? '#94a3b8' : '#f87171') : '#64748b',
            minWidth: '65px'
          }
        }, searchQuery ? (matches.length > 0 ? `${currentMatchIdx + 1} of ${matches.length}` : 'No matches') : ''),

        React.createElement('button', {
          onClick: handleMatchCaseToggle,
          title: matchCase ? 'Match Case (Active)' : 'Match Case (Inactive)',
          style: {
            background: matchCase ? '#0284c7' : '#1e293b',
            color: matchCase ? '#ffffff' : '#94a3b8',
            border: matchCase ? '1px solid #38bdf8' : '1px solid #334155',
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '10px',
            fontWeight: 'bold',
            cursor: 'pointer'
          }
        }, 'Aa'),

        React.createElement('button', {
          onClick: () => handleFindPrev(),
          disabled: matches.length === 0,
          title: 'Previous match (Shift+Enter)',
          style: {
            background: '#1e293b',
            color: matches.length > 0 ? '#cbd5e1' : '#64748b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '2px 7px',
            fontSize: '11px',
            cursor: matches.length > 0 ? 'pointer' : 'default'
          }
        }, '▲'),

        React.createElement('button', {
          onClick: () => handleFindNext(),
          disabled: matches.length === 0,
          title: 'Next match (Enter)',
          style: {
            background: '#1e293b',
            color: matches.length > 0 ? '#cbd5e1' : '#64748b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '2px 7px',
            fontSize: '11px',
            cursor: matches.length > 0 ? 'pointer' : 'default'
          }
        }, '▼'),

        React.createElement('button', {
          onClick: closeSearch,
          title: 'Close search (Escape)',
          style: {
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '0 4px',
            marginLeft: 'auto'
          }
        }, '✕')
      ),

      replaceOpen && React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '18px' }
      },
        React.createElement('input', {
          ref: replaceInputRef,
          className: 'fbb-find-input',
          type: 'text',
          value: replaceQuery,
          onChange: (e) => setReplaceQuery(e.target.value),
          ...imeCompositionProps,
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
              if (isImeComposing(e)) return;
              e.preventDefault();
              handleReplace();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeSearch();
            }
          },
          placeholder: 'Replace with...',
          style: {
            flex: 1,
            maxWidth: '280px',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            color: '#f8fafc',
            fontSize: '11px',
            outline: 'none',
            fontFamily: 'inherit'
          }
        }),

        React.createElement('button', {
          onClick: handleReplace,
          disabled: matches.length === 0,
          title: 'Replace current match',
          style: {
            background: '#1e293b',
            color: matches.length > 0 ? '#cbd5e1' : '#64748b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            cursor: matches.length > 0 ? 'pointer' : 'default'
          }
        }, 'Replace'),

        React.createElement('button', {
          onClick: handleReplaceAll,
          disabled: matches.length === 0,
          title: 'Replace all occurrences',
          style: {
            background: '#1e293b',
            color: matches.length > 0 ? '#cbd5e1' : '#64748b',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '11px',
            cursor: matches.length > 0 ? 'pointer' : 'default'
          }
        }, 'Replace All')
      )
    ),

    // =========================================================================
    // Main Workspace: Left Code Editor (+ Optional Right Ollama Split Panel)
    // =========================================================================
    React.createElement('div', {
      ref: workspaceRef,
      style: {
        display: 'flex',
        flex: 1,
        position: 'relative',
        background: '#060911',
        overflow: 'hidden',
        minHeight: 0
      }
    },
      // Left Side: Code Editor Container
      React.createElement('div', {
        style: {
          display: 'flex',
          flex: showOllamaSplit ? `0 0 ${(aiSplitRatio * 100).toFixed(1)}%` : 1,
          minWidth: showOllamaSplit ? '240px' : 0,
          height: '100%',
          position: 'relative',
          overflow: 'hidden'
        }
      },
        // (1) Line Numbers Gutter
        React.createElement('div', {
          ref: gutterRef,
          style: {
            width: '45px',
            padding: '12px 6px 12px 0',
            textAlign: 'right',
            background: '#090d16',
            borderRight: '1px solid #1e293b',
            color: '#475569',
            userSelect: 'none',
            lineHeight: '20px',
            fontSize: '11px',
            overflowY: 'hidden',
            flexShrink: 0
          }
        },
          lineNumbers.map(n => {
            const isErr = syntaxError && syntaxError.line === n;
            return React.createElement('div', {
              key: n,
              title: isErr ? `Syntax Error: ${syntaxError.message}` : undefined,
              style: isErr ? { color: '#f87171', fontWeight: 'bold', background: 'rgba(239, 68, 68, 0.25)' } : undefined
            }, isErr ? `● ${n}` : n);
          })
        ),

        // (2) Code Area Wrapper
        React.createElement('div', {
          style: {
            position: 'relative',
            flex: 1,
            height: '100%',
            overflow: 'hidden'
          }
        },
          React.createElement('pre', {
            ref: preRef,
            'aria-hidden': 'true',
            dangerouslySetInnerHTML: { __html: renderHighlightedCode(code) + '\n' },
            style: {
              margin: 0,
              padding: '12px',
              width: '100%',
              height: '100%',
              position: 'absolute',
              top: 0,
              left: 0,
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              lineHeight: '20px',
              tabSize: 4,
              whiteSpace: 'pre',
              wordWrap: 'normal',
              overflow: 'hidden',
              pointerEvents: 'none',
              color: '#e2e8f0'
            }
          }),

          React.createElement('textarea', {
            ref: textareaRef,
            className: 'fbb-pilot-textarea',
            value: code,
            onChange: (e) => { setCode(e.target.value); captureSelection(); },
            onSelect: captureSelection,
            onKeyUp: captureSelection,
            onMouseUp: captureSelection,
            onScroll: handleScroll,
            onKeyDown: handleKeyDown,
            spellCheck: false,
            autoCapitalize: 'off',
            autoComplete: 'off',
            autoCorrect: 'off',
            style: {
              margin: 0,
              padding: '12px',
              width: '100%',
              height: '100%',
              position: 'absolute',
              top: 0,
              left: 0,
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              lineHeight: '20px',
              tabSize: 4,
              whiteSpace: 'pre',
              wordWrap: 'normal',
              overflow: 'auto',
              background: 'transparent',
              color: 'transparent',
              caretColor: '#38bdf8',
              border: 'none',
              outline: 'none',
              resize: 'none'
            }
          })
        )
      ),

      // Resizable Splitter (only when Ollama split panel is active)
      showOllamaSplit && React.createElement('div', {
        className: 'fbb-ai-splitter',
        onMouseDown: handleSplitterMouseDown,
        title: 'Drag to resize editor / Ollama chat split',
        style: {
          width: '4px',
          cursor: 'col-resize',
          background: '#1e293b',
          flexShrink: 0,
          transition: 'background 0.15s'
        }
      }),

      // Right Side: Local Ollama Split Chat Panel
      showOllamaSplit && React.createElement('div', {
        style: {
          flex: 1,
          minWidth: '240px',
          display: 'flex',
          flexDirection: 'column',
          background: '#0b101d',
          borderLeft: '1px solid #1e293b',
          overflow: 'hidden'
        }
      },
        // Ollama Panel Header
        React.createElement('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            background: '#0f172a',
            borderBottom: '1px solid #1e293b',
            flexWrap: 'wrap',
            flexShrink: 0
          }
        },
          React.createElement('span', { style: { fontSize: '11px', fontWeight: 'bold', color: '#4ade80' } }, '🦙 Local AI'),
          React.createElement('select', {
            value: ollamaModel,
            onChange: (e) => handleOllamaModelChange(e.target.value),
            disabled: aiStreaming,
            style: {
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '2px 6px',
              fontSize: '10px',
              outline: 'none',
              maxWidth: '150px'
            }
          }, ollamaStatus.models.map(m =>
            React.createElement('option', { key: m, value: m, style: { background: '#1e293b', color: '#f8fafc' } }, m)
          )),

          // Escalate to Browser Web AI buttons
          React.createElement('button', {
            onClick: () => handleLaunchWebAi('gemini', { intent: 'custom', customNote: chatInput, priorHistory: chatMessages }),
            title: 'Escalate conversation + code + telemetry to Browser Gemini',
            style: {
              background: '#1e3a8a',
              color: '#bfdbfe',
              border: '1px solid #3b82f6',
              borderRadius: '4px',
              padding: '2px 7px',
              fontSize: '10px',
              cursor: 'pointer',
              marginLeft: 'auto'
            }
          }, '↗ Gemini'),
          React.createElement('button', {
            onClick: () => handleLaunchWebAi('chatgpt', { intent: 'custom', customNote: chatInput, priorHistory: chatMessages }),
            title: 'Escalate conversation + code + telemetry to Browser ChatGPT',
            style: {
              background: '#064e3b',
              color: '#a7f3d0',
              border: '1px solid #10b981',
              borderRadius: '4px',
              padding: '2px 7px',
              fontSize: '10px',
              cursor: 'pointer'
            }
          }, '↗ ChatGPT'),
          React.createElement('button', {
            onClick: () => setChatMessages([]),
            disabled: aiStreaming || chatMessages.length === 0,
            title: 'Clear chat history',
            style: {
              background: 'transparent',
              color: '#94a3b8',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '2px 6px',
              fontSize: '10px',
              cursor: (aiStreaming || chatMessages.length === 0) ? 'default' : 'pointer'
            }
          }, '🗑')
        ),

        // Chat Messages Stream
        React.createElement('div', {
          ref: chatScrollRef,
          style: {
            flex: 1,
            overflowY: 'auto',
            padding: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '12px',
            lineHeight: '1.5'
          }
        },
          chatMessages.length === 0 && React.createElement('div', {
            style: {
              padding: '14px',
              borderRadius: '8px',
              background: '#0f172a',
              border: '1px dashed #334155',
              color: '#94a3b8',
              fontSize: '11px'
            }
          },
            React.createElement('div', { style: { color: '#e2e8f0', fontWeight: 'bold', marginBottom: '6px' } },
              `🦙 ${ollamaModel} — Ask about pilot.py with live telemetry`
            ),
            React.createElement('div', { style: { marginBottom: '10px' } },
              'Choose a quick action below or type a question. Python code blocks include a 1-click [⚡ Apply] button. Use [↗ Gemini / ChatGPT] above anytime to escalate to Browser AI with full context.'
            ),
            React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              React.createElement('button', {
                onClick: () => handleSendOllamaChat('', 'tune'),
                style: { background: '#1e1b4b', color: '#c4b5fd', border: '1px solid #4c1d95', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer' }
              }, '🔧 Tune Gains'),
              React.createElement('button', {
                onClick: () => handleSendOllamaChat('', 'fix'),
                style: { background: '#3f1d2b', color: '#fda4af', border: '1px solid #881337', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer' }
              }, '🐛 Fix Bug / Error'),
              React.createElement('button', {
                onClick: () => handleSendOllamaChat('', 'explain'),
                style: { background: '#0c4a6e', color: '#bae6fd', border: '1px solid #0284c7', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer' }
              }, '📖 Explain Code')
            )
          ),

          chatMessages.map((msg) => {
            const isUser = msg.role === 'user';
            const segments = isUser ? [{ kind: 'text', text: msg.content }] : parseChatSegments(msg.content);
            return React.createElement('div', {
              key: msg.id,
              style: {
                alignSelf: isUser ? 'flex-end' : 'stretch',
                maxWidth: isUser ? '90%' : '100%',
                background: isUser ? '#1e3a8a' : '#111827',
                border: isUser ? '1px solid #2563eb' : '1px solid #1f2937',
                borderRadius: '8px',
                padding: '8px 10px',
                color: '#f1f5f9'
              }
            },
              React.createElement('div', {
                style: { fontSize: '10px', color: isUser ? '#93c5fd' : '#4ade80', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }
              },
                React.createElement('span', null, isUser ? 'You' : `🦙 ${msg.model || ollamaModel}`),
                React.createElement('span', { style: { color: '#64748b' } }, msg.timestamp || '')
              ),
              (!isUser && !msg.content && aiStreaming) && React.createElement('div', {
                style: { color: '#94a3b8', fontSize: '11px', fontStyle: 'italic' }
              }, 'Thinking...'),
              segments.map((seg, sIdx) => {
                if (seg.kind === 'think') {
                  return React.createElement('details', {
                    key: sIdx,
                    style: {
                      marginBottom: '6px',
                      background: '#090d16',
                      border: '1px solid #1e293b',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '10px',
                      color: '#64748b'
                    }
                  },
                    React.createElement('summary', { style: { cursor: 'pointer', color: '#94a3b8' } },
                      seg.closed ? '💭 Show Thinking Process' : '💭 Thinking...'
                    ),
                    React.createElement('div', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, seg.text)
                  );
                }
                if (seg.kind === 'code') {
                  return React.createElement('div', {
                    key: sIdx,
                    style: {
                      margin: '6px 0',
                      borderRadius: '6px',
                      border: '1px solid #334155',
                      overflow: 'hidden',
                      background: '#060911'
                    }
                  },
                    React.createElement('div', {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '3px 8px',
                        background: '#1e293b',
                        fontSize: '10px',
                        color: '#94a3b8'
                      }
                    },
                      React.createElement('span', null, seg.lang),
                      React.createElement('div', { style: { display: 'flex', gap: '4px' } },
                        React.createElement('button', {
                          onClick: () => copyTextSafe(seg.code).then(ok => {
                            setStatusMsg(ok ? '✓ Code block copied' : 'Copy failed');
                            setStatusType(ok ? 'success' : 'error');
                          }),
                          style: { background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '3px', padding: '1px 6px', fontSize: '10px', cursor: 'pointer' }
                        }, '📋 Copy'),
                        React.createElement('button', {
                          onClick: () => handleOpenSmartApply('```' + seg.lang + '\n' + seg.code + '\n```'),
                          style: { background: '#0284c7', color: '#ffffff', border: '1px solid #38bdf8', borderRadius: '3px', padding: '1px 7px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }
                        }, '⚡ Apply')
                      )
                    ),
                    React.createElement('pre', {
                      style: {
                        margin: 0,
                        padding: '8px',
                        overflowX: 'auto',
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontSize: '11px',
                        color: '#e2e8f0',
                        maxHeight: '260px'
                      }
                    }, seg.code)
                  );
                }
                return React.createElement('div', {
                  key: sIdx,
                  style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '4px' }
                }, seg.text);
              })
            );
          })
        ),

        // Ollama Chat Input Bar
        React.createElement('div', {
          style: {
            display: 'flex',
            gap: '6px',
            padding: '8px',
            background: '#0f172a',
            borderTop: '1px solid #1e293b',
            flexShrink: 0
          }
        },
          React.createElement('textarea', {
            value: chatInput,
            onChange: (e) => setChatInput(e.target.value),
            ...imeCompositionProps,
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (isImeComposing(e)) return;
                e.preventDefault();
                handleSendOllamaChat();
              }
            },
            placeholder: 'Ask about pilot.py... (Enter: Send / Shift+Enter: Newline)',
            rows: 2,
            disabled: aiStreaming,
            style: {
              flex: 1,
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '5px 8px',
              fontSize: '11px',
              outline: 'none',
              resize: 'none',
              fontFamily: 'inherit'
            }
          }),
          aiStreaming
            ? React.createElement('button', {
                onClick: handleCancelOllama,
                style: {
                  background: '#991b1b',
                  color: '#ffffff',
                  border: '1px solid #ef4444',
                  borderRadius: '4px',
                  padding: '0 12px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }
              }, '⏹ Stop')
            : React.createElement('button', {
                onClick: () => handleSendOllamaChat(),
                disabled: !chatInput.trim(),
                style: {
                  background: chatInput.trim() ? '#7c3aed' : '#1e293b',
                  color: chatInput.trim() ? '#ffffff' : '#64748b',
                  border: chatInput.trim() ? '1px solid #a78bfa' : '1px solid #334155',
                  borderRadius: '4px',
                  padding: '0 12px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  cursor: chatInput.trim() ? 'pointer' : 'default'
                }
              }, 'Send')
        )
      )
    ),

    // Bottom Quick-Help Status Bar
    React.createElement('div', {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        padding: '4px 12px',
        background: '#090d16',
        borderTop: '1px solid #1e293b',
        fontSize: '10px',
        color: '#64748b',
        flexShrink: 0
      }
    },
      React.createElement('span', null, `💡 Target: ${displayTitle} | Save: [Ctrl+S] | Jump: [Ctrl+G] | Re-flight: [Restart Scenario]`),
      React.createElement('span', null, `Lines: ${lineCount} | AI: ${aiProvider.toUpperCase()} | UTF-8 | Python 3`)
    ),

    // =========================================================================
    // Inline Modal 1: Smart Apply (Extract Code Block + Line Diff Preview)
    // =========================================================================
    smartApplyModal && React.createElement('div', {
      style: {
        position: 'absolute',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: '16px'
      }
    },
      React.createElement('div', {
        style: {
          width: '100%',
          maxWidth: '720px',
          maxHeight: '90%',
          background: '#0f172a',
          border: '1px solid #38bdf8',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.75)'
        }
      },
        React.createElement('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 14px',
            background: '#1e293b',
            borderBottom: '1px solid #334155'
          }
        },
          React.createElement('span', { style: { fontWeight: 'bold', color: '#38bdf8', fontSize: '12px' } }, '📋 Smart Apply — Extract Code & Diff Preview'),
          React.createElement('button', {
            onClick: () => setSmartApplyModal(null),
            style: { background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px' }
          }, '✕')
        ),

        React.createElement('div', {
          style: { padding: '12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }
        },
          React.createElement('div', { style: { fontSize: '11px', color: '#94a3b8' } },
            'Paste the AI response below (full Markdown supported). ```python code blocks are extracted automatically:'
          ),
          React.createElement('textarea', {
            value: smartApplyModal.rawText,
            onChange: (e) => setSmartApplyModal({ rawText: e.target.value, selectedBlockIdx: 0 }),
            placeholder: 'Press Ctrl+V / Cmd+V to paste AI response here...',
            rows: 5,
            autoFocus: !smartApplyModal.rawText,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              background: '#060911',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '8px',
              fontSize: '11px',
              fontFamily: 'inherit',
              outline: 'none'
            }
          }),

          smartApplyBlocks.length > 1 && React.createElement('div', {
            style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }
          },
            React.createElement('span', { style: { fontSize: '11px', color: '#94a3b8' } }, 'Detected Blocks:'),
            smartApplyBlocks.map((b, idx) => React.createElement('button', {
              key: idx,
              onClick: () => setSmartApplyModal(prev => ({ ...prev, selectedBlockIdx: idx })),
              style: {
                background: (smartApplyModal.selectedBlockIdx || 0) === idx ? '#0284c7' : '#1e293b',
                color: '#f8fafc',
                border: '1px solid #38bdf8',
                borderRadius: '4px',
                padding: '2px 8px',
                fontSize: '10px',
                cursor: 'pointer'
              }
            }, `#${idx + 1} (${b.lang}, ${b.lines} lines)`))
          ),

          activeApplyBlock && smartApplyDiff && React.createElement('div', {
            style: {
              border: '1px solid #334155',
              borderRadius: '6px',
              overflow: 'hidden',
              background: '#060911'
            }
          },
            React.createElement('div', {
              style: {
                padding: '5px 10px',
                background: '#1e293b',
                fontSize: '11px',
                display: 'flex',
                justifyContent: 'space-between',
                color: '#cbd5e1'
              }
            },
              React.createElement('span', null, `Extracted (${activeApplyBlock.lang} / ${activeApplyBlock.lines} lines)`),
              React.createElement('span', null,
                React.createElement('span', { style: { color: '#4ade80', marginRight: '8px' } }, `+${smartApplyDiff.added}`),
                React.createElement('span', { style: { color: '#f87171' } }, `-${smartApplyDiff.removed}`)
              )
            ),
            React.createElement('div', {
              style: { maxHeight: '200px', overflowY: 'auto', padding: '6px 0', fontSize: '11px', lineHeight: '1.45' }
            },
              smartApplyDiff.preview.length === 0
                ? React.createElement('div', { style: { padding: '6px 10px', color: '#94a3b8' } }, '(No differences from current code)')
                : smartApplyDiff.preview.slice(0, 120).map((row, rIdx) => React.createElement('div', {
                    key: rIdx,
                    style: {
                      padding: '0 10px',
                      whiteSpace: 'pre',
                      background: row.type === 'add' ? 'rgba(34, 197, 94, 0.14)' : row.type === 'del' ? 'rgba(239, 68, 68, 0.14)' : 'transparent',
                      color: row.type === 'add' ? '#86efac' : row.type === 'del' ? '#fca5a5' : row.type === 'sep' ? '#475569' : '#94a3b8'
                    }
                  }, `${row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : row.type === 'sep' ? '  ' : '  '}${row.text}`))
            )
          )
        ),

        React.createElement('div', {
          style: {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            padding: '10px 14px',
            background: '#1e293b',
            borderTop: '1px solid #334155',
            flexWrap: 'wrap'
          }
        },
          React.createElement('button', {
            onClick: () => setSmartApplyModal(null),
            style: { background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', padding: '5px 12px', fontSize: '11px', cursor: 'pointer' }
          }, 'Cancel'),
          React.createElement('button', {
            disabled: !activeApplyBlock,
            onClick: () => activeApplyBlock && applyCodeToEditor(activeApplyBlock.code, 'selection'),
            style: {
              background: activeApplyBlock ? '#1e3a8a' : '#1e293b',
              color: activeApplyBlock ? '#bfdbfe' : '#64748b',
              border: '1px solid #3b82f6',
              borderRadius: '4px',
              padding: '5px 12px',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: activeApplyBlock ? 'pointer' : 'default'
            }
          }, '📌 Insert / Replace Selection'),
          React.createElement('button', {
            disabled: !activeApplyBlock,
            onClick: () => activeApplyBlock && applyCodeToEditor(activeApplyBlock.code, 'full'),
            style: {
              background: activeApplyBlock ? '#0284c7' : '#1e293b',
              color: activeApplyBlock ? '#ffffff' : '#64748b',
              border: '1px solid #38bdf8',
              borderRadius: '4px',
              padding: '5px 14px',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: activeApplyBlock ? 'pointer' : 'default'
            }
          }, '✨ Replace Full File')
        )
      )
    ),

    // =========================================================================
    // Inline Modal 2: Manual Prompt Copy / Popup Fallback (Portal-safe)
    // =========================================================================
    manualPromptModal && React.createElement('div', {
      style: {
        position: 'absolute',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 55,
        padding: '16px'
      }
    },
      React.createElement('div', {
        style: {
          width: '100%',
          maxWidth: '640px',
          background: '#0f172a',
          border: '1px solid #a78bfa',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }
      },
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#1e1b4b', borderBottom: '1px solid #312e81' }
        },
          React.createElement('span', { style: { fontWeight: 'bold', color: '#c4b5fd', fontSize: '12px' } }, `🤖 Hand-off to ${manualPromptModal.providerLabel}`),
          React.createElement('button', {
            onClick: () => setManualPromptModal(null),
            style: { background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px' }
          }, '✕')
        ),
        React.createElement('div', { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('div', { style: { fontSize: '11px', color: '#fde047' } }, manualPromptModal.reason),
          React.createElement('textarea', {
            readOnly: true,
            value: manualPromptModal.promptText,
            onFocus: (e) => e.target.select(),
            rows: 8,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              background: '#060911',
              color: '#cbd5e1',
              border: '1px solid #334155',
              borderRadius: '4px',
              padding: '8px',
              fontSize: '11px',
              fontFamily: 'inherit'
            }
          }),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
            React.createElement('button', {
              onClick: () => copyTextSafe(manualPromptModal.promptText).then(ok => {
                setStatusMsg(ok ? '✓ Copied prompt to clipboard' : 'Select text and press Ctrl+C');
                setStatusType(ok ? 'success' : 'info');
              }),
              style: { background: '#1e293b', color: '#f8fafc', border: '1px solid #334155', borderRadius: '4px', padding: '5px 12px', fontSize: '11px', cursor: 'pointer' }
            }, '📋 Copy Again'),
            React.createElement('a', {
              href: manualPromptModal.url,
              target: 'sg_ai_copilot',
              rel: 'noopener noreferrer',
              onClick: () => setManualPromptModal(null),
              style: {
                background: '#2563eb',
                color: '#ffffff',
                border: '1px solid #60a5fa',
                borderRadius: '4px',
                padding: '5px 14px',
                fontSize: '11px',
                fontWeight: 'bold',
                textDecoration: 'none'
              }
            }, `↗ Open ${manualPromptModal.providerLabel}`)
          )
        )
      )
    ),

    // =========================================================================
    // Inline Modal 3: Portal-Safe Confirm Dialog (replaces window.confirm)
    // =========================================================================
    confirmModal && React.createElement('div', {
      style: {
        position: 'absolute',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
        padding: '16px'
      }
    },
      React.createElement('div', {
        style: {
          width: '100%',
          maxWidth: '420px',
          background: '#0f172a',
          border: '1px solid #ef4444',
          borderRadius: '8px',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.7)'
        }
      },
        React.createElement('div', { style: { fontWeight: 'bold', color: '#fca5a5', fontSize: '12px' } }, confirmModal.title),
        React.createElement('div', { style: { fontSize: '11px', color: '#cbd5e1', lineHeight: '1.5' } }, confirmModal.message),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
          React.createElement('button', {
            onClick: () => setConfirmModal(null),
            style: { background: '#1e293b', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', padding: '5px 12px', fontSize: '11px', cursor: 'pointer' }
          }, 'Cancel'),
          React.createElement('button', {
            onClick: confirmModal.onConfirm,
            style: { background: '#b91c1c', color: '#ffffff', border: '1px solid #ef4444', borderRadius: '4px', padding: '5px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }
          }, confirmModal.confirmLabel)
        )
      )
    )
  );
}
