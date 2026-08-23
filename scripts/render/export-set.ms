/*
  Export ONE scene state ("set") into its own folder, named after the set.

    VR_exportSet "m01_day_on"
    VR_exportSet "test01" root:@"D:\vr_render"

  Produces:

    <root>\<setName>\
      <setName>.vrscene     -- 全体シーン (Vantage で開くのはこれ)
      <setName>.set.json    -- このセットの中身とカメラ側への参照

  Cameras are NOT written here. They are identical in every state, so they are
  exported once, separately, by VR_exportCameras() into the render root:

    <root>\cameras.json / cameras.csv / cameras.vrscene

  <setName>.set.json points back at those by relative path, so the link between a
  set folder and the camera list is recorded rather than inferred.

  NOTE: the animated render camera is still baked INTO <setName>.vrscene. It has
  to be — Vantage's API renders a frame range out of the file it opened and has no
  command to merge a separate camera file. cameras.vrscene is a reference /
  manual-inspection artifact, not something run.mjs loads.
*/

-- Load vantage-export.ms if it is not in memory yet. The guard tests a sentinel
-- global's EXISTENCE (not its value) so it never touches an undefined name, and
-- re-loading is avoided because that would reset VR_RENDER_ROOT back to default.
if (globalVars.isGlobal #VR_EXPORT_LOADED) == false do (
  local here
  here = getFilenamePath (getSourceFileName())
  fileIn (here + "vantage-export.ms")
)

-- Declared before definition so a rollout binds to the global, not to a
-- rollout-local (see the same note in vantage-export.ms).
global VR_writeSetManifest, VR_exportSet

fn VR_writeSetManifest path setName cams = (
  local f
  f = createFile path
  format "{\n" to:f
  format "  \"set\": \"%\",\n" setName to:f
  format "  \"maxFile\": \"%\",\n" (maxFileName) to:f
  format "  \"frameCount\": %,\n" cams.count to:f
  format "  \"files\": { \"scene\": \"%.vrscene\" },\n" setName to:f
  format "  \"cameras\": {\n" to:f
  format "    \"json\": \"../cameras.json\",\n" to:f
  format "    \"csv\": \"../cameras.csv\",\n" to:f
  format "    \"vrscene\": \"../cameras.vrscene\"\n" to:f
  format "  }\n}\n" to:f
  close f
)

fn VR_exportSet setName root:undefined = (
  local cams, dir, stem, name, useRoot
  name = setName
  useRoot = root

  if name == undefined or (name as string) == "" do (
    format "usage: VR_exportSet \"m01_day_on\"  [root:@\"D:\\vr_render\"]\n"
    return false
  )
  name = name as string
  if useRoot == undefined do useRoot = VR_RENDER_ROOT

  cams = VR_viewpointCameras()
  if cams.count == 0 do (
    format "ERROR: no cameras named %*  — name your viewpoint cameras VR_AA, VR_AB, ...\n" VR_CAM_PREFIX
    return false
  )

  dir = useRoot + "\\" + name
  stem = dir + "\\" + name
  makeDir dir all:true

  format "\n=== export set '%' ===\n" name
  format "  folder  : %\n" dir
  format "  cameras : % (frames 0-%)\n" cams.count (cams.count - 1)

  -- Warn early rather than let the mismatch surface as wrongly-named output six
  -- hours into a render run.
  if not (doesFileExist (useRoot + @"\cameras.json")) do
    format "  WARNING: %\\cameras.json not found — run VR_exportCameras() once.\n" useRoot

  -- The teleporting render camera must be keyed BEFORE the export, or the vrscene
  -- carries an empty animation range and Vantage renders the same frame N times.
  if (VR_buildRenderCamera()) == undefined then (
    false
  ) else (
    viewport.setCamera (getNodeByName VR_RENDER_CAM_NAME)

    format "  exporting full scene...\n"
    vrayExportVRScene (stem + ".vrscene") startFrame:animationRange.start \
                      endFrame:animationRange.end exportHEXFormatTransf:true
    format "  wrote %.vrscene\n" name

    VR_writeSetManifest (stem + ".set.json") name cams

    format "done — %\n" dir
    true
  )
)

global VR_EXPORTSET_LOADED = true
format "export-set.ms loaded.  usage: VR_exportSet \"m01_day_on\"   (cameras: VR_exportCameras())\n"
