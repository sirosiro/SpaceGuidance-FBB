export const minApiVersion = 1;

export default function ChaosFdirConsole() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect } = window.FBB?.hooks || React;

  const [status, setStatus] = useState({
    fdir_mode: 0,
    cross_track_err: 0.0,
    pos_x: 0.0,
    fuel: 100.0,
    score: 0,
    checkpoint_score: 0,
    bonus_score: 0,
    passed_checkpoints: 0,
    total_checkpoints: 9,
    official_grade: 'IN_FLIGHT',
    last_event: ''
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

    // Official Referee Scorecard (SSOT)
    React.createElement('div', {
      style: {
        background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95))',
        border: '1px solid rgba(59, 130, 246, 0.4)',
        borderRadius: '8px',
        padding: '12px 16px',
        marginBottom: '16px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: 'monospace'
      }
    }, [
      React.createElement('div', { key: 'ref_left' }, [
        React.createElement('div', {
          style: { fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }
        }, 'Official Referee (SSOT)'),
        React.createElement('div', {
          style: { fontSize: '20px', fontWeight: 'bold', color: '#38bdf8' }
        }, `${(status.score || 0).toLocaleString()} PTS`),
        React.createElement('div', {
          style: { fontSize: '11px', color: '#cbd5e1', marginTop: '2px' }
        }, status.last_event || 'Monitoring...')
      ]),
      React.createElement('div', { key: 'ref_right', style: { textAlign: 'right' } }, [
        React.createElement('div', {
          style: {
            display: 'inline-block',
            padding: '3px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 'bold',
            background: status.official_grade && status.official_grade.includes('GRADE S') ? 'rgba(34, 197, 94, 0.2)' : 'rgba(59, 130, 246, 0.2)',
            color: status.official_grade && status.official_grade.includes('GRADE S') ? '#4ade80' : '#60a5fa',
            border: '1px solid currentColor'
          }
        }, status.official_grade || 'IN_FLIGHT'),
        React.createElement('div', {
          style: { fontSize: '11px', color: '#94a3b8', marginTop: '4px' }
        }, `Checkpoints: ${status.passed_checkpoints || 0} / ${status.total_checkpoints || 9}`)
      ])
    ]),

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
