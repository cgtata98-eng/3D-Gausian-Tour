/*
  3ds Max side of the Vantage panorama pipeline.

  Entry points:

    VR_exportCameras()    -- <root>\cameras.json + cameras.csv + cameras.vrscene
        then, in a terminal:  npm run render:plan
    VR_exportVrscenes()   -- reads <root>\render-plan.ms, one .vrscene per state
        then:                 npm run render:run

  Or use the GUI: vantage-tool.ms

  This script never renders. All rendering happens in Vantage, driven by
  scripts/render/run.mjs over Vantage's localhost:20702 API.

  The camera trick: Vantage's sequence command takes a frame range, not a camera
  name, and its API has no way to enumerate or pick a camera inside a loaded
  vrscene. So a single render camera is animated to teleport to viewpoint N on
  frame N. Frame number IS the viewpoint id, and render-plan.ms (generated from
  the same cameras.json) is what tells the renamer which is which.

  MAXScript note: every `local` in this file sits at the very top of its block.
  MAXScript rejects a local declaration that follows any other expression in the
  same block ("先頭行にローカル宣言がありません"), so hoisting is not a style
  choice here.
*/

-- ── Settings ────────────────────────────────────────────────────────────────
global VR_RENDER_ROOT = @"D:\vr_render"     -- must match the `render root` used by run.mjs
global VR_CAM_PREFIX  = "VR_"               -- cameras named VR_AA, VR_AB, ... are viewpoints
global VR_UNIT_SCALE  = 0.001               -- Max system units -> metres (mm scene = 0.001)
global VR_RENDER_CAM_NAME = "VR_RENDER_CAM" -- the animated camera Vantage actually renders

-- Declare every function as a global BEFORE defining it. MAXScript binds an
-- undeclared name used inside a rollout to a rollout-LOCAL, not to the global
-- that gets defined later — so a UI that calls these would silently see
-- `undefined`. Declaring up front makes the binding unambiguous.
global VR_applyMat, VR_applyLight, VR_applyFurn, VR_applyAxis
global VR_objectsOnLayer, VR_cameraNameCompare, VR_viewpointCameras, VR_nodeIdFor, VR_checkVRay
global VR_allCameras, VR_sanitizeId
global VR_writeCamerasCsv, VR_writeCamerasJson, VR_exportVrsceneSelectedOnly
global VR_exportCameras, VR_buildRenderCamera, VR_exportVrscenes

-- ── Scene-specific state application ────────────────────────────────────────
-- FILL THESE IN for your scene. They receive the axis value strings from
-- states.config.json ("m01" / "day" / "on" ...). Anything you can do by hand in
-- the Max UI can go here; it runs once per state before the vrscene is exported.
-- Left as stubs they only log, which is enough to test the whole round trip.

fn VR_applyMat value = (
  -- e.g. assign from a material library to the objects on a layer:
  --   local lib = loadTempMaterialLibrary (VR_RENDER_ROOT + @"\materials.mat")
  --   local m = for mm in lib where mm.name == value do exit with mm
  --   for o in (VR_objectsOnLayer "FLOOR") do o.material = m
  format "  [state] mat = %\n" value
)

fn VR_applyLight value = (
  --   (LayerManager.getLayerFromName "LIGHT_DAY").on   = (value == "day")
  --   (LayerManager.getLayerFromName "LIGHT_NIGHT").on = (value == "night")
  format "  [state] light = %\n" value
)

fn VR_applyFurn value = (
  --   (LayerManager.getLayerFromName "FURNITURE").on = (value == "on")
  format "  [state] furn = %\n" value
)

-- axis key -> handler. Add a row when you add an axis to states.config.json.
fn VR_applyAxis key value = (
  case key of (
    "mat":   VR_applyMat value
    "light": VR_applyLight value
    "furn":  VR_applyFurn value
    default: format "  [state] WARNING unhandled axis '%' = %\n" key value
  )
)

-- ── Helpers ─────────────────────────────────────────────────────────────────

fn VR_objectsOnLayer layerName = (
  local lay, out
  lay = LayerManager.getLayerFromName layerName
  out = #()
  if lay != undefined do lay.nodes &out
  out
)

fn VR_cameraNameCompare a b = (
  if a.name < b.name then -1 else if a.name > b.name then 1 else 0
)

/* Every real camera in the scene, minus the generated render camera.
   `isKindOf c camera` rather than a name test: the `cameras` collection also
   contains Targetobject helpers, and plugin cameras must not be missed. */
fn VR_allCameras = (
  local cams
  cams = for c in cameras where (isKindOf c camera) and c.name != VR_RENDER_CAM_NAME collect c
  -- Name order defines frame order, and must match cameras.json exactly.
  qsort cams VR_cameraNameCompare
  cams
)

/* The viewpoint cameras. `VR_CAM_PREFIX = ""` means "every camera in the scene" —
   use that when the scene's cameras are not named to a convention. Otherwise only
   names starting with the prefix are taken. */
fn VR_viewpointCameras = (
  local all
  all = VR_allCameras()
  if VR_CAM_PREFIX == "" then all
  else ( for c in all where (matchPattern c.name pattern:(VR_CAM_PREFIX + "*")) collect c )
)

/* Node ids become folder and file names, so anything that is not safe in a path
   is folded to "_". With no prefix the whole camera name is the id, and real
   scene cameras are called things like "Camera 001" or "PhysCamera001". */
fn VR_sanitizeId s = (
  local out, ch, i
  out = ""
  for i = 1 to s.count do (
    ch = s[i]
    if (findString "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" ch) != undefined
      then out += ch
      else out += "_"
  )
  out
)

fn VR_nodeIdFor cam = (
  if VR_CAM_PREFIX == "" then VR_sanitizeId cam.name
  else VR_sanitizeId (substring cam.name (VR_CAM_PREFIX.count + 1) -1)
)

fn VR_checkVRay = (
  local n
  n = (classOf renderers.production) as string
  if (findString n "V_Ray") == undefined do
    format "WARNING: production renderer is '%' — vrayExportVRScene may be unavailable.\n" n
)

-- ── 1. Cameras — exported ONCE, separately from the scene states ────────────
--
-- Viewpoint cameras are identical across every state, so they live at the render
-- root and every set folder refers back to them. Writing them per state would
-- mean 12 copies that can silently drift apart, and the frame-number-to-node-id
-- mapping is the one thing in this pipeline that must not be ambiguous.

/* The first column records the source .max file rather than a set name: these
   cameras are shared by every state, so provenance ("which scene produced this
   list") is the link worth carrying, not a set that does not apply. */
fn VR_writeCamerasCsv path cams = (
  local f, c, e, i, src
  f = createFile path
  src = maxFileName
  format "maxFile,index,id,maxCamera,posX,posY,posZ,yaw,pitch,roll,fov,unitScale\n" to:f
  for i = 1 to cams.count do (
    c = cams[i]
    -- Read rotation off the transform matrix: a Target camera is driven by a
    -- LookAt controller and has no `.rotation` property at all — reading it
    -- throws, and most real scenes have target cameras.
    e = (c.transform.rotationPart) as eulerangles
    format "%,%,%,%,%,%,%,%,%,%,%,%\n" \
      src (i - 1) (VR_nodeIdFor c) c.name \
      c.pos.x c.pos.y c.pos.z e.z e.x e.y c.fov VR_UNIT_SCALE to:f
  )
  close f
)

fn VR_writeCamerasJson path cams = (
  local f, c, e, i
  f = createFile path
  format "{\n" to:f
  format "  \"unitScale\": %,\n" VR_UNIT_SCALE to:f
  format "  \"note\": \"raw 3ds Max coordinates (Z-up). Convert to Y-up metres once, on import.\",\n" to:f
  format "  \"nodes\": [\n" to:f
  for i = 1 to cams.count do (
    c = cams[i]
    e = (c.transform.rotationPart) as eulerangles   -- see note in VR_writeCamerasCsv
    format "    { \"index\": %, \"id\": \"%\", \"maxCamera\": \"%\", \"pos\": [%, %, %], \"yaw\": %, \"fov\": % }%\n" \
      (i - 1) (VR_nodeIdFor c) c.name c.pos.x c.pos.y c.pos.z e.z c.fov \
      (if i < cams.count then "," else "") to:f
  )
  format "  ]\n}\n" to:f
  close f
)

/* Export only what is currently selected. The keyword is `exportSelectionOnly`
   — confirmed working on this machine's V-Ray (see Desktop\vantageVRSceneExporter_ANIMATION.ms,
   which has been used in production). Returns true on success. */
fn VR_exportVrsceneSelectedOnly path startF endF = (
  local done
  done = false
  try (
    vrayExportVRScene path startFrame:startF endFrame:endF exportSelectionOnly:true
    done = true
  ) catch (
    format "  selection-only export failed: %\n" (getCurrentException())
  )
  done
)

/* Writes <root>\cameras.json, cameras.csv and cameras.vrscene.
   `vrscene:false` skips the camera-only vrscene when you only want the data. */
fn VR_exportCameras vrscene:true = (
  local cams, rcam, prevSel, ok
  cams = VR_viewpointCameras()
  if cams.count == 0 do (
    format "ERROR: no cameras named %*\n" VR_CAM_PREFIX
    return false
  )

  makeDir VR_RENDER_ROOT all:true
  VR_writeCamerasJson (VR_RENDER_ROOT + @"\cameras.json") cams
  VR_writeCamerasCsv  (VR_RENDER_ROOT + @"\cameras.csv")  cams
  format "wrote cameras.json / cameras.csv (% cameras) in %\n" cams.count VR_RENDER_ROOT

  if vrscene do (
    rcam = VR_buildRenderCamera()
    if rcam != undefined do (
      prevSel = selection as array
      clearSelection()
      select rcam
      ok = VR_exportVrsceneSelectedOnly (VR_RENDER_ROOT + @"\cameras.vrscene") \
             animationRange.start animationRange.end
      clearSelection()
      if prevSel.count > 0 do select prevSel
      if ok then format "wrote cameras.vrscene\n"
      else format "WARNING: no selection-only export keyword accepted — cameras.vrscene skipped.\n"
    )
  )

  format "next: npm run render:plan\n"
  true
)

-- ── 2. Teleporting render camera ────────────────────────────────────────────

fn VR_buildRenderCamera = (
  local cams, rcam, i
  cams = VR_viewpointCameras()
  if cams.count == 0 do (
    format "ERROR: no viewpoint cameras\n"
    return undefined
  )

  rcam = getNodeByName VR_RENDER_CAM_NAME
  if rcam == undefined then (
    rcam = FreeCamera name:VR_RENDER_CAM_NAME
  ) else (
    -- Wipe old keys or a shortened camera list leaves stale frames at the end.
    deleteKeys rcam.controller #allKeys
  )
  rcam.fov = cams[1].fov

  animationRange = interval 0 (cams.count - 1)
  animate on (
    for i = 1 to cams.count do (
      -- Copy the whole transform rather than pos + rotation separately: a Target
      -- camera has no `.rotation` property (LookAt controller), and the matrix
      -- carries position and orientation together anyway.
      at time (i - 1) ( rcam.transform = cams[i].transform )
    )
  )
  -- Interpolation between keys is irrelevant: every rendered frame lands exactly
  -- on a key, and motion blur is off in the Vantage sequence params.
  format "render camera '%' keyed for % frames (0-%)\n" VR_RENDER_CAM_NAME cams.count (cams.count - 1)
  rcam
)

-- ── 3. States -> one .vrscene each ──────────────────────────────────────────

fn VR_exportVrscenes = (
  local planPath, rcam, camCount, stateId, outPath, st, pair
  planPath = VR_RENDER_ROOT + @"\render-plan.ms"

  VR_checkVRay()
  if not (doesFileExist planPath) do (
    format "ERROR: % not found — run 'npm run render:plan' first.\n" planPath
    return false
  )
  fileIn planPath

  rcam = VR_buildRenderCamera()
  if rcam == undefined do return false

  camCount = (VR_viewpointCameras()).count
  if VR_PLAN_FRAME_COUNT != camCount do (
    format "ERROR: plan expects % frames but the scene has % %* cameras. Re-run VR_exportCameras() and npm run render:plan.\n" \
      VR_PLAN_FRAME_COUNT camCount VR_CAM_PREFIX
    return false
  )

  viewport.setCamera rcam

  for st in VR_PLAN_STATES do (
    stateId = st[1]
    outPath = VR_RENDER_ROOT + "\\" + (substituteString st[2] "/" "\\")
    format "\n=== % ===\n" stateId

    if doesFileExist outPath then (
      format "  exists, skipping — delete it to re-export\n"
    ) else (
      for pair in st[3] do VR_applyAxis pair[1] pair[2]
      makeDir (getFilenamePath outPath) all:true
      vrayExportVRScene outPath startFrame:animationRange.start endFrame:animationRange.end \
                        exportHEXFormatTransf:true
      format "  wrote %\n" outPath
    )
  )

  format "\ndone. next: npm run render:run\n"
  true
)

global VR_EXPORT_LOADED = true
format "vantage-export.ms loaded.\n  VR_exportCameras()   -- step 1\n  VR_exportVrscenes()  -- step 3 (after npm run render:plan)\n"
