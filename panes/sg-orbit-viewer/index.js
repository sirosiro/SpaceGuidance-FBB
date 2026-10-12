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
      // 3. Draw Track / World Structures based on Active Stage ID
      // ------------------------------------------------------------------------
      const ringSpacing = 2.5;
      const hexRadius = 3.6;
      const hexAngles = [0, Math.PI/3, 2*Math.PI/3, Math.PI, 4*Math.PI/3, 5*Math.PI/3];
      const stageId = tlm.stage_id || 1;

      if (stageId === 2) {
        // --------------------------------------------------------------------
        // Stage 2: 100m High-Tension Carbon Nanotube Tether Cable & Environments
        // [Origin: GEO Orbital Habitat Station (0m) -> Terminal: Asteroid Mining Base (100m)]
        // --------------------------------------------------------------------
        const cableLength = 100.0;
        const isRuptured = !!tlm.cable_snapped;
        const cableTension = tlm.cable_tension || 10000;
        const cableColor = isRuptured ? '#ef4444' : (cableTension > 13000 ? '#f97316' : '#38bdf8');

        // ====================================================================
        // A. STARTING TERMINUS (0m): Geostationary Orbital Station (GEO Station)
        // ====================================================================
        const stationRot = (now * 0.0003) % (Math.PI * 2);
        const geoX = -2.5;
        const torusR = 9.0;
        const torusInnerR = 7.2;

        // 1. Massive Rotating Habitat Torus Ring in Y-Z plane
        ctx.strokeStyle = '#0284c7';
        ctx.shadowColor = '#0284c7';
        ctx.shadowBlur = 6;
        ctx.lineWidth = 1.6;

        const torusOuterPts = [];
        const torusInnerPts = [];
        const torusSegs = 20;
        for (let i = 0; i < torusSegs; i++) {
          const a = stationRot + (i * Math.PI * 2 / torusSegs);
          const pOut = project3D(geoX, torusR * Math.sin(a), torusR * Math.cos(a));
          const pIn  = project3D(geoX, torusInnerR * Math.sin(a), torusInnerR * Math.cos(a));
          if (pOut) torusOuterPts.push(pOut);
          if (pIn) torusInnerPts.push(pIn);
        }

        if (torusOuterPts.length === torusSegs && torusInnerPts.length === torusSegs) {
          // Outer ring
          ctx.beginPath();
          ctx.moveTo(torusOuterPts[0].sx, torusOuterPts[0].sy);
          for (let i = 1; i < torusSegs; i++) ctx.lineTo(torusOuterPts[i].sx, torusOuterPts[i].sy);
          ctx.closePath();
          ctx.stroke();

          // Inner ring
          ctx.beginPath();
          ctx.moveTo(torusInnerPts[0].sx, torusInnerPts[0].sy);
          for (let i = 1; i < torusSegs; i++) ctx.lineTo(torusInnerPts[i].sx, torusInnerPts[i].sy);
          ctx.closePath();
          ctx.stroke();

          // Window modules & cross bulkheads
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1.0;
          for (let i = 0; i < torusSegs; i += 2) {
            ctx.beginPath();
            ctx.moveTo(torusOuterPts[i].sx, torusOuterPts[i].sy);
            ctx.lineTo(torusInnerPts[i].sx, torusInnerPts[i].sy);
            ctx.stroke();
          }
        }

        // 2. 4 Structural Spoke Trusses connecting Hub to Torus
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1.4;
        const hubCenter = project3D(geoX, 0, 0);
        for (let k = 0; k < 4; k++) {
          const a = stationRot + (k * Math.PI / 2);
          const pSpokeEnd = project3D(geoX, torusInnerR * Math.sin(a), torusInnerR * Math.cos(a));
          if (hubCenter && pSpokeEnd) {
            ctx.beginPath();
            ctx.moveTo(hubCenter.sx, hubCenter.sy);
            ctx.lineTo(pSpokeEnd.sx, pSpokeEnd.sy);
            ctx.stroke();
          }
        }

        // 3. Central Mooring Core & Tether Anchor Sleeve (X from -6m to +0.5m)
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.0;
        const pAnchorEntry = project3D(0.0, 0, 0);
        const pAnchorBack  = project3D(-6.0, 0, 0);
        const hubCollarPts = [];
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI * 2 / 8);
          const pt = project3D(0.2, 2.2 * Math.sin(a), 2.2 * Math.cos(a));
          if (pt) hubCollarPts.push(pt);
        }
        if (hubCollarPts.length === 8) {
          ctx.beginPath();
          ctx.moveTo(hubCollarPts[0].sx, hubCollarPts[0].sy);
          for (let i = 1; i < 8; i++) ctx.lineTo(hubCollarPts[i].sx, hubCollarPts[i].sy);
          ctx.closePath();
          ctx.stroke();
        }

        // 4. Giant Photovoltaic Solar Array Wings (Upper & Lower Z)
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.2;
        const solarZOffsets = [
          { z1: 3.5, z2: 10.5 },
          { z1: -10.5, z2: -3.5 }
        ];
        for (const s of solarZOffsets) {
          const sp1 = project3D(geoX - 1.2, -2.4, s.z1);
          const sp2 = project3D(geoX - 1.2, 2.4, s.z1);
          const sp3 = project3D(geoX - 1.2, 2.4, s.z2);
          const sp4 = project3D(geoX - 1.2, -2.4, s.z2);
          if (sp1 && sp2 && sp3 && sp4) {
            ctx.beginPath();
            ctx.moveTo(sp1.sx, sp1.sy);
            ctx.lineTo(sp2.sx, sp2.sy);
            ctx.lineTo(sp3.sx, sp3.sy);
            ctx.lineTo(sp4.sx, sp4.sy);
            ctx.closePath();
            ctx.stroke();
            // Solar rib grid
            const sm1 = project3D(geoX - 1.2, 0, s.z1);
            const sm2 = project3D(geoX - 1.2, 0, s.z2);
            if (sm1 && sm2) {
              ctx.moveTo(sm1.sx, sm1.sy);
              ctx.lineTo(sm2.sx, sm2.sy);
              ctx.stroke();
            }
          }
        }

        // GEO Station HUD Label
        if (torusOuterPts.length > 0) {
          const topTorus = project3D(geoX, 0, torusR);
          if (topTorus) {
            ctx.save();
            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('GEO ORBITAL STATION [ALPHA ANCHOR]', topTorus.sx, topTorus.sy - 10);
            ctx.restore();
          }
        }

        // ====================================================================
        // B. 100m High-Tension Carbon Nanotube Tether Cable (String Wave)
        // ====================================================================
        ctx.strokeStyle = cableColor;
        ctx.shadowColor = cableColor;
        ctx.shadowBlur = isRuptured ? 16 : 8;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        let firstCablePt = true;
        for (let px = 0.0; px <= cableLength; px += 1.0) {
          const vibOffset = (tlm.cable_vibration || 0.0) * Math.sin((px / cableLength) * Math.PI);
          const pt = project3D(px, vibOffset, 0.0);
          if (pt) {
            if (firstCablePt) { ctx.moveTo(pt.sx, pt.sy); firstCablePt = false; }
            else { ctx.lineTo(pt.sx, pt.sy); }
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Draw altitude beacon rings every 10m (10m .. 90m)
        for (let rx = 10.0; rx <= 90.0; rx += 10.0) {
          const isPassed = rx < shipX - 1.0;
          const ringColor = isPassed ? '#059669' : '#0284c7';
          const ringRad = 2.5;

          ctx.strokeStyle = ringColor;
          ctx.shadowColor = ringColor;
          ctx.shadowBlur = 4;
          ctx.lineWidth = 1.2;

          const circlePts = [];
          for (let i = 0; i < 12; i++) {
            const a = (i * Math.PI * 2) / 12;
            const pt = project3D(rx, ringRad * Math.sin(a), ringRad * Math.cos(a));
            if (pt) circlePts.push(pt);
          }
          if (circlePts.length === 12) {
            ctx.beginPath();
            ctx.moveTo(circlePts[0].sx, circlePts[0].sy);
            for (let i = 1; i < 12; i++) ctx.lineTo(circlePts[i].sx, circlePts[i].sy);
            ctx.closePath();
            ctx.stroke();

            const topPt = circlePts[0];
            if (topPt) {
              ctx.save();
              ctx.fillStyle = isPassed ? '#10b981' : '#94a3b8';
              ctx.font = '10px monospace';
              ctx.textAlign = 'center';
              ctx.fillText(`BEACON ${Math.round(rx/10)} (${rx.toFixed(0)}m)`, topPt.sx, topPt.sy - 8);
              ctx.restore();
            }
          }
        }

        // ====================================================================
        // C. GOAL TERMINUS (100m): Asteroid Mining Base (小惑星採掘基地)
        // ====================================================================
        const astX = 110.0;
        const astBaseR = 12.0;

        // 1. 3D Wireframe Irregular Asteroid Rock Face
        ctx.strokeStyle = '#78716c';
        ctx.lineWidth = 1.0;
        ctx.shadowBlur = 0;

        const latCount = 7;
        const lonCount = 12;
        const astGrid = [];

        for (let la = 0; la < latCount; la++) {
          const lat = -Math.PI / 2 + (la + 0.5) * Math.PI / latCount;
          const ringPts = [];
          for (let lo = 0; lo < lonCount; lo++) {
            const lon = lo * 2 * Math.PI / lonCount;
            // Craggy surface perturbation
            const rDispl = astBaseR + 2.4 * Math.sin(lat * 3) * Math.cos(lon * 2) + 1.2 * Math.sin(lon * 4 + 1.0);
            const px = astX + rDispl * Math.cos(lat) * Math.cos(lon);
            const py = rDispl * Math.cos(lat) * Math.sin(lon);
            const pz = rDispl * Math.sin(lat);
            const pt = project3D(px, py, pz);
            ringPts.push(pt);
          }
          astGrid.push(ringPts);

          // Draw latitude line
          ctx.beginPath();
          let fPt = true;
          for (let lo = 0; lo < lonCount; lo++) {
            const p = ringPts[lo];
            if (p) {
              if (fPt) { ctx.moveTo(p.sx, p.sy); fPt = false; }
              else { ctx.lineTo(p.sx, p.sy); }
            }
          }
          if (ringPts[0] && !fPt) ctx.lineTo(ringPts[0].sx, ringPts[0].sy);
          ctx.stroke();
        }

        // Draw longitude meridian lines on asteroid
        for (let lo = 0; lo < lonCount; lo++) {
          ctx.beginPath();
          let fPt = true;
          for (let la = 0; la < latCount; la++) {
            const p = astGrid[la][lo];
            if (p) {
              if (fPt) { ctx.moveTo(p.sx, p.sy); fPt = false; }
              else { ctx.lineTo(p.sx, p.sy); }
            }
          }
          ctx.stroke();
        }

        // 2. High-Tension Cable Anchor Rig & Steel Gantry Tower (X from 98m to 104m)
        ctx.strokeStyle = '#eab308';
        ctx.shadowColor = '#eab308';
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2.4;

        // Terminal Docking Clamp Ring at X=100.0m
        const dockCollarPts = [];
        for (let i = 0; i < 12; i++) {
          const a = (i * Math.PI * 2 / 12);
          const pt = project3D(100.0, 3.8 * Math.sin(a), 3.8 * Math.cos(a));
          if (pt) dockCollarPts.push(pt);
        }
        if (dockCollarPts.length === 12) {
          ctx.beginPath();
          ctx.moveTo(dockCollarPts[0].sx, dockCollarPts[0].sy);
          for (let i = 1; i < 12; i++) ctx.lineTo(dockCollarPts[i].sx, dockCollarPts[i].sy);
          ctx.closePath();
          ctx.stroke();
        }

        // 4 Anchor Footings bolted into Asteroid Rock face
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.6;
        for (let k = 0; k < 4; k++) {
          const a = k * Math.PI / 2 + Math.PI / 4;
          const pClamp = project3D(100.0, 3.8 * Math.sin(a), 3.8 * Math.cos(a));
          const pAnchorRock = project3D(104.5, 6.5 * Math.sin(a), 6.5 * Math.cos(a));
          if (pClamp && pAnchorRock) {
            ctx.beginPath();
            ctx.moveTo(pClamp.sx, pClamp.sy);
            ctx.lineTo(pAnchorRock.sx, pAnchorRock.sy);
            ctx.stroke();
          }
        }

        // 3. Mining Excavation Core Drill Rig & Geodesic Habitat Domes
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.2;
        // Mining Dome at surface
        const domeCenter = { x: 102.5, y: 5.5, z: 3.5, r: 2.4 };
        const domePts = [];
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI * 2 / 8;
          const pt = project3D(domeCenter.x, domeCenter.y + domeCenter.r * Math.cos(a), domeCenter.z + domeCenter.r * Math.sin(a));
          if (pt) domePts.push(pt);
        }
        if (domePts.length === 8) {
          ctx.beginPath();
          ctx.moveTo(domePts[0].sx, domePts[0].sy);
          for (let i = 1; i < 8; i++) ctx.lineTo(domePts[i].sx, domePts[i].sy);
          ctx.closePath();
          ctx.stroke();
        }

        // Terminal Label
        if (dockCollarPts.length > 0) {
          const topDock = dockCollarPts[0];
          if (topDock) {
            ctx.save();
            ctx.fillStyle = '#fde047';
            ctx.font = 'bold 12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('ASTEROID MINING BASE [TERMINAL PORT]', topDock.sx, topDock.sy - 12);
            ctx.restore();
          }
        }
        ctx.shadowBlur = 0;
      } else if (stageId === 3) {
        // --------------------------------------------------------------------
        // Stage 3: 60m ISS Modular Box Truss Structure with Inspection Nodes
        // --------------------------------------------------------------------
        const trussLength = 60.0;
        const halfW = 1.6;
        const halfH = 1.6;
        const cornerOffsets = [
          { dy: -halfW, dz: -halfH },
          { dy: halfW, dz: -halfH },
          { dy: halfW, dz: halfH },
          { dy: -halfW, dz: halfH }
        ];

        // 4 Main Longitudinal Steel Chords / Guide Rails
        for (let c = 0; c < 4; c++) {
          ctx.strokeStyle = (c === 2 || c === 3) ? '#0284c7' : '#475569';
          ctx.lineWidth = (c === 2) ? 2.5 : 1.2;
          ctx.beginPath();
          let firstP = true;
          for (let rx = 0.0; rx <= trussLength; rx += 2.0) {
            const pt = project3D(rx, cornerOffsets[c].dy, cornerOffsets[c].dz);
            if (pt) {
              if (firstP) { ctx.moveTo(pt.sx, pt.sy); firstP = false; }
              else { ctx.lineTo(pt.sx, pt.sy); }
            }
          }
          ctx.stroke();
        }

        // Cross Bulkheads and Diagonal Bracing every 5m
        for (let bx = 0.0; bx <= trussLength; bx += 5.0) {
          const bPts = [];
          for (const co of cornerOffsets) {
            const pt = project3D(bx, co.dy, co.dz);
            if (pt) bPts.push(pt);
          }
          if (bPts.length === 4) {
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(bPts[0].sx, bPts[0].sy);
            ctx.lineTo(bPts[1].sx, bPts[1].sy);
            ctx.lineTo(bPts[2].sx, bPts[2].sy);
            ctx.lineTo(bPts[3].sx, bPts[3].sy);
            ctx.closePath();
            // Diagonal brace
            ctx.moveTo(bPts[0].sx, bPts[0].sy);
            ctx.lineTo(bPts[2].sx, bPts[2].sy);
            ctx.stroke();
          }
        }

        // 4 Critical Inspection Joints (15m, 30m, 45m, 60m)
        const joints = [
          { x: 15.0, name: 'JOINT 01: S1 TRUSS' },
          { x: 30.0, name: 'JOINT 02: SARJ ROTARY' },
          { x: 45.0, name: 'JOINT 03: P1 TRUSS' },
          { x: 60.0, name: 'TERMINAL: DOCK LATCH' }
        ];

        for (const j of joints) {
          const isPassed = j.x < shipX - 0.5;
          const isClose = Math.abs(shipX - j.x) <= 0.6;
          const jColor = isClose ? '#facc15' : (isPassed ? '#10b981' : '#38bdf8');

          ctx.strokeStyle = jColor;
          ctx.shadowColor = jColor;
          ctx.shadowBlur = isClose ? 16 : 6;
          ctx.lineWidth = isClose ? 3.0 : 1.8;

          const jPts = [];
          for (let i = 0; i < 8; i++) {
            const a = (i * Math.PI * 2) / 8;
            const pt = project3D(j.x, 2.8 * Math.sin(a), 2.8 * Math.cos(a));
            if (pt) jPts.push(pt);
          }
          if (jPts.length === 8) {
            ctx.beginPath();
            ctx.moveTo(jPts[0].sx, jPts[0].sy);
            for (let i = 1; i < 8; i++) ctx.lineTo(jPts[i].sx, jPts[i].sy);
            ctx.closePath();
            ctx.stroke();

            ctx.save();
            ctx.fillStyle = jColor;
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(j.name, jPts[0].sx, jPts[0].sy - 10);
            ctx.restore();
          }
        }
        ctx.shadowBlur = 0;
      } else if (stageId === 4) {
        // --------------------------------------------------------------------
        // Stage 4: 50m Deep Space Laser Docking Corridor & Target Station
        // --------------------------------------------------------------------
        const dockDist = 50.0;

        // Central Optical Laser Beam from Station (50m) to Entry Point (0m)
        ctx.strokeStyle = '#22c55e';
        ctx.shadowColor = '#22c55e';
        ctx.shadowBlur = 14;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const pBeamStart = project3D(0.0, 0.0, 0.0);
        const pBeamEnd = project3D(dockDist, 0.0, 0.0);
        if (pBeamStart && pBeamEnd) {
          ctx.moveTo(pBeamStart.sx, pBeamStart.sy);
          ctx.lineTo(pBeamEnd.sx, pBeamEnd.sy);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;

        // Funnel-shaped Approach Corridor Checkpoints
        const checkpoints = [
          { x: 10.0, r: 4.5, name: 'CORRIDOR 40m' },
          { x: 20.0, r: 3.6, name: 'CORRIDOR 30m' },
          { x: 30.0, r: 2.7, name: 'GATEWAY 20m' },
          { x: 40.0, r: 1.8, name: 'APPROACH 10m' },
          { x: 48.0, r: 1.2, name: 'FINAL CONE 2m' }
        ];

        for (const cp of checkpoints) {
          const isPassed = cp.x < shipX - 0.5;
          const cpColor = isPassed ? '#10b981' : '#06b6d4';
          ctx.strokeStyle = cpColor;
          ctx.lineWidth = 1.4;

          const cpPts = [];
          for (let i = 0; i < 12; i++) {
            const a = (i * Math.PI * 2) / 12;
            const pt = project3D(cp.x, cp.r * Math.sin(a), cp.r * Math.cos(a));
            if (pt) cpPts.push(pt);
          }
          if (cpPts.length === 12) {
            ctx.beginPath();
            ctx.moveTo(cpPts[0].sx, cpPts[0].sy);
            for (let i = 1; i < 12; i++) ctx.lineTo(cpPts[i].sx, cpPts[i].sy);
            ctx.closePath();
            ctx.stroke();

            ctx.save();
            ctx.fillStyle = cpColor;
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(cp.name, cpPts[0].sx, cpPts[0].sy - 6);
            ctx.restore();
          }
        }

        // Rotating Docking Station Port Ring at X=50m
        const targetAngle = (Date.now() / 1000.0) * 0.15; // Realistic slow spin
        const portRad = 3.2;
        ctx.strokeStyle = '#eab308';
        ctx.shadowColor = '#eab308';
        ctx.shadowBlur = 12;
        ctx.lineWidth = 2.8;

        const portPts = [];
        for (let i = 0; i < 16; i++) {
          const a = (i * Math.PI * 2) / 16;
          const pt = project3D(dockDist, portRad * Math.sin(a), portRad * Math.cos(a));
          if (pt) portPts.push(pt);
        }
        if (portPts.length === 16) {
          ctx.beginPath();
          ctx.moveTo(portPts[0].sx, portPts[0].sy);
          for (let i = 1; i < 16; i++) ctx.lineTo(portPts[i].sx, portPts[i].sy);
          ctx.closePath();
          ctx.stroke();

          // Rotating crosshairs on docking target
          for (let k = 0; k < 4; k++) {
            const ca = targetAngle + (k * Math.PI / 2);
            const pArm = project3D(dockDist, portRad * Math.sin(ca), portRad * Math.cos(ca));
            const pCenter = project3D(dockDist, 0, 0);
            if (pArm && pCenter) {
              ctx.strokeStyle = '#f59e0b';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(pCenter.sx, pCenter.sy);
              ctx.lineTo(pArm.sx, pArm.sy);
              ctx.stroke();
            }
          }

          ctx.save();
          ctx.fillStyle = '#fde047';
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('TARGET PORT #01 [ROTATING]', portPts[0].sx, portPts[0].sy - 12);
          ctx.restore();
        }
        ctx.shadowBlur = 0;
      } else {
        // --------------------------------------------------------------------
        // Stage 1: Asteroid Surface Pipeline with Hexagonal Safety Ring Tunnel
        // --------------------------------------------------------------------
        for (let rx = 0.0; rx <= 50.0; rx += ringSpacing) {
          const ry = getPipelineY(rx);
          const isPassed = rx < shipX - 1.0;
          const isNext = Math.abs(rx - shipX) < ringSpacing;
          const isGate = (rx > 0 && Math.abs(rx % 5.0) < 0.1 && rx < 49.0);
          const gateIdx = isGate ? Math.round(rx / 5.0) : 0;
          const isTarget = (rx >= 49.0);

          let ringColor = '#0284c7';
          if (isTarget) ringColor = '#eab308';
          else if (isPassed) ringColor = '#059669';
          else if (isNext) ringColor = '#38bdf8';

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

            if (isGate) {
              const topPt = hexPoints[0];
              if (topPt) {
                ctx.save();
                ctx.fillStyle = isPassed ? '#10b981' : (isNext ? '#38bdf8' : '#94a3b8');
                ctx.font = 'bold 11px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`GATE ${String(gateIdx).padStart(2, '0')}`, topPt.sx, topPt.sy - 8);
                ctx.restore();
              }
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
      }
      // ------------------------------------------------------------------------
      // 4. Draw True 3D Spacecraft Polyhedral Model with Yaw & Bank Roll
      // ------------------------------------------------------------------------
      const isGhost = tlm.carrier_lost || tlm.fdir_mode === 1;
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

      const draw3DEdge = (p1, p2) => {
        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      };

      if (stageId === 2) {
        // ====================================================================
        // STAGE 2: Orbital Tether Climber (Gondola, Rollers, Solar Wings)
        // ====================================================================
        const isRuptured = !!tlm.cable_snapped;
        const climberColor = isRuptured ? '#ef4444' : (isGhost ? '#f59e0b' : '#38bdf8');
        ctx.strokeStyle = climberColor;
        ctx.shadowColor = climberColor;
        ctx.shadowBlur = isRuptured ? 16 : 8;
        ctx.lineWidth = 1.8;
        if (isGhost) ctx.setLineDash([4, 4]);
        else ctx.setLineDash([]);

        // 1. Central Cable Guide Rings (Upper Collar at +0.85m, Lower Collar at -0.85m)
        const collarRadii = 0.45;
        const collarX = [0.85, -0.85];
        for (let k = 0; k < 2; k++) {
          const cx = collarX[k];
          const cPts = [];
          for (let i = 0; i < 8; i++) {
            const a = (i * Math.PI * 2) / 8;
            cPts.push(transformShipPoint(cx, collarRadii * Math.sin(a), collarRadii * Math.cos(a)));
          }
          if (cPts.length === 8) {
            ctx.beginPath();
            ctx.moveTo(cPts[0].sx, cPts[0].sy);
            for (let i = 1; i < 8; i++) ctx.lineTo(cPts[i].sx, cPts[i].sy);
            ctx.closePath();
            ctx.stroke();
          }
        }

        // 4 Connecting Titanium Spine Rods between Top and Bottom Collars
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI * 2) / 4 + Math.PI / 4;
          const p1 = transformShipPoint(0.85, collarRadii * Math.sin(a), collarRadii * Math.cos(a));
          const p2 = transformShipPoint(-0.85, collarRadii * Math.sin(a), collarRadii * Math.cos(a));
          draw3DEdge(p1, p2);
        }

        // 2. Spinning Dual Pinch Roller Wheels (Rotating with velocity)
        const rollerAngle = (now * 0.006 * (tlm.vel_x || 0)) % (Math.PI * 2);
        const rollerR = 0.22;
        const rollerXPositions = [0.70, -0.70];
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.4;
        for (const rx of rollerXPositions) {
          // Left pinch roller wheel (by = -0.25)
          const rwL = [];
          for (let i = 0; i < 6; i++) {
            const a = rollerAngle + (i * Math.PI * 2 / 6);
            rwL.push(transformShipPoint(rx + rollerR * Math.cos(a), -0.25, rollerR * Math.sin(a)));
          }
          if (rwL.length === 6) {
            ctx.beginPath();
            ctx.moveTo(rwL[0].sx, rwL[0].sy);
            for (let i = 1; i < 6; i++) ctx.lineTo(rwL[i].sx, rwL[i].sy);
            ctx.closePath();
            ctx.stroke();
            draw3DEdge(rwL[0], rwL[3]);
          }
          // Right pinch roller wheel (by = +0.25)
          const rwR = [];
          for (let i = 0; i < 6; i++) {
            const a = -rollerAngle + (i * Math.PI * 2 / 6);
            rwR.push(transformShipPoint(rx + rollerR * Math.cos(a), 0.25, rollerR * Math.sin(a)));
          }
          if (rwR.length === 6) {
            ctx.beginPath();
            ctx.moveTo(rwR[0].sx, rwR[0].sy);
            for (let i = 1; i < 6; i++) ctx.lineTo(rwR[i].sx, rwR[i].sy);
            ctx.closePath();
            ctx.stroke();
            draw3DEdge(rwR[0], rwR[3]);
          }
        }

        // 3. Central Hexagonal Pressurized Gondola Pod (bx in [-0.5, +0.5])
        ctx.strokeStyle = climberColor;
        ctx.lineWidth = 1.8;
        const gX = [0.5, -0.5];
        const gRadY = 0.95;
        const gRadZ = 0.75;
        const gondolaEnds = [];
        for (let k = 0; k < 2; k++) {
          const gx = gX[k];
          const gPts = [];
          for (let i = 0; i < 6; i++) {
            const a = (i * Math.PI * 2) / 6;
            gPts.push(transformShipPoint(gx, gRadY * Math.sin(a), gRadZ * Math.cos(a)));
          }
          gondolaEnds.push(gPts);
          if (gPts.length === 6) {
            ctx.beginPath();
            ctx.moveTo(gPts[0].sx, gPts[0].sy);
            for (let i = 1; i < 6; i++) ctx.lineTo(gPts[i].sx, gPts[i].sy);
            ctx.closePath();
            ctx.stroke();
          }
        }
        if (gondolaEnds.length === 2 && gondolaEnds[0].length === 6 && gondolaEnds[1].length === 6) {
          for (let i = 0; i < 6; i++) {
            draw3DEdge(gondolaEnds[0][i], gondolaEnds[1][i]);
          }
          // Observation viewport
          draw3DEdge(gondolaEnds[0][0], gondolaEnds[1][3]);
          draw3DEdge(gondolaEnds[0][1], gondolaEnds[1][4]);
        }

        // 4. Dual Photovoltaic Solar Array Wings (Left & Right)
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.5;
        const pLeft = [
          transformShipPoint(0.35, -0.95, 0),
          transformShipPoint(0.35, -2.5, 0),
          transformShipPoint(-0.35, -2.5, 0),
          transformShipPoint(-0.35, -0.95, 0)
        ];
        if (pLeft.every(p => p !== null)) {
          ctx.beginPath();
          ctx.moveTo(pLeft[0].sx, pLeft[0].sy);
          for (let i = 1; i < 4; i++) ctx.lineTo(pLeft[i].sx, pLeft[i].sy);
          ctx.closePath();
          ctx.stroke();
          const m1 = transformShipPoint(0.35, -1.75, 0);
          const m2 = transformShipPoint(-0.35, -1.75, 0);
          draw3DEdge(m1, m2);
        }

        const pRight = [
          transformShipPoint(0.35, 0.95, 0),
          transformShipPoint(0.35, 2.5, 0),
          transformShipPoint(-0.35, 2.5, 0),
          transformShipPoint(-0.35, 0.95, 0)
        ];
        if (pRight.every(p => p !== null)) {
          ctx.beginPath();
          ctx.moveTo(pRight[0].sx, pRight[0].sy);
          for (let i = 1; i < 4; i++) ctx.lineTo(pRight[i].sx, pRight[i].sy);
          ctx.closePath();
          ctx.stroke();
          const m1 = transformShipPoint(0.35, 1.75, 0);
          const m2 = transformShipPoint(-0.35, 1.75, 0);
          draw3DEdge(m1, m2);
        }

        // 5. Optical Mark Scanner Sensor Head pointing inward at central cable
        const pScanStart = transformShipPoint(0.65, 0.35, 0.35);
        const pScanTarget = transformShipPoint(0.65, 0, 0);
        if (pScanStart && pScanTarget) {
          ctx.strokeStyle = '#22c55e';
          ctx.shadowColor = '#22c55e';
          ctx.shadowBlur = 8;
          ctx.lineWidth = 2.2;
          draw3DEdge(pScanStart, pScanTarget);
        }

        // 6. Drive Induction Coil Glow & Reverse Dynamic Braking
        const actualDrive = (tlm.thrust_x !== undefined) ? tlm.thrust_x : 0.0;
        if (Math.abs(actualDrive) > 0.04) {
          const isBraking = (actualDrive < 0);
          const glowColor = isBraking ? '#ef4444' : '#06b6d4';
          ctx.strokeStyle = glowColor;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 14;
          ctx.lineWidth = 2.5;
          const glowX = isBraking ? 0.85 : -0.85;
          const gPts = [];
          for (let i = 0; i < 8; i++) {
            const a = (i * Math.PI * 2) / 8;
            gPts.push(transformShipPoint(glowX, 0.55 * Math.sin(a), 0.55 * Math.cos(a)));
          }
          if (gPts.length === 8) {
            ctx.beginPath();
            ctx.moveTo(gPts[0].sx, gPts[0].sy);
            for (let i = 1; i < 8; i++) ctx.lineTo(gPts[i].sx, gPts[i].sy);
            ctx.closePath();
            ctx.stroke();
          }
        }
        ctx.shadowBlur = 0;
      } else {
        // ====================================================================
        // STAGE 1, 3, 4: Aerospace Spacecraft Fighter / Explorer Model
        // ====================================================================
        const shipColor = isGhost ? '#f59e0b' : '#38bdf8';
        ctx.strokeStyle = shipColor;
        ctx.shadowColor = shipColor;
        ctx.shadowBlur = isGhost ? 4 : 12;
        ctx.lineWidth = 2.0;
        if (isGhost) ctx.setLineDash([4, 4]);

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

        // Main Engine Thruster Plumes
        const hasFuel = (tlm.fuel === undefined || tlm.fuel > 0);
        const isCruising = ((tlm.vel_x || 0) > 0.05);
        const actualFx = (tlm.thrust_x !== undefined) ? tlm.thrust_x : (isCruising ? 0.15 : 0.0);

        if ((actualFx > 0.005 || (isCruising && actualFx >= -0.005)) && hasFuel) {
          const cmdPower = (actualFx > 0.005) ? actualFx : 0.08;
          const throttle = Math.min(1.0, Math.max(0.20, cmdPower / 0.25));
          const plumeLen = 0.6 + throttle * (1.6 + Math.random() * 0.5);
          const jitter = (Math.random() - 0.5) * 0.12 * throttle;

          ctx.strokeStyle = '#38bdf8';
          ctx.shadowColor = '#0284c7';
          ctx.shadowBlur = 16;
          ctx.lineWidth = 2.0 * throttle + 1.0;
          ctx.setLineDash([]);

          const nozL = V.nozzleL;
          const tipL = transformShipPoint(-1.6 - plumeLen, -0.4 + jitter, jitter * 0.5);
          draw3DEdge(nozL, tipL);

          const nozR = V.nozzleR;
          const tipR = transformShipPoint(-1.6 - plumeLen, 0.4 + jitter, -jitter * 0.5);
          draw3DEdge(nozR, tipR);

          // Inner hot plasma core
          ctx.strokeStyle = '#ffffff';
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 8;
          ctx.lineWidth = 1.0;
          const coreL = transformShipPoint(-1.6 - plumeLen * 0.45, -0.4, 0);
          draw3DEdge(nozL, coreL);
          const coreR = transformShipPoint(-1.6 - plumeLen * 0.45, 0.4, 0);
          draw3DEdge(nozR, coreR);
        }

        // Lateral RCS Thruster Jets
        const actualFy = (tlm.thrust_y !== undefined) ? tlm.thrust_y : 0.0;
        if (Math.abs(actualFy) > 0.01 && hasFuel) {
          const jetLen = 0.4 + Math.min(0.8, Math.abs(actualFy) * 1.5);
          ctx.strokeStyle = '#f59e0b';
          ctx.shadowColor = '#d97706';
          ctx.shadowBlur = 10;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([]);

          if (actualFy > 0.01) {
            draw3DEdge(V.rcsBowR, transformShipPoint(0.8, 0.65 + jetLen, 0));
            draw3DEdge(V.rcsSternR, transformShipPoint(-1.3, 1.8 + jetLen, 0));
          } else {
            draw3DEdge(V.rcsBowL, transformShipPoint(0.8, -0.65 - jetLen, 0));
            draw3DEdge(V.rcsSternL, transformShipPoint(-1.3, -1.8 - jetLen, 0));
          }
        }
      }
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
      telemetry.stage_id === 2 ? (
        React.createElement(React.Fragment, null,
          React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, 'STAGE 2: CLIMBER'),
          React.createElement('span', null, `ALT: ${telemetry.pos_x.toFixed(1)}m / 100m`),
          React.createElement('span', null, `VEL: ${telemetry.vel_x.toFixed(2)} m/s`),
          React.createElement('span', {
            style: { color: (telemetry.cable_tension || 10000) > 13000 ? '#ef4444' : '#10b981', fontWeight: 'bold' }
          }, `TENSION: ${Math.round(telemetry.cable_tension || 10000)}N`),
          React.createElement('span', {
            style: { color: Math.abs(telemetry.cable_vibration || 0) > 0.05 ? '#f59e0b' : '#94a3b8' }
          }, `VIB: ${(Math.abs(telemetry.cable_vibration || 0) * 100).toFixed(1)}cm`),
          telemetry.cable_snapped ? React.createElement('span', { style: { color: '#ef4444', fontWeight: 'bold' } }, '[RUPTURED]') : null
        )
      ) : telemetry.stage_id === 3 ? (
        React.createElement(React.Fragment, null,
          React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, 'STAGE 3: ISS TRUSS'),
          React.createElement('span', null, `RAIL: ${telemetry.pos_x.toFixed(1)}m / 60m`),
          React.createElement('span', null, `VEL: ${telemetry.vel_x.toFixed(2)} m/s`),
          React.createElement('span', {
            style: { color: Math.abs(telemetry.cross_track_err || 0) > 250 ? '#ef4444' : '#10b981', fontWeight: 'bold' }
          }, `RAIL LOAD: ${(telemetry.cross_track_err || 0).toFixed(1)}N / 300N`),
          React.createElement('span', null, `BATT: ${(telemetry.fuel || 100).toFixed(1)}%`)
        )
      ) : telemetry.stage_id === 4 ? (
        React.createElement(React.Fragment, null,
          React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, 'STAGE 4: LASER DOCKING'),
          React.createElement('span', null, `RANGE: ${(50.0 - telemetry.pos_x).toFixed(2)}m`),
          React.createElement('span', null, `VEL: ${telemetry.vel_x.toFixed(3)} m/s`),
          React.createElement('span', {
            style: { color: Math.abs(telemetry.cross_track_err || 0) > 0.03 ? '#ef4444' : '#10b981', fontWeight: 'bold' }
          }, `ALIGN: ${(Math.abs(telemetry.cross_track_err || 0) * 100.0).toFixed(2)}cm`),
          React.createElement('span', {
            style: { color: (50.0 - telemetry.pos_x) <= 0.05 ? '#10b981' : '#f59e0b', fontWeight: 'bold' }
          }, (50.0 - telemetry.pos_x) <= 0.05 ? '[LATCH ENGAGED]' : '[APPROACH]')
        )
      ) : (
        React.createElement(React.Fragment, null,
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
      )
    )
  );
}
