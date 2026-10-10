export const minApiVersion = 1;

export default function ChaosFdirConsole() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect } = window.FBB?.hooks || React;

  const [status, setStatus] = useState({
    fdir_mode: 0,
    cross_track_err: 0.0,
    pos_x: 0.0,
    fuel: 100.0
  });

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('/api/file?path=/tmp/space_guidance_telemetry.json');
        if (res.ok) {
          const j = await res.json();
          setStatus(prev => ({ ...prev, ...j }));
        }
      } catch (e) {}
    }, 60);
    return () => clearInterval(t);
  }, []);

  const modeBanners = [
    { text: 'NOMINAL: TRACKING', bg: '#065f46', fg: '#6ee7b7' },
    { text: 'LOS: DEAD RECKONING', bg: '#78350f', fg: '#fde68a' },
    { text: 'RECOVERY: STATION KEEPING', bg: '#075985', fg: '#7dd3fc' },
    { text: 'RESTORED: NOMINAL ALIGNED', bg: '#14532d', fg: '#86efac' }
  ];
  const currentBanner = modeBanners[status.fdir_mode] || modeBanners[0];

  return React.createElement('div', {
    style: {
      padding: '16px',
      background: '#090d16',
      color: '#e2e8f0',
      fontFamily: 'monospace',
      height: '100%',
      overflowY: 'auto'
    }
  },
    // FDIR Mode Banner
    React.createElement('div', {
      style: {
        padding: '10px 14px',
        borderRadius: '6px',
        background: currentBanner.bg,
        color: currentBanner.fg,
        fontWeight: 'bold',
        fontSize: '12px',
        textAlign: 'center',
        marginBottom: '16px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
      }
    }, `FLIGHT MODE: [ ${currentBanner.text} ]`),

    // Cross-Track Error Vector Gauge
    React.createElement('div', {
      style: {
        background: '#0f172a',
        padding: '12px',
        borderRadius: '6px',
        marginBottom: '14px',
        border: '1px solid #1e293b'
      }
    },
      React.createElement('div', { style: { fontSize: '11px', color: '#94a3b8' } }, 'CROSS-TRACK ERROR VECTOR (Δd)'),
      React.createElement('div', {
        style: {
          fontSize: '20px',
          fontWeight: 'bold',
          color: Math.abs(status.cross_track_err) < 0.1 ? '#22c55e' : '#f59e0b',
          margin: '4px 0'
        }
      }, `${status.cross_track_err.toFixed(3)} m`),
      React.createElement('div', {
        style: {
          width: '100%',
          height: '6px',
          background: '#1e293b',
          borderRadius: '3px',
          overflow: 'hidden'
        }
      },
        React.createElement('div', {
          style: {
            width: `${Math.min(100, Math.abs(status.cross_track_err) / 0.5 * 100)}%`,
            height: '100%',
            background: Math.abs(status.cross_track_err) < 0.1 ? '#22c55e' : '#ef4444'
          }
        })
      )
    ),

    // Hardware Protection Tally
    React.createElement('div', {
      style: {
        background: '#0f172a',
        padding: '12px',
        borderRadius: '6px',
        border: '1px solid #1e293b',
        fontSize: '11px',
        lineHeight: '1.8'
      }
    },
      React.createElement('div', { style: { fontWeight: 'bold', color: '#94a3b8', borderBottom: '1px solid #1e293b', paddingBottom: '4px' } }, 'HARDWARE DEFENSE TALLY'),
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        React.createElement('span', null, 'ECC DISCARDED:'),
        React.createElement('span', { style: { color: '#38bdf8' } }, '0 pkts')
      ),
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        React.createElement('span', null, 'WDG INTERLOCK:'),
        React.createElement('span', { style: { color: '#22c55e' } }, 'ACTIVE (ARMED)')
      )
    )
  );
}
