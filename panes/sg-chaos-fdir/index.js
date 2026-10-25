export const minApiVersion = 1;

export default function ChaosFdirConsole() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect } = window.FBB?.hooks || React;

  const initialStage = (() => {
    try {
      const m = window.FBB?.useDashboard ? window.FBB.useDashboard().manifest : null;
      const sDir = (m?.scenario_dir || '').toLowerCase();
      if (sDir.includes('05_panic') || sDir.includes('panic_control')) return 5;
      if (sDir.includes('02_tether') || sDir.includes('tether_climber')) return 2;
      if (sDir.includes('03_iss') || sDir.includes('iss_truss')) return 3;
      if (sDir.includes('04_laser') || sDir.includes('laser_docking')) return 4;
    } catch (e) {}
    return 1;
  })();

  const [status, setStatus] = useState({
    fdir_mode: 0,
    cross_track_err: 0.0,
    pos_x: 0.0,
    fuel: 100.0,
    score: 0,
    checkpoint_score: 0,
    bonus_score: 0,
    passed_checkpoints: 0,
    total_checkpoints: initialStage === 5 ? 0 : 9,
    stage_id: initialStage,
    official_grade: 'IN_FLIGHT',
    last_event: ''
  });

  useEffect(() => {
    const handleTelemetry = (j) => {
      if (j && j.type && j.type !== 'space_guidance') return;
      setStatus(prev => ({ ...prev, ...j }));
    };

    let sock = window.FBB?.socket;
    if (!sock && window.FBB?.useDashboard) {
      try {
        sock = window.FBB.useDashboard().socket;
      } catch (e) {}
    }

    if (sock) {
      sock.on('scenario:telemetry', handleTelemetry);
      return () => sock.off('scenario:telemetry', handleTelemetry);
    } else {
      const t = setInterval(async () => {
        try {
          let res = await fetch('/api/file?path=/tmp/fbb_scenario_telemetry.json');
          if (!res.ok) res = await fetch('/api/file?path=/tmp/space_guidance_telemetry.json');
          if (res.ok) {
            const j = await res.json();
            handleTelemetry(j);
          }
        } catch (e) {}
      }, 100);
      return () => clearInterval(t);
    }
  }, []);

  const modeBanners = [
    { text: 'NOMINAL: TRACKING', bg: '#065f46', fg: '#6ee7b7' },
    { text: 'LOS: DEAD RECKONING', bg: '#78350f', fg: '#fde68a' },
    { text: 'RECOVERY: STATION KEEPING', bg: '#075985', fg: '#7dd3fc' },
    { text: 'RESTORED: NOMINAL ALIGNED', bg: '#14532d', fg: '#86efac' }
  ];
  const stage5Banners = [
    { text: 'CRASH TUMBLING: UNCONTROLLED (PASSIVE INERTIA)', bg: '#7f1d1d', fg: '#fca5a5' },
    { text: 'PHASE 1: ACTIVE DETUMBLE (REACTION WHEEL ONLINE)', bg: '#075985', fg: '#7dd3fc' },
    { text: 'PHASE 2: ONLINE SYSID (ISOLATING FAULTS)', bg: '#78350f', fg: '#fde68a' },
    { text: 'PHASE 3: ESCAPE BURN (SAFE GATE PASS)', bg: '#14532d', fg: '#86efac' }
  ];
  const isS5 = status.stage_id === 5;
  const currentBanner = isS5 ? (stage5Banners[status.fdir_mode] || stage5Banners[0]) : (modeBanners[status.fdir_mode] || modeBanners[0]);

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

    // Stage 5 Panic Control Specific Widget: Thruster Health Matrix & Tumbling Status
    status.stage_id === 5 && React.createElement('div', {
      style: {
        background: '#0f172a',
        padding: '12px',
        borderRadius: '6px',
        marginBottom: '14px',
        border: '1px solid #334155'
      }
    }, [
      // 3-Axis Tumbling Rates Header & Values
      React.createElement('div', {
        key: 'spin_hdr',
        style: { fontSize: '11px', color: '#94a3b8', display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }
      }, [
        React.createElement('span', null, '3-AXIS TUMBLING RATE (P, Q, R)'),
        React.createElement('span', {
          style: {
            color: (Math.abs(status.omega_x || 0) < 0.05 && Math.abs(status.omega_y || 0) < 0.05 && Math.abs(status.omega_z || status.omega || 0) < 0.05) ? '#22c55e' : '#ef4444',
            fontWeight: 'bold'
          }
        }, (Math.abs(status.omega_x || 0) < 0.05 && Math.abs(status.omega_y || 0) < 0.05 && Math.abs(status.omega_z || status.omega || 0) < 0.05) ? '3D DETUMBLED (STABLE)' : 'CRITICAL 3D TUMBLE')
      ]),
      React.createElement('div', {
        key: 'spin_val_grid',
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '6px',
          marginBottom: '10px'
        }
      }, [
        { label: 'ROLL (P)', val: status.omega_x || 0.0 },
        { label: 'PITCH (Q)', val: status.omega_y || 0.0 },
        { label: 'YAW (R)', val: (status.omega_z !== undefined ? status.omega_z : status.omega) || 0.0 }
      ].map((ax, i) => React.createElement('div', {
        key: `axis_${i}`,
        style: {
          background: 'rgba(15, 23, 42, 0.8)',
          padding: '6px',
          borderRadius: '4px',
          border: '1px solid #334155',
          textAlign: 'center'
        }
      }, [
        React.createElement('div', { key: 'l', style: { fontSize: '9px', color: '#94a3b8' } }, ax.label),
        React.createElement('div', {
          key: 'v',
          style: {
            fontSize: '13px',
            fontWeight: 'bold',
            color: Math.abs(ax.val) < 0.05 ? '#4ade80' : '#f87171'
          }
        }, `${(ax.val * 180.0 / Math.PI).toFixed(1)}°/s`)
      ]))),

      // 3-Axis Reaction Wheel Cluster RPM
      React.createElement('div', {
        key: 'rw_title',
        style: { fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '6px' }
      }, 'Reaction Wheel Cluster (3-Axis RPM)'),
      React.createElement('div', {
        key: 'rw_grid',
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '6px',
          marginBottom: '10px'
        }
      }, [
        { label: 'RW-X (Roll)', rpm: status.wheel_rpm_x || 0.0 },
        { label: 'RW-Y (Pitch)', rpm: status.wheel_rpm_y || 0.0 },
        { label: 'RW-Z (Yaw)', rpm: (status.wheel_rpm_z !== undefined ? status.wheel_rpm_z : status.wheel_rpm) || 0.0 }
      ].map((rw, i) => React.createElement('div', {
        key: `rw_${i}`,
        style: {
          background: 'rgba(15, 23, 42, 0.8)',
          padding: '4px',
          borderRadius: '4px',
          border: '1px solid #1e293b',
          textAlign: 'center'
        }
      }, [
        React.createElement('div', { key: 'rl', style: { fontSize: '9px', color: '#64748b' } }, rw.label),
        React.createElement('div', { key: 'rv', style: { fontSize: '11px', fontWeight: 'bold', color: '#38bdf8' } }, `${Math.round(rw.rpm)}`)
      ]))),

      // Chaos Injection Seed & Kinetic Vector Header
      (() => {
        const azDeg = status.debris_azimuth !== undefined ? (status.debris_azimuth * 180 / Math.PI) : -140;
        const elDeg = status.debris_elevation !== undefined ? (status.debris_elevation * 180 / Math.PI) : 16;
        const dStr = (azDeg > -45 && azDeg <= 45) ? "BOW" : (azDeg > 45 && azDeg <= 135) ? "PORT" : (azDeg < -45 && azDeg >= -135) ? "STBD" : "STERN";
        const vStr = elDeg > 5 ? "UPPER (+Z)" : (elDeg < -5 ? "LOWER (-Z)" : "HORIZ");
        return React.createElement('div', {
          key: 'chaos_meta',
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'rgba(30, 41, 59, 0.7)',
            padding: '6px 10px',
            borderRadius: '4px',
            border: '1px solid #334155',
            marginBottom: '10px',
            fontSize: '10px'
          }
        }, [
          React.createElement('div', { key: 'cs_seed' }, [
            React.createElement('span', { style: { color: '#94a3b8' } }, 'CHAOS SEED: '),
            React.createElement('span', { style: { color: '#f59e0b', fontWeight: 'bold' } }, `0x${(status.chaos_seed || 0).toString(16).toUpperCase()}`)
          ]),
          React.createElement('div', { key: 'cs_vec' }, [
            React.createElement('span', { style: { color: '#94a3b8' } }, 'COLLISION: '),
            React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, `${dStr} ${vStr} (${azDeg.toFixed(0)}°, ${elDeg.toFixed(0)}°)`)
          ])
        ]);
      })(),

      // 12-Channel Thruster Topology
      React.createElement('div', {
        key: 'th_title',
        style: { fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '6px' }
      }, 'Full 6-DoF RCS Thruster Health (12-ch Matrix)'),
      React.createElement('div', {
        key: 'th_grid',
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '6px'
        }
      }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(idx => {
        const isHealthy = ((status.thruster_health !== undefined ? status.thruster_health : 0x0FFF) & (1 << idx)) !== 0;
        const labels = ['T0:Fwd-L', 'T1:Fwd-R', 'T2:Rev-L', 'T3:Rev-R', 'T4:Lat-P', 'T5:Lat-P', 'T6:Lat-S', 'T7:Lat-S', 'T8:Dor-F', 'T9:Ven-F', 'T10:Dor-A', 'T11:Ven-A'];
        return React.createElement('div', {
          key: `th_${idx}`,
          style: {
            padding: '4px',
            textAlign: 'center',
            borderRadius: '4px',
            fontSize: '9px',
            fontWeight: 'bold',
            background: isHealthy ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.25)',
            color: isHealthy ? '#4ade80' : '#f87171',
            border: isHealthy ? '1px solid #166534' : '1px solid #991b1b'
          }
        }, [
          React.createElement('div', { key: 'name' }, labels[idx] || `T${idx}`),
          React.createElement('div', { key: 'stat', style: { fontSize: '8px', opacity: 0.85 } }, isHealthy ? 'OK' : 'DEAD')
        ]);
      }))
    ]),

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
