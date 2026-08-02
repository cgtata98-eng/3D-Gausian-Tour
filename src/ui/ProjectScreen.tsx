import { useEffect, useState } from 'react';
import { useProjectStore, type Project } from '../store/project-store';
import { useSceneStore } from '../store/scene-store';
import { useUIStore, type ProjectType, type ViewMode } from '../store/ui-store';
import { navigate } from '../utils/url';
import * as idb from '../utils/idb';
import type { SceneManifest } from '../core/types';
import { tokens } from './design-tokens';
import { PillButton, PillToggle, Tag, surfaceClass, IconTrash, IconEdit, IconLink, IconCheck, IconClose } from './components';
import { ApiKeySettings } from './ApiKeySettings';

/**
 * Generate an opaque, hard-to-guess project ID for the share URL. 16 lowercase
 * alphanumeric chars from a CSPRNG — small enough to type / scan, large enough
 * (~10²⁵ space) that customers can't enumerate other properties.
 */
function generateShareId(): string {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const len = 16;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
  }
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

/**
 * Top-level landing screen. Lists all projects with their per-project type / view mode,
 * lets the user create new projects (picking type + view mode at creation time)
 * and delete existing ones.
 *
 * Visual: glass-pill aesthetic — see `design-tokens.ts` for colour, gradient
 * and shadow scale. Every interactive surface uses the standard pill recipe
 * (white gradient + 1.5 px hairline border + inset top highlight + multi-
 * layered drop shadow).
 */
type SortKey = 'newest' | 'oldest' | 'name';
const SORT_STORAGE_KEY = '3droomtour:projects:sort:v1';
function loadInitialSort(): SortKey {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw === 'newest' || raw === 'oldest' || raw === 'name') return raw;
  } catch { /* localStorage disabled */ }
  return 'newest';
}

export function ProjectScreen() {
  const projects = useProjectStore((s) => s.projects);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const updateProject = useProjectStore((s) => s.updateProject);
  const setUiViewMode = useUIStore((s) => s.setViewMode);
  const setUiProjectType = useUIStore((s) => s.setProjectType);

  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? projects.find((p) => p.id === editingId) : null;
  const [sortKey, setSortKey] = useState<SortKey>(loadInitialSort);
  // Sorted view of the project list. The store's `projects` array reflects
  // creation order; we re-sort here so users can flip newest / oldest / name
  // without mutating the underlying ordering.
  const sortedProjects = [...projects].sort((a, b) => {
    if (sortKey === 'name') return a.name.localeCompare(b.name, 'ja');
    if (sortKey === 'oldest') return a.createdAt - b.createdAt;
    return b.createdAt - a.createdAt; // newest
  });
  const setSort = (k: SortKey) => {
    setSortKey(k);
    try { localStorage.setItem(SORT_STORAGE_KEY, k); } catch { /* ignore */ }
  };

  const handleOpen = (p: Project, mode: 'viewer' | 'debug') => {
    setUiViewMode(p.viewMode);
    setUiProjectType(p.type);
    navigate(mode === 'viewer' ? `/viewer/${p.id}` : `/scene/${p.id}`);
  };

  const handleDelete = (p: Project) => {
    if (!window.confirm(`「${p.name}」を削除しますか？\n（プロジェクトリストから外れます）`)) return;
    removeProject(p.id);
  };

  const mirrorMode = useUIStore((s) => s.mirrorMode);
  const setMirrorMode = useUIStore((s) => s.setMirrorMode);
  const isMirroring = mirrorMode === 'send';
  const startMirroring = () => {
    if (isMirroring) {
      setMirrorMode('off');
      return;
    }
    setMirrorMode('send');
    const base = window.location.origin + window.location.pathname;
    const target = `${base}?mirror=receive`;
    window.open(target, '_blank', 'noopener,width=1200,height=800');
  };

  return (
    <div style={S.root}>
      {/* Floating header pill — brand left, primary action right. The wrap
          fades the bg out so when the user scrolls, content disappears
          "under" the pill rather than under a hard bar. */}
      <div style={S.headerWrap}>
        <div className={`${surfaceClass('neutral')} ds-fill-neutral ds-blur`} style={S.headerPill}>
          <img src="/icon_GS.png" alt="" style={S.brandIcon} />
          <span className="ds-title">3D Gaussian Tour</span>
          <div style={{ flex: 1 }} />
          <PillButton
            variant={isMirroring ? 'danger' : 'plain'}
            onClick={startMirroring}
            title={isMirroring
              ? 'ミラーリング送信中 (クリックで停止)'
              : '自分のタブが送信モードに / 別ウィンドウで受信用ビューアが開く'}
          >
            {isMirroring ? '⏹  ミラーリング停止' : '📡  ミラーリング'}
          </PillButton>
          <PillButton variant="accent" onClick={() => setShowCreate(true)}>
            <span style={{ fontSize: 14, lineHeight: 1, marginRight: 2 }}>＋</span>
            <span>新規プロジェクト</span>
          </PillButton>
          <ApiKeySettings gearStyle={{ position: 'static', top: 'auto', right: 'auto', flexShrink: 0, marginLeft: 8 }} />
        </div>
      </div>

      <div style={S.body}>
        <div style={S.heading}>
          <div style={S.headingRow}>
            <div className="ds-title" style={S.headingTitle}>
              プロジェクト一覧
              <span className={`${surfaceClass('accent')} ds-tag`} style={S.headingCount}>{projects.length}</span>
            </div>
            {projects.length > 0 && (
              <div style={S.sortRow}>
                <span className="ds-sub" style={S.sortLabel}>並び替え</span>
                <SortPill active={sortKey === 'newest'} onClick={() => setSort('newest')}>新しい順</SortPill>
                <SortPill active={sortKey === 'oldest'} onClick={() => setSort('oldest')}>古い順</SortPill>
                <SortPill active={sortKey === 'name'} onClick={() => setSort('name')}>名前順</SortPill>
              </div>
            )}
          </div>
          <div className="ds-sub" style={S.headingSub}>
            種別と表示モードはプロジェクトごとに設定されます。各カードを開いて中身を編集してください。
          </div>
        </div>

        {projects.length === 0 ? (
          <div className={`${surfaceClass('plain')} ds-surface ds-fill-surface`} style={S.empty}>
            <div style={S.emptyIcon}>📦</div>
            <div className="ds-title">プロジェクトがまだありません</div>
            <div className="ds-sub" style={S.emptySub}>右上の「＋ 新規プロジェクト」から追加してください。</div>
          </div>
        ) : (
          <div style={S.grid}>
            {sortedProjects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={(mode) => handleOpen(p, mode)}
                onDelete={() => handleDelete(p)}
                onEdit={() => setEditingId(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <ProjectDialog
          mode="create"
          onCancel={() => setShowCreate(false)}
          onSubmit={(payload) => {
            const id = generateShareId();
            addProject({ id, ...payload });
            setShowCreate(false);
          }}
        />
      )}

      {editing && (
        <ProjectDialog
          mode="edit"
          initial={editing}
          onCancel={() => setEditingId(null)}
          onSubmit={(payload) => {
            const editingId = editing.id;
            const renamed = payload.name !== editing.name;
            updateProject(editingId, payload);
            // 改名を IDB の manifest と (該当シーンが表示中なら) scene-store にも反映 —
            // DebugViewer / LeftPanel のヘッダは manifest.name を参照するため、
            // ここで同期しないとリネーム後も古い名前のまま残る。
            if (renamed) {
              void (async () => {
                try {
                  const persisted = await idb.loadManifest<SceneManifest>(editingId);
                  if (persisted) {
                    await idb.saveManifest(editingId, { ...persisted, name: payload.name });
                  }
                } catch (e) {
                  console.warn('[rename] IDB manifest sync failed:', e);
                }
                const live = useSceneStore.getState().manifest;
                if (live?.id === editingId) {
                  useSceneStore.getState().setSceneName(payload.name);
                }
              })();
            }
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

/* The pill primitive that used to live here was a second copy of
 * `components/Pill.tsx` — same variants, same hover/active recipe, its own
 * VARIANT table. That duplication is why this screen kept its old look
 * after the shell landed: the tokens moved, but this copy re-implemented
 * the surface on top of them. Now imported from the one implementation. */

// ── Card ──────────────────────────────────────────────────────────

function ProjectCard({ project, onOpen, onDelete, onEdit }: {
  project: Project;
  onOpen: (mode: 'viewer' | 'debug') => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const typeLabel = project.type === 'mansion' ? '住居・店舗' : project.type === 'product' ? 'showroom' : 'その他';
  const modeLabel = project.viewMode === 'splat' ? '3DGS' : '360VR';
  const isMansion = project.type === 'mansion';
  const [copied, setCopied] = useState(false);
  // Hover state used to be tracked in React purely to swap a shadow. `:hover`
  // in CSS does the same thing without a re-render on every pointer cross.

  const copyShareLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/viewer/${project.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('共有用リンク (コピーしてください):', url);
    }
  };

  return (
    <div className={`${surfaceClass('neutral')} ds-card ds-card--hoverable`} style={S.card}>
      <div style={{ ...S.thumb, background: isMansion ? THUMB_GRAD_MANSION : THUMB_GRAD_OTHER }}>
        {project.thumbnail ? (
          <img src={project.thumbnail} alt={project.name} style={S.thumbImg} />
        ) : (
          <ThumbPlaceholder type={project.type} />
        )}
        <div style={S.thumbOverlay}>
          <button
            type="button"
            onClick={project.publishedAt ? copyShareLink : undefined}
            disabled={!project.publishedAt}
            title={project.publishedAt ? '閲覧用 URL をクリップボードにコピー' : '未公開 — デバッグ画面の「🚀 公開」ボタンから公開してください'}
            className={`${surfaceClass(copied ? 'success' : 'plain')} ds-pill ds-pill--sm ds-fill-surface ds-blur`}
            style={{ ...S.thumbAction, ...(project.publishedAt ? null : S.thumbActionDisabled) }}
          >
            {copied ? <><IconCheck />コピー済</> : <><IconLink />リンク</>}
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={onEdit} title="プロジェクト情報を編集"
              className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface ds-blur`} style={S.iconBtn}><IconEdit /></button>
            <button type="button" onClick={onDelete} title="このプロジェクトを削除"
              className={`${surfaceClass('danger')} ds-pill ds-pill--icon ds-blur`} style={S.iconBtn}><IconTrash /></button>
          </div>
        </div>
      </div>

      <div className="ds-card__body">
        <div className="ds-title">{project.name}</div>
        {project.subtitle && <div className="ds-sub" style={S.cardSub}>{project.subtitle}</div>}
        <div className="ds-card__meta">
          <Tag variant={isMansion ? 'accent' : 'warn'}>{typeLabel}</Tag>
          <Tag variant={project.viewMode === 'splat' ? 'success' : 'processing'}>{modeLabel}</Tag>
        </div>
      </div>

      <div className="ds-card__actions">
        {/* Both card actions use a neutral light-gray pill — colour
            accents on this screen are reserved for the global
            "create / mirror" header buttons, not per-card actions. */}
        <PillButton variant="neutral" fullWidth onClick={() => onOpen('debug')}>編集</PillButton>
        <PillButton variant="neutral" fullWidth onClick={() => onOpen('viewer')}>開く</PillButton>
      </div>
    </div>
  );
}

// ── Tag (mini pill) ───────────────────────────────────────────────

/* The local Tag that used to live here was a third copy of the pill recipe —
 * its own palette table, its own flat 1px border, its own inset. That is why
 * 住居・店舗 / 360VR / 3DGS never picked up the shell: they were never the
 * design system's Tag to begin with. Imported from the one implementation. */

// ── Project dialog (create / edit) ───────────────────────────────

interface ProjectFormPayload { name: string; type: ProjectType; viewMode: ViewMode; subtitle?: string }

function ProjectDialog({ mode, initial, onCancel, onSubmit }: {
  mode: 'create' | 'edit';
  initial?: Project;
  onCancel: () => void;
  onSubmit: (payload: ProjectFormPayload) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? '');
  const [type, setType] = useState<ProjectType>(initial?.type ?? 'mansion');
  const [viewMode, setViewMode] = useState<ViewMode>(initial?.viewMode ?? 'splat');
  // Edit mode: peek into the IDB-persisted manifest so we can lock the view
  // mode toggle to whichever data has actually been authored. Switching from
  // 3DGS-with-PLY to 360 (or vice versa) is a footgun — the prior data stays
  // in the manifest but is silently invisible in the new mode.
  const [hasGsData, setHasGsData] = useState(false);
  const [hasVrData, setHasVrData] = useState(false);
  useEffect(() => {
    if (mode !== 'edit' || !initial) return;
    let cancelled = false;
    (async () => {
      try {
        const m = await idb.loadManifest<SceneManifest>(initial.id);
        if (cancelled || !m?.plans) return;
        const gs = m.plans.some((p) => !!p.splat || !!p.splatSog);
        const vr = m.plans.some((p) => p.panoramas && Object.keys(p.panoramas).length > 0);
        setHasGsData(gs);
        setHasVrData(vr);
      } catch {
        // No manifest yet (project freshly created, no upload) — both flags stay false.
      }
    })();
    return () => { cancelled = true; };
  }, [mode, initial]);

  const submit = () => {
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), type, viewMode, subtitle: subtitle.trim() || undefined });
  };

  const title = mode === 'create' ? '新規プロジェクト' : 'プロジェクトを編集';
  const submitLabel = mode === 'create' ? '作成' : '保存';

  return (
    <div style={S.dialogBackdrop} onClick={onCancel}>
      <div className={`${surfaceClass('plain')} ds-card ds-dialog ds-fill-surface`} style={S.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={S.dialogHeader}>
          <span className="ds-title">{title}</span>
          <button type="button" className={`${surfaceClass('plain')} ds-pill ds-pill--icon ds-fill-surface`} onClick={onCancel} style={S.dialogClose}><IconClose /></button>
        </div>

        <div style={S.dialogBody}>
          <Field label="プロジェクト名" required>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
              placeholder="例: モダンマンション B 棟"
              className="ds-input"
            />
          </Field>

          <Field label="サブタイトル (任意)">
            <input
              type="text"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="例: 1LDK / 都心モデルルーム"
              className="ds-input"
            />
          </Field>

          <Field label="種別">
            <PillToggle
              value={type}
              onChange={setType}
              options={[
                { value: 'mansion', title: '住居・店舗', sub: '住宅 / マンション / 店舗' },
                { value: 'other',   title: 'その他',     sub: '展示 / 屋外 / 任意の空間' },
                { value: 'product', title: 'showroom',  sub: '家具など 1 点を回して見る' },
              ]}
            />
          </Field>

          <Field label="表示モード">
            <PillToggle
              value={viewMode}
              onChange={setViewMode}
              options={[
                {
                  value: 'splat',
                  title: '3DGS',
                  sub: 'Gaussian Splat 回遊',
                  disabled: hasVrData,
                  disabledReason: 'パノラマが登録済のため切替不可',
                },
                {
                  value: '360',
                  title: '360VR',
                  sub: '視点ごとのパノラマ',
                  disabled: hasGsData,
                  disabledReason: 'Splat が登録済のため切替不可',
                },
              ]}
            />
            {(hasGsData || hasVrData) && (
              <span style={S.modeLockHint}>
                {hasGsData ? 'Splat (PLY/SOG) ' : ''}
                {hasGsData && hasVrData ? '・' : ''}
                {hasVrData ? 'パノラマ画像 ' : ''}
                が登録済のため、もう一方のモードには切替できません。
              </span>
            )}
          </Field>
        </div>

        <div style={S.dialogFooter}>
          <PillButton variant="plain" onClick={onCancel}>キャンセル</PillButton>
          <PillButton variant="accent" disabled={!name.trim()} onClick={submit}>
            {submitLabel}
          </PillButton>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="ds-label">{label}{required && <span className="ds-required"> *</span>}</span>
      {children}
    </label>
  );
}

/**
 * Pill segmented control. Outer "gutter" uses an inset shadow (sunken
 * channel) and the active inner pill rises out of it with the standard
 * accent glow recipe — the exact pattern from the "Create Project /
 * My Projects" reference.
 */
/* The local PillToggle that stood here was a fourth copy of the segmented
 * control — its own track, its own active recipe, and crucially no sliding
 * indicator, which is why this dialog's 種別 / 表示モード switched with no
 * motion at all. The shared one moves a single accent shell between options.
 * Its option shape already matches, so the two call sites need no edit. */

// ── Sort selector pill ───────────────────────────────────────────

function SortPill({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${surfaceClass(active ? 'accent' : 'plain')} ds-pill ds-pill--sm ${active ? '' : 'ds-fill-surface'}`}
      style={S.sortPill}
    >
      {children}
    </button>
  );
}

// ── Thumbnail placeholder ────────────────────────────────────────

function ThumbPlaceholder({ type }: { type: ProjectType }) {
  if (type === 'mansion') {
    return (
      <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
        <path d="M8 32 L32 12 L56 32 V52 H40 V36 H24 V52 H8 Z" fill="none" stroke="#c8d3e8" strokeWidth="1.35" strokeLinejoin="round" />
        <path d="M28 22 H36" stroke="#c8d3e8" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === 'product') {
    // 単体 showroom: 台座 + 回転矢印で「ターンテーブル」表現
    return (
      <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
        <ellipse cx="32" cy="46" rx="22" ry="6" fill="none" stroke="#a3c7c2" strokeWidth="1.35" />
        <rect x="22" y="22" width="20" height="20" rx="2" fill="#a3c7c2" opacity="0.35" stroke="#a3c7c2" strokeWidth="1.35" />
        <path d="M14 18 A20 8 0 0 1 50 16" fill="none" stroke="#a3c7c2" strokeWidth="1.35" strokeLinecap="round" />
        <path d="M48 14 L52 16 L48 20" fill="none" stroke="#a3c7c2" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
      <rect x="10" y="14" width="44" height="40" rx="2" fill="none" stroke="#e2cda3" strokeWidth="1.35" />
      <path d="M10 24 H54" stroke="#e2cda3" strokeWidth="1.35" />
      <rect x="18" y="32" width="8" height="14" fill="#e2cda3" opacity="0.45" />
      <rect x="32" y="32" width="14" height="8" fill="#e2cda3" opacity="0.45" />
    </svg>
  );
}

// ── Styles ────────────────────────────────────────────────────────

const THUMB_GRAD_MANSION = 'linear-gradient(135deg, rgba(86,112,168,0.14), rgba(86,112,168,0.03))';
const THUMB_GRAD_OTHER = 'linear-gradient(135deg, rgba(160,122,62,0.14), rgba(160,122,62,0.03))';

const S: Record<string, React.CSSProperties> = {
  root: {
    width: '100vw', height: '100vh',
    // Calm light-gray canvas — visible enough to ground the white pills
    // but plain so the active-pill coloured glows are the only colour
    // accents. Reference image is essentially the same: clean light
    // backdrop, drama from the pills themselves.
    //
    // height (not min-height) + overflow:auto = fixed-height root with
    // its OWN scroll context. With min-height the root grew with content
    // and overflow never triggered — once you had ~10+ projects the bottom
    // cards fell below the viewport with no scrollbar.
    background: 'var(--ds-bg)',
    color: 'var(--ds-text)',
    fontFamily: 'var(--ds-font)',
    fontSize: 'var(--ds-fs-md)',
    overflow: 'auto',
  },

  // ── Header ─────────────────────────────────────────────────
  headerWrap: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
    padding: '20px 32px 12px',
    // Wrap stays transparent so the glass header sees the canvas underneath
    // it as the user scrolls — that's where the "liquid" comes from.
    background: 'transparent',
  },
  // Header pill — same neutral light-gray as the project cards and
  // their action buttons, so every framing surface on this screen
  // reads as one consistent gray gradient rather than a mix of
  // white-and-gray planes. Slight backdrop blur keeps the glass
  // feel where the page scrolls under the sticky header.
  headerPill: {
    display: 'flex', alignItems: 'center', gap: 12,
    maxWidth: 1112, margin: '0 auto',
    padding: '10px 12px 10px 18px',
    borderRadius: 999,
  },
  brandIcon: { width: 26, height: 26, display: 'block', objectFit: 'contain' as const },

  // ── Body ──────────────────────────────────────────────────
  body: {
    maxWidth: 1112, margin: '0 auto',
    padding: '28px 32px 96px',
  },
  heading: {
    marginBottom: 28,
    paddingLeft: 4,
  },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap' as const,
    marginBottom: 8,
  },
  headingTitle: {
    fontSize: 19,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  sortRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  sortLabel: { marginRight: 4 },
  sortPill: { padding: '5px 13px' },
  headingCount: { minWidth: 30, height: 24, padding: '0 11px' },
  headingSub: { lineHeight: 1.6 },

  empty: {
    padding: '72px 24px',
    borderRadius: 28,
    textAlign: 'center' as const,
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 10,
  },
  emptyIcon: { fontSize: 40, opacity: 0.5, marginBottom: 4 },
  emptySub: { lineHeight: 1.6 },

  grid: {
    display: 'grid',
    // Sized so a 1080-wide body lands three columns on the spec's ~337px card
    // rather than the 326px the previous 280px floor produced.
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 18,
  },

  // ── Card ──────────────────────────────────────────────────
  // Light-gray surface — matches the `pillNeutral` action buttons inside
  // it, so the card and its actions read as one unified gray panel
  // rather than "white card with gray buttons".
  card: { display: 'flex', flexDirection: 'column' as const },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 10' as unknown as string,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block' },
  thumbIcon: { opacity: 0.9 },
  thumbOverlay: {
    position: 'absolute' as const,
    top: 10, left: 10, right: 10,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
  },
  thumbAction: { padding: '6px 12px' },
  thumbActionDisabled: { cursor: 'not-allowed', opacity: 0.6 },
  iconBtn: { width: 30, height: 30, padding: 0 },


  cardSub: { lineHeight: 1.45 },



  pillNeutral: {},

  // ── Pill toggle (segmented control, glass) ────────────────
  // Outer container reads as a glass "tray" — slightly translucent
  // surface with a faint top-down gradient. Active inner segment is a
  // solid pale-blue pill with a luminous outer glow that bleeds beyond
  // the gutter (matching the "Create Project" button in the reference).
  modeLockHint: {
    fontSize: 10.5,
    color: tokens.color.textMute,
    marginTop: 8,
    lineHeight: 1.55,
  },

  // ── Dialog ───────────────────────────────────────────────
  dialogBackdrop: {
    position: 'fixed' as const, inset: 0,
    background: 'var(--ds-scrim)',
    backdropFilter: 'var(--ds-scrim-blur)',
    WebkitBackdropFilter: 'var(--ds-scrim-blur)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100,
    padding: 20,
  },
  // Dialog stays mostly opaque (text needs to be readable) but uses the
  // same translucent glass recipe — surfaceStrong is ~72 % opacity, with
  // the colour blooms behind still tinting through.
  dialog: {
    width: 480, maxWidth: '100%',
    overflow: 'hidden' as const,
    display: 'flex', flexDirection: 'column' as const,
  },
  dialogHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 24px 8px',
  },
  dialogClose: { width: 32, height: 32 },
  dialogBody: {
    padding: '14px 24px 22px',
    display: 'flex', flexDirection: 'column' as const, gap: 18,
  },
  dialogFooter: {
    display: 'flex', justifyContent: 'flex-end', gap: 10,
    padding: '16px 24px 24px',
  },

};
