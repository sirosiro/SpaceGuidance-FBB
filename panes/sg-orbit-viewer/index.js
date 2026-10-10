export const minApiVersion = 1;

export default function SpaceOrbitViewer3D() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef } = window.FBB?.hooks || React;
  const canvasRef = useRef(null);

  const [viewMode, setViewMode] = useState('chase'); // 'chase', 'iso', 'top'
  const [telemetry, setTelemetry] = useState({
    pos_x: 0.0,
    pos_y: 0.0,
    vel_x: 0.0,
    vel_y: 0.0,
    angle: 0.0,
    omega: 0.0,
    fuel: 100.0,
    cross_track_err: 0.0,
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

  // Compute Stage 1 Asteroid Pipeline S-Curve Y coordinate for given X
  const getPipelineY = (x) => {
    if (x > 10.0 && x <= 25.0) {
      return 2.5 * Math.sin((x - 10.0) / 15.0 * Math.PI);
    } else if (x > 25.0 && x <= 40.0) {
      return -2.5 * Math.sin((x - 25.0) / 15.0 * Math.PI);
    }
    return 0.0;
  };

  // 3D Cyber-Wireframe Perspective Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;

    // Dynamic 3D streaming space-dust & stars (provides visceral sense of acceleration)
    const dustParticles = [];
    for (let i = 0; i < 120; i++) {
      dustParticles.push({
        x: Math.random() * 70 - 10,
        y: (Math.random() - 0.5) * 36,
        z: (Math.random() - 0.5) * 20,
        size: Math.random() * 1.8 + 0.6
      });
    }

    const render = () => {
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;
      const cx = w * 0.5;
      const cy = h * 0.55;

      // Dark deep space background
      ctx.fillStyle = '#030712';
      ctx.fillRect(0, 0, w, h);

      // Camera Setup based on View Mode
      let cam = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
      const shipX = telemetry.pos_x;
      const shipY = telemetry.pos_y;
      const shipZ = 0.0;
      const shipYaw = telemetry.angle;
      const shipBank = (telemetry.omega || 0) * 0.8;

      if (viewMode === 'chase') {
        // Third-person 3D chase cam behind and above the spacecraft
        const camDist = 9.0;
        const camHeight = 3.6;
        cam.x = shipX - Math.cos(shipYaw) * camDist;
        cam.y = shipY - Math.sin(shipYaw) * camDist;
        cam.z = shipZ + camHeight;
        cam.pitch = 0.26; // Radians looking down
        cam.yaw = shipYaw;
        cam.roll = shipBank * 0.3;
      } else if (viewMode === 'iso') {
        // 3D Isometric Perspective Cam looking across the pipeline
        cam.x = shipX - 14.0;
        cam.y = shipY - 12.0;
        cam.z = 10.0;
        cam.pitch = 0.50; // ~28 deg pitch
        cam.yaw = 0.65;   // ~37 deg yaw
        cam.roll = 0.0;
      } else {
        // 2D Tactical Top-Down Cam
        cam.x = shipX - 2.0;
        cam.y = shipY;
        cam.z = 24.0;
        cam.pitch = Math.PI * 0.499; // Almost vertical top-down
        cam.yaw = 0.0;
        cam.roll = 0.0;
      }

      // 3D Perspective Projection Function
      const project3D = (wx, wy, wz) => {
        // 1. World to Camera Translation
        const dx = wx - cam.x;
        const dy = wy - cam.y;
        const dz = wz - cam.z;

        // 2. Rotate by Camera Yaw (around Z)
        const cosY = Math.cos(-cam.yaw);
        const sinY = Math.sin(-cam.yaw);
        const rx1 = dx * cosY - dy * sinY;
        const ry1 = dx * sinY + dy * cosY;
        const rz1 = dz;

        // 3. Rotate by Camera Pitch (around local Y/X)
        const cosP = Math.cos(-cam.pitch);
        const sinP = Math.sin(-cam.pitch);
        const rx2 = ry1;
        const ry2 = rz1 * cosP - rx1 * sinP;
        const rz2 = rz1 * sinP + rx1 * cosP; // Forward depth (camera Z)

        if (rz2 <= 0.8) return null; // Behind camera clipping

        // 4. Perspective Division
        const focal = 380;
        const scale = focal / rz2;
        const sx = cx + rx2 * scale;
        const sy = cy - ry2 * scale;

        return { sx, sy, scale, depth: rz2 };
      };

      // 1. Draw 3D Streaming Space Dust (Speeds up visibly with ship acceleration)
      const speed = Math.abs(telemetry.vel_x || 0);
      for (const p of dustParticles) {
        // Wrap particles ahead of ship
        if (p.x < cam.x - 5) {
          p.x = cam.x + 55 + Math.random() * 10;
          p.y = (Math.random() - 0.5) * 36;
          p.z = (Math.random() - 0.5) * 16;
        }
        const pt = project3D(p.x, p.y, p.z);
        if (pt) {
          // At higher speeds, draw speed streaks instead of dots
          const streakLen = Math.min(24, speed * 3.5);
          ctx.strokeStyle = speed > 2.0 ? '#38bdf8' : '#64748b';
          ctx.lineWidth = pt.scale > 30 ? 1.5 : 1.0;
          ctx.beginPath();
          ctx.moveTo(pt.sx, pt.sy);
          ctx.lineTo(pt.sx - Math.cos(cam.pitch) * streakLen, pt.sy + Math.sin(cam.pitch) * streakLen * 0.4);
          ctx.stroke();
        }
      }

      // 2. Draw 3D Asteroid Surface Grid (Ground Plane at Z = -3.5m)
      ctx.strokeStyle = '#0b192f';
      ctx.lineWidth = 1;
      const groundZ = -3.5;
      const startX = Math.floor((shipX - 25) / 5) * 5;
      const endX = startX + 60;
      for (let gx = startX; gx <= endX; gx += 5) {
        const p1 = project3D(gx, -18, groundZ);
        const p2 = project3D(gx, 18, groundZ);
        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      }
      for (let gy = -18; gy <= 18; gy += 4) {
        const p1 = project3D(startX, gy, groundZ);
        const p2 = project3D(endX, gy, groundZ);
        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      }

      // 3. Draw 3D Asteroid Pipeline Corridor (Hexagonal Rings + Guide Rails)
      const ringSpacing = 2.5; // Every 2.5 meters
      const hexRadius = 1.8;
      const hexAngles = [0, Math.PI/3, 2*Math.PI/3, Math.PI, 4*Math.PI/3, 5*Math.PI/3];

      // Draw Main Guidance Trajectory Line on Ground / Center
      ctx.strokeStyle = '#00f0ff';
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let firstPoint = true;
      for (let px = 0.0; px <= 50.0; px += 0.5) {
        const py = getPipelineY(px);
        const pt = project3D(px, py, 0.0);
        if (pt) {
          if (firstPoint) { ctx.moveTo(pt.sx, pt.sy); firstPoint = false; }
          else { ctx.lineTo(pt.sx, pt.sy); }
        }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Draw 3D Hexagonal Portal Rings along the 50m track
      for (let rx = 0.0; rx <= 50.0; rx += ringSpacing) {
        const ry = getPipelineY(rx);
        const isPast = (rx < shipX - 1.0);
        const isNext = (!isPast && rx <= shipX + ringSpacing);

        // Ring color: active cyan, passed dimmed green, alert if large deviation
        let ringColor = isNext ? '#38bdf8' : (isPast ? '#059669' : '#0284c7');
        if (isNext && Math.abs(telemetry.cross_track_err) > 0.4) {
          ringColor = '#ef4444'; // Red alert gateway
        }

        ctx.strokeStyle = ringColor;
        ctx.shadowColor = ringColor;
        ctx.shadowBlur = isNext ? 10 : 4;
        ctx.lineWidth = isNext ? 2.5 : 1.2;

        const hexPoints = [];
        for (const a of hexAngles) {
          const hx = rx;
          const hy = ry + hexRadius * Math.sin(a);
          const hz = hexRadius * Math.cos(a);
          const hp = project3D(hx, hy, hz);
          if (hp) hexPoints.push(hp);
        }

        if (hexPoints.length === 6) {
          ctx.beginPath();
          ctx.moveTo(hexPoints[0].sx, hexPoints[0].sy);
          for (let i = 1; i < 6; i++) ctx.lineTo(hexPoints[i].sx, hexPoints[i].sy);
          ctx.closePath();
          ctx.stroke();

          // Gateway cross-support struts to asteroid surface
          const bottomPt = hexPoints[4]; // lowest vertex
          const pGround = project3D(rx, ry, groundZ);
          if (pGround) {
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(bottomPt.sx, bottomPt.sy);
            ctx.lineTo(pGround.sx, pGround.sy);
            ctx.stroke();
          }
        }
      }

      // Longitudinal Tunnel Rails (Top, Left, Right rails connecting the rings)
      const railOffsets = [
        { dy: 0, dz: hexRadius },             // Top rail
        { dy: -hexRadius, dz: 0 },            // Left rail
        { dy: hexRadius, dz: 0 }              // Right rail
      ];
      ctx.strokeStyle = '#0369a1';
      ctx.lineWidth = 1.0;
      for (const ro of railOffsets) {
        ctx.beginPath();
        let firstR = true;
        for (let rx = 0.0; rx <= 50.0; rx += 1.0) {
          const ry = getPipelineY(rx) + ro.dy;
          const rz = ro.dz;
          const rp = project3D(rx, ry, rz);
          if (rp) {
            if (firstR) { ctx.moveTo(rp.sx, rp.sy); firstR = false; }
            else { ctx.lineTo(rp.sx, rp.sy); }
          }
        }
        ctx.stroke();
      }

      // 4. Draw True 3D Spacecraft Polyhedral Model
      const isGhost = telemetry.carrier_lost || telemetry.fdir_mode === 1;
      const shipColor = isGhost ? '#f59e0b' : '#38bdf8';
      ctx.strokeStyle = shipColor;
      ctx.shadowColor = shipColor;
      ctx.shadowBlur = isGhost ? 4 : 12;
      ctx.lineWidth = 2.0;
      if (isGhost) ctx.setLineDash([4, 4]);

      // 3D Spacecraft Local Vertices (Body Frame)
      const cosSY = Math.cos(shipYaw);
      const sinSY = Math.sin(shipYaw);
      const cosSB = Math.cos(shipBank);
      const sinSB = Math.sin(shipBank);

      const transformShipPoint = (bx, by, bz) => {
        // Roll bank around local X
        const ry = by * cosSB - bz * sinSB;
        const rz = by * sinSB + bz * cosSB;
        // Yaw rotation around world Z
        const wx = shipX + bx * cosSY - ry * sinSY;
        const wy = shipY + bx * sinSY + ry * cosSY;
        const wz = shipZ + rz;
        return project3D(wx, wy, wz);
      };

      const V = {
        nose: transformShipPoint(2.2, 0, 0),
        wingL: transformShipPoint(-1.3, -1.8, 0),
        wingR: transformShipPoint(-1.3, 1.8, 0),
        canopy: transformShipPoint(-0.2, 0, 0.65),
        finL: transformShipPoint(-1.4, -0.7, 0.8),
        finR: transformShipPoint(-1.4, 0.7, 0.8),
        nozzleL: transformShipPoint(-1.6, -0.4, 0),
        nozzleR: transformShipPoint(-1.6, 0.4, 0),
        keel: transformShipPoint(-0.4, 0, -0.4)
      };

      // Draw 3D Edges if vertices visible
      const draw3DEdge = (p1, p2) => {
        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      };

      // Delta Hull Outline
      draw3DEdge(V.nose, V.wingL);
      draw3DEdge(V.nose, V.wingR);
      draw3DEdge(V.wingL, V.nozzleL);
      draw3DEdge(V.wingR, V.nozzleR);
      draw3DEdge(V.nozzleL, V.nozzleR);

      // 3D Cockpit Canopy Pyramid
      draw3DEdge(V.nose, V.canopy);
      draw3DEdge(V.wingL, V.canopy);
      draw3DEdge(V.wingR, V.canopy);

      // 3D Vertical Stabilizer Fins
      draw3DEdge(V.nozzleL, V.finL);
      draw3DEdge(V.canopy, V.finL);
      draw3DEdge(V.nozzleR, V.finR);
      draw3DEdge(V.canopy, V.finR);

      // 3D Ventral Keel
      draw3DEdge(V.nose, V.keel);
      draw3DEdge(V.wingL, V.keel);
      draw3DEdge(V.wingR, V.keel);

      // Optical Line Sensor Bar ahead of nose (Green Laser Scanning Bar)
      const sensorL = transformShipPoint(1.2, -0.8, 0);
      const sensorR = transformShipPoint(1.2, 0.8, 0);
      if (sensorL && sensorR) {
        ctx.strokeStyle = '#22c55e';
        ctx.shadowColor = '#22c55e';
        ctx.shadowBlur = 8;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        draw3DEdge(sensorL, sensorR);
      }

      // 3D Dynamic Thruster Plumes (Expands and flares intensely with acceleration)
      if (speed > 0.05) {
        const isAccelerating = speed < 4.5 && telemetry.fuel > 0;
        const flameBase = isAccelerating ? (1.5 + Math.min(2.5, speed * 0.6)) : 0.8;
        const plumeLen = flameBase + Math.random() * 0.7;

        // Core flame (Neon Cyan/White at high thrust, Amber/Orange at cruise)
        ctx.strokeStyle = isAccelerating ? '#38bdf8' : '#f97316';
        ctx.shadowColor = isAccelerating ? '#00f0ff' : '#f97316';
        ctx.shadowBlur = 16;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        const pTipL = transformShipPoint(-1.6 - plumeLen, -0.4, (Math.random() - 0.5) * 0.25);
        const pTipR = transformShipPoint(-1.6 - plumeLen, 0.4, (Math.random() - 0.5) * 0.25);
        draw3DEdge(V.nozzleL, pTipL);
        draw3DEdge(V.nozzleR, pTipR);

        // Secondary outer shock cone
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 1.2;
        const pTipMid = transformShipPoint(-1.6 - plumeLen * 1.3, 0.0, (Math.random() - 0.5) * 0.3);
        draw3DEdge(V.nozzleL, pTipMid);
        draw3DEdge(V.nozzleR, pTipMid);
      }

      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      // 5. CRT Scanline glitch overlay during LOS
      if (isGhost) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.07)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ef4444';
        ctx.font = '11px monospace';
        ctx.fillText('[CARRIER LOST: 3D DEAD RECKONING EXTRAPOLATION]', 16, 28);
      }

      // 6. Tactical HUD Crosshairs & Boresight
      const aimPt = project3D(shipX + 10.0, getPipelineY(shipX + 10.0), 0.0);
      if (aimPt) {
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(aimPt.sx, aimPt.sy, 8, 0, Math.PI * 2);
        ctx.moveTo(aimPt.sx - 12, aimPt.sy);
        ctx.lineTo(aimPt.sx + 12, aimPt.sy);
        ctx.moveTo(aimPt.sx, aimPt.sy - 12);
        ctx.lineTo(aimPt.sx, aimPt.sy + 12);
        ctx.stroke();
      }

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [telemetry, viewMode]);

  return React.createElement('div', {
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#030712',
      overflow: 'hidden'
    }
  },
    // Top Camera Mode Selector Bar
    React.createElement('div', {
      style: {
        position: 'absolute',
        top: '10px',
        right: '12px',
        display: 'flex',
        gap: '6px',
        zIndex: 10
      }
    },
      ['chase', 'iso', 'top'].map(mode =>
        React.createElement('button', {
          key: mode,
          onClick: () => setViewMode(mode),
          style: {
            padding: '4px 8px',
            fontSize: '10px',
            fontFamily: 'monospace',
            fontWeight: 'bold',
            borderRadius: '4px',
            border: viewMode === mode ? '1px solid #00f0ff' : '1px solid #1e293b',
            background: viewMode === mode ? 'rgba(0, 240, 255, 0.2)' : 'rgba(15, 23, 42, 0.8)',
            color: viewMode === mode ? '#00f0ff' : '#94a3b8',
            cursor: 'pointer'
          }
        }, mode === 'chase' ? '3D CHASE' : mode === 'iso' ? '3D ISOMETRIC' : '2D TACTICAL')
      )
    ),

    // 3D Perspective Canvas
    React.createElement('canvas', {
      ref: canvasRef,
      style: { width: '100%', height: '100%', display: 'block' }
    }),

    // Bottom Telemetry Overlay
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: '8px',
        left: '12px',
        color: '#94a3b8',
        fontSize: '11px',
        fontFamily: 'monospace',
        background: 'rgba(3, 7, 18, 0.7)',
        padding: '2px 8px',
        borderRadius: '4px',
        border: '1px solid #1e293b'
      }
    }, `3D POS: (${telemetry.pos_x.toFixed(2)}m, ${telemetry.pos_y.toFixed(2)}m) | VEL: ${telemetry.vel_x.toFixed(2)} m/s | ERR: ${(telemetry.cross_track_err || 0).toFixed(3)}m`)
  );
}
