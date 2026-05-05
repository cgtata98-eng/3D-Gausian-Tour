import {
  AppBase,
  Asset,
  Entity,
  StandardMaterial,
  Color,
  ContainerHandler,
  MeshInstance,
} from 'playcanvas';

function createCollisionMaterial(colorHex: string, opacity: number): StandardMaterial {
  const mat = new StandardMaterial();
  const c = new Color();
  c.fromString(colorHex);
  mat.diffuse = c;
  mat.opacity = opacity;
  mat.blendType = 2; // BLEND_NORMAL
  mat.depthWrite = false;
  mat.cull = 0; // CULLFACE_NONE
  mat.update();
  return mat;
}

function applyMaterialToEntity(entity: Entity, material: StandardMaterial) {
  if (entity.render) {
    entity.render.meshInstances.forEach((mi: MeshInstance) => { mi.material = material; });
  }
  entity.children.forEach((child) => {
    if (child instanceof Entity) applyMaterialToEntity(child, material);
  });
}

export interface CollisionEntity {
  entity: Entity;
  material: StandardMaterial;
}

export async function loadCollisionGlb(
  app: AppBase,
  url: string,
  name: string,
  color: string = '#00ff00',
  opacity: number = 0.15
): Promise<CollisionEntity> {
  // Register ContainerHandler if not already
  if (!app.loader.getHandler('container')) {
    app.loader.addHandler('container', new ContainerHandler(app));
  }

  return new Promise((resolve, reject) => {
    const asset = new Asset(name, 'container', { url });
    asset.on('load', () => {
      const entity = (asset.resource as any).instantiateRenderEntity();
      const mat = createCollisionMaterial(color, opacity);
      applyMaterialToEntity(entity, mat);
      resolve({ entity, material: mat });
    });
    asset.on('error', (err: string) => reject(new Error(err)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

export function setCollisionOpacity(c: CollisionEntity, opacity: number) {
  c.material.opacity = opacity;
  c.material.update();
  applyMaterialToEntity(c.entity, c.material);
}

export function setCollisionVisible(c: CollisionEntity, visible: boolean) {
  c.entity.enabled = visible;
}
