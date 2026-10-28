export const minApiVersion = 1;

export default function SpaceTelemetryGauge() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect } = window.FBB?.hooks || React;

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

  useEffect(() => {
    const handleTelemetry = (j) => {
      if (j && j.type && j.type !== 'space_guidance') return;
      setData(prev => ({
        ...prev,
        ...j,
        sensor_saturated: (j.sensor_raw === 0xFFFFFFFF)
      }));
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

  const rwRpmZ = Number(data.wheel_rpm_z || data.wheel_rpm || 0);
  const isWheelSaturated = Math.abs(rwRpmZ) >= 5000;
  const isWarning = data.sensor_saturated || Math.abs(data.cross_track_err) > 0.4 || isWheelSaturated;
  const isCaution = data.carrier_lost || Math.abs(data.cross_track_err) > 0.2 || (Math.abs(rwRpmZ) >= 4000 && !isWheelSaturated);

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

    // Reaction Wheel RPM & Momentum Gauge
    (() => {
      const rwZ = Number(data.wheel_rpm_z || data.wheel_rpm || 0);
      const rwX = Number(data.wheel_rpm_x || 0);
      const rwY = Number(data.wheel_rpm_y || 0);
      const absRpm = Math.abs(rwZ);
      const maxRpm = 6000.0;
      const pct = Math.min(100, (absRpm / maxRpm) * 100);
      const isSat = absRpm >= 5000;
      const isWarn = absRpm >= 4000;
      const barColor = isSat ? '#ef4444' : (isWarn ? '#f59e0b' : '#ec4899');
      const is3Axis = Math.abs(rwX) > 5 || Math.abs(rwY) > 5;

      return React.createElement('div', { style: { marginBottom: '14px' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
          React.createElement('span', null, 'REACTION WHEEL (YAW / Z):'),
          React.createElement('span', { style: { color: barColor, fontWeight: 'bold' } },
            `${rwZ >= 0 ? '+' : ''}${rwZ.toFixed(0)} RPM ${isSat ? '[SATURATED]' : ''}`
          )
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
              width: `${pct}%`,
              height: '100%',
              background: barColor,
              transition: 'width 0.1s linear'
            }
          })
        ),
        is3Axis ? React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8', marginTop: '4px' }
        },
          React.createElement('span', null, `RW-X (Roll): ${rwX >= 0 ? '+' : ''}${rwX.toFixed(0)} RPM`),
          React.createElement('span', null, `RW-Y (Pitch): ${rwY >= 0 ? '+' : ''}${rwY.toFixed(0)} RPM`)
        ) : null
      );
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
