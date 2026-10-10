export const minApiVersion = 1;

export default function SpaceOrbitViewer3D() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef } = window.FBB?.hooks || React;
  const canvasRef = useRef(null);

  const [telemetry, setTelemetry] = useState({
    pos_x: 0.0,
    pos_y: 0.0,
    vel_x: 0.0,
    vel_y: 0.0,
    angle: 0.0,
    fuel: 100.0,
    carrier_lost: false,
    fdir_mode: 0
  });

  // Poll telemetry
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/file?path=/tmp/space_guidance_telemetry.json');
        if (res.ok) {
          const data = await res.json();
          setTelemetry(prev => ({ ...prev, ...data }));
        }
      } catch (e) {}
    }, 50);
    return () => clearInterval(timer);
  }, []);

  // 3D Cyber-Wireframe Canvas Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;

    const render = () => {
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;

      // Dark cosmos background with vector-scope grid
      ctx.fillStyle = '#050811';
      ctx.fillRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = '#0a192f';
      ctx.lineWidth = 1;
      const gridSize = 40;
      for (let x = 0; x < w; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      ctx.save();
      // Center camera on spacecraft: world (pos_x, pos_y) maps to screen
      const scale = 18; // pixels per meter
      const cx = w * 0.35;
      const cy = h * 0.5;

      // Draw Stage 1 Asteroid Pipeline Track (50m S-curve)
      ctx.strokeStyle = '#00f0ff';
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let x = 0; x <= 50.0; x += 0.5) {
        let y = 0.0;
        if (x > 10.0 && x <= 25.0) {
          y = 2.5 * Math.sin((x - 10.0) / 15.0 * Math.PI);
        } else if (x > 25.0 && x <= 40.0) {
          y = -2.5 * Math.sin((x - 25.0) / 15.0 * Math.PI);
        }
        const sx = cx + (x - telemetry.pos_x) * scale;
        const sy = cy - (y - telemetry.pos_y) * scale;
        if (x === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Draw Spacecraft Wireframe at (cx, cy)
      ctx.translate(cx, cy);
      ctx.rotate(-telemetry.angle);

      const isGhost = telemetry.carrier_lost || telemetry.fdir_mode === 1;
      const shipColor = isGhost ? '#f59e0b' : '#38bdf8';
      ctx.strokeStyle = shipColor;
      ctx.shadowColor = shipColor;
      ctx.shadowBlur = isGhost ? 4 : 10;
      ctx.lineWidth = 2;
      if (isGhost) ctx.setLineDash([4, 4]); // Dead reckoning ghost dashed line

      // Delta-wing spacecraft wireframe
      ctx.beginPath();
      ctx.moveTo(22, 0);    // Nose
      ctx.lineTo(-14, -12); // Left wing
      ctx.lineTo(-8, -4);   // Left thruster mount
      ctx.lineTo(-8, 4);    // Right thruster mount
      ctx.lineTo(-14, 12);  // Right wing
      ctx.closePath();
      ctx.stroke();

      // Optical sensor bar ahead of nose
      ctx.strokeStyle = '#22c55e';
      ctx.beginPath();
      ctx.moveTo(12, -8);
      ctx.lineTo(12, 8);
      ctx.stroke();

      // Thruster plume (if moving)
      if (Math.abs(telemetry.vel_x) > 0.05) {
        ctx.strokeStyle = '#f97316';
        ctx.shadowColor = '#f97316';
        ctx.shadowBlur = 8;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.lineTo(-18 - Math.random() * 8, 0);
        ctx.stroke();
      }

      ctx.restore();

      // CRT Scanline flicker overlay during LOS
      if (isGhost) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ef4444';
        ctx.font = '11px monospace';
        ctx.fillText('[CARRIER LOST: DEAD RECKONING EXTRAPOLATION MODE]', 16, 24);
      }

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [telemetry]);

  return React.createElement('div', {
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#050811',
      overflow: 'hidden'
    }
  },
    React.createElement('canvas', {
      ref: canvasRef,
      style: { width: '100%', height: '100%', display: 'block' }
    }),
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: '8px',
        left: '12px',
        color: '#94a3b8',
        fontSize: '11px',
        fontFamily: 'monospace'
      }
    }, `POS: (${telemetry.pos_x.toFixed(2)}m, ${telemetry.pos_y.toFixed(2)}m) | VEL: ${telemetry.vel_x.toFixed(2)} m/s`)
  );
}
