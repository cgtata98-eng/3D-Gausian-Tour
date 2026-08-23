/**
 * 家具 / 照明トグルから素材を引くための小物。3DGS・360画像・360動画に共通。
 *
 * ビューアのトグルは `FurnitureMode` x `LightingMode` の 2 軸だが、素材が 4 通り
 * 全部そろっているとは限らない。実際 mansyon_A は 通常 / 家具なし / 夜 の 3 本で、
 * 「夜 × 家具なし」が無い。そこを黙って別の絵に落とすと、家具なしを選んだのに
 * 家具が出るという嘘になるので、**無い組み合わせは押せないようにする**。
 *
 * 素材の置き場は 2 つある:
 *   - `Plan.assetVariants`  … 3DGS と 360画像
 *   - `Plan.video360.variants` … 360動画 (ノード・エッジ・軌跡と一体なので別)
 * 軸の綴りは両方で揃えてある。揃っていないと、同じトグルで動画と GS の挙動が
 * 食い違う。判定を UI と SceneManager の両方に書くと必ずずれるので、ここに寄せる。
 */
import type { AssetVariant, Plan, Video360Variant, Video360Walk } from './types';

export type Furniture = 'on' | 'off';
export type Lighting = 'day' | 'night';

/** 軸を持つものなら何でも通る最小の形。 */
export interface VariantAxis {
  id: string;
  label?: string;
  furniture?: Furniture;
  lighting?: Lighting;
}

/** そのプランの描き分け素材。無ければ空配列。 */
export function video360VariantsOf(plan: Plan | null | undefined): Video360Variant[] {
  return plan?.video360?.variants ?? [];
}

/** 3DGS / 360画像 の描き分け素材。無ければ空配列。 */
export function assetVariantsOf(plan: Plan | null | undefined): AssetVariant[] {
  return plan?.assetVariants ?? [];
}

/**
 * プラン既定の素材が表している組み合わせ。
 *
 * 家具あり x 昼。`useUIStore` の初期値と同じで、「何も切り替えていない状態」が
 * これにあたる。行として持たせない ― 既定の素材はプランが `splat` /
 * `panoramas` / `video360.src` として既に持っており、同じものを指す行を作ると
 * 持ち主が 2 つになる。
 */
const PLAN_DEFAULT_AXIS: VariantAxis = {
  id: '__plan_default__', label: '通常', furniture: 'on', lighting: 'day',
};

/**
 * そのプランで家具・照明トグルが引きうる組み合わせすべて。
 *
 * 動画と GS/画像を混ぜて 1 本の軸として扱う ― トグルは 1 組しかないので、
 * 「動画では夜に行けるが GS では行けない」を軸の側で表現する手段が無い。
 * 押せるかどうかは「どれか 1 つでも素材がある」で決める。
 *
 * 何か 1 つでも素材があるときは、**プラン既定の組み合わせを必ず足す**。
 * 差し替えたいのは既定から外れた絵だけなので、家具なし・夜しか行を作らないのが
 * 普通の入れ方になる。そのとき既定を候補に入れないと、家具なしに切り替えたあと
 * 元に戻れなくなる (「あり」が素材なし扱いで押せなくなる)。
 */
export function allVariantsOf(plan: Plan | null | undefined): VariantAxis[] {
  const list: VariantAxis[] = [...assetVariantsOf(plan), ...video360VariantsOf(plan)];
  if (list.length === 0) return list;
  const hasDefault = list.some((v) => v.furniture === 'on' && v.lighting === 'day');
  return hasDefault ? list : [PLAN_DEFAULT_AXIS, ...list];
}

/** その組み合わせの 3DGS / 360画像 素材。無ければ null。 */
export function pickAssetVariant(
  plan: Plan | null | undefined,
  furniture: Furniture,
  lighting: Lighting,
): AssetVariant | null {
  return pickVariant(assetVariantsOf(plan), furniture, lighting);
}

/**
 * 軸ごとに、素材が存在する値。
 *
 * `furniture` / `lighting` を書いていないバリアント (手で足したものなど) は
 * どちらの軸にも数えない。id からの推測はしない ― 綴りを変えた瞬間に静かに
 * 壊れる類の推測で、間違えたときに気付けない。
 */
export function variantAxes(list: VariantAxis[]): {
  furniture: Furniture[];
  lighting: Lighting[];
} {
  const f = new Set<Furniture>();
  const l = new Set<Lighting>();
  for (const v of list) {
    if (v.furniture) f.add(v.furniture);
    if (v.lighting) l.add(v.lighting);
  }
  return {
    furniture: (['on', 'off'] as const).filter((x) => f.has(x)),
    lighting: (['day', 'night'] as const).filter((x) => l.has(x)),
  };
}

/** その組み合わせの素材。無ければ null。 */
export function pickVariant<T extends VariantAxis>(
  list: T[],
  furniture: Furniture,
  lighting: Lighting,
): T | null {
  return list.find((v) => v.furniture === furniture && v.lighting === lighting) ?? null;
}

/**
 * いま `other` 軸がその値のとき、この軸の値を選べるか。
 *
 * トグルの片方を無効にするのに使う。例: 照明が「夜」のとき、家具「なし」の素材が
 * 無ければ家具トグルの「なし」を押せなくする。
 */
export function canSelect(
  list: VariantAxis[],
  axis: 'furniture' | 'lighting',
  value: Furniture | Lighting,
  other: Furniture | Lighting,
): boolean {
  return axis === 'furniture'
    ? !!pickVariant(list, value as Furniture, other as Lighting)
    : !!pickVariant(list, other as Furniture, value as Lighting);
}

/**
 * 「素材そのものが差し替わったか」を見分ける鍵。
 *
 * walker を作り直すべきかの判定に使う。いま貼っている 1 本の src で比べては
 * いけない ― 家具なしに切り替えたあとでノードを 1 つ打つと、貼っている src が
 * 既定と違うせいで「素材が変わった」と誤判定し、8K を読み直したうえで既定の
 * バリアントへ勝手に戻る。持ち物全体で比べれば、その事故が起きない。
 */
export function video360SourceSignature(data: Video360Walk | null | undefined): string {
  if (!data) return '';
  const variants = (data.variants ?? [])
    .map((v) => `${v.id}|${v.src}|${v.srcReverse ?? ''}`)
    .join(';');
  return `${data.src}|${data.srcReverse ?? ''}|${data.defaultVariantId ?? ''}|${variants}`;
}
