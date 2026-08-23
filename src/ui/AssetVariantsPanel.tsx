/**
 * 家具あり / なし・昼 / 夜 で差し替える素材の置き場 (Debug → プラン タブ)。
 *
 * ここが長らく無かった。ツールバー表示の「家具切替を表示」「情景切替を表示」は
 * ビューアにトグルを **出すだけ** で、そのトグルが引く素材を入れる場所がどこにも
 * 無く、「タグはあるのに設定できるものが無い」状態だった。
 *
 * 組み合わせは 4 通りに固定して並べる。自由に足せる形にしない ― id が
 * `${furniture}_${lighting}` で決まる以上、名前を手で付けさせると綴り違いで
 * 引けなくなるだけで、選べる幅は 1 ミリも増えない。
 *
 * 埋めるのは差し替えたいものだけでよい。空のスロットはプラン既定
 * (`splat` / `panoramas`) に落ちるので、「夜だけ別の GS」のような持ち方ができる。
 *
 * 360°動画はここに置かない。動画はノード・エッジ・軌跡と一体なので
 * `video360.variants` が持ち、取り込みは 360°動画セクションで行う。
 */
import { useState } from 'react';
import type { AssetVariant, Plan } from '../core/types';
import { useSceneStore } from '../store/scene-store';
import { IDB_REF_PREFIX, deleteBlob, saveBlob } from '../utils/idb';
import { surfaceClass, IconClose, IconTrash } from './components';

const BTN = `${surfaceClass('neutral')} ds-pill ds-pill--sm ds-fill-neutral`;
const BTN_PRIMARY = `${surfaceClass('plain')} ds-pill ds-pill--sm ds-fill-surface`;
const DANGER = `${surfaceClass('danger')} ds-pill ds-pill--icon ds-pill--sm`;

/** 並べる 4 通り。順番は「よく使う順」— 通常が先頭。 */
const SLOTS: { id: string; label: string; furniture: 'on' | 'off'; lighting: 'day' | 'night' }[] = [
  { id: 'on_day', label: '通常', furniture: 'on', lighting: 'day' },
  { id: 'off_day', label: '家具なし', furniture: 'off', lighting: 'day' },
  { id: 'on_night', label: '夜', furniture: 'on', lighting: 'night' },
  { id: 'off_night', label: '家具なし・夜', furniture: 'off', lighting: 'night' },
];

interface Props {
  plan: Plan;
  sceneId: string;
}

export function AssetVariantsPanel({ plan, sceneId }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const variants = plan.assetVariants ?? [];
  const v360 = plan.video360?.variants ?? [];

  const write = (next: AssetVariant[]) => {
    useSceneStore.setState((s) => {
      if (!s.manifest?.plans) return s;
      // 中身が空になった行は落とす。残しておくと「素材があるからトグルを出す」
      // 判定に引っかかって、押せるのに何も変わらないトグルが出る。
      const kept = next.filter((v) => v.splat || v.splatSpz || v.splatSog
        || Object.keys(v.panoramas ?? {}).length > 0);
      return {
        manifest: {
          ...s.manifest,
          plans: s.manifest.plans.map((p) => (p.id === plan.id
            ? { ...p, assetVariants: kept.length ? kept : undefined }
            : p)),
        },
      };
    });
  };

  /** その行を取り出す (無ければ軸だけ入った空の行を作る)。 */
  const rowOf = (slot: typeof SLOTS[number]): AssetVariant =>
    variants.find((v) => v.id === slot.id)
    ?? { id: slot.id, label: slot.label, furniture: slot.furniture, lighting: slot.lighting };

  const patchRow = (slot: typeof SLOTS[number], patch: Partial<AssetVariant>) => {
    const cur = rowOf(slot);
    const next = { ...cur, ...patch };
    write(variants.some((v) => v.id === slot.id)
      ? variants.map((v) => (v.id === slot.id ? next : v))
      : [...variants, next]);
  };

  /**
   * 素材は IDB に置いて、manifest には参照だけ持つ。
   *
   * manifest に data URL で埋めると、8K パノラマ 1 枚で数十 MB の文字列になり、
   * プロジェクト全体の保存が重くなる (カラーの旧実装がそうなっている)。
   */
  const putBlob = async (key: string, file: File) => {
    await saveBlob(key, file);
    return `${IDB_REF_PREFIX}${key}`;
  };

  const dropBlob = async (ref: string | undefined) => {
    if (ref?.startsWith(IDB_REF_PREFIX)) {
      try { await deleteBlob(ref.slice(IDB_REF_PREFIX.length)); } catch { /* 消せなくても参照は外す */ }
    }
  };

  /** 3DGS を入れる。拡張子でどのスロットに入るかが決まる。 */
  const setSplat = async (slot: typeof SLOTS[number], file: File) => {
    setBusy(`${slot.label}: 3DGS を取り込み中…`);
    try {
      const ext = file.name.toLowerCase().split('.').pop();
      const kind = ext === 'sog' ? 'splatSog' : ext === 'spz' ? 'splatSpz' : 'splat';
      const cur = rowOf(slot);
      // 3DGS は 1 行に 1 つ。別形式が入っていたら外す ― 2 つ残すと、
      // どちらが読まれるかが読み込み側の優先順位まかせになる。
      await Promise.all([dropBlob(cur.splat), dropBlob(cur.splatSpz), dropBlob(cur.splatSog)]);
      const ref = await putBlob(`assetvar:${sceneId}:${plan.id}:${slot.id}:splat`, file);
      patchRow(slot, { splat: undefined, splatSpz: undefined, splatSog: undefined, [kind]: ref });
    } finally { setBusy(null); }
  };

  const clearSplat = async (slot: typeof SLOTS[number]) => {
    const cur = rowOf(slot);
    await Promise.all([dropBlob(cur.splat), dropBlob(cur.splatSpz), dropBlob(cur.splatSog)]);
    patchRow(slot, { splat: undefined, splatSpz: undefined, splatSog: undefined });
  };

  const setPano = async (slot: typeof SLOTS[number], vpId: string, file: File) => {
    setBusy(`${slot.label}: パノラマを取り込み中…`);
    try {
      const cur = rowOf(slot);
      await dropBlob(cur.panoramas?.[vpId]);
      const ref = await putBlob(`assetvar:${sceneId}:${plan.id}:${slot.id}:pano:${vpId}`, file);
      patchRow(slot, { panoramas: { ...(cur.panoramas ?? {}), [vpId]: ref } });
    } finally { setBusy(null); }
  };

  const clearPano = async (slot: typeof SLOTS[number], vpId: string) => {
    const cur = rowOf(slot);
    await dropBlob(cur.panoramas?.[vpId]);
    const next = { ...(cur.panoramas ?? {}) };
    delete next[vpId];
    patchRow(slot, { panoramas: next });
  };

  const clearRow = async (slot: typeof SLOTS[number]) => {
    const cur = rowOf(slot);
    await Promise.all([
      dropBlob(cur.splat), dropBlob(cur.splatSpz), dropBlob(cur.splatSog),
      ...Object.values(cur.panoramas ?? {}).map(dropBlob),
    ]);
    write(variants.filter((v) => v.id !== slot.id));
  };

  const vps = plan.viewpoints ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="ds-hint">
        ビューアの<b>家具・情景トグル</b>が引く素材です。埋めた組み合わせだけがトグルで選べます
        （素材が 1 つでも入っていればトグルは自動で出るので、ツールバー表示のチェックは不要）。<br />
        空のままの欄は<b>プラン既定の素材</b>に落ちます。「夜だけ別の GS」のような入れ方ができます。
      </div>
      {busy && <div className="ds-sub">{busy}</div>}

      {v360.length > 0 && (
        <div className="ds-hint">
          このプランには <b>360°動画の描き分けが {v360.length} 本</b>入っています
          （{v360.map((v) => v.label || v.id).join(' / ')}）。動画はノード・エッジと一体なので
          こちらではなく <b>360°動画</b> セクションが持ちます。トグルは共通です。
        </div>
      )}

      {SLOTS.map((slot) => {
        const row = rowOf(slot);
        const splatRef = row.splatSog ?? row.splatSpz ?? row.splat;
        const splatKind = row.splatSog ? 'SOG' : row.splatSpz ? 'SPZ' : row.splat ? 'PLY' : null;
        const panoCount = Object.keys(row.panoramas ?? {}).length;
        const used = !!splatRef || panoCount > 0;
        const fromVideo = v360.some((v) => v.id === slot.id);
        return (
          <div key={slot.id} className="ds-well" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ds-label" style={{ minWidth: 96 }}>{slot.label}</span>
              <span className="ds-sub" style={{ opacity: .7 }}>
                家具{slot.furniture === 'on' ? 'あり' : 'なし'} / {slot.lighting === 'day' ? '昼' : '夜'}
              </span>
              <div style={{ flex: 1 }} />
              <span className={`ds-sub ${used || fromVideo ? 'ds-ok' : 'ds-faint'}`}>
                {used ? '設定済' : fromVideo ? '動画のみ' : '未設定'}
              </span>
              {used && (
                <button onClick={() => void clearRow(slot)} className={DANGER} title="この組み合わせを空にする"><IconTrash /></button>
              )}
            </div>

            {/* 3DGS */}
            <div className="ds-body" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>3DGS</span>
              <span className={`ds-sub ${splatKind ? 'ds-ok' : 'ds-faint'}`}>
                {splatKind ?? 'プラン既定を使う'}
              </span>
              <label className={BTN} style={{ cursor: 'pointer' }}>
                {splatKind ? '差し替え' : '入れる'}
                <input
                  type="file"
                  accept=".ply,.spz,.sog"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void setSplat(slot, f);
                    e.target.value = '';
                  }}
                />
              </label>
              {splatKind && (
                <button onClick={() => void clearSplat(slot)} className={DANGER} title="3DGS を外す"><IconClose /></button>
              )}
            </div>

            {/* 360画像 — 視点ごと */}
            <details>
              <summary className="ds-body" style={{ cursor: 'pointer' }}>
                360画像 <span className={`ds-sub ${panoCount ? 'ds-ok' : 'ds-faint'}`}>
                  {panoCount ? `${panoCount} / ${vps.length} 視点` : 'プラン既定を使う'}
                </span>
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {vps.map((vp) => {
                  const has = !!row.panoramas?.[vp.id];
                  return (
                    <div key={vp.id} className="ds-body" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1 }}>{vp.label}</span>
                      <span className={`ds-sub ${has ? 'ds-ok' : 'ds-faint'}`}>{has ? '登録済' : '未登録'}</span>
                      <label className={BTN} style={{ cursor: 'pointer' }}>
                        パノラマ
                        <input
                          type="file"
                          accept="image/*"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void setPano(slot, vp.id, f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      {has && (
                        <button onClick={() => void clearPano(slot, vp.id)} className={DANGER} title="360 を外す"><IconClose /></button>
                      )}
                    </div>
                  );
                })}
                {vps.length === 0 && <div className="ds-empty">視点がまだありません</div>}
              </div>
            </details>
          </div>
        );
      })}

      <div className="ds-hint">
        <b>カラー</b>（素材色違い）とは別の軸です。両方を掛け合わせた絵は持てない（組み合わせの
        数だけ画像が要る）ので、同じ視点に両方が登録されているときは<b>家具・情景が優先</b>されます
        — 「夜を選んだのに昼が出る」より、色が既定に戻るほうが気付きやすいためです。
      </div>
      <div className="ds-row">
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={() => {
            const n = variants.length;
            alert(n === 0
              ? 'まだ 1 つも入っていません。切り替えたい組み合わせの「入れる」から素材を登録してください。'
              : `${n} 通りの組み合わせに素材が入っています。ビューア（/viewer/${sceneId}）の左レール「カラー」で切り替わります。`);
          }}
        >入っている素材を数える</button>
      </div>
    </div>
  );
}
