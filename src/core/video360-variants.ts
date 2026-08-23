/**
 * 360°動画の描き分け素材を、家具 / 照明トグルの側から引くための小物。
 *
 * ビューアのトグルは `FurnitureMode` x `LightingMode` の 2 軸だが、素材が 4 通り
 * 全部そろっているとは限らない。実際 mansyon_A は 通常 / 家具なし / 夜 の 3 本で、
 * 「夜 × 家具なし」が無い。そこを黙って別の絵に落とすと、家具なしを選んだのに
 * 家具が出るという嘘になるので、**無い組み合わせは押せないようにする**。
 *
 * 判定を UI と SceneManager の両方に書くと必ず食い違うので、ここに寄せる。
 */
import type { Plan, Video360Variant, Video360Walk } from './types';

export type Furniture = 'on' | 'off';
export type Lighting = 'day' | 'night';

/** そのプランの描き分け素材。無ければ空配列。 */
export function video360VariantsOf(plan: Plan | null | undefined): Video360Variant[] {
  return plan?.video360?.variants ?? [];
}

/**
 * 軸ごとに、素材が存在する値。
 *
 * `furniture` / `lighting` を書いていないバリアント (手で足したものなど) は
 * どちらの軸にも数えない。id からの推測はしない ― 綴りを変えた瞬間に静かに
 * 壊れる類の推測で、間違えたときに気付けない。
 */
export function variantAxes(list: Video360Variant[]): {
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
export function pickVariant(
  list: Video360Variant[],
  furniture: Furniture,
  lighting: Lighting,
): Video360Variant | null {
  return list.find((v) => v.furniture === furniture && v.lighting === lighting) ?? null;
}

/**
 * いま `other` 軸がその値のとき、この軸の値を選べるか。
 *
 * トグルの片方を無効にするのに使う。例: 照明が「夜」のとき、家具「なし」の素材が
 * 無ければ家具トグルの「なし」を押せなくする。
 */
export function canSelect(
  list: Video360Variant[],
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
