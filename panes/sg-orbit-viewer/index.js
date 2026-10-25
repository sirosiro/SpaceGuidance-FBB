export const minApiVersion = 1;

// ============================================================================
// SpaceGuidance-FBB: 3D Orbit & Flight Dynamics Viewer
// GPU-Native 120 FPS WebGL / Three.js Rendering Engine
// Supports Stages 1 to 5, Dead-Reckoning, Additive Blending Shaders
// ============================================================================

export default function SpaceOrbitViewer3D() {
  const React = window.React || window.FBB?.React;
  const { useState, useEffect, useRef } = window.FBB?.hooks || React;

  const containerRef = useRef(null);
  const glCanvasRef = useRef(null);
  const hudCanvasRef = useRef(null);

  // Camera presets: 'chase', 'nose', 'hero', 'orbit', 'track', 'cinema'
  const [cameraPreset, setCameraPreset] = useState('chase');
  const [zoom, setZoom] = useState(1.0);
  const [userOffset, setUserOffset] = useState({ yaw: 0.0, pitch: 0.0 });
  const [cinemaIndex, setCinemaIndex] = useState(0);

  const [telemetry, setTelemetry] = useState({
    pos_x: 0.0,
    pos_y: 0.0,
    pos_z: 0.0,
    vel_x: 0.0,
    vel_y: 0.0,
    vel_z: 0.0,
    angle: 0.0,
    omega: 0.0,
    fuel: 100.0,
    cross_track_err: 0.0,
    wheel_rpm: 0.0,
    wheel_rpm_x: 0.0,
    wheel_rpm_y: 0.0,
    wheel_rpm_z: 0.0,
    carrier_lost: false,
    fdir_mode: 0,
    stage_id: 1
  });

  const stateRef = useRef({
    cameraPreset: 'chase',
    zoom: 1.0,
    userOffset: { yaw: 0.0, pitch: 0.0 },
    cinemaIndex: 0,
    smoothRoll: 0.0,
    lastAzimuth: 0.0,
    lastElevation: 0.0,
    rotSpeed: 0.0,
    lastEffectiveMode: 'chase',
    trackAnchor: null,
    trackQuadIndex: -1,
    trackCinemaDuration: 6.0,
    lastShipX: 0.0,
    lastStageId: 1
  });

  stateRef.current.cameraPreset = cameraPreset;
  stateRef.current.zoom = zoom;
  stateRef.current.userOffset = userOffset;
  stateRef.current.cinemaIndex = cinemaIndex;

  const telemetryRef = useRef(null);
  const smoothRef = useRef({
    x: 0.0,
    y: 0.0,
    z: 0.0,
    yaw: 0.0,
    pitch: 0.0,
    roll: 0.0,
    bank: 0.0,
    lastTime: 0,
    initialized: false
  });
  const lastUiUpdateRef = useRef(0);

  const dragRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    baseYaw: 0.0,
    basePitch: 0.0
  });

  // Unified WebSocket Telemetry Bus (scenario:telemetry) with fallback
  useEffect(() => {
    const handleTelemetry = (data) => {
      if (data && data.type && data.type !== 'space_guidance') return;
      telemetryRef.current = data;
      const now = Date.now();
      if (now - lastUiUpdateRef.current >= 100) {
        lastUiUpdateRef.current = now;
        setTelemetry(prev => ({ ...prev, ...data }));
      }
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
      const timer = setInterval(async () => {
        try {
          let res = await fetch('/api/file?path=/tmp/fbb_scenario_telemetry.json');
          if (!res.ok) res = await fetch('/api/file?path=/tmp/space_guidance_telemetry.json');
          if (res.ok) {
            const data = await res.json();
            handleTelemetry(data);
          }
        } catch (e) {}
      }, 100);
      return () => clearInterval(timer);
    }
  }, []);

  // Cinema Mode: Auto-cycle camera angles with speed-adapted TRACK duration
  useEffect(() => {
    if (cameraPreset !== 'cinema') return;
    const modes = ['chase', 'nose', 'hero', 'orbit', 'track'];
    const currentMode = modes[cinemaIndex % modes.length];

    let duration = 6000;
    if (currentMode === 'track') {
      const vx = Math.abs(telemetryRef.current?.vel_x || 1.6);
      const speed = Math.max(0.6, vx);
      // Duration needed for approach, passage, and departure:
      // Distance needed is ~8.5m (approach ~4m + recede ~4.5m)
      duration = Math.max(5000, Math.min(8000, Math.round((8.5 / speed) * 1000)));
      stateRef.current.trackCinemaDuration = duration / 1000.0;
    }

    const timer = setTimeout(() => {
      setCinemaIndex(prev => (prev + 1) % modes.length);
    }, duration);
    return () => clearTimeout(timer);
  }, [cameraPreset, cinemaIndex]);

  // Compute Stage 1 Asteroid Pipeline S-Curve Y coordinate for given X
  const getPipelineY = (x) => {
    if (x > 10.0 && x <= 25.0) {
      return 2.5 * Math.sin((x - 10.0) / 15.0 * Math.PI);
    } else if (x > 25.0 && x <= 40.0) {
      return -2.5 * Math.sin((x - 25.0) / 15.0 * Math.PI);
    }
    return 0.0;
  };

  // Compute Stage 3 ISS Truss Rail 3D Curve Y coordinate for given X
  const getTrussRailY = (x) => {
    if (x >= 20.0 && x <= 25.0) {
      return 1.0 * Math.sin(((x - 20.0) / 5.0) * Math.PI);
    } else if (x >= 40.0 && x <= 45.0) {
      return -1.0 * Math.sin(((x - 40.0) / 5.0) * Math.PI);
    }
    return 0.0;
  };

  // ============================================================================
  // Three.js 3D WebGL Engine & Render Loop
  // ============================================================================
  useEffect(() => {
    const THREE = window.THREE || window.FBB?.THREE;
    const glCanvas = glCanvasRef.current;
    const hudCanvas = hudCanvasRef.current;
    const container = containerRef.current;
    if (!THREE || !glCanvas || !hudCanvas || !container) return;

    // Resolve owner window (works seamlessly in both main Dockview and PopoutWindow child windows)
    const targetWin = container.ownerDocument?.defaultView || window;

    let animId;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: glCanvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(Math.min(targetWin.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x030712, 1.0);
    } catch (e) {
      console.error('[sg-orbit-viewer] Failed to create Three.js WebGLRenderer:', e);
      return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x030712, 0.0035);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.2, 800);
    camera.up.set(0, 0, 1); // Z is vertical up in flight coordinates

    // ------------------------------------------------------------------------
    // 1. Celestial Starfield (1200 Cosmic Stars on Sphere R=450)
    // ------------------------------------------------------------------------
    const starCount = 1200;
    const starGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);

    let seed = 1337;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const colorSky = new THREE.Color(0x38bdf8);
    const colorYellow = new THREE.Color(0xfde047);
    const colorWhite = new THREE.Color(0xffffff);
    const colorDim = new THREE.Color(0x94a3b8);

    for (let i = 0; i < starCount; i++) {
      const u = rand();
      const v = rand();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 450 + rand() * 40;
      starPositions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = r * Math.cos(phi);

      const roll = rand();
      const c = roll > 0.85 ? colorSky : (roll > 0.65 ? colorYellow : (roll > 0.35 ? colorWhite : colorDim));
      starColors[i * 3 + 0] = c.r;
      starColors[i * 3 + 1] = c.g;
      starColors[i * 3 + 2] = c.b;
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));

    const starMat = new THREE.PointsMaterial({
      size: 1.8,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });
    const starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

    // ------------------------------------------------------------------------
    // 2. Stage 1: Asteroid Pipeline Corridor & Surface Grid
    // ------------------------------------------------------------------------
    const stage1Group = new THREE.Group();

    // Ground Grid at Z = -3.5
    const groundGridMat = new THREE.LineBasicMaterial({ color: 0x0b192f, transparent: true, opacity: 0.7 });
    const groundGeo = new THREE.BufferGeometry();
    const groundPts = [];
    for (let gx = -10; gx <= 70; gx += 5) {
      groundPts.push(gx, -20, -3.5, gx, 20, -3.5);
    }
    for (let gy = -20; gy <= 20; gy += 4) {
      groundPts.push(-10, gy, -3.5, 70, gy, -3.5);
    }
    groundGeo.setAttribute('position', new THREE.Float32BufferAttribute(groundPts, 3));
    stage1Group.add(new THREE.LineSegments(groundGeo, groundGridMat));

    // Hexagonal Tunnel Rings & Rails
    const hexRadius = 3.6;
    const hexAngles = [0, Math.PI/3, 2*Math.PI/3, Math.PI, 4*Math.PI/3, 5*Math.PI/3];
    const ringSpacing = 2.5;

    const ringMeshes = [];
    for (let rx = 0.0; rx <= 50.0; rx += ringSpacing) {
      const ry = getPipelineY(rx);
      const isTarget = rx >= 49.0;
      const isGate = rx > 0 && Math.abs(rx % 5.0) < 0.1 && rx < 49.0;
      const ringPts = [];
      const glowRingPts = [];
      const glowRad = hexRadius * 1.035;

      for (let i = 0; i <= 6; i++) {
        const a = hexAngles[i % 6];
        ringPts.push(new THREE.Vector3(rx, ry + hexRadius * Math.sin(a), hexRadius * Math.cos(a)));
        glowRingPts.push(new THREE.Vector3(rx, ry + glowRad * Math.sin(a), glowRad * Math.cos(a)));
      }
      const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
      const glowGeo = new THREE.BufferGeometry().setFromPoints(glowRingPts);

      const ringColor = isTarget ? 0xeab308 : (isGate ? 0x0284c7 : 0x0369a1);
      const ringMat = new THREE.LineBasicMaterial({
        color: ringColor,
        linewidth: isGate ? 2 : 1,
        transparent: true,
        opacity: isGate ? 0.95 : 0.75,
        blending: THREE.AdditiveBlending
      });
      const glowMat = new THREE.LineBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: isGate ? 0.45 : 0.25,
        blending: THREE.AdditiveBlending
      });

      const ringLine = new THREE.Line(ringGeo, ringMat);
      const glowLine = new THREE.Line(glowGeo, glowMat);
      ringMeshes.push({ line: ringLine, glow: glowLine, mat: ringMat, glowMat, rx, isGate, isTarget });
      stage1Group.add(ringLine);
      stage1Group.add(glowLine);
    }

    // Longitudinal Rails along S-curve
    const railOffsets = [
      { dy: 0, dz: hexRadius },
      { dy: -hexRadius, dz: 0 },
      { dy: hexRadius, dz: 0 }
    ];
    for (const ro of railOffsets) {
      const railPts = [];
      for (let rx = 0.0; rx <= 50.0; rx += 0.5) {
        railPts.push(new THREE.Vector3(rx, getPipelineY(rx) + ro.dy, ro.dz));
      }
      const railGeo = new THREE.BufferGeometry().setFromPoints(railPts);
      const railMat = new THREE.LineBasicMaterial({ color: 0x0284c7, transparent: true, opacity: 0.6 });
      stage1Group.add(new THREE.Line(railGeo, railMat));
    }
    scene.add(stage1Group);

    // ------------------------------------------------------------------------
    // 3. Stage 2: 100m High-Tension Carbon Nanotube Tether & Stations
    // ------------------------------------------------------------------------
    const stage2Group = new THREE.Group();

    // GEO Orbital Habitat Station (at X = -2.5)
    const geoStationGroup = new THREE.Group();
    geoStationGroup.position.set(-2.5, 0, 0);

    const torusOuterR = 9.0;
    const torusInnerR = 7.2;
    const torusSegs = 24;

    const torusPts = [];
    for (let i = 0; i < torusSegs; i++) {
      const a1 = (i * Math.PI * 2) / torusSegs;
      const a2 = ((i + 1) * Math.PI * 2) / torusSegs;
      // Outer ring
      torusPts.push(0, torusOuterR * Math.sin(a1), torusOuterR * Math.cos(a1));
      torusPts.push(0, torusOuterR * Math.sin(a2), torusOuterR * Math.cos(a2));
      // Inner ring
      torusPts.push(0, torusInnerR * Math.sin(a1), torusInnerR * Math.cos(a1));
      torusPts.push(0, torusInnerR * Math.sin(a2), torusInnerR * Math.cos(a2));
      // Cross struts
      torusPts.push(0, torusOuterR * Math.sin(a1), torusOuterR * Math.cos(a1));
      torusPts.push(0, torusInnerR * Math.sin(a1), torusInnerR * Math.cos(a1));
    }
    // 4 spokes to hub
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      torusPts.push(0, 0, 0, 0, torusInnerR * Math.sin(a), torusInnerR * Math.cos(a));
    }
    const torusGeo = new THREE.BufferGeometry();
    torusGeo.setAttribute('position', new THREE.Float32BufferAttribute(torusPts, 3));
    const torusMat = new THREE.LineBasicMaterial({ color: 0x0284c7 });
    geoStationGroup.add(new THREE.LineSegments(torusGeo, torusMat));

    // GEO Station Solar Wings
    const solarPts = [];
    for (const sz of [-7.0, 7.0]) {
      const zMin = sz > 0 ? 3.5 : -10.5;
      const zMax = sz > 0 ? 10.5 : -3.5;
      solarPts.push(-1.2, -2.4, zMin, -1.2, 2.4, zMin);
      solarPts.push(-1.2, 2.4, zMin, -1.2, 2.4, zMax);
      solarPts.push(-1.2, 2.4, zMax, -1.2, -2.4, zMax);
      solarPts.push(-1.2, -2.4, zMax, -1.2, -2.4, zMin);
      solarPts.push(-1.2, 0, zMin, -1.2, 0, zMax);
    }
    const solarGeo = new THREE.BufferGeometry();
    solarGeo.setAttribute('position', new THREE.Float32BufferAttribute(solarPts, 3));
    geoStationGroup.add(new THREE.LineSegments(solarGeo, new THREE.LineBasicMaterial({ color: 0x0369a1 })));
    stage2Group.add(geoStationGroup);

    // Tether Dynamic Line (100 segments from X=0 to X=100)
    const tetherSegCount = 101;
    const tetherPositions = new Float32Array(tetherSegCount * 3);
    for (let i = 0; i < tetherSegCount; i++) {
      tetherPositions[i * 3 + 0] = i;
      tetherPositions[i * 3 + 1] = 0;
      tetherPositions[i * 3 + 2] = 0;
    }
    const tetherGeo = new THREE.BufferGeometry();
    tetherGeo.setAttribute('position', new THREE.BufferAttribute(tetherPositions, 3));
    const tetherMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 });
    const tetherLine = new THREE.Line(tetherGeo, tetherMat);
    stage2Group.add(tetherLine);

    // Altitude Beacon Rings (10m .. 90m)
    const beaconMeshes = [];
    for (let bx = 10.0; bx <= 90.0; bx += 10.0) {
      const bPts = [];
      const bR = 2.5;
      for (let i = 0; i <= 16; i++) {
        const a = (i * Math.PI * 2) / 16;
        bPts.push(new THREE.Vector3(bx, bR * Math.sin(a), bR * Math.cos(a)));
      }
      const bGeo = new THREE.BufferGeometry().setFromPoints(bPts);
      const bMat = new THREE.LineBasicMaterial({ color: 0x0284c7 });
      const bLine = new THREE.Line(bGeo, bMat);
      beaconMeshes.push({ line: bLine, mat: bMat, bx });
      stage2Group.add(bLine);
    }

    // Asteroid Mining Base (at X = 110)
    const astGroup = new THREE.Group();
    astGroup.position.set(110.0, 0, 0);
    const astPts = [];
    const astR = 12.0;
    const latCount = 8;
    const lonCount = 16;
    for (let la = 0; la < latCount; la++) {
      const lat = -Math.PI / 2 + (la + 0.5) * Math.PI / latCount;
      for (let lo = 0; lo < lonCount; lo++) {
        const lon = (lo * 2 * Math.PI) / lonCount;
        const nextLon = ((lo + 1) * 2 * Math.PI) / lonCount;
        const r1 = astR + 2.2 * Math.sin(lat * 3) * Math.cos(lon * 2);
        const r2 = astR + 2.2 * Math.sin(lat * 3) * Math.cos(nextLon * 2);
        astPts.push(
          r1 * Math.cos(lat) * Math.cos(lon), r1 * Math.cos(lat) * Math.sin(lon), r1 * Math.sin(lat),
          r2 * Math.cos(lat) * Math.cos(nextLon), r2 * Math.cos(lat) * Math.sin(nextLon), r2 * Math.sin(lat)
        );
      }
    }
    const astGeo = new THREE.BufferGeometry();
    astGeo.setAttribute('position', new THREE.Float32BufferAttribute(astPts, 3));
    astGroup.add(new THREE.LineSegments(astGeo, new THREE.LineBasicMaterial({ color: 0x78716c })));

    // Docking Clamp Ring at X = 100
    const dockPts = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i * Math.PI * 2) / 16;
      dockPts.push(new THREE.Vector3(100.0, 3.8 * Math.sin(a), 3.8 * Math.cos(a)));
    }
    const dockGeo = new THREE.BufferGeometry().setFromPoints(dockPts);
    stage2Group.add(new THREE.Line(dockGeo, new THREE.LineBasicMaterial({ color: 0xeab308, linewidth: 2 })));
    stage2Group.add(astGroup);
    scene.add(stage2Group);

    // ------------------------------------------------------------------------
    // 4. Stage 3: 60m ISS Modular Box Truss & Full ISS Station Complex
    // ------------------------------------------------------------------------
    const stage3Group = new THREE.Group();
    const trussPts = [];
    const trussHalf = 1.6;
    const corners = [
      [-trussHalf, -trussHalf],
      [trussHalf, -trussHalf],
      [trussHalf, trussHalf],
      [-trussHalf, trussHalf]
    ];

    // (A) 3D Curved Longitudinal Chords & Top Guide Rails (Step 1.0m for clean lines)
    const stepX = 1.0;
    for (let x = 0.0; x < 60.0; x += stepX) {
      const x1 = x;
      const x2 = x + stepX;
      const y1 = getTrussRailY(x1);
      const y2 = getTrussRailY(x2);
      // 4 Main Structural Outer Chords
      for (const c of corners) {
        trussPts.push(x1, y1 + c[0], c[1], x2, y2 + c[0], c[1]);
      }
      // Central Structural Guide Pipe for Inspector Crawler (running at Z=0.0 along the rail curve)
      trussPts.push(x1, y1, -0.08, x2, y2, -0.08);
      trussPts.push(x1, y1, 0.08, x2, y2, 0.08);
      trussPts.push(x1, y1 - 0.08, 0, x2, y2 - 0.08, 0);
      trussPts.push(x1, y1 + 0.08, 0, x2, y2 + 0.08, 0);
    }

    // Square Bulkhead Rings every 5.0m (clean perimeter frame, no dense cross-diagonals)
    for (let tx = 0.0; tx <= 60.0; tx += 5.0) {
      const ty = getTrussRailY(tx);
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        trussPts.push(tx, ty + corners[i][0], corners[i][1], tx, ty + corners[next][0], corners[next][1]);
      }
    }
    const trussGeo = new THREE.BufferGeometry();
    trussGeo.setAttribute('position', new THREE.Float32BufferAttribute(trussPts, 3));
    stage3Group.add(new THREE.LineSegments(trussGeo, new THREE.LineBasicMaterial({ color: 0x475569 })));

    // (B) Curve Section Warning Arcs (Entry and Exit of 20-25m and 40-45m)
    const curveWarningPts = [];
    for (const cx of [20.0, 25.0, 40.0, 45.0]) {
      const cy = getTrussRailY(cx);
      for (let i = 0; i < 8; i++) {
        const a1 = (i * Math.PI * 2) / 8;
        const a2 = ((i + 1) * Math.PI * 2) / 8;
        curveWarningPts.push(cx, cy + 2.3 * Math.sin(a1), 2.3 * Math.cos(a1),
                            cx, cy + 2.3 * Math.sin(a2), 2.3 * Math.cos(a2));
      }
    }
    const curveWarnGeo = new THREE.BufferGeometry();
    curveWarnGeo.setAttribute('position', new THREE.Float32BufferAttribute(curveWarningPts, 3));
    stage3Group.add(new THREE.LineSegments(curveWarnGeo, new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      linewidth: 2,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending
    })));

    // (C) 4 Critical Inspection Joints (15m, 30m, 45m, 60m)
    const joints = [
      { x: 15.0, name: 'JOINT 01: S1 TRUSS' },
      { x: 30.0, name: 'JOINT 02: SARJ ROTARY' },
      { x: 45.0, name: 'JOINT 03: P1 TRUSS' },
      { x: 60.0, name: 'TERMINAL: DOCK LATCH' }
    ];
    const jointMeshes = [];
    for (const j of joints) {
      const jy = getTrussRailY(j.x);
      const jPts = [];
      // Outer inspection ring
      for (let i = 0; i <= 12; i++) {
        const a = (i * Math.PI * 2) / 12;
        jPts.push(new THREE.Vector3(j.x, jy + 2.7 * Math.sin(a), 2.7 * Math.cos(a)));
      }
      // Central Pipe Docking Collar Ring (where C-clamps lock)
      for (let i = 0; i <= 8; i++) {
        const a = (i * Math.PI * 2) / 8;
        jPts.push(new THREE.Vector3(j.x, jy + 0.16 * Math.sin(a), 0.16 * Math.cos(a)));
      }
      const jGeo = new THREE.BufferGeometry().setFromPoints(jPts);
      const jMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 });
      const jLine = new THREE.Line(jGeo, jMat);
      jointMeshes.push({ line: jLine, mat: jMat, x: j.x, name: j.name });
      stage3Group.add(jLine);
    }

    // 3 Hidden Structural Defect Markers for Stage 3
    const defectMarkers = [];
    for (let d = 0; d < 3; d++) {
      const dGeo = new THREE.BufferGeometry();
      const dPts = [];
      const dr = 0.28;
      for (let i = 0; i < 8; i++) {
        const a1 = (i * Math.PI * 2) / 8;
        const a2 = ((i + 1) * Math.PI * 2) / 8;
        dPts.push(0, dr * Math.sin(a1), dr * Math.cos(a1),
                  0, dr * Math.sin(a2), dr * Math.cos(a2));
      }
      dPts.push(0, -dr * 1.5, 0, 0, dr * 1.5, 0);
      dPts.push(0, 0, -dr * 1.5, 0, 0, dr * 1.5);
      dGeo.setAttribute('position', new THREE.Float32BufferAttribute(dPts, 3));
      const dMat = new THREE.LineBasicMaterial({
        color: 0xf59e0b,
        linewidth: 2,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending
      });
      const dMesh = new THREE.LineSegments(dGeo, dMat);
      dMesh.visible = false;
      stage3Group.add(dMesh);
      defectMarkers.push({ mesh: dMesh, mat: dMat });
    }

    // (D) SARJ (Solar Alpha Rotary Joint) & 4 Solar Array Wings (SAW)
    const sarjSolarGroup = new THREE.Group();
    sarjSolarGroup.position.set(30.0, 0, 0);

    // SARJ Rotating Central Ring
    const sarjPts = [];
    for (const sx of [-0.8, 0.8]) {
      for (let i = 0; i < 8; i++) {
        const a1 = (i * Math.PI * 2) / 8;
        const a2 = ((i + 1) * Math.PI * 2) / 8;
        sarjPts.push(sx, 2.2 * Math.sin(a1), 2.2 * Math.cos(a1),
                     sx, 2.2 * Math.sin(a2), 2.2 * Math.cos(a2));
      }
    }
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI * 2) / 4;
      sarjPts.push(-0.8, 2.2 * Math.sin(a), 2.2 * Math.cos(a),
                    0.8, 2.2 * Math.sin(a), 2.2 * Math.cos(a));
    }
    const sarjGeo = new THREE.BufferGeometry();
    sarjGeo.setAttribute('position', new THREE.Float32BufferAttribute(sarjPts, 3));
    sarjSolarGroup.add(new THREE.LineSegments(sarjGeo, new THREE.LineBasicMaterial({ color: 0x64748b, linewidth: 2 })));

    // Exactly 4 Solar Array Wings (2 assemblies at x = -18.0 and x = +18.0 relative to SARJ; +Z and -Z wings each)
    const sawRelativeX = [-18.0, 18.0]; // Port (P4) and Starboard (S4)
    const issSolarPts = [];
    const solarGlowPts = [];
    const sawHalfW = 2.4; // 4.8m wide blanket
    const sawLen = 15.0;  // 15m long wing
    const sawRootZ = 2.4; // 2.4m offset from truss

    for (const rx of sawRelativeX) {
      // Upper Wing (+Z) & Lower Wing (-Z) -> 2 * 2 = 4 Solar Panels Total
      for (const sign of [1, -1]) {
        const z0 = sign * sawRootZ;
        const z1 = sign * (sawRootZ + sawLen);

        // Central Lattice Mast Spine
        issSolarPts.push(rx, 0, z0, rx, 0, z1);

        // Left & Right Solar Blanket Outer Frame
        issSolarPts.push(rx, -sawHalfW, z0, rx, -sawHalfW, z1);
        issSolarPts.push(rx, sawHalfW, z0, rx, sawHalfW, z1);

        // Border Caps
        solarGlowPts.push(rx, -sawHalfW, z0, rx, sawHalfW, z0);
        solarGlowPts.push(rx, -sawHalfW, z1, rx, sawHalfW, z1);

        // Photovoltaic cell subdivision grid (Clean 4 divisions per wing)
        for (let zz = sawRootZ + 3.75; zz < sawRootZ + sawLen; zz += 3.75) {
          const zCur = sign * zz;
          issSolarPts.push(rx, -sawHalfW, zCur, rx, sawHalfW, zCur);
        }
      }
    }
    const issSolarGeo = new THREE.BufferGeometry();
    issSolarGeo.setAttribute('position', new THREE.Float32BufferAttribute(issSolarPts, 3));
    sarjSolarGroup.add(new THREE.LineSegments(issSolarGeo, new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.85
    })));

    const solarGlowGeo = new THREE.BufferGeometry();
    solarGlowGeo.setAttribute('position', new THREE.Float32BufferAttribute(solarGlowPts, 3));
    sarjSolarGroup.add(new THREE.LineSegments(solarGlowGeo, new THREE.LineBasicMaterial({
      color: 0xfde047,
      linewidth: 2,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending
    })));

    stage3Group.add(sarjSolarGroup);

    // (E) Pressurized Modules Cluster (ISS Core underneath truss at X=30m)
    const modulePts = [];
    const modR = 1.9;
    const modZ = -3.4;

    // Helper: Clean wireframe cylinder along Y axis (8 facets, 2 rings)
    const addCylinderY = (cx, y1, y2, cz, r, numRings = 2) => {
      for (let i = 0; i <= numRings; i++) {
        const yCur = y1 + (y2 - y1) * (i / numRings);
        for (let a = 0; a < 8; a++) {
          const a1 = (a * Math.PI * 2) / 8;
          const a2 = ((a + 1) * Math.PI * 2) / 8;
          modulePts.push(cx + r * Math.cos(a1), yCur, cz + r * Math.sin(a1),
                         cx + r * Math.cos(a2), yCur, cz + r * Math.sin(a2));
        }
      }
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI * 2) / 4;
        modulePts.push(cx + r * Math.cos(ang), y1, cz + r * Math.sin(ang),
                       cx + r * Math.cos(ang), y2, cz + r * Math.sin(ang));
      }
    };

    // Helper: Clean wireframe cylinder along X axis (8 facets, 2 rings)
    const addCylinderX = (x1, x2, cy, cz, r, numRings = 2) => {
      for (let i = 0; i <= numRings; i++) {
        const xCur = x1 + (x2 - x1) * (i / numRings);
        for (let a = 0; a < 8; a++) {
          const a1 = (a * Math.PI * 2) / 8;
          const a2 = ((a + 1) * Math.PI * 2) / 8;
          modulePts.push(xCur, cy + r * Math.cos(a1), cz + r * Math.sin(a1),
                         xCur, cy + r * Math.cos(a2), cz + r * Math.sin(a2));
        }
      }
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI * 2) / 4;
        modulePts.push(x1, cy + r * Math.cos(ang), cz + r * Math.sin(ang),
                       x2, cy + r * Math.cos(ang), cz + r * Math.sin(ang));
      }
    };

    // 1. Destiny (US Lab): y = 1.0 to 8.5
    addCylinderY(30.0, 1.0, 8.5, modZ, modR, 2);

    // 2. Harmony (Node 2): y = 8.5 to 12.0
    addCylinderY(30.0, 8.5, 12.0, modZ, modR + 0.1, 2);

    // 3. JAXA Kibo (JEM - Japanese Experiment Module): branching +X from Harmony
    addCylinderX(30.0, 41.0, 10.5, modZ, modR + 0.1, 3);
    // Exposed Facility (EF Porch Platform at x = 41.0 to 44.5)
    const efPts = [
      [41.0, 9.2, modZ - 0.8], [44.5, 9.2, modZ - 0.8],
      [44.5, 11.8, modZ - 0.8], [41.0, 11.8, modZ - 0.8],
      [41.0, 9.2, modZ + 0.5], [44.5, 9.2, modZ + 0.5],
      [44.5, 11.8, modZ + 0.5], [41.0, 11.8, modZ + 0.5]
    ];
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      modulePts.push(...efPts[i], ...efPts[next]);
      modulePts.push(...efPts[i + 4], ...efPts[next + 4]);
      modulePts.push(...efPts[i], ...efPts[i + 4]);
    }
    // JEM-RMS Robotic Arm
    modulePts.push(40.5, 12.2, modZ + 0.5, 41.5, 13.2, modZ + 1.5);
    modulePts.push(41.5, 13.2, modZ + 1.5, 43.5, 13.5, modZ + 1.0);

    // 4. Columbus (ESA Lab): branching -X from Harmony (x = 24.5 to 30.0 at y=10.5)
    addCylinderX(24.5, 30.0, 10.5, modZ, modR, 2);

    // 5. Unity & Quest: y = -1.0 to -4.5
    addCylinderY(30.0, -4.5, -1.0, modZ, modR, 2);

    // 6. Russian Segment (Zvezda): y = -4.5 to -13.0
    addCylinderY(30.0, -13.0, -4.5, modZ, modR - 0.2, 3);

    // 7. Cupola (Earth Observation Dome)
    for (let a = 0; a < 6; a++) {
      const a1 = (a * Math.PI * 2) / 6;
      const a2 = ((a + 1) * Math.PI * 2) / 6;
      modulePts.push(30.0 + 1.1 * Math.cos(a1), -1.0 + 1.1 * Math.sin(a1), modZ - 1.8,
                     30.0 + 1.1 * Math.cos(a2), -1.0 + 1.1 * Math.sin(a2), modZ - 1.8);
      modulePts.push(30.0 + 1.1 * Math.cos(a1), -1.0 + 1.1 * Math.sin(a1), modZ - 1.8,
                     30.0 + 0.5 * Math.cos(a1), -1.0 + 0.5 * Math.sin(a1), modZ - 2.4);
    }

    // Truss-to-Module Structural Stanchions
    for (const my of [2.0, 9.0, -2.0, -6.0]) {
      modulePts.push(30.0, 0, -1.6, 30.0, my, modZ + modR);
    }

    const modGeo = new THREE.BufferGeometry();
    modGeo.setAttribute('position', new THREE.Float32BufferAttribute(modulePts, 3));
    stage3Group.add(new THREE.LineSegments(modGeo, new THREE.LineBasicMaterial({
      color: 0x06b6d4,
      transparent: true,
      opacity: 0.85
    })));

    // (F) Thermal Control Radiators (2 Clean Cooling Blades at X=22m and X=38m)
    const radPts = [];
    for (const rx of [22.0, 38.0]) {
      // Single sleek rectangular radiator blade extending -Y
      radPts.push(rx, -2.0, -0.5, rx, -9.0, -0.5);
      radPts.push(rx, -9.0, -0.5, rx, -9.0, 2.2);
      radPts.push(rx, -9.0, 2.2, rx, -2.0, 2.2);
      radPts.push(rx, -2.0, 2.2, rx, -2.0, -0.5);
      // Mid divider line
      radPts.push(rx, -5.5, -0.5, rx, -5.5, 2.2);
    }
    const radGeo = new THREE.BufferGeometry();
    radGeo.setAttribute('position', new THREE.Float32BufferAttribute(radPts, 3));
    stage3Group.add(new THREE.LineSegments(radGeo, new THREE.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.70
    })));

    // (G) Low Earth Orbit Cyber Earth (Background at Z = -38m)
    const earthGlobeGroup = new THREE.Group();
    earthGlobeGroup.position.set(30.0, 0, -38.0);
    const earthPts = [];
    const earthR = 25.0;
    // Latitudes (every 30 deg)
    for (let lat = -60; lat <= 60; lat += 30) {
      const phi = (lat * Math.PI) / 180;
      const rRing = earthR * Math.cos(phi);
      const zRing = earthR * Math.sin(phi);
      for (let i = 0; i < 16; i++) {
        const th1 = (i * Math.PI * 2) / 16;
        const th2 = ((i + 1) * Math.PI * 2) / 16;
        earthPts.push(rRing * Math.cos(th1), rRing * Math.sin(th1), zRing,
                      rRing * Math.cos(th2), rRing * Math.sin(th2), zRing);
      }
    }
    // Longitudes (6 lines)
    for (let lon = 0; lon < 6; lon++) {
      const th = (lon * Math.PI * 2) / 6;
      for (let i = 0; i < 16; i++) {
        const phi1 = ((i - 8) * Math.PI) / 16;
        const phi2 = ((i + 1 - 8) * Math.PI) / 16;
        earthPts.push(earthR * Math.cos(phi1) * Math.cos(th), earthR * Math.cos(phi1) * Math.sin(th), earthR * Math.sin(phi1),
                      earthR * Math.cos(phi2) * Math.cos(th), earthR * Math.cos(phi2) * Math.sin(th), earthR * Math.sin(phi2));
      }
    }
    const earthGeo = new THREE.BufferGeometry();
    earthGeo.setAttribute('position', new THREE.Float32BufferAttribute(earthPts, 3));
    earthGlobeGroup.add(new THREE.LineSegments(earthGeo, new THREE.LineBasicMaterial({
      color: 0x0369a1,
      transparent: true,
      opacity: 0.20
    })));
    stage3Group.add(earthGlobeGroup);

    scene.add(stage3Group);

    // ------------------------------------------------------------------------
    // 5. Stage 4: 50m Laser Docking Corridor & Target Station
    // ------------------------------------------------------------------------
    const stage4Group = new THREE.Group();

    // Central Green Laser Beam
    const laserPts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(50, 0, 0)];
    const laserGeo = new THREE.BufferGeometry().setFromPoints(laserPts);
    const laserMat = new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2.5, blending: THREE.AdditiveBlending });
    stage4Group.add(new THREE.Line(laserGeo, laserMat));

    // Funnel Approach Corridor Checkpoints
    const checkpoints = [
      { x: 10.0, r: 4.5, name: 'CORRIDOR 40m' },
      { x: 20.0, r: 3.6, name: 'CORRIDOR 30m' },
      { x: 30.0, r: 2.7, name: 'GATEWAY 20m' },
      { x: 40.0, r: 1.8, name: 'APPROACH 10m' },
      { x: 48.0, r: 1.2, name: 'FINAL CONE 2m' }
    ];
    const cpMeshes = [];
    for (const cp of checkpoints) {
      const cPts = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i * Math.PI * 2) / 16;
        cPts.push(new THREE.Vector3(cp.x, cp.r * Math.sin(a), cp.r * Math.cos(a)));
      }
      const cGeo = new THREE.BufferGeometry().setFromPoints(cPts);
      const cMat = new THREE.LineBasicMaterial({ color: 0x06b6d4 });
      const cLine = new THREE.Line(cGeo, cMat);
      cpMeshes.push({ line: cLine, mat: cMat, x: cp.x, name: cp.name });
      stage4Group.add(cLine);
    }

    // (A) ISS Forward Docking Complex & Full Station at X >= 50m
    const issStationGroup = new THREE.Group();
    issStationGroup.position.set(50.0, 0, 0);

    // Rotating Docking Station Port Ring & Capture Guide Petals at X = 50.0m
    const dockPortGroup = new THREE.Group();
    dockPortGroup.position.set(0, 0, 0);

    const portRingPts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i * Math.PI * 2) / 24;
      portRingPts.push(new THREE.Vector3(0, 1.8 * Math.sin(a), 1.8 * Math.cos(a)));
    }
    const portRingGeo = new THREE.BufferGeometry().setFromPoints(portRingPts);
    dockPortGroup.add(new THREE.Line(portRingGeo, new THREE.LineBasicMaterial({ color: 0xfacc15, linewidth: 2.5 })));

    // 3 APAS/IDA Docking Guide Petals (at 0, 120, 240 deg)
    const petalPts = [];
    for (const aDeg of [0, 120, 240]) {
      const aRad = (aDeg * Math.PI) / 180;
      const cosA = Math.cos(aRad), sinA = Math.sin(aRad);
      const cosA1 = Math.cos(aRad - 0.2), sinA1 = Math.sin(aRad - 0.2);
      const cosA2 = Math.cos(aRad + 0.2), sinA2 = Math.sin(aRad + 0.2);
      petalPts.push(0, 1.8 * cosA1, 1.8 * sinA1, -0.6, 2.3 * cosA, 2.3 * sinA);
      petalPts.push(-0.6, 2.3 * cosA, 2.3 * sinA, 0, 1.8 * cosA2, 1.8 * sinA2);
    }
    const petalGeo = new THREE.BufferGeometry();
    petalGeo.setAttribute('position', new THREE.Float32BufferAttribute(petalPts, 3));
    dockPortGroup.add(new THREE.LineSegments(petalGeo, new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 2 })));

    // Rotating Optical Docking Crosshair Arms
    const crossArmPts = [
      0, -1.8, 0, 0, 1.8, 0,
      0, 0, -1.8, 0, 0, 1.8
    ];
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute('position', new THREE.Float32BufferAttribute(crossArmPts, 3));
    const crossLine = new THREE.LineSegments(crossGeo, new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 1.5 }));
    dockPortGroup.add(crossLine);
    issStationGroup.add(dockPortGroup);

    // PMA-2 (Pressurized Mating Adapter 2) Conical Mating Adapter (x = 0 to 3.2m)
    const pmaPts = [];
    for (let a = 0; a < 8; a++) {
      const a1 = (a * Math.PI * 2) / 8;
      const a2 = ((a + 1) * Math.PI * 2) / 8;
      pmaPts.push(0, 1.8 * Math.cos(a1), 1.8 * Math.sin(a1), 0, 1.8 * Math.cos(a2), 1.8 * Math.sin(a2));
      pmaPts.push(3.2, 2.4 * Math.cos(a1), 2.4 * Math.sin(a1), 3.2, 2.4 * Math.cos(a2), 2.4 * Math.sin(a2));
      pmaPts.push(0, 1.8 * Math.cos(a1), 1.8 * Math.sin(a1), 3.2, 2.4 * Math.cos(a1), 2.4 * Math.sin(a1));
    }
    const pmaGeo = new THREE.BufferGeometry();
    pmaGeo.setAttribute('position', new THREE.Float32BufferAttribute(pmaPts, 3));
    issStationGroup.add(new THREE.LineSegments(pmaGeo, new THREE.LineBasicMaterial({ color: 0x94a3b8 })));

    // ISS Main Pressurized Modules Cluster (Harmony, Destiny, Kibo, Columbus)
    const issModPts = [];
    const addModCylinderX = (x1, x2, cy, cz, r) => {
      for (const xc of [x1, (x1 + x2) * 0.5, x2]) {
        for (let a = 0; a < 8; a++) {
          const a1 = (a * Math.PI * 2) / 8;
          const a2 = ((a + 1) * Math.PI * 2) / 8;
          issModPts.push(xc, cy + r * Math.cos(a1), cz + r * Math.sin(a1),
                         xc, cy + r * Math.cos(a2), cz + r * Math.sin(a2));
        }
      }
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI * 2) / 4;
        issModPts.push(x1, cy + r * Math.cos(ang), cz + r * Math.sin(ang),
                       x2, cy + r * Math.cos(ang), cz + r * Math.sin(ang));
      }
    };
    const addModCylinderZ = (z1, z2, cx, cy, r) => {
      for (const zc of [z1, (z1 + z2) * 0.5, z2]) {
        for (let a = 0; a < 8; a++) {
          const a1 = (a * Math.PI * 2) / 8;
          const a2 = ((a + 1) * Math.PI * 2) / 8;
          issModPts.push(cx + r * Math.cos(a1), cy + r * Math.sin(a1), zc,
                         cx + r * Math.cos(a2), cy + r * Math.sin(a2), zc);
        }
      }
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI * 2) / 4;
        issModPts.push(cx + r * Math.cos(ang), cy + r * Math.sin(ang), z1,
                       cx + r * Math.cos(ang), cy + r * Math.sin(ang), z2);
      }
    };

    // Node 2 (Harmony): x = 3.2 to 10.5
    addModCylinderX(3.2, 10.5, 0, 0, 2.4);
    // Destiny US Lab: x = 10.5 to 22.0
    addModCylinderX(10.5, 22.0, 0, 0, 2.4);
    // JAXA Kibo Module (Starboard +Z): z = 2.4 to 13.5 at x = 7.0
    addModCylinderZ(2.4, 13.5, 7.0, 0, 2.3);
    // Columbus ESA Lab (Port -Z): z = -2.4 to -8.5 at x = 7.0
    addModCylinderZ(-8.5, -2.4, 7.0, 0, 2.2);

    const issModGeo = new THREE.BufferGeometry();
    issModGeo.setAttribute('position', new THREE.Float32BufferAttribute(issModPts, 3));
    issStationGroup.add(new THREE.LineSegments(issModGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })));

    // ISS Integrated Truss Structure (ITS) at x = 17.0m, spanning Z = -28m to +28m
    const issTrussPts = [];
    const tx = 17.0, trY = 0.0, trW = 1.4;
    for (const zc of [-28.0, 28.0]) {
      issTrussPts.push(tx - trW, trY - trW, zc, tx + trW, trY - trW, zc);
      issTrussPts.push(tx + trW, trY - trW, zc, tx + trW, trY + trW, zc);
      issTrussPts.push(tx + trW, trY + trW, zc, tx - trW, trY + trW, zc);
      issTrussPts.push(tx - trW, trY + trW, zc, tx - trW, trY - trW, zc);
    }
    for (const [xSign, ySign] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      issTrussPts.push(tx + xSign * trW, trY + ySign * trW, -28.0, tx + xSign * trW, trY + ySign * trW, 28.0);
    }
    for (let zc = -24.0; zc <= 24.0; zc += 8.0) {
      issTrussPts.push(tx - trW, trY - trW, zc, tx + trW, trY - trW, zc);
      issTrussPts.push(tx + trW, trY + trW, zc, tx - trW, trY + trW, zc);
      issTrussPts.push(tx - trW, trY - trW, zc, tx + trW, trY + trW, zc);
    }
    const issTrussGeo = new THREE.BufferGeometry();
    issTrussGeo.setAttribute('position', new THREE.Float32BufferAttribute(issTrussPts, 3));
    issStationGroup.add(new THREE.LineSegments(issTrussGeo, new THREE.LineBasicMaterial({ color: 0x64748b, linewidth: 2 })));

    // 4 Massive Solar Array Wings (SAW) on Truss Tips (z = -22m and z = +22m, extending Y = +-12m)
    const sawPts = [];
    for (const zSaw of [-22.0, 22.0]) {
      for (const ySign of [1, -1]) {
        const y0 = ySign * 2.0;
        const y1 = ySign * 13.5;
        sawPts.push(tx - 3.0, y0, zSaw, tx + 3.0, y0, zSaw);
        sawPts.push(tx - 3.0, y1, zSaw, tx + 3.0, y1, zSaw);
        sawPts.push(tx - 3.0, y0, zSaw, tx - 3.0, y1, zSaw);
        sawPts.push(tx + 3.0, y0, zSaw, tx + 3.0, y1, zSaw);
        sawPts.push(tx, y0, zSaw, tx, y1, zSaw);
        for (let yc = y0 + ySign * 2.8; Math.abs(yc) < Math.abs(y1); yc += ySign * 2.8) {
          sawPts.push(tx - 3.0, yc, zSaw, tx + 3.0, yc, zSaw);
        }
      }
    }
    const sawGeo = new THREE.BufferGeometry();
    sawGeo.setAttribute('position', new THREE.Float32BufferAttribute(sawPts, 3));
    issStationGroup.add(new THREE.LineSegments(sawGeo, new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 })));

    stage4Group.add(issStationGroup);
    scene.add(stage4Group);

    // ------------------------------------------------------------------------
    // 6. Stage 5: Panic Control Debris Field & Recovery Gate
    // ------------------------------------------------------------------------
    const stage5Group = new THREE.Group();

    // 10 Rotating Debris Shards (Synchronized with physics engine)
    const debrisConfigs = [
      { x:  6.5, y:  2.2, z:  1.5, r: 0.45 },
      { x: 10.0, y: -1.8, z: -1.2, r: 0.48 },
      { x: 14.0, y:  1.5, z: -1.6, r: 0.42 },
      { x: 17.5, y: -2.5, z:  1.8, r: 0.50 },
      { x: 21.0, y:  1.2, z:  1.4, r: 0.44 },
      { x: 24.5, y: -1.4, z: -1.5, r: 0.46 },
      { x: 27.0, y:  2.8, z: -2.0, r: 0.48 },
      { x: 29.5, y: -2.2, z:  1.6, r: 0.42 },
      { x: 31.5, y:  1.6, z: -1.2, r: 0.45 },
      { x: 33.5, y: -1.5, z:  1.4, r: 0.46 }
    ];
    const debrisMeshes = [];
    for (let i = 0; i < debrisConfigs.length; i++) {
      const cfg = debrisConfigs[i];
      const shardGroup = new THREE.Group();
      shardGroup.position.set(cfg.x, cfg.y, cfg.z);

      const w = cfg.r * 1.2;
      const h = cfg.r * 0.8;
      const sPts = [
        -w * 0.5, -h * 0.5, 0,  w * 0.5, -h * 0.4, cfg.r * 0.25,
         w * 0.5, -h * 0.4, cfg.r * 0.25,  w * 0.4, h * 0.5, -cfg.r * 0.15,
         w * 0.4, h * 0.5, -cfg.r * 0.15, -w * 0.5, h * 0.4, 0,
        -w * 0.5, h * 0.4, 0, -w * 0.5, -h * 0.5, 0,
        // Solar rib grid
        -w * 0.2, -h * 0.2, 0, w * 0.2, h * 0.2, 0
      ];
      const sGeo = new THREE.BufferGeometry();
      sGeo.setAttribute('position', new THREE.Float32BufferAttribute(sPts, 3));
      const sLine = new THREE.LineSegments(sGeo, new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 1.5 }));
      shardGroup.add(sLine);
      debrisMeshes.push({ group: shardGroup, idx: i, baseCfg: cfg });
      stage5Group.add(shardGroup);
    }

    // Kinetic Impactor Shard (Sharp metal wedge active during prologue)
    const impactorGroup = new THREE.Group();
    const impPts = [
      -0.3, -0.2, 0,  0.3, -0.15, 0.12,
       0.3, -0.15, 0.12, 0.2, 0.25, -0.12,
       0.2, 0.25, -0.12, -0.3, 0.2, 0,
      -0.3, 0.2, 0, -0.3, -0.2, 0
    ];
    const impGeo = new THREE.BufferGeometry();
    impGeo.setAttribute('position', new THREE.Float32BufferAttribute(impPts, 3));
    impactorGroup.add(new THREE.LineSegments(impGeo, new THREE.LineBasicMaterial({ color: 0xf87171, linewidth: 2 })));
    stage5Group.add(impactorGroup);

    // Collision Shockwave Ring & Sparks (GPU Additive Blending)
    const shockwaveGeo = new THREE.BufferGeometry();
    const shockPts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i * Math.PI * 2) / 24;
      shockPts.push(Math.cos(a), Math.sin(a), 0);
    }
    shockwaveGeo.setAttribute('position', new THREE.Float32BufferAttribute(shockPts, 3));
    const shockwaveMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      linewidth: 2.5,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending
    });
    const shockwaveMesh = new THREE.Line(shockwaveGeo, shockwaveMat);
    stage5Group.add(shockwaveMesh);

    // Kinetic Spark Particles (16 particles)
    const sparkCount = 16;
    const sparkGeo = new THREE.BufferGeometry();
    const sparkPositions = new Float32Array(sparkCount * 3);
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
    const sparkMat = new THREE.PointsMaterial({
      color: 0xf59e0b,
      size: 4.5,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending
    });
    const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
    stage5Group.add(sparkPoints);

    // Safe Orbit Recovery Line Gate Ring at X = 35.0m
    const gatePts = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i * Math.PI * 2) / 8;
      gatePts.push(new THREE.Vector3(35.0, 6.0 * Math.sin(a), 6.0 * Math.cos(a)));
    }
    const gateGeo = new THREE.BufferGeometry().setFromPoints(gatePts);
    const gateLine = new THREE.Line(gateGeo, new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2.5 }));
    stage5Group.add(gateLine);
    scene.add(stage5Group);

    // ------------------------------------------------------------------------
    // 7. Spacecraft 3D Models
    // ------------------------------------------------------------------------
    // Ship Root Object
    const shipRoot = new THREE.Group();

    // A. Delta Aerospace Fighter / Explorer (Stages 1, 3, 4, 5)
    const fighterGroup = new THREE.Group();

    const fighterHullPts = [
      // Delta hull outline
      2.2, 0, 0,   -1.3, -1.8, 0,
      2.2, 0, 0,   -1.3, 1.8, 0,
      -1.3, -1.8, 0,  -1.6, -0.4, 0,
      -1.3, 1.8, 0,   -1.6, 0.4, 0,
      -1.6, -0.4, 0,  -1.6, 0.4, 0,
      // Cockpit canopy
      2.2, 0, 0,   -0.2, 0, 0.65,
      -1.3, -1.8, 0, -0.2, 0, 0.65,
      -1.3, 1.8, 0,  -0.2, 0, 0.65,
      // Vertical stabilizer fins
      -1.6, -0.4, 0, -1.4, -0.7, 0.8,
      -0.2, 0, 0.65, -1.4, -0.7, 0.8,
      -1.6, 0.4, 0,  -1.4, 0.7, 0.8,
      -0.2, 0, 0.65, -1.4, 0.7, 0.8,
      // Ventral keel
      2.2, 0, 0,   -0.4, 0, -0.4,
      -1.3, -1.8, 0, -0.4, 0, -0.4,
      -1.3, 1.8, 0,  -0.4, 0, -0.4
    ];
    const fighterHullGeo = new THREE.BufferGeometry();
    fighterHullGeo.setAttribute('position', new THREE.Float32BufferAttribute(fighterHullPts, 3));
    
    // 1. Primary Vibrant Neon Hull Lines
    const fighterHullMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      linewidth: 2,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending
    });
    const fighterHullLine = new THREE.LineSegments(fighterHullGeo, fighterHullMat);
    fighterGroup.add(fighterHullLine);

    // 2. Outer Halo Glow Shell (Dual-pass additive bloom)
    const fighterGlowMat = new THREE.LineBasicMaterial({
      color: 0x0284c7,
      linewidth: 1,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending
    });
    const fighterGlowLine = new THREE.LineSegments(fighterHullGeo, fighterGlowMat);
    fighterGlowLine.scale.set(1.028, 1.028, 1.028);
    fighterGroup.add(fighterGlowLine);

    // 3. Inner White-Hot Accent Edges (Spine & Wing Leading Edges)
    const hotCorePts = [
      2.2, 0, 0,  -0.2, 0, 0.65,
      -0.2, 0, 0.65, -1.6, 0, 0,
      2.2, 0, 0,  -1.3, -1.8, 0,
      2.2, 0, 0,  -1.3, 1.8, 0
    ];
    const hotCoreGeo = new THREE.BufferGeometry();
    hotCoreGeo.setAttribute('position', new THREE.Float32BufferAttribute(hotCorePts, 3));
    const hotCoreMat = new THREE.LineBasicMaterial({
      color: 0xe0f2fe,
      linewidth: 1,
      transparent: true,
      opacity: 0.90,
      blending: THREE.AdditiveBlending
    });
    fighterGroup.add(new THREE.LineSegments(hotCoreGeo, hotCoreMat));

    // ------------------------------------------------------------------------
    // Reaction Wheel Assembly (RWA): 3-Axis Orthogonal Flywheel Triad
    // Positioned at Spacecraft Center of Mass (0, 0, 0) with physical clearance
    // ------------------------------------------------------------------------
    const rwCluster = new THREE.Group();
    rwCluster.position.set(0, 0, 0); // Positioned at Spacecraft Center of Mass (CoM)

    // Helper to generate circular rotor ring + cross spokes
    const createFlywheel = (radius, plane, colorHex) => {
      const grp = new THREE.Group();
      const pts = [];
      const segs = 24;
      for (let i = 0; i < segs; i++) {
        const a1 = (i * Math.PI * 2) / segs;
        const a2 = ((i + 1) * Math.PI * 2) / segs;
        if (plane === 'XY') {
          pts.push(radius * Math.cos(a1), radius * Math.sin(a1), 0);
          pts.push(radius * Math.cos(a2), radius * Math.sin(a2), 0);
        } else if (plane === 'XZ') {
          pts.push(radius * Math.cos(a1), 0, radius * Math.sin(a1));
          pts.push(radius * Math.cos(a2), 0, radius * Math.sin(a2));
        } else if (plane === 'YZ') {
          pts.push(0, radius * Math.cos(a1), radius * Math.sin(a1));
          pts.push(0, radius * Math.cos(a2), radius * Math.sin(a2));
        }
      }
      // Cross spokes to visualize spin rotation
      if (plane === 'XY') {
        pts.push(-radius, 0, 0, radius, 0, 0);
        pts.push(0, -radius, 0, 0, radius, 0);
      } else if (plane === 'XZ') {
        pts.push(-radius, 0, 0, radius, 0, 0);
        pts.push(0, 0, -radius, 0, 0, radius);
      } else if (plane === 'YZ') {
        pts.push(0, -radius, 0, 0, radius, 0);
        pts.push(0, 0, -radius, 0, 0, radius);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const mat = new THREE.LineBasicMaterial({
        color: colorHex,
        linewidth: 1.5,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending
      });
      grp.add(new THREE.LineSegments(geo, mat));
      return { group: grp, material: mat, defaultColor: colorHex };
    };

    // Orthogonal 3-axis wheels (Triad mounting with physical clearance):
    // Wheel X: Roll Axis (spins around local X, rotor in YZ plane, offset forward +X)
    const wheelX = createFlywheel(0.15, 'YZ', 0xa855f7); // Purple
    wheelX.group.position.set(0.18, 0, 0);

    // Wheel Y: Pitch Axis (spins around local Y, rotor in XZ plane, offset starboard +Y)
    const wheelY = createFlywheel(0.15, 'XZ', 0x06b6d4); // Cyan
    wheelY.group.position.set(0, 0.18, 0);

    // Wheel Z: Yaw Axis (spins around local Z, rotor in XY plane, offset dorsal +Z)
    const wheelZ = createFlywheel(0.15, 'XY', 0xec4899); // Magenta
    wheelZ.group.position.set(0, 0, 0.18);

    rwCluster.add(wheelX.group);
    rwCluster.add(wheelY.group);
    rwCluster.add(wheelZ.group);

    // Aerospace-Grade Triad Truss Bracket & Central Avionics Hub
    const rwaTrussPts = [];
    const hs = 0.05;
    // Central hub cube at Center of Mass (0, 0, 0)
    rwaTrussPts.push(-hs, -hs, -hs, hs, -hs, -hs,  hs, -hs, -hs, hs, hs, -hs);
    rwaTrussPts.push(hs, hs, -hs, -hs, hs, -hs,   -hs, hs, -hs, -hs, -hs, -hs);
    rwaTrussPts.push(-hs, -hs, hs, hs, -hs, hs,    hs, -hs, hs, hs, hs, hs);
    rwaTrussPts.push(hs, hs, hs, -hs, hs, hs,     -hs, hs, hs, -hs, -hs, hs);
    rwaTrussPts.push(-hs, -hs, -hs, -hs, -hs, hs,  hs, -hs, -hs, hs, -hs, hs);
    rwaTrussPts.push(hs, hs, -hs, hs, hs, hs,     -hs, hs, -hs, -hs, hs, hs);
    // Motor mount spindle struts connecting hub to wheel centers
    rwaTrussPts.push(0, 0, 0, 0.18, 0, 0);
    rwaTrussPts.push(0, 0, 0, 0, 0.18, 0);
    rwaTrussPts.push(0, 0, 0, 0, 0, 0.18);
    // Diagonal stiffener struts between wheel housings
    rwaTrussPts.push(0.18, 0, 0, 0, 0.18, 0);
    rwaTrussPts.push(0, 0.18, 0, 0, 0, 0.18);
    rwaTrussPts.push(0, 0, 0.18, 0.18, 0, 0);

    const rwaTrussGeo = new THREE.BufferGeometry();
    rwaTrussGeo.setAttribute('position', new THREE.Float32BufferAttribute(rwaTrussPts, 3));
    const rwaTrussMat = new THREE.LineSegments(
      rwaTrussGeo,
      new THREE.LineBasicMaterial({
        color: 0x64748b,
        linewidth: 1,
        transparent: true,
        opacity: 0.5
      })
    );
    rwCluster.add(rwaTrussMat);
    fighterGroup.add(rwCluster);

    // Cumulative wheel spin angles (integrated over dt to prevent Nyquist aliasing)
    const rwAngles = { x: 0.0, y: 0.0, z: 0.0 };

    // Optical Line Sensor Bar (Stage 1)
    const sensorGeo = new THREE.BufferGeometry();
    sensorGeo.setAttribute('position', new THREE.Float32BufferAttribute([1.2, -0.8, 0, 1.2, 0.8, 0], 3));
    const sensorLine = new THREE.Line(sensorGeo, new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2 }));
    fighterGroup.add(sensorLine);

    // RCS Pod Hardware Status Markers
    const rcsLocations = [
      { id: 0, pos: [-1.6, -0.4, 0] },
      { id: 1, pos: [-1.6, 0.4, 0] },
      { id: 2, pos: [0.8, -0.65, 0] },
      { id: 3, pos: [0.8, 0.65, 0] },
      { id: 4, pos: [-1.3, -1.8, 0] },
      { id: 5, pos: [0.8, -0.65, 0] },
      { id: 6, pos: [-1.3, 1.8, 0] },
      { id: 7, pos: [0.8, 0.65, 0] }
    ];
    const rcsCubes = [];
    const cubeBoxGeo = new THREE.BoxGeometry(0.04, 0.04, 0.04);
    for (const r of rcsLocations) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
      const mesh = new THREE.Mesh(cubeBoxGeo, mat);
      mesh.position.set(r.pos[0], r.pos[1], r.pos[2]);
      fighterGroup.add(mesh);
      rcsCubes.push({ mesh, mat, id: r.id });
    }

    // B. Climber Gondola Model (Stage 2)
    const climberGroup = new THREE.Group();

    // Central Titanium Collars & Spine
    const climberPts = [];
    for (const cx of [0.85, -0.85]) {
      for (let i = 0; i < 8; i++) {
        const a1 = (i * Math.PI * 2) / 8;
        const a2 = ((i + 1) * Math.PI * 2) / 8;
        climberPts.push(cx, 0.45 * Math.sin(a1), 0.45 * Math.cos(a1));
        climberPts.push(cx, 0.45 * Math.sin(a2), 0.45 * Math.cos(a2));
      }
    }
    // 4 Spine Rods
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI * 2) / 4 + Math.PI / 4;
      climberPts.push(0.85, 0.45 * Math.sin(a), 0.45 * Math.cos(a), -0.85, 0.45 * Math.sin(a), 0.45 * Math.cos(a));
    }
    // Hexagonal Pressurized Gondola
    for (const gx of [0.5, -0.5]) {
      for (let i = 0; i < 6; i++) {
        const a1 = (i * Math.PI * 2) / 6;
        const a2 = ((i + 1) * Math.PI * 2) / 6;
        climberPts.push(gx, 0.95 * Math.sin(a1), 0.75 * Math.cos(a1));
        climberPts.push(gx, 0.95 * Math.sin(a2), 0.75 * Math.cos(a2));
      }
    }
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI * 2) / 6;
      climberPts.push(0.5, 0.95 * Math.sin(a), 0.75 * Math.cos(a), -0.5, 0.95 * Math.sin(a), 0.75 * Math.cos(a));
    }
    // Solar Wings
    for (const wy of [-1, 1]) {
      const y1 = wy * 0.95;
      const y2 = wy * 2.5;
      climberPts.push(0.35, y1, 0, 0.35, y2, 0);
      climberPts.push(0.35, y2, 0, -0.35, y2, 0);
      climberPts.push(-0.35, y2, 0, -0.35, y1, 0);
      climberPts.push(-0.35, y1, 0, 0.35, y1, 0);
    }
    const climberGeo = new THREE.BufferGeometry();
    climberGeo.setAttribute('position', new THREE.Float32BufferAttribute(climberPts, 3));
    climberGroup.add(new THREE.LineSegments(climberGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })));

    // C. Mobile Transporter / ISS Truss Pipe Crawler Robot (Stage 3)
    const inspectorGroup = new THREE.Group();
    const chHalfX = 0.38, chHalfY = 0.18, chHalfZ = 0.10; // Compact 0.76m x 0.36m x 0.20m aerospace body

    // 0. Sleek Aerodynamic Composite Hull (Strictly fitted INSIDE gold wireframe)
    // Sized to fill 97% of the main chassis box (leaving crisp 5mm border) plus integrated nose & tail cones
    const hx = (chHalfX - 0.08) - 0.005; // 0.295m (wireframe chassis box is 0.300m)
    const hy = chHalfY - 0.005;          // 0.175m (wireframe width is 0.180m)
    const hz = chHalfZ - 0.005;          // 0.095m (wireframe height is 0.100m)
    const tby = (chHalfY * 0.7) - 0.005; // 0.121m tail/nose cone base width (wireframe is 0.126m)
    const tbz = (chHalfZ * 0.7) - 0.005; // 0.065m tail/nose cone base height (wireframe is 0.070m)
    const noseTipX = (chHalfX + 0.08) - 0.010;  // 0.450m (wireframe tip is 0.460m)
    const tailTipX = (-chHalfX - 0.08) + 0.010; // -0.450m (wireframe tip is -0.460m)

    // Main central chassis box corners:
    const v = [
      [-hx, -hy, -hz], // 0: Aft Right Bottom
      [ hx, -hy, -hz], // 1: Fwd Right Bottom
      [ hx,  hy, -hz], // 2: Fwd Left Bottom
      [-hx,  hy, -hz], // 3: Aft Left Bottom
      [-hx, -hy,  hz], // 4: Aft Right Top
      [ hx, -hy,  hz], // 5: Fwd Right Top
      [ hx,  hy,  hz], // 6: Fwd Left Top
      [-hx,  hy,  hz]  // 7: Aft Left Top
    ];

    // Nose & Tail cone bases & tips:
    const n = [
      [ hx, -tby, -tbz], // N0: Fwd-Right-Bottom
      [ hx,  tby, -tbz], // N1: Fwd-Left-Bottom
      [ hx,  tby,  tbz], // N2: Fwd-Left-Top
      [ hx, -tby,  tbz], // N3: Fwd-Right-Top
      [ noseTipX, 0, 0]  // N4: Nose Apex (+X)
    ];

    const t = [
      [-hx, -tby, -tbz], // T0: Aft-Right-Bottom
      [-hx,  tby, -tbz], // T1: Aft-Left-Bottom
      [-hx,  tby,  tbz], // T2: Aft-Left-Top
      [-hx, -tby,  tbz], // T3: Aft-Right-Top
      [ tailTipX, 0, 0]  // T4: Tail Apex (-X)
    ];

    const hullTriangles = [
      // 1. Main Central Chassis Box Faces (fills 97% of gold rectangle cross section)
      // Top (+Z)
      v[4], v[5], v[6],  v[4], v[6], v[7],
      // Bottom (-Z)
      v[0], v[2], v[1],  v[0], v[3], v[2],
      // Left (+Y)
      v[3], v[6], v[2],  v[3], v[7], v[6],
      // Right (-Y)
      v[0], v[1], v[5],  v[0], v[5], v[4],
      // Front Face (+X)
      v[1], v[2], v[6],  v[1], v[6], v[5],
      // Rear Face (-X, directly facing CHASE camera)
      v[0], v[7], v[3],  v[0], v[4], v[7],

      // 2. Aerodynamic Nose Cone (+X)
      n[0], n[1], n[4],  // Bottom to nose
      n[1], n[2], n[4],  // Left to nose
      n[2], n[3], n[4],  // Top to nose
      n[3], n[0], n[4],  // Right to nose

      // 3. Tapered Tail Cone (-X)
      t[0], t[4], t[1],  // Bottom to tail
      t[1], t[4], t[2],  // Left to tail
      t[2], t[4], t[3],  // Top to tail
      t[3], t[4], t[0]   // Right to tail
    ];

    const hullVerts = [];
    for (const pt of hullTriangles) {
      hullVerts.push(pt[0], pt[1], pt[2]);
    }

    const hullGeo = new THREE.BufferGeometry();
    hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(hullVerts, 3));
    hullGeo.computeVertexNormals();

    const hullMat = new THREE.MeshBasicMaterial({
      color: 0x0a1e36, // Deep space slate navy
      transparent: true,
      opacity: 0.50,   // Balanced translucency - crisp visual shielding of ISS lines
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const hullMesh = new THREE.Mesh(hullGeo, hullMat);
    inspectorGroup.add(hullMesh);

    // 1. Sleek Beveled Aerospace Chassis Capsule (High-Visibility Aerospace Gold #fbbf24)
    const inspPts = [];
    const chCorners = [
      [-chHalfX + 0.08, -chHalfY, -chHalfZ],
      [chHalfX - 0.08, -chHalfY, -chHalfZ],
      [chHalfX - 0.08, chHalfY, -chHalfZ],
      [-chHalfX + 0.08, chHalfY, -chHalfZ],
      [-chHalfX + 0.08, -chHalfY, chHalfZ],
      [chHalfX - 0.08, -chHalfY, chHalfZ],
      [chHalfX - 0.08, chHalfY, chHalfZ],
      [-chHalfX + 0.08, chHalfY, chHalfZ]
    ];
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      inspPts.push(...chCorners[i], ...chCorners[next]);
      inspPts.push(...chCorners[i + 4], ...chCorners[next + 4]);
      inspPts.push(...chCorners[i], ...chCorners[i + 4]);
    }

    // Aerodynamic tapered nose cone (front: +X)
    const noseTip = [chHalfX + 0.08, 0, 0];
    const noseBase = [
      [chHalfX - 0.08, -chHalfY * 0.7, -chHalfZ * 0.7],
      [chHalfX - 0.08, chHalfY * 0.7, -chHalfZ * 0.7],
      [chHalfX - 0.08, chHalfY * 0.7, chHalfZ * 0.7],
      [chHalfX - 0.08, -chHalfY * 0.7, chHalfZ * 0.7]
    ];
    for (let i = 0; i < 4; i++) {
      inspPts.push(...noseTip, ...noseBase[i]);
      const next = (i + 1) % 4;
      inspPts.push(...noseBase[i], ...noseBase[next]);
    }

    // Tapered tail cone (rear: -X)
    const tailTip = [-chHalfX - 0.08, 0, 0];
    const tailBase = [
      [-chHalfX + 0.08, -chHalfY * 0.7, -chHalfZ * 0.7],
      [-chHalfX + 0.08, chHalfY * 0.7, -chHalfZ * 0.7],
      [-chHalfX + 0.08, chHalfY * 0.7, chHalfZ * 0.7],
      [-chHalfX + 0.08, -chHalfY * 0.7, chHalfZ * 0.7]
    ];
    for (let i = 0; i < 4; i++) {
      inspPts.push(...tailTip, ...tailBase[i]);
      const next = (i + 1) % 4;
      inspPts.push(...tailBase[i], ...tailBase[next]);
    }

    // 2. Pipe-Gripping C-Clamps & Pinch Rollers (Hugging structural guide pipe; NO wheels/tires!)
    for (const gx of [-0.22, 0.22]) {
      // Mechanical suspension arm connecting chassis to pipe gripper
      inspPts.push(gx, -0.12, -chHalfZ, gx, -0.11, -0.06);
      inspPts.push(gx, 0.12, -chHalfZ, gx, 0.11, -0.06);

      // C-shaped curved robotic jaw encircling the cylindrical pipe (radius 0.11m around pipe)
      for (let a = 1; a < 7; a++) {
        const a1 = (a * Math.PI) / 4;
        const a2 = ((a + 1) * Math.PI) / 4;
        const r1 = 0.11;
        inspPts.push(gx, r1 * Math.cos(a1), r1 * Math.sin(a1),
                     gx, r1 * Math.cos(a2), r1 * Math.sin(a2));
      }

      // Opposed concave pinch drive rollers hugging pipe circumference
      inspPts.push(gx - 0.04, 0, -0.09, gx + 0.04, 0, -0.09);
      inspPts.push(gx - 0.04, 0, 0.09, gx + 0.04, 0, 0.09);
      inspPts.push(gx - 0.04, -0.09, 0, gx + 0.04, -0.09, 0);
      inspPts.push(gx - 0.04, 0.09, 0, gx + 0.04, 0.09, 0);
    }

    const inspGeo = new THREE.BufferGeometry();
    inspGeo.setAttribute('position', new THREE.Float32BufferAttribute(inspPts, 3));
    // High-visibility Aerospace Gold / Solar MLI Thermal Blanket wireframe (#fbbf24)
    inspectorGroup.add(new THREE.LineSegments(inspGeo, new THREE.LineBasicMaterial({ color: 0xfbbf24, linewidth: 2 })));

    // 3. Conformal Phased-Array Flat Antenna (Cyber Cyan #00f0ff on gold hull)
    const antPts = [];
    const antX1 = -0.16, antX2 = 0.12;
    const antY = 0.11, antZ = chHalfZ;
    antPts.push(antX1, -antY, antZ, antX2, -antY, antZ);
    antPts.push(antX2, -antY, antZ, antX2, antY, antZ);
    antPts.push(antX2, antY, antZ, antX1, antY, antZ);
    antPts.push(antX1, antY, antZ, antX1, -antY, antZ);
    antPts.push(0, -antY, antZ, 0, antY, antZ);
    antPts.push(antX1, 0, antZ, antX2, 0, antZ);
    const antGeo = new THREE.BufferGeometry();
    antGeo.setAttribute('position', new THREE.Float32BufferAttribute(antPts, 3));
    inspectorGroup.add(new THREE.LineSegments(antGeo, new THREE.LineBasicMaterial({ color: 0x00f0ff, linewidth: 2 })));

    // 4. Aerospace Navigation / Strobe Beacons (Port red, Starboard green, Nose/Tail strobe)
    const navPts = [
      chHalfX - 0.06, chHalfY, chHalfZ,   // Port Forward (Red)
      -chHalfX + 0.06, chHalfY, chHalfZ,  // Port Aft (Red)
      chHalfX - 0.06, -chHalfY, chHalfZ,  // Starboard Forward (Green)
      -chHalfX + 0.06, -chHalfY, chHalfZ, // Starboard Aft (Green)
      chHalfX + 0.08, 0, 0,              // Nose Beacon (White)
      -chHalfX - 0.08, 0, 0              // Tail Beacon (Amber)
    ];
    const navColors = [
      1.0, 0.2, 0.2, // Red
      1.0, 0.2, 0.2, // Red
      0.1, 0.9, 0.3, // Green
      0.1, 0.9, 0.3, // Green
      1.0, 1.0, 1.0, // White
      1.0, 0.7, 0.1  // Amber
    ];
    const navGeo = new THREE.BufferGeometry();
    navGeo.setAttribute('position', new THREE.Float32BufferAttribute(navPts, 3));
    navGeo.setAttribute('color', new THREE.Float32BufferAttribute(navColors, 3));
    const navMat = new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true });
    inspectorGroup.add(new THREE.Points(navGeo, navMat));

    // 5. Front & Rear Magnetic Locking Clamp Pads (Locks firmly onto pipe collar during joint scan)
    const inspectorClampMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 3, transparent: true, opacity: 0.9 });
    const clampPts = [];
    for (const cx of [-0.22, 0.22]) {
      for (let a = 0; a < 8; a++) {
        const a1 = (a * Math.PI * 2) / 8;
        const a2 = ((a + 1) * Math.PI * 2) / 8;
        clampPts.push(cx, 0.12 * Math.cos(a1), 0.12 * Math.sin(a1),
                      cx, 0.12 * Math.cos(a2), 0.12 * Math.sin(a2));
      }
    }
    const clampGeo = new THREE.BufferGeometry();
    clampGeo.setAttribute('position', new THREE.Float32BufferAttribute(clampPts, 3));
    const inspectorClampLine = new THREE.LineSegments(clampGeo, inspectorClampMat);
    inspectorGroup.add(inspectorClampLine);

    shipRoot.add(fighterGroup);
    shipRoot.add(climberGroup);
    shipRoot.add(inspectorGroup);
    scene.add(shipRoot);

    // ------------------------------------------------------------------------
    // 8. Task 3.3: GPU Additive Blending Thruster Plumes
    // ------------------------------------------------------------------------
    const thrusterGroup = new THREE.Group();

    // Main Engine Plumes (T0, T1): Volumetric Vacuum Expansion Bell (10 segments each)
    const plumePtsCount = 20 * 2 * 3; // 20 segments * 2 vertices * 3 coords
    const plumeGeo0 = new THREE.BufferGeometry();
    plumeGeo0.setAttribute('position', new THREE.BufferAttribute(new Float32Array(plumePtsCount), 3));
    const plumeGeo1 = new THREE.BufferGeometry();
    plumeGeo1.setAttribute('position', new THREE.BufferAttribute(new Float32Array(plumePtsCount), 3));

    // Outer Neon Glow: Saturated Vibrant Electric Yellow (High contrast against black space & cyan frames)
    const plumeMat = new THREE.LineBasicMaterial({
      color: 0xfacc15, // Bright Neon Yellow
      linewidth: 3.0,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending
    });
    // Inner White-Hot Core Laser Ray: Pure Incandescent White (Dual-pass neon bloom)
    const plumeCoreMat = new THREE.LineBasicMaterial({
      color: 0xffffff, // Pure Incandescent White
      linewidth: 1.5,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending
    });

    const plumeT0 = new THREE.LineSegments(plumeGeo0, plumeMat);
    const plumeT1 = new THREE.LineSegments(plumeGeo1, plumeMat);
    const plumeCoreT0 = new THREE.LineSegments(plumeGeo0, plumeCoreMat);
    const plumeCoreT1 = new THREE.LineSegments(plumeGeo1, plumeCoreMat);
    thrusterGroup.add(plumeT0);
    thrusterGroup.add(plumeT1);
    thrusterGroup.add(plumeCoreT0);
    thrusterGroup.add(plumeCoreT1);

    // Multi-Nozzle RCS Jets (T2..T11): Multi-Ray Plasma Spray Fan
    const rcsJetGeo = new THREE.BufferGeometry();
    const rcsJetPositions = new Float32Array(128 * 2 * 3); // 128 rays * 2 points
    rcsJetGeo.setAttribute('position', new THREE.BufferAttribute(rcsJetPositions, 3));
    const rcsJetMat = new THREE.LineBasicMaterial({
      color: 0xfbbf24, // Electric Amber Yellow
      linewidth: 2.5,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending
    });
    const rcsCoreMat = new THREE.LineBasicMaterial({
      color: 0xffffff, // Blinding White Core
      linewidth: 1.5,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending
    });
    const rcsJetLines = new THREE.LineSegments(rcsJetGeo, rcsJetMat);
    const rcsCoreLines = new THREE.LineSegments(rcsJetGeo, rcsCoreMat);
    thrusterGroup.add(rcsJetLines);
    thrusterGroup.add(rcsCoreLines);

    shipRoot.add(thrusterGroup);

    // Stage 3: 360-degree Laser Inspection Scanner Fan
    const scanFanGeo = new THREE.BufferGeometry();
    const scanFanPts = new Float32Array(48 * 3);
    scanFanGeo.setAttribute('position', new THREE.BufferAttribute(scanFanPts, 3));
    const scanFanMat = new THREE.LineBasicMaterial({
      color: 0x22c55e,
      linewidth: 2.5,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending
    });
    const scanFanLine = new THREE.LineSegments(scanFanGeo, scanFanMat);
    scanFanLine.visible = false;
    shipRoot.add(scanFanLine);

    // ------------------------------------------------------------------------
    // Main Animation & Render Loop (120 FPS Native GPU Pipeline)
    // ------------------------------------------------------------------------
    const render = () => {
      try {
        const clientW = Math.max(container.clientWidth || 300, 10);
        const clientH = Math.max(container.clientHeight || 150, 10);

        const dpr = targetWin.devicePixelRatio || 1;
        const expectedGlW = Math.floor(clientW * Math.min(dpr, 2));
        const expectedGlH = Math.floor(clientH * Math.min(dpr, 2));

        if (glCanvas.width !== expectedGlW || glCanvas.height !== expectedGlH) {
          renderer.setSize(clientW, clientH, false);
          camera.aspect = clientW / clientH;
          camera.updateProjectionMatrix();
          hudCanvas.width = clientW;
          hudCanvas.height = clientH;
        }

      const now = Date.now();
      const nowSec = now * 0.001;
      const st = stateRef.current;
      const sm = smoothRef.current;

      let dt = sm.lastTime > 0 ? (nowSec - sm.lastTime) : 0.016;
      sm.lastTime = nowSec;
      if (dt > 0.05) dt = 0.05;
      if (dt < 0.001) dt = 0.001;

      const tlm = telemetryRef.current || telemetry;

      // Reset or initialize positions
      if (!sm.initialized && (tlm.pos_x !== 0.0 || tlm.vel_x !== 0.0)) {
        sm.x = tlm.pos_x || 0.0;
        sm.y = tlm.pos_y || 0.0;
        sm.z = tlm.pos_z || 0.0;
        sm.yaw = tlm.yaw !== undefined ? tlm.yaw : (tlm.angle || 0.0);
        sm.pitch = tlm.pitch || 0.0;
        sm.roll = tlm.roll || 0.0;
        sm.bank = -(tlm.omega || 0) * 1.1;
        sm.initialized = true;
      } else if (Math.abs((tlm.pos_x || 0.0) - sm.x) > 10.0 || Math.abs((tlm.pos_y || 0.0) - sm.y) > 10.0) {
        sm.x = tlm.pos_x || 0.0;
        sm.y = tlm.pos_y || 0.0;
        sm.z = tlm.pos_z || 0.0;
        sm.yaw = tlm.yaw !== undefined ? tlm.yaw : (tlm.angle || 0.0);
        sm.pitch = tlm.pitch || 0.0;
        sm.roll = tlm.roll || 0.0;
      }

      // Stage ID Detection
      let stageId = tlm.stage_id;
      if (!stageId) {
        try {
          const m = window.FBB?.useDashboard ? window.FBB.useDashboard().manifest : null;
          const sDir = (m?.scenario_dir || '').toLowerCase();
          if (sDir.includes('05_panic') || sDir.includes('panic_control')) stageId = 5;
          else if (sDir.includes('02_tether') || sDir.includes('tether_climber')) stageId = 2;
          else if (sDir.includes('03_iss') || sDir.includes('iss_truss')) stageId = 3;
          else if (sDir.includes('04_laser') || sDir.includes('laser_docking')) stageId = 4;
          else stageId = 1;
        } catch (e) {
          stageId = 1;
        }
      }

      // Toggle stage-specific 3D scenes
      stage1Group.visible = (stageId === 1);
      stage2Group.visible = (stageId === 2);
      stage3Group.visible = (stageId === 3);
      stage4Group.visible = (stageId === 4);
      stage5Group.visible = (stageId === 5);

      fighterGroup.visible = (stageId !== 2 && stageId !== 3);
      climberGroup.visible = (stageId === 2);
      inspectorGroup.visible = (stageId === 3);
      sensorLine.visible = (stageId === 1);

      // Dynamic animations for Stage 3 ISS & Inspector Crawler
      if (sarjSolarGroup) {
        sarjSolarGroup.rotation.x = (now * 0.00015) % (Math.PI * 2);
      }
      if (earthGlobeGroup) {
        earthGlobeGroup.rotation.y = (now * 0.00008) % (Math.PI * 2);
      }
      if (inspectorClampMat) {
        inspectorClampMat.color.setHex(tlm.fdir_mode === 1 ? 0xfacc15 : 0x0284c7);
      }

      // Dead-Reckoning Blending
      const targetX = tlm.pos_x !== undefined ? tlm.pos_x : sm.x;
      const targetY = tlm.pos_y !== undefined ? tlm.pos_y : sm.y;
      const targetZ = tlm.pos_z || 0.0;
      const targetYaw = tlm.yaw !== undefined ? tlm.yaw : tlm.angle;
      const targetPitch = tlm.pitch || 0.0;
      const targetBank = -Math.max(-0.45, Math.min(0.45, (tlm.omega || 0) * 1.2));
      const targetRoll = tlm.roll !== undefined ? tlm.roll : targetBank;

      const vx = tlm.vel_x !== undefined ? tlm.vel_x : 0.0;
      const vy = tlm.vel_y !== undefined ? tlm.vel_y : 0.0;
      const vz = tlm.vel_z !== undefined ? tlm.vel_z : 0.0;
      const wx = tlm.omega_x !== undefined ? tlm.omega_x : 0.0;
      const wy = tlm.omega_y !== undefined ? tlm.omega_y : 0.0;
      const wz = tlm.omega_z !== undefined ? tlm.omega_z : (tlm.omega || 0.0);

      // Inertial forward propagation
      sm.x += vx * dt;
      sm.y += vy * dt;
      sm.z += vz * dt;
      sm.yaw += (stageId === 5 ? wz : (tlm.omega || 0.0)) * dt;
      if (stageId === 5) {
        sm.pitch += wy * dt;
        sm.roll += wx * dt;
      }

      // Spring blend towards incoming telemetry
      const blendPos = Math.min(1.0, 5.0 * dt);
      sm.x += (targetX - sm.x) * blendPos;
      sm.y += (targetY - sm.y) * blendPos;
      sm.z += (targetZ - sm.z) * blendPos;

      const blendRot = Math.min(1.0, 6.0 * dt);
      let dYaw = targetYaw - sm.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      sm.yaw += dYaw * blendRot;

      let dPitch = targetPitch - sm.pitch;
      while (dPitch > Math.PI) dPitch -= Math.PI * 2;
      while (dPitch < -Math.PI) dPitch += Math.PI * 2;
      sm.pitch += dPitch * blendRot;

      let dRoll = targetRoll - sm.roll;
      while (dRoll > Math.PI) dRoll -= Math.PI * 2;
      while (dRoll < -Math.PI) dRoll += Math.PI * 2;
      sm.roll += dRoll * blendRot;
      sm.bank += (targetBank - sm.bank) * Math.min(1.0, 4.0 * dt);

      const shipX = sm.x;
      const shipY = sm.y;
      const shipZ = sm.z;
      const shipYaw = sm.yaw;
      const shipPitch = sm.pitch;
      const shipRoll = (stageId === 5 || stageId === 4) ? sm.roll : sm.bank;

      // Position & Rotate Spacecraft in Three.js
      shipRoot.position.set(shipX, shipY, shipZ);
      shipRoot.rotation.set(0, 0, 0);
      const euler = new THREE.Euler(shipRoll, shipPitch, shipYaw, 'ZYX');
      shipRoot.setRotationFromEuler(euler);

      // 3-Axis Reaction Wheel Cluster Dynamics & Visual Rotation
      const rpmX = Number(tlm.wheel_rpm_x || 0);
      const rpmY = Number(tlm.wheel_rpm_y || 0);
      const rpmZ = Number(tlm.wheel_rpm_z !== undefined ? tlm.wheel_rpm_z : (tlm.wheel_rpm || 0));

      // Visual speed mapper: prevent stroboscopic Nyquist aliasing at 5000+ RPM
      const toVisualSpeed = (rpm) => {
        if (Math.abs(rpm) < 1.0) return 0.0;
        const speed = rpm * 0.0035;
        const maxSpeed = 18.0; // rad/s
        return Math.sign(speed) * Math.min(Math.abs(speed), maxSpeed);
      };

      rwAngles.x = (rwAngles.x + toVisualSpeed(rpmX) * dt) % (Math.PI * 2);
      rwAngles.y = (rwAngles.y + toVisualSpeed(rpmY) * dt) % (Math.PI * 2);
      rwAngles.z = (rwAngles.z + toVisualSpeed(rpmZ) * dt) % (Math.PI * 2);

      wheelX.group.rotation.x = rwAngles.x;
      wheelY.group.rotation.y = rwAngles.y;
      wheelZ.group.rotation.z = rwAngles.z;

      // Saturation warning color (Red if |RPM| > 5000, otherwise nominal axis color)
      wheelX.material.color.setHex(Math.abs(rpmX) > 5000 ? 0xef4444 : wheelX.defaultColor);
      wheelY.material.color.setHex(Math.abs(rpmY) > 5000 ? 0xef4444 : wheelY.defaultColor);
      wheelZ.material.color.setHex(Math.abs(rpmZ) > 5000 ? 0xef4444 : wheelZ.defaultColor);

      // Spacecraft ghost & alert flicker states
      let isGhost = false;
      let isPanicTumbling = false;
      const stageElapsed = tlm.elapsed_time !== undefined ? tlm.elapsed_time : 0.0;
      if (stageId === 5) {
        // Prologue assessment phase lasts 4.5s (debris collision occurs at T=0.6s)
        const isPrologue = (stageElapsed >= 0.6 && stageElapsed < 4.5 && (tlm.fdir_mode === 0 || tlm.fdir_mode === undefined) && !tlm.is_detumbled);
        if (isPrologue) {
          isGhost = true;
          isPanicTumbling = true;
        } else if (tlm.mission_status === 'FAILED') {
          isGhost = true;
        }
      } else {
        isGhost = tlm.carrier_lost || tlm.fdir_mode === 1;
      }

      if (isPanicTumbling) {
        const flicker = Math.floor(now * 0.008) % 2 === 0;
        const c = flicker ? 0xef4444 : 0xf59e0b;
        fighterHullMat.color.setHex(c);
        fighterGlowMat.color.setHex(c);
      } else if (isGhost) {
        fighterHullMat.color.setHex(0xf59e0b);
        fighterGlowMat.color.setHex(0xd97706);
      } else {
        fighterHullMat.color.setHex(0x38bdf8);
        fighterGlowMat.color.setHex(0x0284c7);
      }

      // Update RCS hardware brackets
      const healthMask = (tlm.thruster_health !== undefined) ? tlm.thruster_health : 0xFFF;
      for (const r of rcsCubes) {
        const damaged = (healthMask & (1 << r.id)) === 0;
        r.mat.color.setHex(damaged ? 0xef4444 : 0xf59e0b);
      }

      // Update Dynamic Plumes & Particles
      const hasFuel = (tlm.fuel === undefined || tlm.fuel > 0);
      const thrustMask = (tlm.thrust_z !== undefined) ? (tlm.thrust_z & 0xFFF) : 0;
      const actualFx = (tlm.thrust_x !== undefined) ? tlm.thrust_x : 0.0;
      const actualFy = (tlm.thrust_y !== undefined) ? tlm.thrust_y : 0.0;
      const actualTau = (tlm.torque !== undefined) ? tlm.torque : 0.0;

      // ------------------------------------------------------------------------
      // 1. Main Thrusters T0, T1 (Volumetric Vacuum Bell & Dual-Pass Neon Glow)
      // ------------------------------------------------------------------------
      const isReverse = (actualFx < -0.005);
      const fxForwardMag = Math.min(1.0, Math.max(0.0, actualFx));
      const fxBrakeMag = Math.min(1.0, Math.max(0.0, -actualFx));

      // For Stage 3 (Crawler): T0/T1 are mounted on crawler and can counter-fire
      // For Fighters (Stage 1, 4, 5): T0/T1 are REAR forward propulsion engines only!
      let isT0Firing = false;
      let isT1Firing = false;
      let isCounterFiring = false;

      if (stageId === 3) {
        isCounterFiring = hasFuel && isReverse;
        isT0Firing = hasFuel && (healthMask & (1 << 0)) && ((thrustMask & (1 << 0)) || Math.abs(actualFx) > 0.005);
        isT1Firing = hasFuel && (healthMask & (1 << 1)) && ((thrustMask & (1 << 1)) || Math.abs(actualFx) > 0.005);
      } else {
        // Rear main thrusters ONLY fire when accelerating forward (+X)
        isT0Firing = hasFuel && (healthMask & (1 << 0)) && ((thrustMask & (1 << 0)) || actualFx > 0.005);
        isT1Firing = hasFuel && (healthMask & (1 << 1)) && ((thrustMask & (1 << 1)) || actualFx > 0.005);
        isCounterFiring = false;
      }

      // Dynamic plume tint: High-contrast incandescent neon yellow/gold
      plumeMat.color.setHex(isCounterFiring ? 0xfef08a : 0xfacc15);
      plumeCoreMat.color.setHex(0xffffff);

      // Visibility floor: 0.22m minimum visible bell ensures micro-trimming is clearly visible
      // Full throttle (1.0) -> expands to 1.55m roaring bell
      const mainThrottle = (stageId === 3) ? Math.min(1.0, Math.abs(actualFx)) : fxForwardMag;
      const minPlumeLen = 0.22;
      const maxExtraLen = (stageId === 3) ? 0.65 : 1.35;
      const pLen = (minPlumeLen + maxExtraLen * Math.min(1.0, mainThrottle)) * (0.90 + Math.random() * 0.20);
      const plumeW = Math.max(0.08, pLen * 0.28);
      const jx = (Math.random() - 0.5) * 0.05 * Math.max(0.3, mainThrottle);

      plumeMat.opacity = Math.max(0.55, Math.min(0.98, 0.55 + mainThrottle * 0.43));
      plumeCoreMat.opacity = Math.max(0.70, Math.min(1.0, 0.70 + mainThrottle * 0.30));

      // Helper: Writes a 10-segment 3D vacuum expansion bell into BufferGeometry
      const writePlumeBell = (posAttr, ox, oy, oz, dirX, len, w, jit) => {
        const xTip = ox + dirX * len;
        let v = 0;
        const setSeg = (x1, y1, z1, x2, y2, z2) => {
          posAttr.setXYZ(v++, x1, y1, z1);
          posAttr.setXYZ(v++, x2, y2, z2);
        };
        // 1. Central incandescent spine
        setSeg(ox, oy, oz, xTip, oy + jit, oz + jit);
        // 2-5. 4 Vacuum cone expansion boundary rays
        setSeg(ox, oy, oz, xTip, oy + w, oz);
        setSeg(ox, oy, oz, xTip, oy - w, oz);
        setSeg(ox, oy, oz, xTip, oy, oz + w);
        setSeg(ox, oy, oz, xTip, oy, oz - w);
        // 6-9. Outer expansion bell perimeter crossbars
        setSeg(xTip, oy + w, oz, xTip, oy, oz + w);
        setSeg(xTip, oy, oz + w, xTip, oy - w, oz);
        setSeg(xTip, oy - w, oz, xTip, oy, oz - w);
        setSeg(xTip, oy, oz - w, xTip, oy + w, oz);
        // 10. Inner Mach shock diamond streak
        const xMid = ox + dirX * len * 0.45;
        setSeg(xMid, oy, oz, xTip, oy + jit, oz + jit);
        posAttr.needsUpdate = true;
      };

      plumeT0.visible = !!isT0Firing;
      plumeCoreT0.visible = !!isT0Firing;
      if (isT0Firing) {
        const posAttr = plumeGeo0.attributes.position;
        if (stageId === 3) {
          writePlumeBell(posAttr, 0.38, -0.10, 0, isCounterFiring ? 1.0 : -1.0, pLen, plumeW, jx);
        } else {
          writePlumeBell(posAttr, -1.6, -0.4, 0, -1.0, pLen, plumeW, jx);
        }
      }

      plumeT1.visible = !!isT1Firing;
      plumeCoreT1.visible = !!isT1Firing;
      if (isT1Firing) {
        const posAttr = plumeGeo1.attributes.position;
        if (stageId === 3) {
          writePlumeBell(posAttr, 0.38, 0.10, 0, isCounterFiring ? 1.0 : -1.0, pLen, plumeW, jx);
        } else {
          writePlumeBell(posAttr, -1.6, 0.4, 0, -1.0, pLen, plumeW, jx);
        }
      }

      // ------------------------------------------------------------------------
      // 2. Multi-Nozzle RCS Jets (T2..T11) with Multi-Ray Plasma Spray Fans
      // ------------------------------------------------------------------------
      let rcsIdx = 0;
      const rcsPos = rcsJetGeo.attributes.position;

      // Writes 1 full central jet ray + 4 short (20% length) root flare rays (horizontal & vertical)
      const addRcsSpray = (ox, oy, oz, axis, sign, len) => {
        if (rcsIdx >= 110) return;
        const shortLen = len * 0.20;
        const flareW = Math.max(0.015, shortLen * 0.60);
        const setRay = (x1, y1, z1, x2, y2, z2) => {
          rcsPos.setXYZ(rcsIdx * 2, x1, y1, z1);
          rcsPos.setXYZ(rcsIdx * 2 + 1, x2, y2, z2);
          rcsIdx++;
        };

        if (axis === 'x') {
          const dx = sign * len;
          const dxS = sign * shortLen;
          // 1. Central main jet ray (100% length)
          setRay(ox, oy, oz, ox + dx, oy, oz);
          // 2. Two horizontal short flare rays (20% length)
          setRay(ox, oy, oz, ox + dxS, oy + flareW, oz);
          setRay(ox, oy, oz, ox + dxS, oy - flareW, oz);
          // 3. Two vertical short flare rays (20% length)
          setRay(ox, oy, oz, ox + dxS, oy, oz + flareW);
          setRay(ox, oy, oz, ox + dxS, oy, oz - flareW);
        } else if (axis === 'y') {
          const dy = sign * len;
          const dyS = sign * shortLen;
          // 1. Central main jet ray (100% length)
          setRay(ox, oy, oz, ox, oy + dy, oz);
          // 2. Two horizontal short flare rays (20% length)
          setRay(ox, oy, oz, ox + flareW, oy + dyS, oz);
          setRay(ox, oy, oz, ox - flareW, oy + dyS, oz);
          // 3. Two vertical short flare rays (20% length)
          setRay(ox, oy, oz, ox, oy + dyS, oz + flareW);
          setRay(ox, oy, oz, ox, oy + dyS, oz - flareW);
        } else if (axis === 'z') {
          const dz = sign * len;
          const dzS = sign * shortLen;
          // 1. Central main jet ray (100% length)
          setRay(ox, oy, oz, ox, oy, oz + dz);
          // 2. Two horizontal short flare rays (20% length)
          setRay(ox, oy, oz, ox + flareW, oy, oz + dzS);
          setRay(ox, oy, oz, ox - flareW, oy, oz + dzS);
          // 3. Two vertical short flare rays (20% length)
          setRay(ox, oy, oz, ox, oy + flareW, oz + dzS);
          setRay(ox, oy, oz, ox, oy - flareW, oz + dzS);
        }
      };

      if (hasFuel) {
        // Forward Braking Counter-Thrusters (T2, T3 at x = 0.8, y = +-0.65)
        // Fire FORWARD (+X) to decelerate/brake when approaching dock or holding speed
        const isBraking = isReverse || (thrustMask & (1 << 2)) || (thrustMask & (1 << 3));
        if (isBraking && stageId !== 3) {
          const brakeLen = (0.16 + Math.min(1.0, fxBrakeMag) * 0.75) * (0.90 + Math.random() * 0.20);
          if (healthMask & (1 << 2)) addRcsSpray(0.8, -0.65, 0, 'x', 1.0, brakeLen);
          if (healthMask & (1 << 3)) addRcsSpray(0.8,  0.65, 0, 'x', 1.0, brakeLen);
        }

        // Lateral Translation & Attitude RCS Jets (T4, T5, T6, T7)
        // Dynamically scaled by lateral force (actualFy) and attitude torque (actualTau)
        const d5 = Math.max(0, actualFy * 0.7 - actualTau * 0.7) + ((thrustMask & (1 << 5)) ? 0.6 : 0);
        const d7 = Math.max(0, -actualFy * 0.7 + actualTau * 0.7) + ((thrustMask & (1 << 7)) ? 0.6 : 0);
        const d4 = Math.max(0, actualFy * 0.7 + actualTau * 0.7) + ((thrustMask & (1 << 4)) ? 0.6 : 0);
        const d6 = Math.max(0, -actualFy * 0.7 - actualTau * 0.7) + ((thrustMask & (1 << 6)) ? 0.6 : 0);

        const rcsLen = (demand) => (0.14 + Math.min(1.0, demand) * 0.55) * (0.90 + Math.random() * 0.20);

        if (d5 > 0.005 && (healthMask & (1 << 5))) {
          addRcsSpray(0.8, -0.65, 0, 'y', -1.0, rcsLen(d5));
        }
        if (d7 > 0.005 && (healthMask & (1 << 7))) {
          addRcsSpray(0.8,  0.65, 0, 'y', 1.0, rcsLen(d7));
        }
        if (d4 > 0.005 && (healthMask & (1 << 4))) {
          addRcsSpray(-1.3, -1.8, 0, 'y', -1.0, rcsLen(d4));
        }
        if (d6 > 0.005 && (healthMask & (1 << 6))) {
          addRcsSpray(-1.3,  1.8, 0, 'y', 1.0, rcsLen(d6));
        }

        // Vertical RCS (T8..T11)
        if ((healthMask & (1 << 8)) && (thrustMask & (1 << 8))) addRcsSpray(1.2, 0, 0.4, 'z', 1.0, 0.45);
        if ((healthMask & (1 << 9)) && (thrustMask & (1 << 9))) addRcsSpray(1.2, 0, -0.4, 'z', -1.0, 0.45);
        if ((healthMask & (1 << 10)) && (thrustMask & (1 << 10))) addRcsSpray(-1.2, 0, 0.4, 'z', 1.0, 0.45);
        if ((healthMask & (1 << 11)) && (thrustMask & (1 << 11))) addRcsSpray(-1.2, 0, -0.4, 'z', -1.0, 0.45);
      }
      rcsJetGeo.setDrawRange(0, rcsIdx * 2);
      rcsPos.needsUpdate = true;

      // Update Stage 2 Tether Wave Vibration
      if (stageId === 2) {
        const vib = tlm.cable_vibration || 0.0;
        const pos = tetherGeo.attributes.position;
        for (let i = 0; i < tetherSegCount; i++) {
          const v = vib * Math.sin((i / 100.0) * Math.PI);
          pos.setY(i, v);
        }
        pos.needsUpdate = true;
        tetherMat.color.setHex(tlm.cable_snapped ? 0xef4444 : ((tlm.cable_tension || 10000) > 13000 ? 0xf97316 : 0x38bdf8));
      }

      // Update Stage 3 360-deg Laser Scanner Fan & Defect Detection Markers
      if (stageId === 3) {
        const isClamped = (tlm.fdir_mode === 1);
        const scanDeg = (tlm.thrust_y !== undefined) ? tlm.thrust_y : 0.0;
        const beamDeg = (tlm.torque !== undefined && tlm.torque > 0.0) ? tlm.torque : 15.0;
        const snr = tlm.cable_vibration || 0.0;

        scanFanLine.visible = isClamped;
        if (isClamped) {
          const radCenter = (scanDeg * Math.PI) / 180.0;
          const halfBeam = ((beamDeg * 0.5) * Math.PI) / 180.0;
          const R = 2.7;
          const posAttr = scanFanGeo.attributes.position;
          let pIdx = 0;
          const setPt = (x, y, z) => { posAttr.setXYZ(pIdx++, x, y, z); };

          // Laser fan from crawler center to outer ring
          const aL = radCenter - halfBeam;
          setPt(0, 0, 0);
          setPt(0, R * Math.sin(aL), R * Math.cos(aL));
          setPt(0, 0, 0);
          setPt(0, R * Math.sin(radCenter), R * Math.cos(radCenter));
          const aR = radCenter + halfBeam;
          setPt(0, 0, 0);
          setPt(0, R * Math.sin(aR), R * Math.cos(aR));

          // Outer arc segments
          const numArc = 6;
          for (let k = 0; k < numArc; k++) {
            const arc1 = aL + (aR - aL) * (k / numArc);
            const arc2 = aL + (aR - aL) * ((k + 1) / numArc);
            setPt(0, R * Math.sin(arc1), R * Math.cos(arc1));
            setPt(0, R * Math.sin(arc2), R * Math.cos(arc2));
          }
          scanFanGeo.setDrawRange(0, pIdx);
          posAttr.needsUpdate = true;

          if (snr >= 600) {
            scanFanMat.color.setHex(0x10b981); // Solid Lock Green
            scanFanMat.opacity = 1.0;
          } else if (snr >= 200) {
            scanFanMat.color.setHex(0xf59e0b); // Anomaly Echo Amber
            scanFanMat.opacity = 0.85;
          } else {
            scanFanMat.color.setHex(0x06b6d4); // Active Radar Cyan
            scanFanMat.opacity = 0.65;
          }
        }

        // 3 Structural Defect Markers along Joint Rings
        const jXTable = [15.0, 30.0, 45.0, 60.0];
        const defAngles = [tlm.debris_spawn_x, tlm.debris_spawn_y, tlm.debris_spawn_z];
        const defJoints = [tlm.debris_impact_x, tlm.debris_impact_y, tlm.debris_impact_z];
        const detBits = (tlm.sensor_edge !== undefined) ? ((tlm.sensor_edge >> 20) & 0x07) : 0;

        for (let d = 0; d < 3; d++) {
          const marker = defectMarkers[d];
          if (!marker) continue;
          const jId = Math.round(defJoints[d] || 0);
          const angDeg = defAngles[d] || 0.0;
          if (angDeg === 0.0 && jId === 0 && d > 0) {
            marker.mesh.visible = false;
            continue;
          }
          const jX = jXTable[jId] || 15.0;
          const jY = getTrussRailY(jX);
          const rad = (angDeg * Math.PI) / 180.0;
          const R = 2.7;
          marker.mesh.position.set(jX, jY + R * Math.sin(rad), R * Math.cos(rad));
          marker.mesh.visible = true;

          const isDetected = (detBits & (1 << d)) !== 0;
          if (isDetected) {
            marker.mat.color.setHex(0x22c55e); // Detected: Confirmed Green
            marker.mat.opacity = 0.95;
            marker.mesh.scale.setScalar(1.2 + 0.2 * Math.sin(Date.now() * 0.006));
          } else {
            marker.mat.color.setHex(0xf59e0b); // Undetected: Faint Latent Amber
            marker.mat.opacity = 0.45;
            marker.mesh.scale.setScalar(1.0);
          }
        }
      } else {
        scanFanLine.visible = false;
        for (let d = 0; d < 3; d++) {
          if (defectMarkers[d]) defectMarkers[d].mesh.visible = false;
        }
      }

      // Update Stage 4 Centrifugal Artificial Gravity Station Rotation (Driven by daemon SSOT target_angle)
      if (stageId === 4) {
        const targetAng = tlm.target_angle !== undefined ? tlm.target_angle : (nowSec * 0.065);
        issStationGroup.rotation.x = targetAng;
      }

      // Update Stage 5 Debris Shards & Impact Dynamics
      if (stageId === 5) {
        for (const deb of debrisMeshes) {
          deb.group.rotation.x = nowSec * 0.8 + deb.idx;
          deb.group.rotation.y = nowSec * 0.6 + deb.idx;
        }

        // Kinetic impactor prologue trajectory (T=0.05..1.8s)
        if (stageElapsed >= 0.05 && stageElapsed < 1.8) {
          impactorGroup.visible = true;
          const tImpact = 0.6;
          const spawnX = tlm.debris_spawn_x !== undefined ? tlm.debris_spawn_x : -16.0;
          const spawnY = tlm.debris_spawn_y !== undefined ? tlm.debris_spawn_y : -12.0;
          const spawnZ = tlm.debris_spawn_z !== undefined ? tlm.debris_spawn_z : 3.5;
          const impPtX = tlm.debris_impact_x !== undefined ? tlm.debris_impact_x : 0.8;
          const impPtY = tlm.debris_impact_y !== undefined ? tlm.debris_impact_y : -0.65;
          const impPtZ = tlm.debris_impact_z !== undefined ? tlm.debris_impact_z : 0.0;

          if (stageElapsed < tImpact) {
            const prog = Math.max(0.0, (stageElapsed - 0.05) / (tImpact - 0.05));
            impactorGroup.position.set(
              shipX + spawnX * (1 - prog) + impPtX * prog,
              shipY + spawnY * (1 - prog) + impPtY * prog,
              shipZ + spawnZ * (1 - prog) + impPtZ * prog
            );
          } else {
            const tPost = stageElapsed - tImpact;
            impactorGroup.position.set(
              shipX + impPtX + tPost * 8.0,
              shipY + impPtY + tPost * 4.0,
              shipZ + impPtZ + tPost * 2.0
            );
          }
          impactorGroup.rotation.x = nowSec * 12.0;
          impactorGroup.rotation.y = nowSec * 8.0;

          // Shockwave and Sparks at collision
          if (stageElapsed >= 0.6 && stageElapsed <= 1.8) {
            const flashAge = stageElapsed - 0.6;
            const flashAlpha = Math.max(0, 1.0 - flashAge / 1.2);
            shockwaveMesh.visible = true;
            shockwaveMesh.position.set(shipX + impPtX, shipY + impPtY, shipZ + impPtZ);
            const scale = Math.min(3.5, flashAge * 4.0) + 0.1;
            shockwaveMesh.scale.set(scale, scale, scale);
            shockwaveMat.opacity = flashAlpha;

            sparkPoints.visible = true;
            sparkPoints.position.set(shipX + impPtX, shipY + impPtY, shipZ + impPtZ);
            sparkMat.opacity = flashAlpha;
            const spAttr = sparkGeo.attributes.position;
            for (let sp = 0; sp < sparkCount; sp++) {
              const ang = (sp * Math.PI * 2 / sparkCount) + sp * 0.3;
              const dist = flashAge * (1.8 + (sp % 4) * 0.8);
              spAttr.setXYZ(sp, Math.cos(ang) * dist, Math.sin(ang) * dist, (sp % 2 === 0 ? 0.3 : -0.3) * dist);
            }
            spAttr.needsUpdate = true;
          } else {
            shockwaveMesh.visible = false;
            sparkPoints.visible = false;
          }
        } else {
          impactorGroup.visible = false;
          shockwaveMesh.visible = false;
          sparkPoints.visible = false;
        }
      }

      // Camera Presets & Dynamic Motion
      const cinemaModes = ['chase', 'nose', 'hero', 'orbit', 'track'];
      const effectiveMode = (st.cameraPreset === 'cinema') ? cinemaModes[st.cinemaIndex] : st.cameraPreset;

      // Stage 5 Initial Debris Impact Camera Shake
      let shakeX = 0, shakeY = 0, shakeZ = 0;
      if (stageId === 5 && stageElapsed >= 0.6 && stageElapsed < 1.8) {
        const shakeDecay = Math.max(0, 1.0 - (stageElapsed - 0.6) / 1.2);
        const shakeMag = 0.35 * shakeDecay;
        shakeX = (Math.sin(now * 0.065) + Math.cos(now * 0.089)) * shakeMag;
        shakeY = (Math.cos(now * 0.071) - Math.sin(now * 0.093)) * shakeMag;
        shakeZ = Math.sin(now * 0.082) * shakeMag * 0.7;
      }

      let camX, camY, camZ;

      if (effectiveMode === 'track') {
        // Dynamic Stationary Tracking Camera:
        // Positioned so that approach, closest flyby, and departure complete symmetrically.
        const isModeSwitch = (st.lastEffectiveMode !== 'track');
        const isRewind = (shipX < (st.lastShipX || 0) - 4.0);
        const isStageChanged = (st.lastStageId !== undefined && st.lastStageId !== stageId);
        // Continuous Relay: When spacecraft has flown past the camera by the same distance it approached from,
        // reposition the camera ahead to repeat the approach -> pass-by sequence seamlessly.
        const isFlownPast = !!(st.trackAnchor && st.trackAnchor.leadDist &&
                               (shipX - st.trackAnchor.stationX) >= (st.trackAnchor.leadDist * 0.98));

        if (!st.trackAnchor || isModeSwitch || isRewind || isStageChanged || isFlownPast) {
          const vx = Math.abs(tlm.vel_x !== undefined ? tlm.vel_x : 1.6);
          const forwardSpeed = Math.max(0.6, Math.min(3.5, vx));
          const slotDuration = st.trackCinemaDuration || 6.0;

          // Closest approach occurs right at 50% of the allocated slot duration:
          // The craft approaches during the first half, passes the camera, and recedes during the second half.
          const leadDist = Math.max(3.2, forwardSpeed * (slotDuration * 0.50));
          const targetStationX = shipX + leadDist;

          // Corridor centerline at targetStationX
          let corridorY = 0.0;
          if (stageId === 1) {
            corridorY = getPipelineY(targetStationX);
          } else if (stageId === 3) {
            corridorY = getTrussRailY(targetStationX);
          } else if (stageId === 5) {
            corridorY = Math.max(-1.5, Math.min(1.5, shipY * 0.4));
          }

          let corridorZ = (stageId === 5 ? Math.max(0.0, shipZ * 0.5) : 0.0);

          // Four observation quadrants relative to flight corridor:
          // Top-Right (右上: -Y, +Z), Top-Left (左上: +Y, +Z),
          // Bottom-Right (右下: -Y, -Z), Bottom-Left (左下: +Y, -Z)
          const qScale = (stageId === 3) ? 0.5 : 1.0;
          const quadrants = [
            { y: -2.8 * qScale, z: 1.2 * qScale },  // 右上 (Starboard Elevated)
            { y: 2.8 * qScale, z: 1.2 * qScale },   // 左上 (Port Elevated)
            { y: -2.8 * qScale, z: -1.2 * qScale }, // 右下 (Starboard Ventral)
            { y: 2.8 * qScale, z: -1.2 * qScale }   // 左下 (Port Ventral)
          ];

          const prevQuad = (st.trackQuadIndex !== undefined) ? st.trackQuadIndex : -1;
          let nextQuad;
          do {
            nextQuad = Math.floor(Math.random() * quadrants.length);
          } while (nextQuad === prevQuad && quadrants.length > 1);
          st.trackQuadIndex = nextQuad;

          const chosenQuad = quadrants[nextQuad];

          // Close-up vantage point in selected quadrant:
          // With 3.6m spacecraft wingspan (1.0m wingtip clearance), this provides a roaring, high-speed flyby!
          st.trackAnchor = {
            stationX: targetStationX,
            initShipX: shipX,
            leadDist: leadDist,
            corridorY: corridorY,
            corridorZ: corridorZ,
            relY: chosenQuad.y,
            relZ: chosenQuad.z
          };
        }

        const anchor = st.trackAnchor;
        const zoomScale = 1.0 / Math.max(0.4, Math.min(5.0, st.zoom));

        camX = anchor.stationX + st.userOffset.yaw * 6.0 + shakeX;
        camY = anchor.corridorY + (anchor.relY * zoomScale) + shakeY;
        camZ = anchor.corridorZ + (anchor.relZ * zoomScale) + st.userOffset.pitch * 4.0 + shakeZ;

        camera.position.set(camX, camY, camZ);
        camera.up.set(0, 0, 1);
        camera.lookAt(shipX, shipY, shipZ);
      } else {
        // Spacecraft-relative camera views: chase, nose, hero, orbit
        // Stage 3 crawler is 0.76m (compact), so baseDist is calibrated 2.5x closer for crisp default visibility!
        let baseAzimuth = 0.0;
        let baseElevation = 0.26;
        let baseDist = (stageId === 3) ? 3.6 : 9.0;

        if (effectiveMode === 'chase') {
          baseAzimuth = 0.0;
          baseElevation = 0.26;
          baseDist = (stageId === 3) ? 3.6 : 9.0;
        } else if (effectiveMode === 'nose') {
          baseAzimuth = Math.PI;
          baseElevation = 0.20;
          baseDist = (stageId === 3) ? 3.0 : 7.5;
        } else if (effectiveMode === 'hero') {
          baseAzimuth = -0.75;
          baseElevation = -0.28;
          baseDist = (stageId === 3) ? 2.5 : 6.2;
        } else if (effectiveMode === 'orbit') {
          baseAzimuth = (now * 0.00045) % (Math.PI * 2);
          baseElevation = 0.24 + 0.12 * Math.sin(now * 0.0003);
          baseDist = (stageId === 3) ? 3.5 : 8.8;
        }

        const finalAzimuth = baseAzimuth + st.userOffset.yaw;
        const finalElevation = Math.max(-1.3, Math.min(1.3, baseElevation + st.userOffset.pitch));
        const finalDist = baseDist / Math.max(0.4, Math.min(5.0, st.zoom));

        const cosA = Math.cos(finalAzimuth);
        const sinA = Math.sin(finalAzimuth);
        const cosE = Math.cos(finalElevation);
        const sinE = Math.sin(finalElevation);

        camX = shipX - finalDist * cosE * cosA + shakeX;
        camY = shipY - finalDist * cosE * sinA + shakeY;
        camZ = shipZ + finalDist * sinE + shakeZ;

        camera.position.set(camX, camY, camZ);

        // Smooth camera roll damping
        const targetCamRoll = (st.cameraPreset === 'chase' ? -Math.max(-0.12, Math.min(0.12, (tlm.omega || 0) * 0.15)) : 0.0);
        st.smoothRoll += (targetCamRoll - st.smoothRoll) * 0.08;

        // Camera Up vector with subtle roll around line of sight
        const r_raw = new THREE.Vector3(sinA, -cosA, 0.0);
        const u_raw = new THREE.Vector3(sinE * cosA, sinE * sinA, cosE);
        const cosR = Math.cos(st.smoothRoll);
        const sinR = Math.sin(st.smoothRoll);
        const camUp = new THREE.Vector3()
          .addScaledVector(r_raw, -sinR)
          .addScaledVector(u_raw, cosR);

        camera.up.copy(camUp);
        camera.lookAt(shipX, shipY, shipZ);
      }

      // Record state history for mode transitions and restarts
      st.lastEffectiveMode = effectiveMode;
      st.lastShipX = shipX;
      st.lastStageId = stageId;

      // Keep celestial starfield centered around camera (Infinite Distance zero parallax)
      starField.position.set(camX, camY, camZ);

      // WebGL Hardware Render Call
      renderer.render(scene, camera);

      // ----------------------------------------------------------------------
      // Lightweight 2D Tactical HUD Overlay
      // ----------------------------------------------------------------------
      const hudCtx = hudCanvas.getContext('2d');
      hudCtx.clearRect(0, 0, clientW, clientH);

      // Helper to project 3D point to 2D HUD Canvas
      const tempVec = new THREE.Vector3();
      const toScreen = (wx, wy, wz) => {
        tempVec.set(wx, wy, wz);
        tempVec.project(camera);
        if (tempVec.z > 1.0) return null; // behind far plane or camera
        const sx = (tempVec.x * 0.5 + 0.5) * clientW;
        const sy = (-(tempVec.y * 0.5) + 0.5) * clientH;
        return { sx, sy };
      };

      // 1. Tactical Crosshair ahead of ship
      const aimP = toScreen(shipX + 10.0, getPipelineY(shipX + 10.0), 0.0);
      if (aimP) {
        hudCtx.save();
        hudCtx.shadowBlur = 10;
        hudCtx.shadowColor = '#00f0ff';
        hudCtx.strokeStyle = 'rgba(0, 240, 255, 0.85)';
        hudCtx.lineWidth = 1.4;
        hudCtx.beginPath();
        hudCtx.arc(aimP.sx, aimP.sy, 8, 0, Math.PI * 2);
        hudCtx.moveTo(aimP.sx - 12, aimP.sy); hudCtx.lineTo(aimP.sx + 12, aimP.sy);
        hudCtx.moveTo(aimP.sx, aimP.sy - 12); hudCtx.lineTo(aimP.sx, aimP.sy + 12);
        hudCtx.stroke();
        hudCtx.restore();
      }

      // 2. Stage-Specific HUD Labels
      hudCtx.font = 'bold 11px monospace';
      hudCtx.textAlign = 'center';

      if (stageId === 1) {
        for (const rm of ringMeshes) {
          const isPassed = rm.rx < shipX - 1.0;
          const isNext = Math.abs(rm.rx - shipX) < ringSpacing;
          if (rm.isTarget) {
            rm.mat.color.setHex(0xeab308);
            rm.glowMat.color.setHex(0xeab308);
            rm.mat.opacity = 0.95;
            rm.glowMat.opacity = 0.50;
          } else if (isNext) {
            rm.mat.color.setHex(0x38bdf8);
            rm.glowMat.color.setHex(0x38bdf8);
            rm.mat.opacity = 1.0;
            rm.glowMat.opacity = 0.65;
          } else if (isPassed) {
            rm.mat.color.setHex(0x10b981);
            rm.glowMat.color.setHex(0x059669);
            rm.mat.opacity = 0.70;
            rm.glowMat.opacity = 0.25;
          } else {
            rm.mat.color.setHex(rm.isGate ? 0x0284c7 : 0x0369a1);
            rm.glowMat.color.setHex(rm.isGate ? 0x0284c7 : 0x0369a1);
            rm.mat.opacity = rm.isGate ? 0.85 : 0.60;
            rm.glowMat.opacity = rm.isGate ? 0.35 : 0.15;
          }
          if (rm.isGate) {
            const p = toScreen(rm.rx, getPipelineY(rm.rx), hexRadius);
            if (p) {
              hudCtx.save();
              hudCtx.shadowBlur = isNext ? 12 : 6;
              hudCtx.shadowColor = isPassed ? '#10b981' : (isNext ? '#38bdf8' : '#0284c7');
              hudCtx.fillStyle = isPassed ? '#10b981' : (isNext ? '#38bdf8' : '#94a3b8');
              hudCtx.fillText(`GATE ${String(Math.round(rm.rx / 5.0)).padStart(2, '0')}`, p.sx, p.sy - 8);
              hudCtx.restore();
            }
          }
        }
      } else if (stageId === 2) {
        // Beacon labels
        hudCtx.font = '10px monospace';
        for (const bm of beaconMeshes) {
          const p = toScreen(bm.bx, 0, 2.5);
          if (p) {
            const isPassed = bm.bx < shipX - 1.0;
            hudCtx.fillStyle = isPassed ? '#10b981' : '#94a3b8';
            hudCtx.fillText(`BEACON ${Math.round(bm.bx / 10)} (${bm.bx.toFixed(0)}m)`, p.sx, p.sy - 6);
          }
        }
        // Station and Terminal labels
        const pGeo = toScreen(-2.5, 0, torusOuterR);
        if (pGeo) {
          hudCtx.font = 'bold 11px monospace';
          hudCtx.fillStyle = '#38bdf8';
          hudCtx.fillText('GEO ORBITAL STATION [ALPHA ANCHOR]', pGeo.sx, pGeo.sy - 8);
        }
        const pAst = toScreen(100.0, 0, 3.8);
        if (pAst) {
          hudCtx.font = 'bold 12px monospace';
          hudCtx.fillStyle = '#fde047';
          hudCtx.fillText('ASTEROID MINING BASE [TERMINAL PORT]', pAst.sx, pAst.sy - 10);
        }
      } else if (stageId === 3) {
        for (const jm of jointMeshes) {
          const jy = getTrussRailY(jm.x);
          const p = toScreen(jm.x, jy, 2.8);
          if (p) {
            const isPassed = jm.x < shipX - 0.5;
            const isClose = Math.abs(shipX - jm.x) <= 0.6;
            hudCtx.fillStyle = isClose ? '#facc15' : (isPassed ? '#10b981' : '#38bdf8');
            hudCtx.fillText(jm.name, p.sx, p.sy - 8);
          }
        }
        // Major ISS Modules & Facilities
        const pKibo = toScreen(36.0, 10.5, -2.2);
        if (pKibo) {
          hudCtx.font = 'bold 11px monospace';
          hudCtx.fillStyle = '#38bdf8';
          hudCtx.fillText('JAXA KIBO (JEM) LAB & EF', pKibo.sx, pKibo.sy - 8);
        }
        const pDestiny = toScreen(30.0, 5.0, -2.2);
        if (pDestiny) {
          hudCtx.font = '10px monospace';
          hudCtx.fillStyle = '#06b6d4';
          hudCtx.fillText('NASA DESTINY (US LAB)', pDestiny.sx, pDestiny.sy - 8);
        }
        const pSaw = toScreen(30.0, 0.0, 8.5);
        if (pSaw) {
          hudCtx.font = 'bold 10px monospace';
          hudCtx.fillStyle = '#f59e0b';
          hudCtx.fillText('SOLAR ARRAY WINGS (4x SAW)', pSaw.sx, pSaw.sy - 8);
        }
        const pC1 = toScreen(22.5, getTrussRailY(22.5), 2.4);
        if (pC1 && shipX <= 28.0) {
          hudCtx.font = '9px monospace';
          hudCtx.fillStyle = '#facc15';
          hudCtx.fillText('⚠️ CURVE 01 [R=5.0m | Fc < 300N]', pC1.sx, pC1.sy - 8);
        }
        const pC2 = toScreen(42.5, getTrussRailY(42.5), 2.4);
        if (pC2 && shipX >= 25.0 && shipX <= 48.0) {
          hudCtx.font = '9px monospace';
          hudCtx.fillStyle = '#facc15';
          hudCtx.fillText('⚠️ CURVE 02 [R=5.0m | Fc < 300N]', pC2.sx, pC2.sy - 8);
        }
      } else if (stageId === 4) {
        for (const cpm of cpMeshes) {
          const p = toScreen(cpm.x, 0, 3.0);
          if (p) {
            const isPassed = cpm.x < shipX - 0.5;
            hudCtx.fillStyle = isPassed ? '#10b981' : '#06b6d4';
            hudCtx.fillText(cpm.name, p.sx, p.sy - 6);
          }
        }
        const pPort = toScreen(50.0, 0, 3.2);
        if (pPort) {
          hudCtx.fillStyle = '#fde047';
          hudCtx.fillText('TARGET PORT #01 [ROTATING]', pPort.sx, pPort.sy - 10);
        }
      } else if (stageId === 5) {
        // Recovery Gate line
        const pGate = toScreen(35.0, 0, 6.0);
        if (pGate) {
          hudCtx.fillStyle = '#4ade80';
          hudCtx.fillText('SAFE ORBIT RECOVERY LINE (35m)', pGate.sx, pGate.sy - 12);
        }
        // Debris Labels
        hudCtx.font = '9px monospace';
        for (let i = 0; i < debrisConfigs.length; i++) {
          const cfg = debrisConfigs[i];
          const pDeb = toScreen(cfg.x, cfg.y, cfg.z);
          if (pDeb) {
            hudCtx.fillStyle = '#f87171';
            hudCtx.fillText(`DEBRIS #${i + 1}`, pDeb.sx, pDeb.sy - 8);
          }
        }
      }

      } catch (err) {
        console.error('[sg-orbit-viewer] Render error:', err);
      } finally {
        animId = targetWin.requestAnimationFrame(render);
      }
    };

    animId = targetWin.requestAnimationFrame(render);

    return () => {
      targetWin.cancelAnimationFrame(animId);
      if (renderer) renderer.dispose();
      scene.clear();
    };
  }, []);

  // Mouse Interaction handlers
  const handleMouseDown = (e) => {
    dragRef.current.isDragging = true;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
    dragRef.current.baseYaw = userOffset.yaw;
    dragRef.current.basePitch = userOffset.pitch;
  };

  const handleMouseMove = (e) => {
    if (!dragRef.current.isDragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setUserOffset({
      yaw: dragRef.current.baseYaw + dx * 0.007,
      pitch: Math.max(-1.2, Math.min(1.2, dragRef.current.basePitch + dy * 0.007))
    });
  };

  const handleMouseUp = () => {
    dragRef.current.isDragging = false;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    setZoom(prev => Math.max(0.4, Math.min(5.0, prev - e.deltaY * 0.0015)));
  };

  const resetView = () => {
    setUserOffset({ yaw: 0.0, pitch: 0.0 });
    setZoom(1.0);
  };

  const isManualOffset = userOffset.yaw !== 0.0 || userOffset.pitch !== 0.0 || zoom !== 1.0;

  return React.createElement('div', {
    ref: containerRef,
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
        { id: 'track', label: 'TRACK' },
        { id: 'cinema', label: cameraPreset === 'cinema' ? `CINEMA [CAM ${cinemaIndex + 1}/5]` : 'CINEMA (AUTO)' }
      ].map(preset =>
        React.createElement('button', {
          key: preset.id,
          onClick: () => {
            if (preset.id === 'track') {
              stateRef.current.trackAnchor = null;
            }
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
        max: '5.0',
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

    // Layer 1: Hardware-Accelerated 3D WebGL Canvas
    React.createElement('canvas', {
      ref: glCanvasRef,
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp,
      onMouseLeave: handleMouseUp,
      onWheel: handleWheel,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        cursor: dragRef.current.isDragging ? 'grabbing' : 'grab'
      }
    }),

    // Layer 2: Transparent 2D Tactical HUD Canvas
    React.createElement('canvas', {
      ref: hudCanvasRef,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: 'none'
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
        pointerEvents: 'none',
        zIndex: 10
      }
    }, 'DRAG: 3D Orbit Rotate | WHEEL: Zoom | 120 FPS WebGL'),

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
        gap: '12px',
        zIndex: 10
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
          React.createElement('span', null, `PIPE: ${telemetry.pos_x.toFixed(1)}m / 60m`),
          React.createElement('span', null, `VEL: ${telemetry.vel_x.toFixed(2)} m/s`),
          React.createElement('span', {
            style: { color: Math.abs(telemetry.cross_track_err || 0) > 250 ? '#ef4444' : '#10b981', fontWeight: 'bold' }
          }, `CLAMP LOAD: ${(telemetry.cross_track_err || 0).toFixed(1)}N / 300N`),
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
      ) : telemetry.stage_id === 5 ? (() => {
        const azDeg = telemetry.debris_azimuth !== undefined ? (telemetry.debris_azimuth * 180.0 / Math.PI) : -140;
        const elDeg = telemetry.debris_elevation !== undefined ? (telemetry.debris_elevation * 180.0 / Math.PI) : 16;
        const dStr = (azDeg > -45 && azDeg <= 45) ? "BOW" : (azDeg > 45 && azDeg <= 135) ? "PORT" : (azDeg < -45 && azDeg >= -135) ? "STBD" : "STERN";
        const vStr = elDeg > 5 ? "UPPER" : (elDeg < -5 ? "LOWER" : "HORIZ");
        return React.createElement(React.Fragment, null,
          React.createElement('span', { style: { color: '#f87171', fontWeight: 'bold' } }, 'STAGE EX: PANIC CONTROL'),
          React.createElement('span', null, `SEED: 0x${(telemetry.chaos_seed || 0).toString(16).toUpperCase()}`),
          React.createElement('span', null, `INC: ${dStr}/${vStr} (${azDeg.toFixed(0)}°)`),
          React.createElement('span', {
            style: { color: '#ef4444', fontWeight: 'bold' }
          }, `DMG: T${telemetry.damaged_thruster_1 !== undefined ? telemetry.damaged_thruster_1 : '?'}, T${telemetry.damaged_thruster_2 !== undefined ? telemetry.damaged_thruster_2 : '?'}`),
          React.createElement('span', {
            style: { color: Math.abs(telemetry.omega || 0) < 0.05 ? '#4ade80' : '#ef4444', fontWeight: 'bold' }
          }, `SPIN: ${(Math.abs(telemetry.omega || 0) * 180.0 / Math.PI).toFixed(1)}°/s ${Math.abs(telemetry.omega || 0) < 0.05 ? '[DETUMBLED]' : '[TUMBLING]'}`),
          React.createElement('span', {
            style: { color: (telemetry.fuel || 100) < 30 ? '#ef4444' : '#f59e0b', fontWeight: 'bold' }
          }, `LEAK FUEL: ${(telemetry.fuel || 100).toFixed(1)}%`),
          React.createElement('span', null, `HITS: ${telemetry.debris_hits || 0}`),
          React.createElement('span', {
            style: {
              color: (Math.abs(telemetry.wheel_rpm_x || 0) > 5000 || Math.abs(telemetry.wheel_rpm_y || 0) > 5000 || Math.abs(telemetry.wheel_rpm_z || 0) > 5000) ? '#ef4444' : '#c084fc',
              fontWeight: 'bold'
            }
          }, `RW: [X:${(telemetry.wheel_rpm_x || 0).toFixed(0)} Y:${(telemetry.wheel_rpm_y || 0).toFixed(0)} Z:${(telemetry.wheel_rpm_z !== undefined ? telemetry.wheel_rpm_z : (telemetry.wheel_rpm || 0)).toFixed(0)}]`)
        );
      })() : (
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
