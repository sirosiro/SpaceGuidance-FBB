export const minApiVersion = 1;

export default function PilotCodeEditor() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef, useMemo } = window.FBB?.hooks || React;

  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const [fileName, setFileName] = useState('pilot.py');
  const [scenarioName, setScenarioName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('info'); // info, success, error
  const [tuneZones, setTuneZones] = useState([]);
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

  const textareaRef = useRef(null);
  const preRef = useRef(null);
  const gutterRef = useRef(null);
  const searchInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const jumpLineInputRef = useRef(null);

  // Discover tune zones in code (e.g. "# === TUNE ZONE 1: ... ===", "# 🎯 TUNE ZONE 1: ...")
  const parseTuneZones = (src) => {
    const lines = src.split('\n');
    const zones = [];
    const re = /(?:===|🎯|⚡|\b)\s*(TUNE ZONE[^\n=]*)/i;
    lines.forEach((line, idx) => {
      if (line.trim().startsWith('#   ') || /#\s*\d+\.\s*TUNE/i.test(line)) return;
      const m = line.match(re);
      if (m) {
        let label = m[1].replace(/===/g, '').trim();
        if (label.length > 36) label = label.substring(0, 34) + '...';
        zones.push({
          line: idx,
          label: label
        });
      }
    });
    setTuneZones(zones);
  };

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
        parseTuneZones(data.content || '');
        setSyntaxError(null);
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

  // Scroll and highlight active match in textarea
  const jumpToMatch = (m, shouldFocus = false) => {
    if (!m || !textareaRef.current) return;
    const ta = textareaRef.current;
    if (shouldFocus) {
      ta.focus({ preventScroll: true });
    }
    ta.setSelectionRange(m.index, m.index + m.length);
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

  // Handle Search Input Change
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

  // Handle Match Case Toggle
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

  // Replace single occurrence
  const handleReplace = () => {
    if (matches.length === 0 || currentMatchIdx >= matches.length) return;
    const m = matches[currentMatchIdx];
    const nextCode = code.substring(0, m.index) + replaceQuery + code.substring(m.index + m.length);
    setCode(nextCode);
    setStatusMsg('Replaced 1 match');
    setStatusType('info');
  };

  // Replace all occurrences
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

  // Open search / replace UI with text pre-selection
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

  // Close / dismiss search & replace, collapse selection range to prevent accidental overwrites
  const closeSearch = () => {
    setSearchOpen(false);
    setReplaceOpen(false);
    setSearchQuery(''); // Clears search query so matches is empty and highlights disappear
    setCurrentMatchIdx(0);
    const ta = textareaRef.current;
    if (ta) {
      // Collapse selection range to a single cursor point at current position
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
        parseTuneZones(code);
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

  // Revert pilot.py to factory default (pilot.default.py)
  const handleRevertOriginal = async () => {
    if (!window.confirm('Revert pilot.py to original factory code?\nAll current modifications will be replaced with baseline parameters.')) {
      return;
    }
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
          parseTuneZones(defaultContent);
          setSyntaxError(null);
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
    // Ctrl+S / Cmd+S: Save
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      handleSave();
      return;
    }

    // Ctrl+G / Cmd+G: Toggle Go to line / Jump drawer
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

    // Escape: Close search bar or jump bar
    if (e.key === 'Escape') {
      if (jumpOpen) {
        e.preventDefault();
        setJumpOpen(false);
        return;
      }
      if (searchOpen) {
        e.preventDefault();
        closeSearch();
        return;
      }
    }

    // Tab: 4 spaces indent
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
      }, 0);
    }
  };

  // Jump to Tune Zone
  const handleJumpToZone = (lineIdx) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const lines = code.split('\n');
    let charStart = 0;
    for (let i = 0; i < lineIdx && i < lines.length; i++) {
      charStart += lines[i].length + 1;
    }

    // 1. Focus with preventScroll, place cursor at line start without range selection (avoids overwrite)
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(charStart, charStart);

    // 2. Center target line in viewport
    const lineHeight = 20;
    const targetScroll = Math.max(0, lineIdx * lineHeight - 60);
    ta.scrollTop = targetScroll;

    // 3. Immediately synchronize pre and gutter
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

      // Strings (single and double quoted)
      safeCode = safeCode.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|".*?"|'.*?')/g, '<span style="color:#86efac;">$1</span>');

      // Keywords
      safeCode = safeCode.replace(keywordRegex, '<span style="color:#f472b6;font-weight:bold;">$1</span>');

      // Common telemetry symbols / hardware keywords
      safeCode = safeCode.replace(/\b(hw|math|time|np|sys|os|print|float|int|len|abs|range|SpaceGuidanceHardware|UartTee)\b/g, '<span style="color:#38bdf8;">$1</span>');

      // Numbers
      safeCode = safeCode.replace(numRegex, '<span style="color:#fde047;">$1</span>');

      // Comment
      const safeComment = commentPart ? `<span style="color:#64748b;font-style:italic;">${escapeHtml(commentPart)}</span>` : '';

      let fullLine = safeCode + safeComment;

      // Apply search query highlight if active
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

  const isDirty = code !== savedCode;
  const lineCount = (code.match(/\n/g) || []).length + 1;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);
  const displayTitle = scenarioName ? `${scenarioName}/${fileName}` : fileName;

  return React.createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#090d16',
      color: '#e2e8f0',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: '12px',
      overflow: 'hidden'
    }
  },
    // Scoped CSS styles for selection and search input
    React.createElement('style', null, `
      .fbb-pilot-textarea::selection {
        background: rgba(56, 189, 248, 0.45) !important;
        color: transparent !important;
      }
      .fbb-find-input:focus {
        border-color: #38bdf8 !important;
        box-shadow: 0 0 0 1px #38bdf8 !important;
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
        flexShrink: 0
      }
    },
      // Left: File Identity & Dirty Badge
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
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
            marginLeft: '6px',
            cursor: (syntaxError && syntaxError.line) ? 'pointer' : 'default',
            textDecoration: (syntaxError && syntaxError.line) ? 'underline' : 'none'
          }
        }, statusMsg)
      ),

      // Right: Find & Replace Buttons, Tune Zone Jump, Reset & Save Buttons
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
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

        // Jump Menu Toggle Button (Opens expanded bottom drawer)
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
          title: 'Jump to Tune Zone or Line Number (Ctrl+G)',
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

        // Reset Button
        React.createElement('button', {
          onClick: () => {
            if (isDirty && !window.confirm('Discard unsaved changes and reload from disk?')) return;
            loadFile(fileName);
          },
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
      // Left: Tune Zone Selector (takes full horizontal width)
      tuneZones.length > 0 && React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '220px' }
      },
        React.createElement('span', {
          style: { fontSize: '11px', color: '#38bdf8', whiteSpace: 'nowrap', fontWeight: 'bold' }
        }, '🎯 Tune Zone:'),
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
          React.createElement('option', { value: '', disabled: true }, '-- Select Tune Zone to Jump --'),
          tuneZones.map((z, i) => React.createElement('option', { key: i, value: z.line }, `Line ${z.line + 1}: ${z.label}`))
        )
      ),

      // Right: Go to Line Number Input
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

      // Close Jump Bar Button [✕]
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
      // Row 1: Search input + Controls
      React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px' }
      },
        // Replace expand/collapse toggle arrow
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

        // Search input
        React.createElement('input', {
          ref: searchInputRef,
          className: 'fbb-find-input',
          type: 'text',
          value: searchQuery,
          onChange: (e) => handleSearchChange(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
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

        // Match count indicator
        React.createElement('span', {
          style: {
            fontSize: '11px',
            color: searchQuery ? (matches.length > 0 ? '#94a3b8' : '#f87171') : '#64748b',
            minWidth: '65px'
          }
        }, searchQuery ? (matches.length > 0 ? `${currentMatchIdx + 1} of ${matches.length}` : 'No matches') : ''),

        // Match Case Toggle [Aa]
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

        // Prev Match [▲]
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

        // Next Match [▼]
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

        // Close Search [✕]
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

      // Row 2: Replace input + Action buttons
      replaceOpen && React.createElement('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '18px' }
      },
        React.createElement('input', {
          ref: replaceInputRef,
          className: 'fbb-find-input',
          type: 'text',
          value: replaceQuery,
          onChange: (e) => setReplaceQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') {
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

    // Main Code Editor Workspace
    React.createElement('div', {
      style: {
        display: 'flex',
        flex: 1,
        position: 'relative',
        background: '#060911',
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

      // (2) Code Area Wrapper (Stacking Container)
      React.createElement('div', {
        style: {
          position: 'relative',
          flex: 1,
          height: '100%',
          overflow: 'hidden'
        }
      },
        // (2a) Syntax Highlighted Background (<pre>)
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

        // (2b) Interactive Editable Overlay (<textarea>)
        React.createElement('textarea', {
          ref: textareaRef,
          className: 'fbb-pilot-textarea',
          value: code,
          onChange: (e) => setCode(e.target.value),
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

    // Bottom Quick-Help Status Bar
    React.createElement('div', {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        padding: '4px 12px',
        background: '#090d16',
        borderTop: '1px solid #1e293b',
        fontSize: '10px',
        color: '#64748b'
      }
    },
      React.createElement('span', null, `💡 Target: ${displayTitle} | Save: [Ctrl+S] | Re-flight: [Restart Scenario]`),
      React.createElement('span', null, `Lines: ${lineCount} | UTF-8 | Python 3`)
    )
  );
}
