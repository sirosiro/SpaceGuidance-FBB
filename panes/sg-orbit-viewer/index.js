export const minApiVersion = 1;

// ============================================================================
// Persistent Celestial Sphere Starfield (260 Immutable Cosmic Stars)
// Fixed in World Inertial Space (Infinite Distance: Zero Linear Parallax)
// ============================================================================
const CELESTIAL_STARS = (() => {
  const stars = [];
  // Deterministic pseudo-random generator (LCG)
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < 280; i++) {
    const u = rand();
    const v = rand();
    const theta = u * 2.0 * Math.PI;
    const phi = Math.acos(2.0 * v - 1.0); // Uniform sphere distribution
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.sin(phi) * Math.sin(theta);
    const z = Math.cos(phi);
    const baseSize = rand() * 1.6 + 0.5;
    const twinkleSpeed = rand() * 1.8 + 0.8;
    const twinklePhase = rand() * Math.PI * 2;
    const colorRoll = rand();
    const color = colorRoll > 0.85 ? '#38bdf8' : (colorRoll > 0.68 ? '#fde047' : (colorRoll > 0.45 ? '#e2e8f0' : '#ffffff'));
    stars.push({ x, y, z, baseSize, twinkleSpeed, twinklePhase, color });
  }
  return stars;
})();

export default function SpaceOrbitViewer3D() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef } = window.FBB?.hooks || React;
  const canvasRef = useRef(null);

  // Camera presets: 'chase', 'nose', 'hero', 'orbit', 'cinema'
  const [cameraPreset, setCameraPreset] = useState('chase');
  const [zoom, setZoom] = useState(1.0);
  const [userOffset, setUserOffset] = useState({ yaw: 0.0, pitch: 0.0 });
  const [cinemaIndex, setCinemaIndex] = useState(0);

  const [telemetry, setTelemetry] = useState({
    pos_x: 0.0,
    pos_y: 0.0,
    vel_x: 0.0,
    vel_y: 0.0,
    angle: 0.0,
    omega: 0.0,
    fuel: 100.0,
    cross_track_err: 0.0,
    wheel_rpm: 0.0,
    carrier_lost: false,
    fdir_mode: 0
  });

  // State refs to keep animation loop at steady 60FPS without teardown
  const stateRef = useRef({
    cameraPreset: 'chase',
    zoom: 1.0,
    userOffset: { yaw: 0.0, pitch: 0.0 },
    cinemaIndex: 0,
    smoothRoll: 0.0,
    lastAzimuth: 0.0,
    lastElevation: 0.0,
    rotSpeed: 0.0
  });

  // Update refs on state changes
  stateRef.current.cameraPreset = cameraPreset;
  stateRef.current.zoom = zoom;
  stateRef.current.userOffset = userOffset;
  stateRef.current.cinemaIndex = cinemaIndex;

  // Continuous 60FPS Kinematic & Rotational Inertia State
  const telemetryRef = useRef(null);
  const smoothRef = useRef({
    x: 0.0,
    y: 0.0,
    yaw: 0.0,
    bank: 0.0,
    initialized: false
  });

  const dragRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    baseYaw: 0.0,
    basePitch: 0.0
  });

  // Poll telemetry at 50Hz
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/file?path=/tmp/space_guidance_telemetry.json');
        if (res.ok) {
          const data = await res.json();
          telemetryRef.current = data;
          setTelemetry(prev => ({ ...prev, ...data }));
        }
      } catch (e) {}
    }, 50);
    return () => clearInterval(timer);
  }, []);

  // Cinema Mode: Auto-cycle camera angles every 6 seconds
  useEffect(() => {
    if (cameraPreset !== 'cinema') return;
    const modes = ['chase', 'nose', 'hero', 'orbit'];
    const interval = setInterval(() => {
      setCinemaIndex(prev => (prev + 1) % modes.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [cameraPreset]);

  // Compute Stage 1 Asteroid Pipeline S-Curve Y coordinate for given X
  const getPipelineY = (x) => {
    if (x > 10.0 && x <= 25.0) {
      return 2.5 * Math.sin((x - 10.0) / 15.0 * Math.PI);
    } else if (x > 25.0 && x <= 40.0) {
      return -2.5 * Math.sin((x - 25.0) / 15.0 * Math.PI);
    }
    return 0.0;
  };

  // 3D Perspective Render Loop (Persistent 60FPS Animation)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId;

    const render = () => {
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;
      const cx = w * 0.5;
      const cy = h * 0.55;
      const now = Date.now();
      const timeSec = now * 0.001;

      // Deep Space background
      ctx.fillStyle = '#030712';
      ctx.fillRect(0, 0, w, h);

      const st = stateRef.current;
      const sm = smoothRef.current;

      // First packet instant snap
      const initTlm = telemetryRef.current || telemetry;
      if (!sm.initialized && (initTlm.pos_x !== 0.0 || initTlm.vel_x !== 0.0)) {
        sm.x = initTlm.pos_x;
        sm.y = initTlm.pos_y;
        sm.yaw = initTlm.angle;
        sm.bank = -(initTlm.omega || 0) * 1.1;
        sm.initialized = true;
      }

      // Continuous 60FPS Spring-Damper Interpolation (Rotational & Translational Inertia)
      const tlm = telemetryRef.current || telemetry;
      const targetX = tlm.pos_x;
      const targetY = tlm.pos_y;
      const targetYaw = tlm.angle;
      const targetBank = -Math.max(-0.45, Math.min(0.45, (tlm.omega || 0) * 1.2));

      sm.x += (targetX - sm.x) * 0.28;
      sm.y += (targetY - sm.y) * 0.28;

      let dYaw = targetYaw - sm.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      sm.yaw += dYaw * 0.24;

      // Authentic angular roll inertia (wings smoothly tilt into curves and level out)
      sm.bank += (targetBank - sm.bank) * 0.16;

      const shipX = sm.x;
      const shipY = sm.y;
      const shipZ = 0.0;
      const shipYaw = sm.yaw;
      const rawBank = sm.bank;

      // Smooth camera roll damping (subtle natural horizon reaction, max 6 deg)
      const targetRoll = (st.cameraPreset === 'chase' ? -Math.max(-0.12, Math.min(0.12, (tlm.omega || 0) * 0.15)) : 0.0);
      st.smoothRoll += (targetRoll - st.smoothRoll) * 0.08;

      // Camera preset parameters
      const cinemaModes = ['chase', 'nose', 'hero', 'orbit'];
      const effectiveMode = (st.cameraPreset === 'cinema') ? cinemaModes[st.cinemaIndex] : st.cameraPreset;

      let baseAzimuth = 0.0;
      let baseElevation = 0.26;
      let baseDist = 9.0;

      if (effectiveMode === 'chase') {
        // Rear-Top Chase looking +X
        baseAzimuth = 0.0;
        baseElevation = 0.26;
        baseDist = 9.0;
      } else if (effectiveMode === 'nose') {
        // Front-Top looking back towards approaching ship
        baseAzimuth = Math.PI;
        baseElevation = 0.20;
        baseDist = 7.5;
      } else if (effectiveMode === 'hero') {
        // Dramatic Low-Angle Hero Shot
        baseAzimuth = -0.75;
        baseElevation = -0.28;
        baseDist = 6.2;
      } else if (effectiveMode === 'orbit') {
        // Continuous 360 Fly-Around
        baseAzimuth = (now * 0.00045) % (Math.PI * 2);
        baseElevation = 0.24 + 0.12 * Math.sin(now * 0.0003);
        baseDist = 8.8;
      }

      // Combine Preset + User Offset + Zoom
      const finalAzimuth = baseAzimuth + st.userOffset.yaw;
      const finalElevation = Math.max(-1.3, Math.min(1.3, baseElevation + st.userOffset.pitch));
      const finalDist = baseDist / Math.max(0.4, Math.min(2.5, st.zoom));

      // Calculate camera angular rotation rate (for dynamic star twinkle intensity)
      const dAz = Math.abs(finalAzimuth - st.lastAzimuth);
      const dEl = Math.abs(finalElevation - st.lastElevation);
      const currentRotRate = Math.min(1.0, (dAz + dEl) * 15.0 + Math.abs(st.smoothRoll) * 2.0);
      st.rotSpeed += (currentRotRate - st.rotSpeed) * 0.12;
      st.lastAzimuth = finalAzimuth;
      st.lastElevation = finalElevation;

      // ------------------------------------------------------------------------
      // Rigorous Orthonormal Camera Basis Vectors
      // ------------------------------------------------------------------------
      const cosA = Math.cos(finalAzimuth);
      const sinA = Math.sin(finalAzimuth);
      const cosE = Math.cos(finalElevation);
      const sinE = Math.sin(finalElevation);

      // Camera position relative to target ship
      const cam = {
        x: shipX - finalDist * cosE * cosA,
        y: shipY - finalDist * cosE * sinA,
        z: shipZ + finalDist * sinE
      };

      // Optical Forward Vector (from Camera to Target)
      const f = {
        x: cosE * cosA,
        y: cosE * sinA,
        z: -sinE
      };

      // Camera Right Vector (Horizontal in World XY)
      const r_raw = {
        x: sinA,
        y: -cosA,
        z: 0.0
      };

      // Camera Up Vector (Orthogonal to f and r)
      const u_raw = {
        x: sinE * cosA,
        y: sinE * sinA,
        z: cosE
      };

      // Apply Camera Roll (st.smoothRoll) around line of sight
      const cosR = Math.cos(st.smoothRoll);
      const sinR = Math.sin(st.smoothRoll);

      const r = {
        x: cosR * r_raw.x + sinR * u_raw.x,
        y: cosR * r_raw.y + sinR * u_raw.y,
        z: cosR * r_raw.z + sinR * u_raw.z
      };

      const u = {
        x: -sinR * r_raw.x + cosR * u_raw.x,
        y: -sinR * r_raw.y + cosR * u_raw.y,
        z: -sinR * r_raw.z + cosR * u_raw.z
      };

      const focal = 380;

      // 3D Perspective Projection for World Objects
      const project3D = (wx, wy, wz) => {
        const dx = wx - cam.x;
        const dy = wy - cam.y;
        const dz = wz - cam.z;

        const z_cam = dx * f.x + dy * f.y + dz * f.z;
        if (z_cam <= 0.6) return null;

        const x_cam = dx * r.x + dy * r.y + dz * r.z;
        const y_cam = dx * u.x + dy * u.y + dz * u.z;

        const scale = focal / z_cam;
        return {
          sx: cx + x_cam * scale,
          sy: cy - y_cam * scale,
          scale,
          depth: z_cam
        };
      };

      // ------------------------------------------------------------------------
      // 1. Draw Celestial Starfield (Immutable Astronomical Sphere)
      // Completely stationary when camera is fixed; flows in exact direction when turned
      // ------------------------------------------------------------------------
      const starFocal = focal * 1.15;
      for (const s of CELESTIAL_STARS) {
        // Depth along camera line of sight
        const z_star = s.x * f.x + s.y * f.y + s.z * f.z;
        if (z_star > 0.08) {
          const x_star = s.x * r.x + s.y * r.y + s.z * r.z;
          const y_star = s.x * u.x + s.y * u.y + s.z * u.z;

          const ssx = cx + (x_star / z_star) * starFocal;
          const ssy = cy - (y_star / z_star) * starFocal;

          if (ssx >= -10 && ssx <= w + 10 && ssy >= -10 && ssy <= h + 10) {
            // Dynamic Twinkle: serene when still, shimmers and flares dynamically on turns/bank
            const baseTwinkle = 0.52 + 0.48 * Math.sin(timeSec * s.twinkleSpeed + s.twinklePhase);
            const dynamicTwinkle = Math.min(1.0, baseTwinkle + st.rotSpeed * 0.35);

            ctx.fillStyle = s.color;
            ctx.globalAlpha = dynamicTwinkle;
            ctx.beginPath();
            ctx.arc(ssx, ssy, s.baseSize, 0, Math.PI * 2);
            ctx.fill();

            // Cross diffraction spikes on prominent stars (flares with motion)
            if (s.baseSize > 1.5 && dynamicTwinkle > 0.70) {
              const spk = 3.5 + st.rotSpeed * 3.0;
              ctx.strokeStyle = s.color;
              ctx.lineWidth = 0.8;
              ctx.beginPath();
              ctx.moveTo(ssx - spk, ssy); ctx.lineTo(ssx + spk, ssy);
              ctx.moveTo(ssx, ssy - spk); ctx.lineTo(ssx, ssy + spk);
              ctx.stroke();
            }
          }
        }
      }
      ctx.globalAlpha = 1.0;

      // ------------------------------------------------------------------------
      // 2. Draw 3D Asteroid Surface Grid (Ground Plane at Z = -3.5m)
      // ------------------------------------------------------------------------
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

      // ------------------------------------------------------------------------
      // 3. Draw 3D Asteroid Pipeline Corridor (Hexagonal Rings + Guide Rails)
      // ------------------------------------------------------------------------
      const ringSpacing = 2.5;
      const hexRadius = 3.6;
      const hexAngles = [0, Math.PI/3, 2*Math.PI/3, Math.PI, 4*Math.PI/3, 5*Math.PI/3];

      // Main Guidance Trajectory Line
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

      // Hexagonal Portal Rings
      for (let rx = 0.0; rx <= 50.0; rx += ringSpacing) {
        const ry = getPipelineY(rx);
        const isPast = (rx < shipX - 1.0);
        const isNext = (!isPast && rx <= shipX + ringSpacing);

        let ringColor = isNext ? '#38bdf8' : (isPast ? '#059669' : '#0284c7');
        if (isNext && Math.abs(tlm.cross_track_err || 0) > 0.4) {
          ringColor = '#ef4444';
        }

        const isGate = (rx > 0 && Math.abs(rx % 5.0) < 0.1 && rx < 49.0);
        const gateIdx = isGate ? Math.round(rx / 5.0) : 0;

        ctx.strokeStyle = ringColor;
        ctx.shadowColor = ringColor;
        ctx.shadowBlur = isNext ? 12 : (isGate ? 8 : 4);
        ctx.lineWidth = isNext ? 2.8 : (isGate ? 2.0 : 1.0);

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

          // Gate Header HUD Label
          if (isGate) {
            const topPt = hexPoints[0];
            if (topPt) {
              ctx.save();
              ctx.fillStyle = isPast ? '#10b981' : (isNext ? '#38bdf8' : '#94a3b8');
              ctx.font = 'bold 11px monospace';
              ctx.textAlign = 'center';
              ctx.shadowColor = isNext ? '#38bdf8' : '#000000';
              ctx.shadowBlur = 4;
              ctx.fillText(`GATE ${String(gateIdx).padStart(2, '0')}`, topPt.sx, topPt.sy - 8);
              ctx.restore();
            }
          }

          // Ground struts
          const bottomPt = hexPoints[4];
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

      // Longitudinal Tunnel Rails
      const railOffsets = [
        { dy: 0, dz: hexRadius },
        { dy: -hexRadius, dz: 0 },
        { dy: hexRadius, dz: 0 }
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

      // ------------------------------------------------------------------------
      // 4. Draw True 3D Spacecraft Polyhedral Model with Yaw & Bank Roll
      // ------------------------------------------------------------------------
      const isGhost = tlm.carrier_lost || tlm.fdir_mode === 1;
      const shipColor = isGhost ? '#f59e0b' : '#38bdf8';
      ctx.strokeStyle = shipColor;
      ctx.shadowColor = shipColor;
      ctx.shadowBlur = isGhost ? 4 : 12;
      ctx.lineWidth = 2.0;
      if (isGhost) ctx.setLineDash([4, 4]);

      const cosSY = Math.cos(shipYaw);
      const sinSY = Math.sin(shipYaw);
      const cosSB = Math.cos(rawBank);
      const sinSB = Math.sin(rawBank);

      const transformShipPoint = (bx, by, bz) => {
        // Roll around ship body X axis
        const ry = by * cosSB - bz * sinSB;
        const rz = by * sinSB + bz * cosSB;
        // Yaw around World Z axis
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
        keel: transformShipPoint(-0.4, 0, -0.4),
        rcsBowL: transformShipPoint(0.8, -0.65, 0),
        rcsBowR: transformShipPoint(0.8, 0.65, 0),
        rcsSternL: transformShipPoint(-1.3, -1.8, 0),
        rcsSternR: transformShipPoint(-1.3, 1.8, 0)
      };

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

      // Cockpit Canopy
      draw3DEdge(V.nose, V.canopy);
      draw3DEdge(V.wingL, V.canopy);
      draw3DEdge(V.wingR, V.canopy);

      // Vertical Stabilizer Fins
      draw3DEdge(V.nozzleL, V.finL);
      draw3DEdge(V.canopy, V.finL);
      draw3DEdge(V.nozzleR, V.finR);
      draw3DEdge(V.canopy, V.finR);

      // Ventral Keel
      draw3DEdge(V.nose, V.keel);
      draw3DEdge(V.wingL, V.keel);
      draw3DEdge(V.wingR, V.keel);

      // Internal Reaction Wheel Flywheel Disk (Center of Mass)
      const wheelAngle = (now * 0.001 * ((tlm.wheel_rpm || 0) * 0.1)) % (Math.PI * 2);
      const rwRadius = 0.45;
      const rwSegments = 8;
      const rwPts = [];
      for (let i = 0; i < rwSegments; i++) {
        const a = wheelAngle + (i * Math.PI * 2 / rwSegments);
        rwPts.push(transformShipPoint(-0.4 + Math.cos(a) * rwRadius * 0.6, Math.sin(a) * rwRadius, 0.1));
      }
      ctx.strokeStyle = Math.abs(tlm.wheel_rpm || 0) > 5000 ? '#ef4444' : '#ec4899';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < rwSegments; i++) {
        const next = (i + 1) % rwSegments;
        if (rwPts[i] && rwPts[next]) {
          ctx.moveTo(rwPts[i].sx, rwPts[i].sy);
          ctx.lineTo(rwPts[next].sx, rwPts[next].sy);
        }
      }
      ctx.stroke();
      if (rwPts[0] && rwPts[4]) {
        ctx.moveTo(rwPts[0].sx, rwPts[0].sy); ctx.lineTo(rwPts[4].sx, rwPts[4].sy);
      }
      if (rwPts[2] && rwPts[6]) {
        ctx.moveTo(rwPts[2].sx, rwPts[2].sy); ctx.lineTo(rwPts[6].sx, rwPts[6].sy);
      }
      ctx.stroke();

      // RCS Pod Hardware Brackets
      const drawRcsPod = (p) => {
        if (!p) return;
        ctx.fillStyle = '#f59e0b';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 4;
        ctx.fillRect(p.sx - 2.5, p.sy - 2.5, 5, 5);
      };
      drawRcsPod(V.rcsBowL);
      drawRcsPod(V.rcsBowR);
      drawRcsPod(V.rcsSternL);
      drawRcsPod(V.rcsSternR);

      // Optical Line Sensor Bar ahead of nose
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

      // Main Engine Thruster Plumes (Active Forward Thrust & Cruise Burn)
      const hasFuel = (tlm.fuel === undefined || tlm.fuel > 0);
      const isCruising = ((tlm.vel_x || 0) > 0.05);
      const actualFx = (tlm.thrust_x !== undefined) ? tlm.thrust_x : (isCruising ? 0.15 : 0.0);

      if ((actualFx > 0.005 || (isCruising && actualFx >= -0.005)) && hasFuel) {
        // Forward Acceleration / Cruise Thrust:
        // Even during steady turns or cruise, produce prominent twin plasma plumes
        const cmdPower = (actualFx > 0.005) ? actualFx : 0.08;
        const throttle = Math.min(1.0, Math.max(0.20, cmdPower / 0.25));
        const plumeLen = 0.6 + throttle * (1.6 + Math.random() * 0.5);
        const jitter = (Math.random() - 0.5) * 0.12 * throttle;

        // Outer Plasma Sheath (Bright Cyan Blue)
        ctx.strokeStyle = '#38bdf8';
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 10 + throttle * 15;
        ctx.lineWidth = 1.8 + throttle * 2.2;
        ctx.setLineDash([]);

        const pTipL = transformShipPoint(-1.6 - plumeLen, -0.4, (Math.random() - 0.5) * 0.15 * throttle);
        const pTipR = transformShipPoint(-1.6 - plumeLen, 0.4, (Math.random() - 0.5) * 0.15 * throttle);
        draw3DEdge(V.nozzleL, pTipL);
        draw3DEdge(V.nozzleR, pTipR);

        // Core Plasma Flame (Hyper-Hot Orange/White)
        ctx.strokeStyle = throttle > 0.5 ? '#ffffff' : '#fb923c';
        ctx.shadowColor = '#f97316';
        ctx.shadowBlur = 8 + throttle * 12;
        ctx.lineWidth = 1.2 + throttle * 1.5;
        const pTipMid = transformShipPoint(-1.6 - plumeLen * 1.25, 0.0, jitter);
        draw3DEdge(V.nozzleL, pTipMid);
        draw3DEdge(V.nozzleR, pTipMid);

        // Twin nozzle flare crossbars for high visual presence
        const flareSpread = 0.25 + throttle * 0.15;
        const pFlL1 = transformShipPoint(-1.7, -0.4 - flareSpread, 0);
        const pFlL2 = transformShipPoint(-1.7, -0.4 + flareSpread, 0);
        const pFlR1 = transformShipPoint(-1.7, 0.4 - flareSpread, 0);
        const pFlR2 = transformShipPoint(-1.7, 0.4 + flareSpread, 0);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.0;
        draw3DEdge(pFlL1, pFlL2);
        draw3DEdge(pFlR1, pFlR2);
      } else if (actualFx < -0.005 && hasFuel) {
        // Reverse Braking: Forward retrograde plumes from bow nozzles
        const throttle = Math.min(1.0, Math.abs(actualFx) / 0.25);
        const revLen = 0.4 + throttle * (1.2 + Math.random() * 0.5);

        ctx.strokeStyle = '#f59e0b';
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 8 + throttle * 12;
        ctx.lineWidth = 1.5 + throttle * 1.5;
        ctx.setLineDash([]);

        const pRevL = transformShipPoint(2.2 + revLen, -0.35, 0.0);
        const pRevR = transformShipPoint(2.2 + revLen, 0.35, 0.0);
        draw3DEdge(V.nose, pRevL);
        draw3DEdge(V.nose, pRevR);
      }

      // RCS Cold-Gas Plumes (Proportional to Actual Firing Commands: Torque & Lateral)
      const effTorque = (tlm.torque !== undefined) ? tlm.torque : 0.0;
      const effLat = (tlm.thrust_y !== undefined) ? tlm.thrust_y : 0.0;

      const drawRcsJet = (bx, by, bz, dirY, dirX = 0, power = 0.15) => {
        const normPower = Math.min(1.0, Math.max(0.2, power / 0.25));
        const jetLen = normPower * (0.75 + Math.random() * 0.45);
        const pBase = transformShipPoint(bx, by, bz);
        const pTip = transformShipPoint(bx + dirX * jetLen, by + dirY * jetLen, bz + (Math.random() - 0.5) * 0.12 * normPower);
        if (pBase && pTip) {
          ctx.strokeStyle = '#38bdf8';
          ctx.shadowColor = '#00f0ff';
          ctx.shadowBlur = 4 + normPower * 10;
          ctx.lineWidth = 1.0 + normPower * 1.8;
          ctx.beginPath();
          ctx.moveTo(pBase.sx, pBase.sy);
          ctx.lineTo(pTip.sx, pTip.sy);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.lineWidth = 0.8 + normPower * 0.8;
          ctx.beginPath();
          ctx.moveTo(pBase.sx, pBase.sy);
          ctx.lineTo(pTip.sx + (Math.random() - 0.5) * 3, pTip.sy + (Math.random() - 0.5) * 3);
          ctx.stroke();
        }
      };

      // Attitude Yaw RCS Plumes (Proportional to effTorque)
      if (effTorque > 0.015) {
        drawRcsJet(0.8, 0.65, 0, 1.0, 0, effTorque);
        drawRcsJet(-1.3, -1.8, 0, -1.0, 0, effTorque);
      }
      if (effTorque < -0.015) {
        drawRcsJet(0.8, -0.65, 0, -1.0, 0, -effTorque);
        drawRcsJet(-1.3, 1.8, 0, 1.0, 0, -effTorque);
      }

      // Lateral Translation RCS Plumes (Proportional to effLat)
      if (effLat > 0.015) {
        drawRcsJet(0.8, 0.65, 0, 0.8, 0, effLat);
        drawRcsJet(-1.3, 1.8, 0, 0.8, 0, effLat);
      }
      if (effLat < -0.015) {
        drawRcsJet(0.8, -0.65, 0, -0.8, 0, -effLat);
        drawRcsJet(-1.3, -1.8, 0, -0.8, 0, -effLat);
      }

      // Vertical Roll RCS Jet Plumes (Proportional to Bank Angle)
      if (Math.abs(rawBank) > 0.04) {
        const rollDir = rawBank > 0 ? 1.0 : -1.0;
        const normRoll = Math.min(1.0, Math.abs(rawBank) / 0.18);
        const rollLen = normRoll * (0.6 + Math.random() * 0.35);
        const drawRollJet = (bx, by, dirZ) => {
          const pBase = transformShipPoint(bx, by, 0.0);
          const pTip = transformShipPoint(bx, by, dirZ * rollLen);
          if (pBase && pTip) {
            ctx.strokeStyle = '#38bdf8';
            ctx.shadowColor = '#00f0ff';
            ctx.shadowBlur = 4 + normRoll * 8;
            ctx.lineWidth = 1.0 + normRoll * 1.5;
            ctx.beginPath();
            ctx.moveTo(pBase.sx, pBase.sy);
            ctx.lineTo(pTip.sx, pTip.sy);
            ctx.stroke();
          }
        };
        drawRollJet(-1.3, -1.8, rollDir);
        drawRollJet(-1.3, 1.8, -rollDir);
      }

      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      // 5. Tactical HUD Crosshairs ahead of ship
      const aimPt = project3D(shipX + 10.0, getPipelineY(shipX + 10.0), 0.0);
      if (aimPt) {
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(aimPt.sx, aimPt.sy, 8, 0, Math.PI * 2);
        ctx.moveTo(aimPt.sx - 12, aimPt.sy); ctx.lineTo(aimPt.sx + 12, aimPt.sy);
        ctx.moveTo(aimPt.sx, aimPt.sy - 12); ctx.lineTo(aimPt.sx, aimPt.sy + 12);
        ctx.stroke();
      }

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, []); // Continuous 60FPS render loop

  // Mouse Drag Event Handlers for Intuitive Orbit View
  const handleMouseDown = (e) => {
    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      baseYaw: userOffset.yaw,
      basePitch: userOffset.pitch
    };
  };

  const handleMouseMove = (e) => {
    if (!dragRef.current.isDragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setUserOffset({
      yaw: dragRef.current.baseYaw + dx * 0.006,
      pitch: Math.max(-1.3, Math.min(1.3, dragRef.current.basePitch + dy * 0.006))
    });
  };

  const handleMouseUp = () => {
    dragRef.current.isDragging = false;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.4, Math.min(2.5, +(z + delta).toFixed(1))));
  };

  const resetView = () => {
    setUserOffset({ yaw: 0.0, pitch: 0.0 });
    setZoom(1.0);
  };

  const isManualOffset = (Math.abs(userOffset.yaw) > 0.01 || Math.abs(userOffset.pitch) > 0.01 || zoom !== 1.0);

  return React.createElement('div', {
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#030712',
      overflow: 'hidden',
      userSelect: 'none'
    }
  },
    // Top Control Bar: Camera Presets & Cinema Mode
    React.createElement('div', {
      style: {
        position: 'absolute',
        top: '10px',
        right: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        zIndex: 20
      }
    },
      [
        { id: 'chase', label: 'CHASE' },
        { id: 'nose', label: 'FRONT' },
        { id: 'hero', label: 'HERO' },
        { id: 'orbit', label: 'PATROL' },
        { id: 'cinema', label: cameraPreset === 'cinema' ? `CINEMA [CAM ${cinemaIndex + 1}/4]` : 'CINEMA (AUTO)' }
      ].map(preset =>
        React.createElement('button', {
          key: preset.id,
          onClick: () => {
            setCameraPreset(preset.id);
            setUserOffset({ yaw: 0.0, pitch: 0.0 });
          },
          style: {
            padding: '4px 9px',
            fontSize: '10px',
            fontFamily: 'monospace',
            fontWeight: 'bold',
            borderRadius: '4px',
            border: cameraPreset === preset.id
              ? (preset.id === 'cinema' ? '1px solid #f59e0b' : '1px solid #00f0ff')
              : '1px solid #1e293b',
            background: cameraPreset === preset.id
              ? (preset.id === 'cinema' ? 'rgba(245, 158, 11, 0.25)' : 'rgba(0, 240, 255, 0.25)')
              : 'rgba(15, 23, 42, 0.85)',
            color: cameraPreset === preset.id
              ? (preset.id === 'cinema' ? '#f59e0b' : '#00f0ff')
              : '#94a3b8',
            cursor: 'pointer',
            transition: 'all 0.15s ease'
          }
        }, preset.label)
      )
    ),

    // Top-Left Control Bar: Zoom Slider & View Reset
    React.createElement('div', {
      style: {
        position: 'absolute',
        top: '10px',
        left: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'rgba(15, 23, 42, 0.85)',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid #1e293b',
        zIndex: 20,
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#94a3b8'
      }
    },
      React.createElement('span', { style: { fontWeight: 'bold', color: '#38bdf8' } }, 'ZOOM:'),
      React.createElement('input', {
        type: 'range',
        min: '0.4',
        max: '2.5',
        step: '0.1',
        value: zoom,
        onChange: (e) => setZoom(parseFloat(e.target.value)),
        style: {
          width: '75px',
          cursor: 'pointer',
          accentColor: '#00f0ff'
        }
      }),
      React.createElement('span', { style: { minWidth: '32px', textAlign: 'right', color: '#e2e8f0', fontWeight: 'bold' } }, `${zoom.toFixed(1)}x`),
      isManualOffset && React.createElement('button', {
        onClick: resetView,
        style: {
          marginLeft: '4px',
          padding: '2px 6px',
          fontSize: '9px',
          borderRadius: '3px',
          border: '1px solid #38bdf8',
          background: 'rgba(56, 189, 248, 0.2)',
          color: '#38bdf8',
          cursor: 'pointer',
          fontWeight: 'bold'
        }
      }, 'RESET VIEW')
    ),

    // 3D Perspective Canvas with Mouse Drag and Wheel Listeners
    React.createElement('canvas', {
      ref: canvasRef,
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp,
      onMouseLeave: handleMouseUp,
      onWheel: handleWheel,
      style: {
        width: '100%',
        height: '100%',
        display: 'block',
        cursor: dragRef.current.isDragging ? 'grabbing' : 'grab'
      }
    }),

    // Bottom-Right Interactive Hint Badge
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: '8px',
        right: '12px',
        color: '#64748b',
        fontSize: '10px',
        fontFamily: 'monospace',
        background: 'rgba(3, 7, 18, 0.7)',
        padding: '2px 8px',
        borderRadius: '4px',
        border: '1px solid #1e293b',
        pointerEvents: 'none'
      }
    }, 'DRAG: 3D Orbit Rotate | WHEEL: Zoom'),

    // Bottom-Left Telemetry & Actuator Overlay
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: '8px',
        left: '12px',
        color: '#94a3b8',
        fontSize: '11px',
        fontFamily: 'monospace',
        background: 'rgba(3, 7, 18, 0.8)',
        padding: '3px 10px',
        borderRadius: '4px',
        border: '1px solid #1e293b',
        display: 'flex',
        gap: '12px'
      }
    },
      React.createElement('span', null, `POS: (${telemetry.pos_x.toFixed(2)}m, ${telemetry.pos_y.toFixed(2)}m)`),
      React.createElement('span', null, `VEL: ${telemetry.vel_x.toFixed(2)} m/s`),
      React.createElement('span', null, `ERR: ${(telemetry.cross_track_err || 0).toFixed(3)}m`),
      React.createElement('span', {
        style: {
          color: Math.abs(telemetry.wheel_rpm || 0) > 5000 ? '#ef4444' : '#ec4899',
          fontWeight: 'bold'
        }
      }, `RW: ${(telemetry.wheel_rpm || 0).toFixed(0)} RPM ${Math.abs(telemetry.wheel_rpm || 0) > 5000 ? '[DESAT]' : ''}`)
    )
  );
}
