export const minApiVersion = 1;

// =============================================================================
// Module-Scope Persistent Store (Survives Dock <-> Pop-out React Portal Remount)
// =============================================================================
const AI_PREFS_KEY = 'sg_pilot_ai_prefs_v1';
const aiSessionStore = {
  chatMessages: [],       // [{ id, role: 'user'|'assistant'|'system-notice', content, apiContent?, model?, timestamp }]
  aiBarOpen: false,       // Web AI / Copilot bar or Ollama split panel open state
  aiSplitRatio: 0.56,     // Left editor width fraction in Ollama split mode (0.35 ~ 0.75)
  prevCodeBeforeAi: null, // 1-step Undo snapshot before last AI Smart Apply
  aiIncludeTelemetry: true,
  aiIncludeTrace: false,
  aiTraceWindow: 'full_30', // 'time_travel' | 'last_30' | 'full_30'
  aiTracePreset: 'control', // 'control' | 'energy' | 'fdir' | 'tracer' | 'custom'
  aiTraceSelectedSignals: ['POS_X', 'XT_ERR', 'ANGLE', 'ROLL', 'THRUST_CMD_X', 'THRUST_CMD_Y', 'TORQUE_CMD', 'WHEEL_TORQUE_X', 'WHEEL_TORQUE_CMD'],
  aiPromptDraft: '',
  // Persistent references & active-session flags for Browser Web AI companion windows
  // (NOTE: gemini.google.com / chatgpt.com use COOP same-origin which turns ref.closed=true after load,
  // so we track sessionStarted explicitly rather than trusting ref.closed!)
  webAiWindows: {
    gemini: null,
    chatgpt: null
  },
  webAiSessionStarted: {
    gemini: false,
    chatgpt: false
  },
  // Pinned initialization context anchor (sent once per model / manual sync; keeps Ollama KV-cache hot)
  ollamaSession: {
    model: '',
    scenario: '',
    fileName: '',
    initializedCode: '',
    systemMsg: null,
    initUserMsg: null,
    initAssistantMsg: null,
    turnAnchorIdx: 0
  }
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

function dedentSnippet(rawSnippet) {
  const normalized = (rawSnippet || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^[ \t]*/);
    const indentLen = m ? m[0].length : 0;
    if (indentLen < minIndent) minIndent = indentLen;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return lines;
  return lines.map(line => (line.trim() ? line.slice(minIndent) : ''));
}

function alignSnippetForInsert(srcCode, start, end, rawSnippet) {
  const safeStart = Math.max(0, Math.min(srcCode.length, start || 0));
  const safeEnd = Math.max(safeStart, Math.min(srcCode.length, end || safeStart));
  const lineStart = srcCode.lastIndexOf('\n', safeStart - 1) + 1;
  const beforeCursor = srcCode.slice(lineStart, safeStart);
  const selectedText = srcCode.slice(safeStart, safeEnd);

  const dedentedLines = dedentSnippet(rawSnippet);
  let targetIndent = '';
  let indentFirstLine = false;

  if (/^[ \t]*$/.test(beforeCursor)) {
    if (beforeCursor.length > 0) {
      // Cursor is already positioned at the desired indentation column (e.g. "    |")
      targetIndent = beforeCursor;
      indentFirstLine = false;
    } else if (safeEnd > safeStart) {
      // User selected whole line(s) starting from column 0 (e.g. "|    kp = 1.2\n    kd = 0.6|")
      const firstNonEmpty = selectedText.split('\n').find(l => l.trim().length > 0) || '';
      const m = firstNonEmpty.match(/^[ \t]*/);
      targetIndent = m ? m[0] : '';
      indentFirstLine = targetIndent.length > 0;
    }
  } else {
    // Cursor is after non-whitespace text on the line -> align subsequent lines to this line's base indent
    const m = beforeCursor.match(/^[ \t]*/);
    targetIndent = m ? m[0] : '';
    indentFirstLine = false;
  }

  const alignedLines = dedentedLines.map((line, idx) => {
    if (!line.trim()) return '';
    if (idx === 0 && !indentFirstLine) return line;
    return targetIndent + line;
  });

  const alignedText = alignedLines.join('\n');
  const nextCode = srcCode.substring(0, safeStart) + alignedText + srcCode.substring(safeEnd);
  const newCursorPos = safeStart + alignedText.length;
  const lineNum = (srcCode.slice(0, safeStart).match(/\n/g) || []).length + 1;
  return {
    alignedText,
    nextCode,
    newCursorPos,
    targetIndent,
    indentCols: targetIndent.replace(/\t/g, '    ').length,
    lineNum
  };
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

// =============================================================================
// Semantic Hardware Trace Decoder & Role Dictionary (Q16.16 / IEEE-754 f64 / Flags)
// =============================================================================
const TRACE_SIGNAL_CATALOG = {
  // Control & Actuation (Q16.16 signed fixed-point)
  THRUST_CMD_X:     { group: 'Control',      unit: '-1..1',   offset: '0x10', enc: 'q16', digits: 3, role: 'Forward main thrust command (hw.write_commands(thrust_x=...))' },
  THRUST_CMD_Y:     { group: 'Control',      unit: '-1..1',   offset: '0x14', enc: 'q16', digits: 3, role: 'Lateral RCS thrust command (hw.write_commands(thrust_y=...))' },
  THRUST_CMD_Z:     { group: 'Control',      unit: '-1..1',   offset: '0x18', enc: 'q16', digits: 3, role: 'Z/Bitmask thrust command (hw.write_commands(thrust_z=...))' },
  TORQUE_CMD:       { group: 'Control',      unit: 'N*m',     offset: '0x1C', enc: 'q16', digits: 3, role: 'Yaw RCS torque command (hw.write_commands(torque=...))' },
  WHEEL_TORQUE_CMD: { group: 'Control',      unit: 'N*m',     offset: '0x2C', enc: 'q16', digits: 3, role: 'Yaw Reaction Wheel torque (hw.write_commands(wheel_torque=...))' },
  TORQUE_X_CMD:     { group: 'Control',      unit: 'N*m',     offset: '0x90', enc: 'q16', digits: 3, role: 'Roll RCS torque command (hw.write_commands(torque_x=...))' },
  TORQUE_Y_CMD:     { group: 'Control',      unit: 'N*m',     offset: '0x94', enc: 'q16', digits: 3, role: 'Pitch RCS torque command (hw.write_commands(torque_y=...))' },
  WHEEL_TORQUE_X:   { group: 'Control',      unit: 'N*m',     offset: '0x98', enc: 'q16', digits: 3, role: 'Roll Reaction Wheel torque (hw.write_commands(wheel_torque_x=...))' },
  WHEEL_TORQUE_Y:   { group: 'Control',      unit: 'N*m',     offset: '0x9C', enc: 'q16', digits: 3, role: 'Pitch Reaction Wheel torque (hw.write_commands(wheel_torque_y=...))' },
  THRUST_VERT_CMD:  { group: 'Control',      unit: '-1..1',   offset: '0xA0', enc: 'q16', digits: 3, role: 'Vertical Z-axis thrust command (hw.write_commands(thrust_vertical=...))' },
  // Kinematics & Dynamics (IEEE-754 64-bit double split across _L/_H)
  POS_X:            { group: 'Kinematics',   unit: 'm',       offset: '0x30/34', enc: 'f64', tlmKey: 'pos_x', digits: 2, role: 'Longitudinal X position along course (tlm["pos_x"])' },
  POS_Y:            { group: 'Kinematics',   unit: 'm',       offset: '0x38/3C', enc: 'f64', tlmKey: 'pos_y', digits: 2, role: 'Lateral Y position (tlm["pos_y"])' },
  POS_Z:            { group: 'Kinematics',   unit: 'm',       offset: '0xB0/B4', enc: 'f64', tlmKey: 'pos_z', digits: 2, role: 'Vertical Z position (tlm["pos_z"])' },
  VEL_X:            { group: 'Kinematics',   unit: 'm/s',     offset: '0x40/44', enc: 'f64', tlmKey: 'vel_x', digits: 2, role: 'Forward X velocity (tlm["vel_x"])' },
  VEL_Y:            { group: 'Kinematics',   unit: 'm/s',     offset: '0x48/4C', enc: 'f64', tlmKey: 'vel_y', digits: 2, role: 'Lateral Y velocity (tlm["vel_y"])' },
  VEL_Z:            { group: 'Kinematics',   unit: 'm/s',     offset: '0xB8/BC', enc: 'f64', tlmKey: 'vel_z', digits: 2, role: 'Vertical Z velocity (tlm["vel_z"])' },
  XT_ERR:           { group: 'Kinematics',   unit: 'm',       offset: '0x68/6C', enc: 'f64', tlmKey: 'cross_track_err', digits: 3, role: 'Cross-track trajectory error from centerline (tlm["cross_track_err"])' },
  ANGLE:            { group: 'Attitude',     unit: 'rad',     offset: '0x50/54', enc: 'f64', tlmKey: 'angle', digits: 3, role: 'Yaw heading angle (tlm["angle"])' },
  OMEGA:            { group: 'Attitude',     unit: 'rad/s',   offset: '0x58/5C', enc: 'f64', tlmKey: 'omega', digits: 3, role: 'Yaw angular rate (tlm["omega"])' },
  ROLL:             { group: 'Attitude',     unit: 'rad',     offset: '0xC0/C4', enc: 'f64', tlmKey: 'roll', digits: 3, role: 'Roll bank angle (tlm["roll"])' },
  PITCH:            { group: 'Attitude',     unit: 'rad',     offset: '0xC8/CC', enc: 'f64', tlmKey: 'pitch', digits: 3, role: 'Pitch angle (tlm["pitch"])' },
  YAW:              { group: 'Attitude',     unit: 'rad',     offset: '0xD0/D4', enc: 'f64', tlmKey: 'yaw', digits: 3, role: '3D Yaw angle (tlm["yaw"])' },
  OMEGA_X:          { group: 'Attitude',     unit: 'rad/s',   offset: '0xD8/DC', enc: 'f64', tlmKey: 'omega_x', digits: 3, role: 'Roll angular rate (tlm["omega_x"])' },
  OMEGA_Y:          { group: 'Attitude',     unit: 'rad/s',   offset: '0xE0/E4', enc: 'f64', tlmKey: 'omega_y', digits: 3, role: 'Pitch angular rate (tlm["omega_y"])' },
  OMEGA_Z:          { group: 'Attitude',     unit: 'rad/s',   offset: '0xE8/EC', enc: 'f64', tlmKey: 'omega_z', digits: 3, role: 'Yaw angular rate (tlm["omega_z"])' },
  // Energy & Reaction Wheels
  FUEL:             { group: 'Energy/RW',    unit: '%',       offset: '0x60/64', enc: 'f64', tlmKey: 'fuel', digits: 1, role: 'Remaining RCS propellant percentage (tlm["fuel"])' },
  WHEEL_RPM:        { group: 'Energy/RW',    unit: 'RPM',     offset: '0x70/74', enc: 'f64', tlmKey: 'wheel_rpm', digits: 0, role: 'Yaw Reaction Wheel RPM; desat threshold ~5200 RPM (tlm["wheel_rpm"])' },
  WHEEL_RPM_X:      { group: 'Energy/RW',    unit: 'RPM',     offset: '0xF0/F4', enc: 'f64', tlmKey: 'wheel_rpm_x', digits: 0, role: 'Roll Reaction Wheel RPM (tlm["wheel_rpm_x"])' },
  WHEEL_RPM_Y:      { group: 'Energy/RW',    unit: 'RPM',     offset: '0xF8/FC', enc: 'f64', tlmKey: 'wheel_rpm_y', digits: 0, role: 'Pitch Reaction Wheel RPM (tlm["wheel_rpm_y"])' },
  WHEEL_RPM_Z:      { group: 'Energy/RW',    unit: 'RPM',     offset: '0x100/104', enc: 'f64', tlmKey: 'wheel_rpm_z', digits: 0, role: 'Z Reaction Wheel RPM (tlm["wheel_rpm_z"])' },
  CABLE_TENSION:    { group: 'Energy/RW',    unit: 'N',       offset: '0x108/10C', enc: 'f64', tlmKey: 'cable_tension', digits: 1, role: 'Tether climber cable tension (tlm["cable_tension"])' },
  CABLE_VIB:        { group: 'Energy/RW',    unit: 'm',       offset: '0x110/114', enc: 'f64', tlmKey: 'cable_vibration', digits: 3, role: 'Tether lateral vibration amplitude (tlm["cable_vibration"])' },
  // Sensors, FDIR & Referee
  SENSOR_EDGE:      { group: 'Sensors/FDIR', unit: 'm',       offset: '0x0C', enc: 'q16', digits: 3, role: 'Line-sensor lateral edge offset (tlm["sensor_edge"]/65536.0)' },
  SENSOR_RAW:       { group: 'Sensors/FDIR', unit: 'hex',     offset: '0x08', enc: 'hex', role: 'Raw line-sensor bitmask (0=lost, 0xFFFFFFFF=saturated)' },
  SR_STATUS:        { group: 'Sensors/FDIR', unit: 'hex',     offset: '0x04', enc: 'hex', role: 'Hardware status flags (Bit 3 = CARRIER_LOST)' },
  FDIR_MODE:        { group: 'Sensors/FDIR', unit: 'enum',    offset: '0x78', enc: 'u32', role: 'FDIR mode (0=Nominal, 1=LOS/Recovery, 2=Safe)' },
  OFFICIAL_SCORE:   { group: 'Sensors/FDIR', unit: 'pts',     offset: '0x80', enc: 'i32', role: 'Official referee cumulative score (tlm["score"])' },
  PASSED_GATES:     { group: 'Sensors/FDIR', unit: 'cnt',     offset: '0x84', enc: 'u32', role: 'Number of passed checkpoints/gates (tlm["passed_checkpoints"])' },
  THRUST_HEALTH:    { group: 'Sensors/FDIR', unit: 'hex',     offset: '0x174', enc: 'hex', role: '12-ch RCS thruster health bitmask (1=healthy, 0=damaged)' }
};

const TRACE_PRESETS = {
  control: {
    label: '🎯 Control Loop',
    signals: ['POS_X', 'XT_ERR', 'ANGLE', 'ROLL', 'THRUST_CMD_X', 'THRUST_CMD_Y', 'TORQUE_CMD', 'WHEEL_TORQUE_X', 'WHEEL_TORQUE_CMD']
  },
  energy: {
    label: '⚡ Energy & Wheels',
    signals: ['POS_X', 'FUEL', 'WHEEL_RPM', 'WHEEL_RPM_X', 'TORQUE_CMD', 'WHEEL_TORQUE_CMD', 'WHEEL_TORQUE_X']
  },
  fdir: {
    label: '🛡 FDIR & Sensors',
    signals: ['POS_X', 'SR_STATUS', 'FDIR_MODE', 'SENSOR_RAW', 'SENSOR_EDGE', 'XT_ERR', 'THRUST_HEALTH']
  }
};

function toSigned32(val) {
  if (val == null) return 0;
  const n = Number(val) >>> 0;
  return (n & 0x80000000) ? (n - 0x100000000) : n;
}

function decodeDoubleFromHalves(lo, hi) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Number(lo) >>> 0, true);
  view.setUint32(4, Number(hi) >>> 0, true);
  const v = view.getFloat64(0, true);
  return Number.isFinite(v) ? v : 0;
}

function discoverTraceSignals(history, manifestRegs) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const sample = history[history.length - 1];
  const rawKeys = Object.keys(sample).filter(k => k !== 'index' && k !== 'time' && k !== 'telemetry');
  const regLookup = {};
  (manifestRegs || []).forEach(r => {
    regLookup[`${r.deviceName}_${r.name}`] = r;
  });

  // Group raw register keys by base name (auto-merging *_L and *_H into a single f64 signal)
  const rawByShort = {};
  rawKeys.forEach(fullKey => {
    const meta = regLookup[fullKey];
    const shortName = meta?.name || fullKey.replace(/^[a-zA-Z0-9]+_reg_|^[^_]+_/, '');
    rawByShort[shortName] = { fullKey, meta };
  });

  const signals = [];
  const consumed = new Set();

  Object.keys(rawByShort).forEach(shortName => {
    if (consumed.has(shortName)) return;
    // Skip internal/noisy sync/reserved/string registers unless explicitly desired
    if (/^(RESERVED_|SHM_MAGIC|SEQLOCK_COUNTER|GRADE_STR|EVENT_STR|WATCHDOG_KICK)/.test(shortName)) return;

    // Pair *_L and *_H into a single 64-bit IEEE-754 double signal
    if (shortName.endsWith('_L')) {
      const base = shortName.slice(0, -2);
      const hiName = `${base}_H`;
      if (rawByShort[hiName]) {
        consumed.add(shortName);
        consumed.add(hiName);
        const cat = TRACE_SIGNAL_CATALOG[base];
        signals.push({
          id: base,
          rawKeys: [rawByShort[shortName].fullKey, rawByShort[hiName].fullKey],
          loKey: rawByShort[shortName].fullKey,
          hiKey: rawByShort[hiName].fullKey,
          group: cat?.group || rawByShort[shortName].meta?.group || 'Telemetry (f64)',
          unit: cat?.unit || '',
          offset: cat?.offset || rawByShort[shortName].meta?.offset || '',
          enc: 'f64',
          tlmKey: cat?.tlmKey || null,
          digits: cat?.digits ?? 3,
          role: cat?.role || `64-bit IEEE-754 float register pair (${base}_L / ${base}_H)`
        });
        return;
      }
    }
    if (shortName.endsWith('_H') && rawByShort[`${shortName.slice(0, -2)}_L`]) {
      return; // Handled when *_L is visited
    }

    consumed.add(shortName);
    const cat = TRACE_SIGNAL_CATALOG[shortName];
    signals.push({
      id: shortName,
      rawKeys: [rawByShort[shortName].fullKey],
      key: rawByShort[shortName].fullKey,
      group: cat?.group || rawByShort[shortName].meta?.group || 'Other Registers',
      unit: cat?.unit || '',
      offset: cat?.offset || rawByShort[shortName].meta?.offset || '',
      enc: cat?.enc || 'i32',
      digits: cat?.digits ?? 0,
      role: cat?.role || `32-bit hardware register (${rawByShort[shortName].meta?.group || 'MMIO'})`
    });
  });

  const groupOrder = { Control: 0, Kinematics: 1, Attitude: 2, 'Energy/RW': 3, 'Sensors/FDIR': 4 };
  signals.sort((a, b) => (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9) || a.id.localeCompare(b.id));
  return signals;
}

function decodeSignalValue(snap, sig) {
  if (!snap || !sig) return null;
  if (sig.enc === 'f64') {
    if (sig.tlmKey && snap.telemetry && typeof snap.telemetry[sig.tlmKey] === 'number') {
      return snap.telemetry[sig.tlmKey];
    }
    return decodeDoubleFromHalves(snap[sig.loKey], snap[sig.hiKey]);
  }
  const raw = snap[sig.key];
  if (raw === undefined || raw === null) return null;
  if (sig.enc === 'q16') return toSigned32(raw) / 65536.0;
  if (sig.enc === 'i32') return toSigned32(raw);
  return Number(raw) >>> 0;
}

function formatDecodedVal(val, sig) {
  if (val === null || val === undefined || Number.isNaN(val)) return '-';
  if (sig.enc === 'hex') return `0x${(Number(val) >>> 0).toString(16).toUpperCase()}`;
  if (sig.enc === 'u32' || sig.enc === 'i32') return String(Math.round(val));
  return Number(val).toFixed(sig.digits ?? 2);
}

function formatTraceContext(history, selectedIds, windowMode, timeTravelIndex, manifestRegs) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const allSignals = discoverTraceSignals(history, manifestRegs);
  const sigMap = {};
  allSignals.forEach(s => { sigMap[s.id] = s; });
  const activeSignals = (selectedIds || []).map(id => sigMap[id]).filter(Boolean);
  if (activeSignals.length === 0) return '';

  // 1. Slice & downsample target window (keep ~25-31 compact rows for token efficiency)
  const total = history.length;
  let picked = [];
  let windowDesc = '';
  if (windowMode === 'time_travel' && typeof timeTravelIndex === 'number') {
    let center = history.findIndex(s => s.index === timeTravelIndex);
    if (center === -1) center = Math.min(total - 1, Math.max(0, timeTravelIndex));
    const start = Math.max(0, center - 15);
    const end = Math.min(total, center + 16);
    picked = history.slice(start, end);
    windowDesc = `Around Time-Travel Frame #${history[center]?.index ?? center} (${picked.length} of ${total} frames)`;
  } else if (windowMode === 'last_30') {
    picked = history.slice(-30);
    windowDesc = `Last ${picked.length} of ${total} frames`;
  } else {
    const targetPts = 30;
    if (total <= targetPts) {
      picked = history;
    } else {
      const idxSet = new Set([0, total - 1]);
      // Always include peak |XT_ERR| frame if present so worst overshoot is never dropped
      const xtSig = sigMap.XT_ERR;
      if (xtSig) {
        let peakIdx = 0;
        let peakAbs = -1;
        for (let i = 0; i < total; i++) {
          const v = Math.abs(decodeSignalValue(history[i], xtSig) || 0);
          if (v > peakAbs) { peakAbs = v; peakIdx = i; }
        }
        idxSet.add(peakIdx);
      }
      for (let k = 1; k < targetPts - 1; k++) {
        idxSet.add(Math.round((k * (total - 1)) / (targetPts - 1)));
      }
      picked = Array.from(idxSet).sort((a, b) => a - b).map(i => history[i]);
    }
    windowDesc = `Full Run Downsampled (${picked.length} pts from ${total} total frames)`;
  }

  const lines = [];
  lines.push(`### Hardware Register Trace Data — ${windowDesc}`);
  lines.push('');
  lines.push('#### Signal Roles & Encoding (Decoded to Physical Units)');
  activeSignals.forEach(s => {
    const unitStr = s.unit ? ` [${s.unit}]` : '';
    const offStr = s.offset ? ` @ ${s.offset}` : '';
    lines.push(`- **${s.id}**${unitStr} (${s.enc}${offStr}): ${s.role}`);
  });

  // 2. Summary statistics over the selected window
  lines.push('');
  lines.push('#### Window Statistics');
  activeSignals.forEach(s => {
    const vals = picked.map(sn => ({ idx: sn.index, v: decodeSignalValue(sn, s) })).filter(x => x.v !== null && !Number.isNaN(x.v));
    if (vals.length === 0) return;
    if (s.enc === 'hex') {
      const uniq = Array.from(new Set(vals.map(x => formatDecodedVal(x.v, s)))).slice(0, 6);
      lines.push(`- ${s.id}: unique=[${uniq.join(', ')}]`);
      return;
    }
    let minItem = vals[0];
    let maxItem = vals[0];
    let sum = 0;
    vals.forEach(x => {
      if (x.v < minItem.v) minItem = x;
      if (x.v > maxItem.v) maxItem = x;
      sum += x.v;
    });
    const mean = sum / vals.length;
    lines.push(
      `- ${s.id}: min=${formatDecodedVal(minItem.v, s)} (#${minItem.idx}), max=${formatDecodedVal(maxItem.v, s)} (#${maxItem.idx}), mean=${formatDecodedVal(mean, s)}, start->end=${formatDecodedVal(vals[0].v, s)}->${formatDecodedVal(vals[vals.length - 1].v, s)}`
    );
  });

  // 3. Compact CSV time-series table
  lines.push('');
  lines.push('#### Time-Series Samples (CSV)');
  lines.push('```csv');
  lines.push(['idx', 'time', ...activeSignals.map(s => s.id)].join(','));
  picked.forEach(sn => {
    const row = [sn.index ?? '', sn.time ?? '', ...activeSignals.map(s => formatDecodedVal(decodeSignalValue(sn, s), s))];
    lines.push(row.join(','));
  });
  lines.push('```');
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
  const [aiIncludeTrace, setAiIncludeTrace] = useState(aiSessionStore.aiIncludeTrace);
  const [aiTraceWindow, setAiTraceWindow] = useState(aiSessionStore.aiTraceWindow);
  const [aiTracePreset, setAiTracePreset] = useState(aiSessionStore.aiTracePreset);
  const [aiTraceSelectedSignals, setAiTraceSelectedSignals] = useState(aiSessionStore.aiTraceSelectedSignals);
  const [traceCount, setTraceCount] = useState(0);
  const [tracePickerModal, setTracePickerModal] = useState(false);
  const [aiIntent, setAiIntent] = useState('tune'); // 'tune' | 'fix' | 'explain' | 'custom'
  const [aiCustomNote, setAiCustomNote] = useState(aiSessionStore.aiPromptDraft);
  const [chatMessages, setChatMessages] = useState(aiSessionStore.chatMessages);
  const [chatInput, setChatInput] = useState('');
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiInitializing, setAiInitializing] = useState(false);
  const [ollamaSession, setOllamaSession] = useState(aiSessionStore.ollamaSession);
  const [aiSplitRatio, setAiSplitRatio] = useState(aiSessionStore.aiSplitRatio);
  const [prevCodeBeforeAi, setPrevCodeBeforeAi] = useState(aiSessionStore.prevCodeBeforeAi);
  const [hasTelemetry, setHasTelemetry] = useState(false);
  const [webAiOpenMap, setWebAiOpenMap] = useState(() => ({
    gemini: Boolean(aiSessionStore.webAiSessionStarted.gemini),
    chatgpt: Boolean(aiSessionStore.webAiSessionStarted.chatgpt)
  }));

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
  const initInFlightRef = useRef(false);
  const telemetryRef = useRef(null);
  const traceHistoryRef = useRef([]);
  const manifestRegsRef = useRef([]);
  const hiddenTraceKeysRef = useRef({});
  const timeTravelIdxRef = useRef(null);
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
  useEffect(() => { aiSessionStore.ollamaSession = ollamaSession; }, [ollamaSession]);
  useEffect(() => { aiSessionStore.aiBarOpen = aiBarOpen; }, [aiBarOpen]);
  useEffect(() => { aiSessionStore.aiSplitRatio = aiSplitRatio; }, [aiSplitRatio]);
  useEffect(() => { aiSessionStore.prevCodeBeforeAi = prevCodeBeforeAi; }, [prevCodeBeforeAi]);
  useEffect(() => { aiSessionStore.aiIncludeTelemetry = aiIncludeTelemetry; }, [aiIncludeTelemetry]);
  useEffect(() => { aiSessionStore.aiIncludeTrace = aiIncludeTrace; }, [aiIncludeTrace]);
  useEffect(() => { aiSessionStore.aiTraceWindow = aiTraceWindow; }, [aiTraceWindow]);
  useEffect(() => { aiSessionStore.aiTracePreset = aiTracePreset; }, [aiTracePreset]);
  useEffect(() => { aiSessionStore.aiTraceSelectedSignals = aiTraceSelectedSignals; }, [aiTraceSelectedSignals]);
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

  // Helper: Check stored Browser AI companion window reference (may be COOP-severed on cross-origin)
  const getFocusHandleIfAllowed = (prov) => {
    const key = prov === 'chatgpt' ? 'chatgpt' : 'gemini';
    const ref = aiSessionStore.webAiWindows[key];
    try {
      if (ref && !ref.closed) return ref;
    } catch (e) {}
    return null;
  };

  const syncWebAiSessionState = () => {
    setWebAiOpenMap(prev => {
      const nextG = Boolean(aiSessionStore.webAiSessionStarted.gemini);
      const nextC = Boolean(aiSessionStore.webAiSessionStarted.chatgpt);
      return (prev.gemini === nextG && prev.chatgpt === nextC) ? prev : { gemini: nextG, chatgpt: nextC };
    });
  };

  // Portal-safe Synchronous Right-Half Window Launcher / Activator (MUST be called BEFORE any await!)
  const openWebAiWindowSync = (targetProvider, { forceNew = false, copyOnly = false } = {}) => {
    const { win } = getActiveWinDoc();
    const prov = targetProvider === 'chatgpt' ? 'chatgpt' : 'gemini';
    const url = prov === 'chatgpt'
      ? 'https://chatgpt.com/'
      : 'https://gemini.google.com/app';
    const targetName = `sg_ai_copilot_${prov}`;

    const liveHandle = getFocusHandleIfAllowed(prov);
    const alreadyStarted = Boolean(aiSessionStore.webAiSessionStarted[prov]);

    if (copyOnly || (!forceNew && (liveHandle || alreadyStarted))) {
      let focused = false;
      if (liveHandle) {
        try {
          if (typeof liveHandle.focus === 'function') {
            liveHandle.focus();
            focused = true;
          }
        } catch (e) {}
      }
      if (copyOnly) {
        aiSessionStore.webAiSessionStarted[prov] = true;
        syncWebAiSessionState();
      }
      return { opened: liveHandle || true, reused: true, focused, url, targetName };
    }

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
      opened = win.open(url, targetName, features);
      if (opened) {
        aiSessionStore.webAiWindows[prov] = opened;
        aiSessionStore.webAiSessionStarted[prov] = true;
        if (typeof opened.focus === 'function') opened.focus();
      }
    } catch (e) {}
    syncWebAiSessionState();
    return { opened, reused: false, focused: Boolean(opened), url, targetName };
  };

  // Passive Telemetry & Hardware Trace Listener (zero 30Hz re-render overhead on editor)
  const refreshTraceFromServer = async () => {
    try {
      const [trRes, mfRes] = await Promise.all([
        fetch(`/api/trace-history?_t=${Date.now()}`, { cache: 'no-store' }).catch(() => null),
        fetch(`/api/manifest?_t=${Date.now()}`, { cache: 'no-store' }).catch(() => null)
      ]);
      if (trRes && trRes.ok) {
        const arr = await trRes.json();
        if (Array.isArray(arr)) {
          traceHistoryRef.current = arr.slice(-500);
          setTraceCount(traceHistoryRef.current.length);
        }
      }
      if (mfRes && mfRes.ok) {
        const mf = await mfRes.json();
        const flatRegs = [];
        (mf?.devices || []).forEach(d => {
          (d.registers || []).forEach(r => flatRegs.push({ ...r, deviceName: d.name }));
        });
        manifestRegsRef.current = flatRegs;
      }
    } catch (e) {}
  };

  useEffect(() => {
    const updateTlm = (j, historical = false) => {
      if (!j || (j.type && j.type !== 'space_guidance')) return;
      telemetryRef.current = { ...j, isHistorical: Boolean(historical || j.isHistorical) };
      setHasTelemetry(prev => (prev ? prev : true));
    };

    refreshTraceFromServer();

    let sock = window.FBB?.socket;
    if (!sock && window.FBB?.useDashboard) {
      try { sock = window.FBB.useDashboard().socket; } catch (e) {}
    }
    const onLive = (j) => updateTlm(j, false);
    const onTraceInit = (arr) => {
      if (Array.isArray(arr)) {
        traceHistoryRef.current = arr.slice(-500);
        setTraceCount(traceHistoryRef.current.length);
      }
    };
    const onTraceUpdate = (snap) => {
      if (!snap) return;
      const buf = traceHistoryRef.current;
      buf.push(snap);
      if (buf.length > 500) buf.shift();
      // Only trigger lightweight count state on first frame (avoid 30Hz editor re-renders)
      if (buf.length === 1) setTraceCount(1);
    };

    if (sock) {
      sock.on('scenario:telemetry', onLive);
      sock.on('trace-history-init', onTraceInit);
      sock.on('trace-history-update', onTraceUpdate);
    }

    const onEffective = (e) => {
      if (e?.detail) {
        updateTlm(e.detail, Boolean(e.detail.isHistorical));
        if (e.detail.isHistorical && typeof e.detail.index === 'number') {
          timeTravelIdxRef.current = e.detail.index;
        } else if (!e.detail.isHistorical) {
          timeTravelIdxRef.current = null;
        }
      }
    };
    window.addEventListener('fbb:telemetry:effective', onEffective);

    let syncChannel;
    try {
      if ('BroadcastChannel' in window) {
        syncChannel = new BroadcastChannel('fbb_dashboard_sync');
        syncChannel.onmessage = (event) => {
          const { type, payload } = event.data || {};
          if (type === 'SYNC_TIME_TRAVEL') {
            if (payload?.isLive === false) {
              if (typeof payload.selectedIndex === 'number') timeTravelIdxRef.current = payload.selectedIndex;
              if (payload?.snapshot?.telemetry) updateTlm(payload.snapshot.telemetry, true);
            } else if (payload?.isLive === true) {
              timeTravelIdxRef.current = null;
            }
          } else if (type === 'SYNC_HIDDEN_TRACE_KEYS' && payload) {
            hiddenTraceKeysRef.current = payload;
          }
        };
      }
    } catch (e) {}

    return () => {
      if (sock) {
        sock.off('scenario:telemetry', onLive);
        sock.off('trace-history-init', onTraceInit);
        sock.off('trace-history-update', onTraceUpdate);
      }
      window.removeEventListener('fbb:telemetry:effective', onEffective);
      try { syncChannel?.close(); } catch (e) {}
    };
  }, []);

  // Resolve active trace signals (supports "Sync with Register Tracer" dynamically)
  const resolveSelectedTraceSignalIds = () => {
    const allSigs = discoverTraceSignals(traceHistoryRef.current, manifestRegsRef.current);
    if (aiTracePreset === 'tracer') {
      const hidden = hiddenTraceKeysRef.current || {};
      const visible = allSigs.filter(s => s.rawKeys.some(k => !hidden[k])).map(s => s.id);
      return visible.length > 0 ? visible.slice(0, 14) : aiTraceSelectedSignals;
    }
    return aiTraceSelectedSignals;
  };

  const handleOpenTracePicker = async () => {
    await refreshTraceFromServer();
    setTraceCount(traceHistoryRef.current.length);
    setTracePickerModal(true);
  };

  const handleApplyTracePreset = (presetKey) => {
    setAiTracePreset(presetKey);
    if (presetKey === 'tracer') {
      const allSigs = discoverTraceSignals(traceHistoryRef.current, manifestRegsRef.current);
      const hidden = hiddenTraceKeysRef.current || {};
      const visible = allSigs.filter(s => s.rawKeys.some(k => !hidden[k])).map(s => s.id);
      if (visible.length > 0) setAiTraceSelectedSignals(visible.slice(0, 14));
      return;
    }
    const preset = TRACE_PRESETS[presetKey];
    if (preset) {
      setAiTraceSelectedSignals([...preset.signals]);
    }
  };

  const handleToggleTraceSignal = (sigId) => {
    setAiTracePreset('custom');
    setAiTraceSelectedSignals(prev =>
      prev.includes(sigId) ? prev.filter(x => x !== sigId) : [...prev, sigId]
    );
  };

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

    if (aiIncludeTrace && traceHistoryRef.current.length > 0) {
      const traceBlock = formatTraceContext(
        traceHistoryRef.current,
        resolveSelectedTraceSignalIds(),
        aiTraceWindow,
        timeTravelIdxRef.current,
        manifestRegsRef.current
      );
      if (traceBlock) {
        blocks.push('\n' + traceBlock);
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

  // Launch Browser Web AI (Gemini / ChatGPT) — Reuses active session without reloading unless forceNew=true!
  const handleLaunchWebAi = (targetProvider, opts = {}) => {
    const prov = targetProvider === 'chatgpt' ? 'chatgpt' : 'gemini';
    const providerLabel = prov === 'chatgpt' ? 'ChatGPT (Web)' : 'Gemini (Web)';
    const forceNew = Boolean(opts.forceNew);
    const copyOnly = Boolean(opts.copyOnly);
    const promptText = buildAiContextPrompt(opts);

    // 1. MUST focus/open synchronously inside click gesture before any await!
    const { opened, reused, focused, url, targetName } = openWebAiWindowSync(prov, { forceNew, copyOnly });

    // 2. Copy prompt safely using activeWin / activeDoc
    copyTextSafe(promptText).then((copied) => {
      if (!opened) {
        setManualPromptModal({
          prov,
          promptText,
          url,
          targetName,
          providerLabel,
          reason: copied
            ? 'Popup was blocked by the browser. The prompt is already copied to your clipboard — click the button below to open and paste (Ctrl+V / Cmd+V).'
            : 'Both popup and automatic clipboard copy were blocked. Copy the prompt below and click the button to open.'
        });
        setStatusMsg(`Popup blocked — opened fallback guide for ${providerLabel}`);
        setStatusType('info');
      } else if (!copied) {
        setManualPromptModal({
          prov,
          promptText,
          url,
          targetName,
          providerLabel,
          reason: `${reused ? 'Continue in your open' : 'Opened'} ${providerLabel} window. Automatic clipboard copy was restricted — copy the prompt below and paste it there.`
        });
        setStatusMsg(`${reused ? 'Active session' : 'Opened'} ${providerLabel} (manual copy fallback)`);
        setStatusType('info');
      } else if (reused) {
        setStatusMsg(
          focused
            ? `✓ Copied follow-up prompt & focused ${providerLabel} — Press Ctrl+V / Cmd+V in your active chat!`
            : `✓ Copied follow-up prompt — Paste (Ctrl+V / Cmd+V) into your open ${providerLabel} chat!`
        );
        setStatusType('success');
      } else {
        setStatusMsg(`✓ Copied prompt & opened ${providerLabel} — Press Ctrl+V / Cmd+V to paste!`);
        setStatusType('success');
      }
    });
  };

  // Open Smart Apply Modal (reads clipboard or pre-fills provided code block, snapshotting cursor/selection)
  const handleOpenSmartApply = async (prefilledText = null) => {
    const ta = textareaRef.current;
    const selStart = ta ? ta.selectionStart : (selectionRef.current?.start || 0);
    const selEnd = ta ? ta.selectionEnd : (selectionRef.current?.end || selStart);
    const pickDefaultMode = (txt) => {
      const blocks = extractCodeBlocks(txt || '');
      const first = blocks[0];
      const curLines = (code.match(/\n/g) || []).length + 1;
      if (first && first.lines < Math.max(20, Math.floor(curLines * 0.6))) return 'selection';
      return (selEnd > selStart) ? 'selection' : 'full';
    };

    if (typeof prefilledText === 'string' && prefilledText.trim()) {
      setSmartApplyModal({
        rawText: prefilledText,
        selectedBlockIdx: 0,
        selStart,
        selEnd,
        previewMode: pickDefaultMode(prefilledText)
      });
      return;
    }
    const clip = await readClipboardSafe();
    const initialRaw = clip || '';
    setSmartApplyModal({
      rawText: initialRaw,
      selectedBlockIdx: 0,
      selStart,
      selEnd,
      previewMode: pickDefaultMode(initialRaw)
    });
  };

  const applyCodeToEditor = (newSnippet, mode) => {
    setPrevCodeBeforeAi(code);
    if (mode === 'selection') {
      const start = (smartApplyModal && typeof smartApplyModal.selStart === 'number')
        ? smartApplyModal.selStart
        : (textareaRef.current ? textareaRef.current.selectionStart : (selectionRef.current?.start || 0));
      const end = (smartApplyModal && typeof smartApplyModal.selEnd === 'number')
        ? smartApplyModal.selEnd
        : (textareaRef.current ? textareaRef.current.selectionEnd : (selectionRef.current?.end || start));
      const aligned = alignSnippetForInsert(code, start, end, newSnippet);
      setCode(aligned.nextCode);
      selectionRef.current = { start: aligned.newCursorPos, end: aligned.newCursorPos };
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(aligned.newCursorPos, aligned.newCursorPos);
        }
      }, 20);
      setStatusMsg(`✨ Inserted at Line ${aligned.lineNum} (Auto-Indent: ${aligned.indentCols}sp — Ctrl+S to save)`);
      setStatusType('success');
    } else {
      setCode(newSnippet);
      setStatusMsg('✨ AI code applied to full file (Ctrl+S to save, or Undo AI)');
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

  // Build Pinned Initialization Messages (Role + Formatting Template + Current pilot.py)
  const buildOllamaInitMessages = (srcCode) => {
    const targetPath = scenarioName ? `${scenarioName}/${fileName}` : fileName;
    const systemMsg = {
      role: 'system',
      content: [
        'You are an expert Space Guidance & Control (GNC) and Python autopilot assistant for SpaceGuidance-FBB.',
        'Conversation rules:',
        '1. Always respond concisely in the same language as the user (English or Japanese).',
        '2. For casual greetings (e.g., "Hello", "こんにちは") or general questions, reply naturally and briefly WITHOUT dumping unsolicited code reviews or improvements.',
        '3. Reference the initialized pilot.py script and any attached telemetry only when relevant to the user\'s question.',
        '4. Whenever you propose modified Python code, output it inside a clean ```python ... ``` fenced code block so the user can apply it with one click.'
      ].join('\n')
    };

    const initUserMsg = {
      role: 'user',
      content: [
        `[SESSION INITIALIZATION — ${targetPath}]`,
        `Here is the current \`${fileName}\` script for this session. Read and retain it as our active reference context:`,
        '```python',
        srcCode,
        '```',
        'Reply in 1–2 brief sentences confirming you have understood this pilot.py script and are ready to help. Do NOT propose changes yet.'
      ].join('\n')
    };

    return { systemMsg, initUserMsg };
  };

  // Shared NDJSON Streaming Reader for /api/ai/chat
  const streamOllamaToMessage = async (model, apiMessages, assistantId) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
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
      return content;
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
          if (chunk.error) throw new Error(chunk.error);
          const delta = chunk.message?.content || '';
          if (delta) {
            accContent += delta;
            setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accContent } : m));
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
        }
      }
    }

    if (!accContent.trim()) {
      accContent = '(Empty response)';
      setChatMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accContent } : m));
    }
    return accContent;
  };

  // One-Time Initialization / Manual Refresh of Role + Template + pilot.py
  const initializeOllamaSession = async (targetModel, isManualRefresh = false) => {
    if (!targetModel || !code || initInFlightRef.current || aiStreaming) return;
    initInFlightRef.current = true;
    setAiInitializing(true);
    setAiStreaming(true);

    const { systemMsg, initUserMsg } = buildOllamaInitMessages(code);
    const lineCnt = (code.match(/\n/g) || []).length + 1;
    const noticeId = `sys_${Date.now()}`;
    const assistantId = `init_${Date.now() + 1}`;
    const noticeObj = {
      id: noticeId,
      role: 'system-notice',
      content: isManualRefresh
        ? `🔄 Context Refreshed — Re-sent Role, Template & ${fileName} (${lineCnt} lines) to ${targetModel}`
        : `🚀 Initializing ${targetModel} with Role, Template & ${fileName} (${lineCnt} lines)...`,
      timestamp: new Date().toLocaleTimeString()
    };
    const assistantObj = {
      id: assistantId,
      role: 'assistant',
      content: '',
      model: targetModel,
      timestamp: new Date().toLocaleTimeString()
    };

    const nextAnchorIdx = chatMessages.length + 2;
    setChatMessages(prev => [...prev, noticeObj, assistantObj]);

    try {
      const ackContent = await streamOllamaToMessage(targetModel, [systemMsg, initUserMsg], assistantId);
      const cleanedAck = (ackContent || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || 'Understood pilot.py and ready to help.';
      setOllamaSession({
        model: targetModel,
        scenario: scenarioName,
        fileName,
        initializedCode: code,
        systemMsg,
        initUserMsg,
        initAssistantMsg: { role: 'assistant', content: cleanedAck },
        turnAnchorIdx: nextAnchorIdx
      });
      setStatusMsg(`✓ ${targetModel} initialized with ${fileName}`);
      setStatusType('success');
    } catch (e) {
      if (e.name === 'AbortError') {
        setChatMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: (m.content ? m.content + '\n\n' : '') + '⏹ *(Initialization cancelled — click 🔄 Sync Context to retry)*' } : m
        ));
      } else {
        setChatMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `⚠️ Initialization error: ${e.message}\n\nClick [🔄 Sync Context] to retry, or use [↗ Gemini] / [↗ ChatGPT] above.` } : m
        ));
      }
    } finally {
      abortControllerRef.current = null;
      initInFlightRef.current = false;
      setAiInitializing(false);
      setAiStreaming(false);
    }
  };

  // Auto-initialize once when Ollama split panel is opened or model/scenario changes
  useEffect(() => {
    const isOllamaSplitVisible = aiBarOpen && aiProvider === 'ollama' && ollamaStatus.available;
    if (!isOllamaSplitVisible || loading || !code || !ollamaModel || aiStreaming || initInFlightRef.current) return;
    const needsInit =
      ollamaSession.model !== ollamaModel ||
      ollamaSession.fileName !== fileName ||
      ollamaSession.scenario !== scenarioName ||
      !ollamaSession.initAssistantMsg;
    if (needsInit) {
      initializeOllamaSession(ollamaModel, false);
    }
  }, [aiBarOpen, aiProvider, ollamaStatus.available, loading, ollamaModel, fileName, scenarioName, Boolean(code)]);

  // Local Ollama Streaming Chat Handler (Sends ONLY prompt + optional Telemetry after init!)
  const handleSendOllamaChat = async (overridePrompt = null, overrideIntent = null) => {
    if (aiStreaming || !ollamaStatus.available || !ollamaModel) return;
    const userText = (overridePrompt !== null ? overridePrompt : chatInput).trim();
    if (!userText && !overrideIntent) return;

    const displayUserMsg = userText || (
      overrideIntent === 'tune' ? '🔧 Suggest gain & control tuning improvements based on current pilot.py and telemetry.' :
      overrideIntent === 'fix' ? '🐛 Diagnose errors or instability in pilot.py and propose a safe fix.' :
      '📖 Explain how the current pilot.py control logic works and key areas to improve.'
    );

    // Build ONLY the lightweight per-turn payload (NEVER re-sends full pilot.py on every turn!)
    const turnParts = [displayUserMsg];
    if (aiIncludeTelemetry) {
      if (syntaxError) {
        const errLineStr = syntaxError.line ? `Line ${syntaxError.line}` : 'Unknown line';
        turnParts.push(`⚠️ Current Syntax Error (${errLineStr}): \`${syntaxError.message}\``);
      }
      if (telemetryRef.current) {
        const tlmSummary = formatTelemetrySummary(telemetryRef.current);
        if (tlmSummary) turnParts.push(tlmSummary);
      }
      const { start, end } = selectionRef.current || { start: 0, end: 0 };
      if (end > start && end <= code.length) {
        const selectedSnippet = code.slice(start, end);
        if (selectedSnippet.trim() && selectedSnippet.length < code.length) {
          const startLine = (code.slice(0, start).match(/\n/g) || []).length + 1;
          const endLine = (code.slice(0, end).match(/\n/g) || []).length + 1;
          turnParts.push(`Selected Code Focus (Lines ${startLine}-${endLine}):\n\`\`\`python\n${selectedSnippet}\n\`\`\``);
        }
      }
    }
    if (aiIncludeTrace && traceHistoryRef.current.length > 0) {
      const traceBlock = formatTraceContext(
        traceHistoryRef.current,
        resolveSelectedTraceSignalIds(),
        aiTraceWindow,
        timeTravelIdxRef.current,
        manifestRegsRef.current
      );
      if (traceBlock) turnParts.push(traceBlock);
    }
    const userApiContent = turnParts.join('\n\n');

    const userMsgObj = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: displayUserMsg,
      apiContent: userApiContent,
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

    // Assemble pinned KV-cache prefix + recent follow-up turns + current user message
    const hasPinnedSession = Boolean(ollamaSession.systemMsg && ollamaSession.initUserMsg && ollamaSession.initAssistantMsg && ollamaSession.model === ollamaModel);
    const fallbackInit = hasPinnedSession ? null : buildOllamaInitMessages(code);

    const anchorIdx = hasPinnedSession ? (ollamaSession.turnAnchorIdx || 0) : 0;
    const liveTurns = nextHistory
      .slice(anchorIdx, -1)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map(m => ({
        role: m.role,
        content: m.apiContent || (m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      }));

    const apiMessages = hasPinnedSession
      ? [
          ollamaSession.systemMsg,
          ollamaSession.initUserMsg,
          ollamaSession.initAssistantMsg,
          ...liveTurns,
          { role: 'user', content: userApiContent }
        ]
      : [
          fallbackInit.systemMsg,
          fallbackInit.initUserMsg,
          { role: 'assistant', content: 'Understood pilot.py and ready to help.' },
          ...liveTurns,
          { role: 'user', content: userApiContent }
        ];

    try {
      await streamOllamaToMessage(ollamaModel, apiMessages, assistantId);
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
      if (tracePickerModal) { e.preventDefault(); setTracePickerModal(false); return; }
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
  const smartApplyAligned = useMemo(() => {
    if (!smartApplyModal || !activeApplyBlock) return null;
    const start = typeof smartApplyModal.selStart === 'number' ? smartApplyModal.selStart : (selectionRef.current?.start || 0);
    const end = typeof smartApplyModal.selEnd === 'number' ? smartApplyModal.selEnd : (selectionRef.current?.end || start);
    return alignSnippetForInsert(code, start, end, activeApplyBlock.code);
  }, [code, activeApplyBlock?.code, smartApplyModal?.selStart, smartApplyModal?.selEnd]);

  const smartApplyDiff = useMemo(() => {
    if (!activeApplyBlock) return null;
    const targetNext = (smartApplyModal?.previewMode === 'selection' && smartApplyAligned)
      ? smartApplyAligned.nextCode
      : activeApplyBlock.code;
    return computeLineDiff(code, targetNext);
  }, [code, activeApplyBlock?.code, smartApplyModal?.previewMode, smartApplyAligned?.nextCode]);

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

        // Selective Hardware Trace Attachment Toggle + Signal Picker Trigger
        React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: '4px' }
        },
          React.createElement('label', {
            title: 'Attach decoded hardware register Trace time-series + role legend to the AI prompt',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              color: aiIncludeTrace ? '#4ade80' : '#64748b',
              cursor: 'pointer',
              userSelect: 'none'
            }
          },
            React.createElement('input', {
              type: 'checkbox',
              checked: aiIncludeTrace,
              onChange: (e) => {
                const next = e.target.checked;
                setAiIncludeTrace(next);
                if (next && traceHistoryRef.current.length === 0) refreshTraceFromServer();
              },
              style: { margin: 0, cursor: 'pointer', accentColor: '#4ade80' }
            }),
            `📈 Attach Trace (${aiTraceSelectedSignals.length})`
          ),
          React.createElement('button', {
            onClick: handleOpenTracePicker,
            title: 'Select which hardware signals and time window to attach for AI analysis',
            style: {
              background: aiIncludeTrace ? '#064e3b' : '#1e293b',
              color: aiIncludeTrace ? '#86efac' : '#94a3b8',
              border: aiIncludeTrace ? '1px solid #10b981' : '1px solid #334155',
              borderRadius: '4px',
              padding: '2px 6px',
              fontSize: '10px',
              cursor: 'pointer'
            }
          }, '⚙ Select')
        ),

        // Web AI Primary Action Buttons (when Gemini or ChatGPT selected)
        aiProvider !== 'ollama' && React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: '4px' }
        },
          React.createElement('button', {
            onClick: (e) => handleLaunchWebAi(aiProvider, { forceNew: e.shiftKey }),
            title: webAiOpenMap[aiProvider]
              ? `Copy updated prompt to clipboard without reloading your ${aiProvider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} window (Shift+Click to open a new window)`
              : `Copy code + telemetry prompt and open ${aiProvider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} in the right half of the current monitor`,
            style: {
              background: webAiOpenMap[aiProvider]
                ? (aiProvider === 'chatgpt' ? '#047857' : '#1d4ed8')
                : (aiProvider === 'chatgpt' ? '#059669' : '#2563eb'),
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
          }, webAiOpenMap[aiProvider]
            ? (aiProvider === 'chatgpt' ? '📋 Copy Follow-up (ChatGPT)' : '📋 Copy Follow-up (Gemini)')
            : (aiProvider === 'chatgpt' ? '↗ Copy & Open ChatGPT' : '↗ Copy & Open Gemini')),
          !webAiOpenMap[aiProvider] && React.createElement('button', {
            onClick: () => handleLaunchWebAi(aiProvider, { copyOnly: true }),
            title: `Copy prompt only (use this if you already have ${aiProvider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} open in another window/tab)`,
            style: {
              background: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #475569',
              borderRadius: '4px',
              padding: '4px 7px',
              fontSize: '10px',
              cursor: 'pointer'
            }
          }, '📋 Copy Only'),
          webAiOpenMap[aiProvider] && React.createElement('button', {
            onClick: () => handleLaunchWebAi(aiProvider, { forceNew: true }),
            title: `Open a fresh ${aiProvider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} chat window`,
            style: {
              background: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #475569',
              borderRadius: '4px',
              padding: '4px 7px',
              fontSize: '10px',
              cursor: 'pointer'
            }
          }, '↗ New Window')
        ),

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

          // Refresh / Re-sync Role + Template + latest pilot.py to Ollama
          React.createElement('button', {
            onClick: () => initializeOllamaSession(ollamaModel, true),
            disabled: aiStreaming || !code,
            title: (ollamaSession.model === ollamaModel && ollamaSession.initializedCode && ollamaSession.initializedCode !== code)
              ? 'pilot.py has been modified since last sync — Click to re-send Role, Template & latest pilot.py'
              : 'Re-send Role, Template & latest pilot.py to refresh AI short-term memory',
            style: {
              background: (ollamaSession.model === ollamaModel && ollamaSession.initializedCode && ollamaSession.initializedCode !== code)
                ? '#78350f'
                : '#1e293b',
              color: (ollamaSession.model === ollamaModel && ollamaSession.initializedCode && ollamaSession.initializedCode !== code)
                ? '#fde047'
                : '#cbd5e1',
              border: (ollamaSession.model === ollamaModel && ollamaSession.initializedCode && ollamaSession.initializedCode !== code)
                ? '1px solid #f59e0b'
                : '1px solid #334155',
              borderRadius: '4px',
              padding: '2px 7px',
              fontSize: '10px',
              fontWeight: 'bold',
              cursor: (aiStreaming || !code) ? 'default' : 'pointer'
            }
          }, aiInitializing
            ? '⏳ Syncing...'
            : ((ollamaSession.model === ollamaModel && ollamaSession.initializedCode && ollamaSession.initializedCode !== code)
                ? '🔄 Sync*'
                : '🔄 Sync Context')),

          // Escalate to Browser Web AI buttons
          React.createElement('button', {
            onClick: () => handleLaunchWebAi('gemini', { intent: 'custom', customNote: chatInput, priorHistory: chatMessages.filter(m => m.role === 'user' || m.role === 'assistant') }),
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
            onClick: () => handleLaunchWebAi('chatgpt', { intent: 'custom', customNote: chatInput, priorHistory: chatMessages.filter(m => m.role === 'user' || m.role === 'assistant') }),
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
            onClick: () => {
              setChatMessages([]);
              setOllamaSession(prev => ({ ...prev, turnAnchorIdx: 0 }));
            },
            disabled: aiStreaming || chatMessages.length === 0,
            title: 'Clear chat log (retains initialized pilot.py context)',
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
              ollamaSession.model === ollamaModel && ollamaSession.initAssistantMsg
                ? `✓ ${ollamaModel} Ready (${fileName} loaded)`
                : `🦙 ${ollamaModel} — Initializing session...`
            ),
            React.createElement('div', null,
              'Type any question below. When [Attach TLM] is unchecked, only your plain message is sent. Use [🔄 Sync Context] anytime to re-send Role, Template & updated pilot.py.'
            )
          ),

          chatMessages.map((msg) => {
            if (msg.role === 'system-notice') {
              return React.createElement('div', {
                key: msg.id,
                style: {
                  alignSelf: 'center',
                  fontSize: '10px',
                  color: '#94a3b8',
                  background: '#0f172a',
                  border: '1px solid #1e293b',
                  borderRadius: '12px',
                  padding: '3px 10px',
                  textAlign: 'center'
                }
              }, `${msg.content} (${msg.timestamp || ''})`);
            }
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

        // Quick Action Strip (always accessible above chat input)
        React.createElement('div', {
          style: {
            display: 'flex',
            gap: '5px',
            padding: '5px 8px 0 8px',
            background: '#0f172a',
            borderTop: '1px solid #1e293b',
            flexWrap: 'wrap',
            flexShrink: 0
          }
        },
          [
            { id: 'tune', label: '🔧 Tune Gains', bg: '#1e1b4b', fg: '#c4b5fd', bd: '#4c1d95' },
            { id: 'fix', label: '🐛 Fix Bug', bg: '#3f1d2b', fg: '#fda4af', bd: '#881337' },
            { id: 'explain', label: '📖 Explain', bg: '#0c4a6e', fg: '#bae6fd', bd: '#0284c7' }
          ].map(q => React.createElement('button', {
            key: q.id,
            disabled: aiStreaming,
            onClick: () => handleSendOllamaChat('', q.id),
            style: {
              background: q.bg,
              color: aiStreaming ? '#64748b' : q.fg,
              border: `1px solid ${q.bd}`,
              borderRadius: '10px',
              padding: '2px 8px',
              fontSize: '10px',
              cursor: aiStreaming ? 'default' : 'pointer',
              opacity: aiStreaming ? 0.55 : 1
            }
          }, q.label))
        ),

        // Ollama Chat Input Bar
        React.createElement('div', {
          style: {
            display: 'flex',
            gap: '6px',
            padding: '6px 8px 8px 8px',
            background: '#0f172a',
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
            onChange: (e) => setSmartApplyModal(prev => ({ ...prev, rawText: e.target.value, selectedBlockIdx: 0 })),
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
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
                color: '#cbd5e1'
              }
            },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                React.createElement('span', null, `Preview (${activeApplyBlock.lang} / ${activeApplyBlock.lines} lines):`),
                React.createElement('button', {
                  onClick: () => setSmartApplyModal(prev => ({ ...prev, previewMode: 'selection' })),
                  style: {
                    background: smartApplyModal.previewMode === 'selection' ? '#1e3a8a' : '#0f172a',
                    color: smartApplyModal.previewMode === 'selection' ? '#bfdbfe' : '#94a3b8',
                    border: smartApplyModal.previewMode === 'selection' ? '1px solid #3b82f6' : '1px solid #334155',
                    borderRadius: '4px',
                    padding: '1px 7px',
                    fontSize: '10px',
                    cursor: 'pointer'
                  }
                }, smartApplyAligned ? `📌 Insert L${smartApplyAligned.lineNum} (Indent ${smartApplyAligned.indentCols}sp)` : '📌 Selection Insert'),
                React.createElement('button', {
                  onClick: () => setSmartApplyModal(prev => ({ ...prev, previewMode: 'full' })),
                  style: {
                    background: smartApplyModal.previewMode !== 'selection' ? '#0284c7' : '#0f172a',
                    color: smartApplyModal.previewMode !== 'selection' ? '#ffffff' : '#94a3b8',
                    border: smartApplyModal.previewMode !== 'selection' ? '1px solid #38bdf8' : '1px solid #334155',
                    borderRadius: '4px',
                    padding: '1px 7px',
                    fontSize: '10px',
                    cursor: 'pointer'
                  }
                }, '✨ Full File')
              ),
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
          }, smartApplyAligned ? `📌 Insert at L${smartApplyAligned.lineNum} (Auto-Indent: ${smartApplyAligned.indentCols}sp)` : '📌 Insert / Replace Selection'),
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
              target: manualPromptModal.targetName || 'sg_ai_copilot',
              rel: 'noopener noreferrer',
              onClick: (e) => {
                const live = getFocusHandleIfAllowed(manualPromptModal.prov);
                if (live) {
                  e.preventDefault();
                  try { if (typeof live.focus === 'function') live.focus(); } catch (err) {}
                } else if (manualPromptModal.prov) {
                  aiSessionStore.webAiSessionStarted[manualPromptModal.prov] = true;
                  syncWebAiSessionState();
                }
                setManualPromptModal(null);
              },
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
            }, getFocusHandleIfAllowed(manualPromptModal.prov) ? `↗ Focus ${manualPromptModal.providerLabel}` : `↗ Open ${manualPromptModal.providerLabel}`)
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
    ),

    // =========================================================================
    // Inline Modal 4: Selective Hardware Trace Picker & Preview (Portal-safe)
    // =========================================================================
    tracePickerModal && (() => {
      const availableSignals = discoverTraceSignals(traceHistoryRef.current, manifestRegsRef.current);
      const grouped = {};
      availableSignals.forEach(s => {
        if (!grouped[s.group]) grouped[s.group] = [];
        grouped[s.group].push(s);
      });
      const previewText = formatTraceContext(
        traceHistoryRef.current,
        resolveSelectedTraceSignalIds(),
        aiTraceWindow,
        timeTravelIdxRef.current,
        manifestRegsRef.current
      );
      return React.createElement('div', {
        style: {
          position: 'absolute',
          inset: 0,
          background: 'rgba(2, 6, 23, 0.84)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 58,
          padding: '16px'
        }
      },
        React.createElement('div', {
          style: {
            width: '100%',
            maxWidth: '760px',
            maxHeight: '90%',
            background: '#0f172a',
            border: '1px solid #10b981',
            borderRadius: '8px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.78)'
          }
        },
          // Header
          React.createElement('div', {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              background: '#064e3b',
              borderBottom: '1px solid #047857'
            }
          },
            React.createElement('span', { style: { fontWeight: 'bold', color: '#a7f3d0', fontSize: '12px' } },
              `📈 Trace Signal Selector (${traceHistoryRef.current.length} frames buffered | Decoded Q16.16 & IEEE-754 f64)`
            ),
            React.createElement('button', {
              onClick: () => setTracePickerModal(false),
              style: { background: 'transparent', border: 'none', color: '#a7f3d0', cursor: 'pointer', fontSize: '14px' }
            }, '✕')
          ),

          // Body
          React.createElement('div', {
            style: { padding: '12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }
          },
            // Presets + Time Window Row
            React.createElement('div', {
              style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }
            },
              React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
                React.createElement('span', { style: { fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' } }, 'Presets:'),
                Object.entries(TRACE_PRESETS).map(([pKey, pDef]) => React.createElement('button', {
                  key: pKey,
                  onClick: () => handleApplyTracePreset(pKey),
                  style: {
                    background: aiTracePreset === pKey ? '#059669' : '#1e293b',
                    color: aiTracePreset === pKey ? '#ffffff' : '#cbd5e1',
                    border: aiTracePreset === pKey ? '1px solid #34d399' : '1px solid #334155',
                    borderRadius: '12px',
                    padding: '2px 9px',
                    fontSize: '10px',
                    cursor: 'pointer'
                  }
                }, pDef.label)),
                React.createElement('button', {
                  onClick: () => handleApplyTracePreset('tracer'),
                  title: 'Use whichever signals are currently visible in Register State Tracer',
                  style: {
                    background: aiTracePreset === 'tracer' ? '#0284c7' : '#1e293b',
                    color: aiTracePreset === 'tracer' ? '#ffffff' : '#cbd5e1',
                    border: aiTracePreset === 'tracer' ? '1px solid #38bdf8' : '1px solid #334155',
                    borderRadius: '12px',
                    padding: '2px 9px',
                    fontSize: '10px',
                    cursor: 'pointer'
                  }
                }, '📊 Sync with Tracer')
              ),

              React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                React.createElement('span', { style: { fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' } }, 'Window:'),
                React.createElement('select', {
                  value: aiTraceWindow,
                  onChange: (e) => setAiTraceWindow(e.target.value),
                  style: {
                    background: '#1e293b',
                    color: '#f8fafc',
                    border: '1px solid #334155',
                    borderRadius: '4px',
                    padding: '3px 7px',
                    fontSize: '11px',
                    outline: 'none'
                  }
                },
                  React.createElement('option', { value: 'full_30', style: { background: '#1e293b', color: '#f8fafc' } }, 'Full Run (~30 pts + Peak Error)'),
                  React.createElement('option', { value: 'last_30', style: { background: '#1e293b', color: '#f8fafc' } }, 'Last 30 Frames'),
                  React.createElement('option', { value: 'time_travel', style: { background: '#1e293b', color: '#f8fafc' } },
                    typeof timeTravelIdxRef.current === 'number'
                      ? `Around Time-Travel (#${timeTravelIdxRef.current} ±15)`
                      : 'Around Time-Travel (±15, fallback Last 30)'
                  )
                )
              )
            ),

            // Signal Checkbox Groups
            availableSignals.length === 0
              ? React.createElement('div', {
                  style: { padding: '14px', background: '#060911', border: '1px dashed #334155', borderRadius: '6px', color: '#94a3b8', fontSize: '11px' }
                }, 'No trace frames recorded yet. Run the scenario to populate Register Trace history, then click Refresh.')
              : React.createElement('div', {
                  style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px' }
                },
                  Object.entries(grouped).map(([grpName, sigs]) => React.createElement('div', {
                    key: grpName,
                    style: {
                      background: '#060911',
                      border: '1px solid #1e293b',
                      borderRadius: '6px',
                      padding: '8px'
                    }
                  },
                    React.createElement('div', {
                      style: { fontSize: '10px', fontWeight: 'bold', color: '#38bdf8', marginBottom: '6px', textTransform: 'uppercase' }
                    }, grpName),
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                      sigs.map(s => {
                        const checked = aiTraceSelectedSignals.includes(s.id);
                        return React.createElement('label', {
                          key: s.id,
                          title: `${s.role}${s.offset ? ` (${s.offset}, ${s.enc})` : ''}`,
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            fontSize: '11px',
                            color: checked ? '#f8fafc' : '#94a3b8',
                            cursor: 'pointer'
                          }
                        },
                          React.createElement('input', {
                            type: 'checkbox',
                            checked,
                            onChange: () => handleToggleTraceSignal(s.id),
                            style: { margin: 0, cursor: 'pointer', accentColor: '#10b981' }
                          }),
                          React.createElement('span', { style: { fontWeight: checked ? 'bold' : 'normal' } }, s.id),
                          s.unit && React.createElement('span', { style: { fontSize: '9px', color: '#64748b' } }, `[${s.unit}]`)
                        );
                      })
                    )
                  ))
                ),

            // Live Decoded Preview (verifies AI-readable Legend + Stats + CSV)
            previewText && React.createElement('details', {
              style: { background: '#060911', border: '1px solid #1e293b', borderRadius: '6px', padding: '6px 10px' }
            },
              React.createElement('summary', { style: { cursor: 'pointer', fontSize: '11px', color: '#86efac' } },
                `🔍 Preview AI Trace Payload (${previewText.length} chars, ~${Math.ceil(previewText.length / 4)} tokens)`
              ),
              React.createElement('pre', {
                style: { margin: '6px 0 0 0', fontSize: '10px', color: '#cbd5e1', maxHeight: '180px', overflow: 'auto', whiteSpace: 'pre-wrap' }
              }, previewText)
            )
          ),

          // Footer
          React.createElement('div', {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              background: '#1e293b',
              borderTop: '1px solid #334155',
              gap: '8px'
            }
          },
            React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              React.createElement('button', {
                onClick: handleOpenTracePicker,
                style: { background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', padding: '4px 10px', fontSize: '11px', cursor: 'pointer' }
              }, '↻ Refresh Trace'),
              React.createElement('span', { style: { fontSize: '11px', color: '#94a3b8' } },
                `Selected: ${aiTraceSelectedSignals.length} signals`
              )
            ),
            React.createElement('div', { style: { display: 'flex', gap: '8px' } },
              React.createElement('button', {
                onClick: () => setTracePickerModal(false),
                style: { background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', padding: '5px 12px', fontSize: '11px', cursor: 'pointer' }
              }, 'Close'),
              React.createElement('button', {
                onClick: () => {
                  setAiIncludeTrace(true);
                  setTracePickerModal(false);
                },
                disabled: aiTraceSelectedSignals.length === 0,
                style: {
                  background: aiTraceSelectedSignals.length > 0 ? '#059669' : '#1e293b',
                  color: aiTraceSelectedSignals.length > 0 ? '#ffffff' : '#64748b',
                  border: '1px solid #34d399',
                  borderRadius: '4px',
                  padding: '5px 14px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  cursor: aiTraceSelectedSignals.length > 0 ? 'pointer' : 'default'
                }
              }, '✓ Enable Attach Trace')
            )
          )
        )
      );
    })()
  );
}
