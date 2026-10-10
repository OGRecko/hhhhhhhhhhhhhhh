import React, { useRef, useState, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Html, OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import { MAT_COLORS } from '../lib/materials';
import { generateInterpolationGrid, Point3D } from '../lib/interpolation';
import { LIMITS } from '../lib/publicLimits';

// Point-in-polygon test (ray casting) plus distance-to-nearest-edge, on room
// world coordinates. Used both for 1st-person walking collision and for
// clamping drag targets so sources/receivers can't be dropped outside the
// room or clipped into a wall.
function isInsideRoom(poly: { x: number; y: number }[], L: number, W: number, worldX: number, worldZ: number, margin: number) {
  if (!poly || poly.length < 3) return true;
  const nx = worldX / L + 0.5;
  const nz = worldZ / W + 0.5;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > nz) !== (yj > nz)) &&
      (nx < (xj - xi) * (nz - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  if (!inside) return false;
  let minDist = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const x1 = (poly[j].x - 0.5) * L, z1 = (poly[j].y - 0.5) * W;
    const x2 = (poly[i].x - 0.5) * L, z2 = (poly[i].y - 0.5) * W;
    const dx = x2 - x1, dz = z2 - z1;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq === 0 ? 0 : ((worldX - x1) * dx + (worldZ - z1) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, pz = z1 + t * dz;
    const dist = Math.hypot(worldX - px, worldZ - pz);
    if (dist < minDist) minDist = dist;
  }
  return minDist >= margin;
}

function CameraManager({ isDragging }: { isDragging: boolean }) {
  const { viewMode } = useStore();
  const { camera } = useThree();

  useEffect(() => {
    if (viewMode !== '2d') {
      camera.position.set(0, 15, 15);
      camera.lookAt(0, 0, 0);
    }
  }, [viewMode]);

  if (viewMode === '2d') {
    return (
      <>
        <OrthographicCamera makeDefault position={[0, 50, 0]} zoom={30} rotation={[-Math.PI / 2, 0, 0]} />
        <OrbitControls enableRotate={false} enabled={!isDragging} />
      </>
    );
  }
  return <OrbitControls enabled={!isDragging} />;
}

const HeatmapFloorOverlay = React.memo(({ L, W }: { L: number, W: number }) => {
  const multiReceiverResult = useStore(state => state.multiReceiverResult);
  const heatmapMetric = useStore(state => state.heatmapMetric);
  
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);

  useEffect(() => {
    if (!multiReceiverResult || !multiReceiverResult.receivers || multiReceiverResult.receivers.length < 2) {
      if (texture) {
        texture.dispose();
        setTexture(null);
      }
      return;
    }

    const points: Point3D[] = [];
    multiReceiverResult.receivers.forEach(r => {
      const val = r.metrics[heatmapMetric as keyof typeof r.metrics] as number;
      if (val != null && Number.isFinite(val)) {
        points.push({ x: r.position.x, y: r.position.y, z: r.position.z, value: val });
      }
    });

    if (points.length < 2) return;

    let min = Infinity;
    let max = -Infinity;
    points.forEach(p => {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    });

    const resolution = 64;
    const grid = generateInterpolationGrid(points, resolution);

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    const cellW = canvas.width / resolution;
    const cellH = canvas.height / resolution;

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const val = grid[y * resolution + x];
        if (val === null) continue;
        const normalized = max > min ? (val - min) / (max - min) : 0.5;
        const hue = 240 - normalized * 240;
        ctx.fillStyle = `hsla(${hue}, 100%, 50%, 0.6)`;
        ctx.fillRect(x * cellW, canvas.height - (y + 1) * cellH, cellW + 1, cellH + 1);
      }
    }

    const newTex = new THREE.CanvasTexture(canvas);
    setTexture(newTex);

    return () => {
      newTex.dispose();
    };
  }, [multiReceiverResult, heatmapMetric]);

  if (!texture) return null;

  return (
    <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[L, W]} />
      <meshBasicMaterial map={texture} transparent opacity={0.8} />
    </mesh>
  );
});

/** DISPLAY ONLY: marker height for a receiver whose Z is unknown. Never used by any analysis. */
const RECEIVER_UNKNOWN_Z_DISPLAY_M = 1.2;

const ReceiverNode = React.memo(({ r, i, L, W, isActive, onDown, onDoubleClick, onClick, dragInfo }: any) => {
  return (
    <mesh 
      position={[(r.x - 0.5) * L, r.z ?? RECEIVER_UNKNOWN_Z_DISPLAY_M, (r.y - 0.5) * W]}
      onPointerDown={onDown}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = dragInfo ? 'move' : 'auto')}
    >
      <sphereGeometry args={[0.2, 16, 16]} />
      <meshStandardMaterial color={isActive ? "#ffffff" : "#6b7280"} emissive={isActive ? "#ffffff" : "#000000"} emissiveIntensity={0.2} />
      <Html center zIndexRange={[1, 5]}>
        <div
          className="bg-[#6b7280] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-lg select-none cursor-move"
          style={{ pointerEvents: 'auto' }}
          onPointerDown={onDown}
          onDoubleClick={onDoubleClick}
          onClick={onClick}
        >{i + 1}</div>
      </Html>
    </mesh>
  );
});

export default function ThreeView() {
  const { 
    viewMode,
    poly, L, W, H, updatePoint, addPoint, removePoint, setPoly,
    sources, receivers, activeReceiverId, setActiveReceiverId,
    updateSource, updateReceiver, addReceiver, addingReceiver,
    removeSource, removeReceiver,
    wallMaterial, wallSegMats, selectedWallSeg, setSelectedWallSeg, floorMaterial, theme,
    wallOpenings, setWallOpening,
  } = useStore();
  
  const [dragInfo, setDragInfo] = useState<{type: 'corner'|'source'|'receiver', index: number|string} | null>(null);
  const didDrag = useRef(false);

  const pts = poly.map(p => new THREE.Vector3((p.x - 0.5) * L, 0, (p.y - 0.5) * W));
  const shape = new THREE.Shape();
  if (pts.length > 0) {
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
    shape.lineTo(pts[0].x, -pts[0].z);
  }

  const floorColor = MAT_COLORS[floorMaterial] || '#404040';

  return (
    <>
      {addingReceiver && (
        <div className="absolute top-4 right-4 z-10 bg-[#2563eb] text-black px-4 py-2 rounded text-xs font-bold shadow-lg">
          Click on the floor to place receiver
        </div>
      )}

      {/* Room Builder UI Guide */}
      {!activeReceiverId && (
        <div className={`absolute bottom-16 right-4 z-10 ${theme === 'dark' ? 'bg-[#202226]/90 border-[#2a2c30] text-[#e7e7e5]' : 'bg-white/90 border-[#e5e7eb] text-[#111827]'} border px-4 py-3 rounded-md text-xs shadow-lg backdrop-blur pointer-events-none`}>
          <div className="font-bold mb-2 flex items-center"><span className="w-2 h-2 rounded-full bg-[#2563eb] mr-2"></span> Room Builder</div>
          <ul className="list-none space-y-1 opacity-90">
            <li><b>Drag</b> corners to customize shape</li>
            <li><b>Double-Click</b> walls to split / add corner</li>
            <li><b>Double-Click</b> corners to delete</li>
          </ul>
        </div>
      )}
      
      {viewMode === '2d' ? (
        <div className="absolute top-4 left-4 z-20 text-[#2563eb] font-bold text-xs uppercase bg-[#202226] px-3 py-1 rounded border border-[#2563eb]">2D TOP VIEW</div>
      ) : null}
      <Canvas 
        shadows={{ type: THREE.PCFShadowMap }}
        camera={{ position: [0, 15, 15], fov: 50 }} 
        className={`w-full h-full ${theme === 'dark' ? 'bg-[#1a1b1e]' : 'bg-[#f0f2f5]'}`}
        style={{ cursor: dragInfo ? 'move' : addingReceiver ? 'crosshair' : 'default' }}
        onPointerMove={(e) => {
          if (dragInfo) {
            // No-op here: drag tracking is handled by the global invisible
            // plane's onPointerMove below, which intersects at the correct
            // elevation for whatever is being dragged.
          }
        }}
        onPointerUp={() => {
          if (dragInfo) setDragInfo(null);
        }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[10, 20, 10]} intensity={0.7} castShadow shadow-mapSize={[2048, 2048]} />
        <gridHelper args={[100, 100, theme === "dark" ? "#2a2c30" : "#e5e7eb", theme === "dark" ? "#1a1b1e" : "#f3f4f6"]} position={[0, -0.01, 0]} />

        {/* Global plane to catch pointer moves for dragging.
            Height matches whatever we're currently dragging so the ray
            intersects at the same elevation as the object - otherwise
            the drop point drifts away from the cursor as the camera tilts. */}
        <mesh 
          rotation={[-Math.PI / 2, 0, 0]} 
          position={[0, dragInfo?.type === 'receiver' ? 1.6 : dragInfo?.type === 'source' ? H * 0.85 : H, 0]} 
          visible={true}
          onPointerMove={(e) => {
            if (dragInfo) {
              e.stopPropagation();
              didDrag.current = true;
              // Snap to 0.5m grid
              const snap = 0.5;
              const snappedX = Math.round(e.point.x / snap) * snap;
              const snappedZ = Math.round(e.point.z / snap) * snap;

              let newX = snappedX / L + 0.5;
              let newY = snappedZ / W + 0.5;
              
              if (dragInfo.type === 'corner') {
                const i = dragInfo.index as number;
                const prev = poly[(i - 1 + poly.length) % poly.length];
                const next = poly[(i + 1) % poly.length];
                
                // Auto-lock (snap) to adjacent points to easily make perfectly straight 90-degree walls
                const threshX = 0.04;
                const threshY = 0.04;
                
                if (Math.abs(newX - prev.x) < threshX) newX = prev.x;
                else if (Math.abs(newX - next.x) < threshX) newX = next.x;
                
                if (Math.abs(newY - prev.y) < threshY) newY = prev.y;
                else if (Math.abs(newY - next.y) < threshY) newY = next.y;

                updatePoint(i, {x: newX, y: newY});
              } else if (dragInfo.type === 'source') {
                // Keep sources/receivers from being dropped outside the
                // room or clipped into a wall - corners are exempt since
                // dragging them is how the room shape itself is edited.
                if (isInsideRoom(poly, L, W, snappedX, snappedZ, 0.3)) {
                  updateSource(dragInfo.index as string, {x: newX, y: newY});
                }
              } else if (dragInfo.type === 'receiver') {
                if (isInsideRoom(poly, L, W, snappedX, snappedZ, 0.3)) {
                  updateReceiver(dragInfo.index as string, {x: newX, y: newY});
                }
              }
            }
          }}
          onPointerUp={() => setDragInfo(null)}
          
        >
          <planeGeometry args={[1000, 1000]} />
          <meshBasicMaterial transparent={true} opacity={0} depthWrite={false} />
        </mesh>

        <group position={[0, 0, 0]}>
          <mesh 
            rotation={[-Math.PI / 2, 0, 0]} 
            receiveShadow
            visible={true} 
            onPointerDown={(e) => {
              if (addingReceiver) {
                e.stopPropagation();
                const { point } = e;
                if (receivers.length >= LIMITS.MAX_RECEIVERS) { useStore.getState().setAddingReceiver(false); return; }
                addReceiver({
                  id: crypto.randomUUID(),
                  name: `Receiver ${receivers.length + 1}`,
                  x: Math.min(1, Math.max(0, (point.x / L) + 0.5)),
                  y: Math.min(1, Math.max(0, (point.z / W) + 0.5)),
                  z: Math.min(1.2, H) // explicit ISO 3382 receiver height, matching what the UI shows
                });
                useStore.getState().setAddingReceiver(false);
              }
            }}
          >
            <shapeGeometry args={[shape]} />
            <meshStandardMaterial color={floorColor} side={THREE.DoubleSide} roughness={0.9} />
          </mesh>

          <HeatmapFloorOverlay L={L} W={W} />

          {pts.map((p, i) => {
            const nextP = pts[(i + 1) % pts.length];
            const length = p.distanceTo(nextP);
            const mid = new THREE.Vector3((p.x + nextP.x) / 2, H / 2, (p.z + nextP.z) / 2);
            const angle = Math.atan2(nextP.z - p.z, nextP.x - p.x);
            
            const segMat = wallSegMats[i] || wallMaterial;
            const wColor = MAT_COLORS[segMat] || '#607d8b';
            const isSelected = selectedWallSeg === i;
            const opening = wallOpenings[i];

            const selectHandlers = {
              onPointerDown: (e: any) => {
                e.stopPropagation();
                setSelectedWallSeg(isSelected ? null : i);
              },
              onDoubleClick: (e: any) => {
                e.stopPropagation();
                const normX = e.point.x / L + 0.5;
                const normY = e.point.z / W + 0.5;
                addPoint(i + 1, {x: normX, y: normY});
              },
              onPointerOver: () => (document.body.style.cursor = 'pointer'),
              onPointerOut: () => (document.body.style.cursor = dragInfo ? 'move' : 'auto'),
            };

            const wallMaterialProps = {
              color: wColor,
              roughness: 0.85,
              transparent: true,
              opacity: isSelected ? 0.9 : 0.4,
              emissive: isSelected ? '#ffffff' : '#000000',
              emissiveIntensity: isSelected ? 0.1 : 0,
            };
            const edgeColor = isSelected ? '#2563eb' : (theme === 'dark' ? '#78909c' : '#b0bec5');

            if (opening === 'full') {
              // Whole wall removed - render a thin, mostly-invisible click
              // target (so the opening can still be selected/restored from
              // the panel) with a dashed outline marking where the wall
              // used to be, but no solid geometry and no acoustic barrier.
              return (
                <group key={`wall-${i}`} position={mid} rotation={[0, -angle, 0]}>
                  <mesh {...selectHandlers} visible={false}>
                    <boxGeometry args={[length, H, 0.2]} />
                  </mesh>
                  {isSelected && (
                    <lineSegments>
                      <edgesGeometry args={[new THREE.BoxGeometry(length, H, 0.05)]} />
                      <lineBasicMaterial color="#ff6b6b" linewidth={2} />
                    </lineSegments>
                  )}
                </group>
              );
            }

            if (opening && typeof opening === 'object') {
              // Partial gap: split into up to two solid pieces (left of the
              // gap, right of the gap) so the doorway/window opening is a
              // real hole in the geometry, not just a visual trick.
              const gapStart = Math.max(0, Math.min(1, opening.start));
              const gapEnd = Math.max(gapStart, Math.min(1, opening.end));
              const leftLen = gapStart * length;
              const rightLen = (1 - gapEnd) * length;
              const pieces: React.ReactNode[] = [];
              if (leftLen > 0.01) {
                const leftOffset = -length / 2 + leftLen / 2;
                pieces.push(
                  <group key="left" position={[leftOffset, 0, 0]}>
                    <mesh {...selectHandlers}>
                      <boxGeometry args={[leftLen, H, 0.2]} />
                      <meshStandardMaterial {...wallMaterialProps} />
                    </mesh>
                    <lineSegments>
                      <edgesGeometry args={[new THREE.BoxGeometry(leftLen, H, 0.2)]} />
                      <lineBasicMaterial color={edgeColor} linewidth={isSelected ? 2 : 1} />
                    </lineSegments>
                  </group>
                );
              }
              if (rightLen > 0.01) {
                const rightOffset = length / 2 - rightLen / 2;
                pieces.push(
                  <group key="right" position={[rightOffset, 0, 0]}>
                    <mesh {...selectHandlers}>
                      <boxGeometry args={[rightLen, H, 0.2]} />
                      <meshStandardMaterial {...wallMaterialProps} />
                    </mesh>
                    <lineSegments>
                      <edgesGeometry args={[new THREE.BoxGeometry(rightLen, H, 0.2)]} />
                      <lineBasicMaterial color={edgeColor} linewidth={isSelected ? 2 : 1} />
                    </lineSegments>
                  </group>
                );
              }
              // Thin invisible click target spanning the gap itself, so the
              // opening remains selectable even from directly in front of
              // the hole (where there's no solid geometry to click on).
              const gapLen = (gapEnd - gapStart) * length;
              const gapOffset = -length / 2 + (gapStart + (gapEnd - gapStart) / 2) * length;
              if (gapLen > 0.01) {
                pieces.push(
                  <mesh key="gap" position={[gapOffset, 0, 0]} {...selectHandlers} visible={false}>
                    <boxGeometry args={[gapLen, H, 0.2]} />
                  </mesh>
                );
              }
              return (
                <group key={`wall-${i}`} position={mid} rotation={[0, -angle, 0]}>
                  {pieces}
                </group>
              );
            }

            // Solid wall (no opening)
            return (
              <group key={`wall-${i}`} position={mid} rotation={[0, -angle, 0]}>
                <mesh {...selectHandlers}>
                  <boxGeometry args={[length, H, 0.2]} />
                  <meshStandardMaterial {...wallMaterialProps} />
                </mesh>
                <lineSegments>
                  <edgesGeometry args={[new THREE.BoxGeometry(length, H, 0.2)]} />
                  <lineBasicMaterial color={edgeColor} linewidth={isSelected ? 2 : 1} />
                </lineSegments>
              </group>
            );
          })}

          {pts.map((p, i) => (
            <mesh 
              key={'corner-'+i} 
              position={[p.x, H, p.z]}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                useStore.getState().saveHistory();
                setDragInfo({ type: 'corner', index: i });
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(i);
              }}
              onPointerOver={() => (document.body.style.cursor = 'move')}
              onPointerOut={() => (document.body.style.cursor = dragInfo ? 'move' : 'auto')}
            >
              <sphereGeometry args={[0.2, 16, 16]} />
              <meshBasicMaterial color="#2563eb" transparent opacity={0.6} />
              <Html center zIndexRange={[1, 5]}> 
                <div className="text-[#2563eb] font-bold text-[11px] -mt-6 select-none pointer-events-none">{i + 1}</div>
              </Html>
            </mesh>
          ))}

          
               
          {sources.map((s, i) => (
            <mesh 
              key={s.id} 
              position={[(s.x - 0.5) * L, H * 0.85, (s.y - 0.5) * W]}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removeSource(s.id);
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                useStore.getState().saveHistory();
                setDragInfo({ type: 'source', index: s.id });
              }}
              onPointerOver={() => (document.body.style.cursor = 'move')}
              onPointerOut={() => (document.body.style.cursor = dragInfo ? 'move' : 'auto')}
            >
              <sphereGeometry args={[0.25, 16, 16]} />
              <meshStandardMaterial color="#2563eb" emissive="#2563eb" emissiveIntensity={0.8} roughness={0.2} metalness={0.8} />
              <Html center zIndexRange={[1, 5]}>
                <div
                  className="bg-[#2563eb] text-[#0d0e0f] text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-lg select-none cursor-move"
                  style={{ pointerEvents: 'auto' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    useStore.getState().saveHistory();
                    setDragInfo({ type: 'source', index: s.id });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    removeSource(s.id);
                  }}
                >{i + 1}</div>
              </Html>
            </mesh>
          ))}

          {receivers.map((r, i) => (
            <ReceiverNode
              key={r.id}
              r={r} i={i} L={L} W={W}
              isActive={activeReceiverId === r.id}
              dragInfo={dragInfo}
              onDown={(e: any) => {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                didDrag.current = false;
                useStore.getState().saveHistory();
                setDragInfo({ type: 'receiver', index: r.id });
              }}
              onDoubleClick={(e: any) => {
                e.stopPropagation();
                removeReceiver(r.id);
              }}
              onClick={(e: any) => {
                e.stopPropagation();
                if (!didDrag.current) {
                  setActiveReceiverId(r.id);
                }
              }}
            />
          ))}
        </group>

        <CameraManager isDragging={!!dragInfo} />
      </Canvas>
    </>
  );
}
