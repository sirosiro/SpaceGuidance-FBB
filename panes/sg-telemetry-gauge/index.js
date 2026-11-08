export const minApiVersion = 1;

export default function SpaceTelemetryGauge() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef } = window.FBB?.hooks || React;

  const [data, setData] = useState({
    pos_x: 0.0,
    vel_x: 0.0,
    angle: 0.0,
    fuel: 100.0,
    cross_track_err: 0.0,
    wheel_rpm: 0.0,
    wheel_rpm_x: 0.0,
    wheel_rpm_y: 0.0,
    wheel_rpm_z: 0.0,
    carrier_lost: false,
    sensor_saturated: false
  });

  const [isHistorical, setIsHistorical] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(null);
  const isTimeTravelRef = useRef(false);

  useEffect(() => {
    const applyTelemetry = (j, historical = false, snapIndex = null) => {
      if (j && j.type && j.type !== 'space_guidance') return;
      setData(prev => ({
        ...prev,
        ...j,
        sensor_saturated: (j.sensor_raw === 0xFFFFFFFF)
      }));
      if (historical) {
        isTimeTravelRef.current = true;
        setIsHistorical(true);
        if (snapIndex !== null && snapIndex !== undefined) {
          setHistoryIndex(snapIndex);
        }
      } else if (historical === false && isTimeTravelRef.current) {
        isTimeTravelRef.current = false;
        setIsHistorical(false);
        setHistoryIndex(null);
      }
    };

    // 1. Live WebSocket Telemetry Listener
    let sock = window.FBB?.socket;
    if (!sock && window.FBB?.useDashboard) {
      try {
        sock = window.FBB.useDashboard().socket;
      } catch (e) {}
    }

    const onLiveTelemetry = (j) => {
      // INTERLOCK: Discard incoming live packets while Time-Travel is active
      // to eliminate jitter and maintain stable historical inspection.
      if (isTimeTravelRef.current) return;
      applyTelemetry(j, false);
    };

    if (sock) {
      sock.on('scenario:telemetry', onLiveTelemetry);
    }

    // 2. Same-Window Time-Travel Listener (fbb:telemetry:effective)
    const onEffectiveTelemetry = (e) => {
      if (!e || !e.detail) return;
      if (e.detail.isHistorical) {
        applyTelemetry(e.detail, true, e.detail.index);
      } else {
        // Return to LIVE event
        isTimeTravelRef.current = false;
        setIsHistorical(false);
        setHistoryIndex(null);
        applyTelemetry(e.detail, false);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('fbb:telemetry:effective', onEffectiveTelemetry);
    }

    // 3. Multi-Window / Popout BroadcastChannel Sync Listener
    let syncChannel;
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        syncChannel = new BroadcastChannel('fbb_dashboard_sync');
        syncChannel.onmessage = (event) => {
          const { type, payload } = event.data || {};
          if (type === 'SYNC_TIME_TRAVEL') {
            if (payload && payload.isLive === false && payload.snapshot?.telemetry) {
              applyTelemetry(payload.snapshot.telemetry, true, payload.snapshot.index);
            } else if (payload && payload.isLive === true) {
              isTimeTravelRef.current = false;
              setIsHistorical(false);
              setHistoryIndex(null);
            }
          }
        };
      }
    } catch (e) {}

    // 4. Polling Fallback (only used when WebSocket is unavailable)
    let fallbackTimer = null;
    if (!sock) {
      fallbackTimer = setInterval(async () => {
        // INTERLOCK: Skip file polling during Time-Travel to protect past state
        if (isTimeTravelRef.current) return;
        try {
          let res = await fetch('/api/file?path=/tmp/fbb_scenario_telemetry.json');
          if (!res.ok) res = await fetch('/api/file?path=/tmp/space_guidance_telemetry.json');
          if (res.ok) {
            const j = await res.json();
            onLiveTelemetry(j);
          }
        } catch (e) {}
      }, 100);
    }

    return () => {
      if (sock) sock.off('scenario:telemetry', onLiveTelemetry);
      if (typeof window !== 'undefined') {
        window.removeEventListener('fbb:telemetry:effective', onEffectiveTelemetry);
      }
      if (syncChannel) syncChannel.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, []);

  const rwX = Number(data.wheel_rpm_x || 0);
  const rwY = Number(data.wheel_rpm_y || 0);
  const rwZ = Number(data.wheel_rpm_z !== undefined ? data.wheel_rpm_z : (data.wheel_rpm || 0));
  const maxRpmVal = Math.max(Math.abs(rwX), Math.abs(rwY), Math.abs(rwZ));
  const isWheelSaturated = maxRpmVal >= 5000;
  const isWarning = data.sensor_saturated || Math.abs(data.cross_track_err) > 0.4 || isWheelSaturated;
  const isCaution = data.carrier_lost || Math.abs(data.cross_track_err) > 0.2 || (maxRpmVal >= 4000 && !isWheelSaturated);

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
    // Optional Time-Travel Read-Only Indicator Badge
    isHistorical ? React.createElement('div', {
      style: {
        background: 'rgba(6, 182, 212, 0.15)',
        border: '1px solid #06b6d4',
        color: '#22d3ee',
        borderRadius: '4px',
        padding: '5px 10px',
        marginBottom: '12px',
        fontSize: '11px',
        fontWeight: 'bold',
        textAlign: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        boxShadow: '0 0 10px rgba(6, 182, 212, 0.25)'
      }
    }, [
      React.createElement('span', { key: 'tt_icon' }, '⏪'),
      React.createElement('span', { key: 'tt_text' }, `TIME-TRAVEL ${historyIndex !== null && historyIndex !== undefined ? `#${historyIndex}` : ''} (READ-ONLY SNAPSHOT)`)
    ]) : null,

    // Master C&W Annunciator Header
    React.createElement('div', {
      style: {
        display: 'flex',
        gap: '8px',
        marginBottom: '16px',
        borderBottom: '1px solid #1e293b',
        paddingBottom: '10px'
      }
    },
      React.createElement('div', {
        style: {
          flex: 1,
          padding: '6px 8px',
          borderRadius: '4px',
          textAlign: 'center',
          fontWeight: 'bold',
          fontSize: '11px',
          background: isWarning ? '#ef4444' : '#1e293b',
          color: isWarning ? '#ffffff' : '#64748b'
        }
      }, isWheelSaturated ? 'WARN / RW SAT' : 'WARN / RED ALERT'),
      React.createElement('div', {
        style: {
          flex: 1,
          padding: '6px 8px',
          borderRadius: '4px',
          textAlign: 'center',
          fontWeight: 'bold',
          fontSize: '11px',
          background: isCaution && !isWarning ? '#f59e0b' : '#1e293b',
          color: isCaution && !isWarning ? '#ffffff' : '#64748b'
        }
      }, 'CAUTION (LOS)'),
      React.createElement('div', {
        style: {
          flex: 1,
          padding: '6px 8px',
          borderRadius: '4px',
          textAlign: 'center',
          fontWeight: 'bold',
          fontSize: '11px',
          background: !isCaution && !isWarning ? '#22c55e' : '#1e293b',
          color: !isCaution && !isWarning ? '#ffffff' : '#64748b'
        }
      }, 'NOMINAL')
    ),

    // Fuel Delta-V Bar
    React.createElement('div', { style: { marginBottom: '14px' } },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
        React.createElement('span', null, 'PROPULSION DELTA-V:'),
        React.createElement('span', { style: { color: data.fuel > 30 ? '#38bdf8' : '#ef4444' } }, `${data.fuel.toFixed(1)}%`)
      ),
      React.createElement('div', {
        style: {
          width: '100%',
          height: '8px',
          background: '#1e293b',
          borderRadius: '4px',
          overflow: 'hidden',
          marginTop: '4px'
        }
      },
        React.createElement('div', {
          style: {
            width: `${Math.max(0, Math.min(100, data.fuel))}%`,
            height: '100%',
            background: data.fuel > 30 ? '#0284c7' : '#ef4444',
            transition: 'width 0.1s linear'
          }
        })
      )
    ),

    // 3-Axis Reaction Wheel Momentum Cluster
    (() => {
      const wheels = [
        { label: 'RW-X (Roll)', rpm: rwX },
        { label: 'RW-Y (Pitch)', rpm: rwY },
        { label: 'RW-Z (Yaw)', rpm: rwZ }
      ];
      const maxRpm = 6000.0;

      return React.createElement('div', {
        style: {
          background: '#0f172a',
          padding: '12px',
          borderRadius: '6px',
          marginBottom: '14px',
          border: '1px solid #1e293b'
        }
      }, [
        React.createElement('div', {
          key: 'rw_hdr',
          style: {
            fontSize: '11px',
            color: '#94a3b8',
            fontWeight: 'bold',
            marginBottom: '8px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }
        }, [
          React.createElement('span', null, 'REACTION WHEEL CLUSTER (3-AXIS RPM)'),
          isWheelSaturated
            ? React.createElement('span', { style: { color: '#ef4444', fontWeight: 'bold' } }, '[RW SATURATED]')
            : (maxRpmVal >= 4000 ? React.createElement('span', { style: { color: '#f59e0b', fontWeight: 'bold' } }, '[RW CAUTION]') : null)
        ]),
        React.createElement('div', {
          key: 'rw_bars',
          style: { display: 'flex', flexDirection: 'column', gap: '8px' }
        }, wheels.map((w, idx) => {
          const abs = Math.abs(w.rpm);
          const pct = Math.min(100, (abs / maxRpm) * 100);
          const isSat = abs >= 5000;
          const isWarn = abs >= 4000;
          const barColor = isSat ? '#ef4444' : (isWarn ? '#f59e0b' : '#38bdf8');

          return React.createElement('div', { key: `rw_${idx}` }, [
            React.createElement('div', {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '11px',
                marginBottom: '3px'
              }
            }, [
              React.createElement('span', { style: { color: '#cbd5e1' } }, w.label),
              React.createElement('span', { style: { color: barColor, fontWeight: 'bold' } },
                `${w.rpm >= 0 ? '+' : ''}${Math.round(w.rpm)} RPM ${isSat ? '[SAT]' : ''}`
              )
            ]),
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
                  width: `${pct}%`,
                  height: '100%',
                  background: barColor,
                  transition: 'width 0.1s linear'
                }
              })
            )
          ]);
        }))
      ]);
    })(),

    // Optical Sensor Box with Crimson Pulse Bezel Glow
    React.createElement('div', {
      style: {
        padding: '12px',
        borderRadius: '6px',
        background: '#0f172a',
        border: data.sensor_saturated ? '2px solid #ef4444' : '1px solid #1e293b',
        boxShadow: data.sensor_saturated ? '0 0 12px rgba(239, 68, 68, 0.6)' : 'none',
        marginBottom: '14px'
      }
    },
      React.createElement('div', { style: { fontSize: '11px', color: '#94a3b8' } }, 'OPTICAL SENSOR CENTROID'),
      React.createElement('div', { style: { fontSize: '18px', fontWeight: 'bold', color: data.sensor_saturated ? '#ef4444' : '#38bdf8' } },
        data.sensor_saturated ? '[SATURATED: SOLAR GLARE]' : `${data.cross_track_err.toFixed(3)} m`
      )
    ),

    // Attitude & Velocity Readouts (4-cell grid)
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px' } },
      React.createElement('div', { style: { background: '#0f172a', padding: '8px', borderRadius: '4px' } },
        React.createElement('span', { style: { color: '#64748b' } }, 'YAW ANGLE: '),
        React.createElement('span', { style: { color: '#38bdf8' } }, `${((data.yaw !== undefined ? data.yaw : data.angle) * 180 / Math.PI).toFixed(1)}°`)
      ),
      React.createElement('div', { style: { background: '#0f172a', padding: '8px', borderRadius: '4px' } },
        React.createElement('span', { style: { color: '#64748b' } }, 'ROLL (BANK): '),
        React.createElement('span', { style: { color: Math.abs(data.roll || 0) > 0.05 ? '#a855f7' : '#38bdf8' } }, `${((data.roll || 0) * 180 / Math.PI).toFixed(1)}°`)
      ),
      React.createElement('div', { style: { background: '#0f172a', padding: '8px', borderRadius: '4px' } },
        React.createElement('span', { style: { color: '#64748b' } }, 'ALTITUDE Z: '),
        React.createElement('span', { style: { color: '#38bdf8' } }, `${(data.pos_z || 0).toFixed(2)} m`)
      ),
      React.createElement('div', { style: { background: '#0f172a', padding: '8px', borderRadius: '4px' } },
        React.createElement('span', { style: { color: '#64748b' } }, 'FORWARD VEL: '),
        React.createElement('span', { style: { color: '#38bdf8' } }, `${data.vel_x.toFixed(2)} m/s`)
      )
    )
  );
}
