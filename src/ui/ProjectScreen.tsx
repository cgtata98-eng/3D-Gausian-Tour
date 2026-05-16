import { useEffect, useState } from 'react';
import { useProjectStore, type Project } from '../store/project-store';
import { useSceneStore } from '../store/scene-store';
import { useUIStore, type ProjectType, type ViewMode } from '../store/ui-store';
import { navigate } from '../utils/url';
import * as idb from '../utils/idb';
import type { SceneManifest } from '../core/types';
import { tokens } from './design-tokens';

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
        <div style={S.headerPill}>
          <img src="/icon_GS.png" alt="" style={S.brandIcon} />
          <span style={S.brand}>3D Gaussian Tour</span>
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
            <span style={{ fontSize: 16, lineHeight: 1, marginRight: 2 }}>＋</span>
            <span>新規プロジェクト</span>
          </PillButton>
        </div>
      </div>

      <div style={S.body}>
        <div style={S.heading}>
          <div style={S.headingRow}>
            <div style={S.headingTitle}>
              プロジェクト一覧
              <span style={S.headingCount}>{projects.length}</span>
            </div>
            {projects.length > 0 && (
              <div style={S.sortRow}>
                <span style={S.sortLabel}>並び替え</span>
                <SortPill active={sortKey === 'newest'} onClick={() => setSort('newest')}>新しい順</SortPill>
                <SortPill active={sortKey === 'oldest'} onClick={() => setSort('oldest')}>古い順</SortPill>
                <SortPill active={sortKey === 'name'} onClick={() => setSort('name')}>名前順</SortPill>
              </div>
            )}
          </div>
          <div style={S.headingSub}>
            種別と表示モードはプロジェクトごとに設定されます。各カードを開いて中身を編集してください。
          </div>
        </div>

        {projects.length === 0 ? (
          <div style={S.empty}>
            <div style={S.emptyIcon}>📦</div>
            <div style={S.emptyTitle}>プロジェクトがまだありません</div>
            <div style={S.emptySub}>右上の「＋ 新規プロジェクト」から追加してください。</div>
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

// ── Pill button primitive ─────────────────────────────────────────

type PillVariant = 'plain' | 'accent' | 'success' | 'processing' | 'danger';

function PillButton({
  variant = 'plain',
  onClick, disabled, title, children, fullWidth, style,
}: {
  variant?: PillVariant;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
  fullWidth?: boolean;
  /** Inline overrides — applied last, e.g. recolour text or tint a
   *  shadow without spinning up a whole new variant. */
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        ...S.pillBase,
        // `fullWidth` in a flex container = `flex: 1` (share row width).
        // Standalone, fall back to `width: 100%` so it still spans.
        ...(fullWidth ? { flex: 1, minWidth: 0 } : null),
        ...VARIANT[variant].base,
        ...(hover && !disabled ? VARIANT[variant].hover : null),
        ...(active && !disabled ? VARIANT[variant].active : null),
        ...(disabled ? S.disabled : null),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// PillButton variants. All variants use the same dark-gray text colour
// (`tokens.color.text`) — the pill *background* tint is what carries the
// state semantics, not the text. This keeps every label legible against
// every variant bg.
const VARIANT: Record<PillVariant, { base: React.CSSProperties; hover: React.CSSProperties; active: React.CSSProperties }> = {
  plain: {
    base: {
      background: tokens.gradient.surface,
      borderColor: tokens.color.border,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glass,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.02)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.98)' },
  },
  accent: {
    base: {
      background: tokens.gradient.accent,
      borderColor: tokens.color.accentBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glassAccent,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.03) saturate(1.05)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.97)' },
  },
  success: {
    base: {
      background: tokens.gradient.success,
      borderColor: tokens.color.successBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glassSuccess,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.03)' },
    active: { transform: 'translateY(0)', filter: 'brightness(0.97)' },
  },
  processing: {
    base: {
      background: tokens.gradient.processing,
      borderColor: tokens.color.processingBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glassProcessing,
    },
    hover: { transform: 'translateY(-1px)' },
    active: { transform: 'translateY(0)' },
  },
  danger: {
    base: {
      background: tokens.gradient.danger,
      borderColor: tokens.color.dangerBorder,
      color: tokens.color.text,
      boxShadow: tokens.shadow.glass,
    },
    hover: { transform: 'translateY(-1px)', filter: 'brightness(1.03)' },
    active: { transform: 'translateY(0)' },
  },
};

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
  const [hover, setHover] = useState(false);

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
    <div
      style={{ ...S.card, ...(hover ? S.cardHover : null) }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
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
            style={{
              ...S.thumbAction,
              ...(copied ? S.thumbActionCopied : null),
              ...(project.publishedAt ? null : S.thumbActionDisabled),
            }}
          >
            {copied ? '✓ コピー済' : '🔗 リンク'}
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={onEdit} title="プロジェクト情報を編集" style={S.iconBtn}>✎</button>
            <button type="button" onClick={onDelete} title="このプロジェクトを削除" style={{ ...S.iconBtn, ...S.iconBtnDanger }}>✕</button>
          </div>
        </div>
      </div>

      <div style={S.cardBody}>
        <div style={S.cardName}>{project.name}</div>
        {project.subtitle && <div style={S.cardSub}>{project.subtitle}</div>}
        <div style={S.tagRow}>
          <Tag variant={isMansion ? 'accent' : 'warn'}>{typeLabel}</Tag>
          <Tag variant={project.viewMode === 'splat' ? 'success' : 'processing'}>{modeLabel}</Tag>
        </div>
      </div>

      <div style={S.cardActions}>
        {/* Both card actions use a neutral light-gray pill — colour
            accents on this screen are reserved for the global
            "create / mirror" header buttons, not per-card actions. */}
        <PillButton variant="plain" fullWidth onClick={() => onOpen('debug')} style={S.pillNeutral}>編集</PillButton>
        <PillButton variant="plain" fullWidth onClick={() => onOpen('viewer')} style={S.pillNeutral}>開く</PillButton>
      </div>
    </div>
  );
}

// ── Tag (mini pill) ───────────────────────────────────────────────

function Tag({ variant, children }: { variant: 'accent' | 'success' | 'processing' | 'warn'; children: React.ReactNode }) {
  // Same rule as PillButton: bg colour carries the state, text stays dark
  // gray so every tag is readable regardless of variant.
  const palette = {
    accent:     { bg: tokens.gradient.accent,     border: tokens.color.accentBorder,     text: tokens.color.text },
    success:    { bg: tokens.gradient.success,    border: tokens.color.successBorder,    text: tokens.color.text },
    processing: { bg: tokens.gradient.processing, border: tokens.color.processingBorder, text: tokens.color.text },
    warn:       { bg: tokens.gradient.warn,       border: tokens.color.warnBorder,       text: tokens.color.text },
  }[variant];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7,
      padding: '3px 11px',
      borderRadius: tokens.radius.pill,
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      color: palette.text,
      fontFamily: tokens.font.mono,
      boxShadow: 'inset 0 1px 0.5px rgba(255,255,255,0.9)',
    }}>{children}</span>
  );
}

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
      <div style={S.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={S.dialogHeader}>
          <span style={S.dialogTitle}>{title}</span>
          <button type="button" onClick={onCancel} style={S.dialogClose}>×</button>
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
              style={S.input}
            />
          </Field>

          <Field label="サブタイトル (任意)">
            <input
              type="text"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="例: 1LDK / 都心モデルルーム"
              style={S.input}
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
      <span style={S.fieldLabel}>{label}{required && <span style={S.required}> *</span>}</span>
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
function PillToggle<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; sub?: string; disabled?: boolean; disabledReason?: string }[];
}) {
  return (
    <div style={S.pillToggle}>
      {options.map((o) => {
        const active = o.value === value;
        const disabled = !!o.disabled && !active;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => { if (!disabled) onChange(o.value); }}
            disabled={disabled}
            title={disabled ? o.disabledReason : undefined}
            style={{
              ...S.pillToggleSeg,
              ...(active ? S.pillToggleSegActive : null),
              ...(disabled ? S.pillToggleSegDisabled : null),
            }}
          >
            <span style={S.pillToggleTitle}>{o.title}</span>
            {o.sub && <span style={S.pillToggleSub}>{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

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
      style={{ ...S.sortPill, ...(active ? S.sortPillActive : null) }}
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
        <path d="M8 32 L32 12 L56 32 V52 H40 V36 H24 V52 H8 Z" fill="none" stroke="#c8d3e8" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M28 22 H36" stroke="#c8d3e8" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === 'product') {
    // 単体 showroom: 台座 + 回転矢印で「ターンテーブル」表現
    return (
      <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
        <ellipse cx="32" cy="46" rx="22" ry="6" fill="none" stroke="#a3c7c2" strokeWidth="2.5" />
        <rect x="22" y="22" width="20" height="20" rx="2" fill="#a3c7c2" opacity="0.35" stroke="#a3c7c2" strokeWidth="2" />
        <path d="M14 18 A20 8 0 0 1 50 16" fill="none" stroke="#a3c7c2" strokeWidth="2" strokeLinecap="round" />
        <path d="M48 14 L52 16 L48 20" fill="none" stroke="#a3c7c2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
      <rect x="10" y="14" width="44" height="40" rx="2" fill="none" stroke="#e2cda3" strokeWidth="2.5" />
      <path d="M10 24 H54" stroke="#e2cda3" strokeWidth="2" />
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
    background: tokens.color.bg,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    fontSize: 13,
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
    maxWidth: 1080, margin: '0 auto',
    padding: '10px 12px 10px 18px',
    background: tokens.gradient.neutral,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: '1px solid #d8d8d8',
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
  },
  brandIcon: { width: 26, height: 26, display: 'block', objectFit: 'contain' as const },
  brand: { fontSize: 14.5, fontWeight: 700, letterSpacing: 0.4, color: tokens.color.text },

  // ── Body ──────────────────────────────────────────────────
  body: {
    maxWidth: 1080, margin: '0 auto',
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
    fontSize: 22, fontWeight: 700, letterSpacing: 0.2,
    color: tokens.color.text,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  sortRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  sortLabel: {
    fontSize: 11,
    color: tokens.color.textMute,
    marginRight: 4,
  },
  sortPill: {
    padding: '5px 12px',
    fontSize: 11.5,
    fontWeight: 600,
    background: tokens.gradient.surface,
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: tokens.color.border,
    borderRadius: tokens.radius.pill,
    color: tokens.color.textMute,
    cursor: 'pointer',
    fontFamily: tokens.font.family,
    outline: 'none',
    transition: `background ${tokens.transition}, color ${tokens.transition}, border-color ${tokens.transition}`,
  },
  sortPillActive: {
    background: tokens.gradient.accent,
    borderColor: tokens.color.accentBorder,
    color: tokens.color.text,
    boxShadow: tokens.shadow.glassAccent,
  },
  headingCount: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 30, height: 24, padding: '0 11px',
    fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
    color: tokens.color.text,
    background: tokens.gradient.accent,
    border: `1px solid ${tokens.color.accentBorder}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glassAccent,
    fontFamily: tokens.font.mono,
  },
  headingSub: { fontSize: 13, color: tokens.color.textMute, lineHeight: 1.6 },

  empty: {
    padding: '72px 24px',
    background: tokens.gradient.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.lg,
    boxShadow: tokens.shadow.glass,
    textAlign: 'center' as const,
    color: tokens.color.textMute,
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 10,
  },
  emptyIcon: { fontSize: 44, opacity: 0.5, marginBottom: 4 },
  emptyTitle: { fontSize: 15, fontWeight: 700, color: tokens.color.text },
  emptySub: { fontSize: 12.5, lineHeight: 1.6 },

  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 18,
  },

  // ── Card ──────────────────────────────────────────────────
  // Light-gray surface — matches the `pillNeutral` action buttons inside
  // it, so the card and its actions read as one unified gray panel
  // rather than "white card with gray buttons".
  card: {
    display: 'flex', flexDirection: 'column' as const,
    background: tokens.gradient.neutral,
    border: '1px solid #d8d8d8',
    borderRadius: tokens.radius.card,
    boxShadow: tokens.shadow.glass,
    overflow: 'hidden' as const,
    transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}`,
  },
  cardHover: {
    boxShadow: [
      'inset 0 1px 0.5px rgba(255,255,255,0.9)',
      'inset 0 -1px 0.5px rgba(40,48,80,0.06)',
      '0 2px 4px rgba(40,48,80,0.06)',
      '0 16px 36px rgba(40,48,80,0.14)',
      '0 36px 72px rgba(40,48,80,0.10)',
    ].join(', '),
    transform: 'translateY(-2px)',
  },
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
  thumbAction: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 12px',
    background: 'rgba(255,255,255,0.88)',
    color: tokens.color.text,
    borderRadius: tokens.radius.pill,
    border: `1px solid ${tokens.color.border}`,
    fontSize: 11, fontWeight: 600,
    fontFamily: tokens.font.family,
    cursor: 'pointer',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    boxShadow: `${tokens.shadow.innerHighlight}, ${tokens.shadow.soft}`,
    transition: `background ${tokens.transition}`,
  },
  thumbActionCopied: {
    background: 'rgba(231,241,231,0.95)',
    color: tokens.color.success,
    borderColor: tokens.color.successBorder,
  },
  thumbActionDisabled: {
    background: 'rgba(240,242,246,0.78)',
    color: tokens.color.textFaint,
    borderColor: tokens.color.border,
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  iconBtn: {
    width: 30, height: 30,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.88)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    fontSize: 13, fontWeight: 600,
    fontFamily: tokens.font.family,
    boxShadow: `${tokens.shadow.innerHighlight}, ${tokens.shadow.soft}`,
    padding: 0,
    transition: `background ${tokens.transition}, color ${tokens.transition}`,
  },
  iconBtnDanger: {
    color: tokens.color.danger,
    borderColor: tokens.color.dangerBorder,
  },

  cardBody: { padding: '16px 18px 10px 18px', flex: 1 },
  cardName: { fontSize: 15, fontWeight: 700, color: tokens.color.text, marginBottom: 4, letterSpacing: 0.2 },
  cardSub: { fontSize: 12, color: tokens.color.textMute, marginBottom: 12, lineHeight: 1.45 },
  tagRow: { display: 'flex', gap: 6, flexWrap: 'wrap' as const },

  cardActions: {
    display: 'flex', gap: 8,
    padding: '12px 14px 14px 14px',
  },

  // Light-gray override applied to per-card actions (編集 / 開く). Plain
  // variant alone is essentially white against the `#eef0f4` canvas;
  // this gradient nudges the bg into visibly gray territory so the
  // pill reads as "neutral / secondary" rather than "primary white".
  pillNeutral: {
    background: tokens.gradient.neutral,
    borderColor: '#d8d8d8',
  },

  // ── Pill base ─────────────────────────────────────────────
  // Shared by every <PillButton> variant. Variant specifics override
  // background / border / color / boxShadow.
  pillBase: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '10px 18px',
    // Long-hand split (see Pill.tsx) — shorthand + variant `borderColor`
    // overlay leaks the previous color across re-renders.
    borderWidth: 1.5,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: tokens.radius.pill,
    fontSize: 12.5, fontWeight: 700, letterSpacing: 0.3,
    cursor: 'pointer', fontFamily: tokens.font.family,
    transition: `box-shadow ${tokens.transition}, transform ${tokens.transition}, filter ${tokens.transition}, background ${tokens.transition}`,
    flexShrink: 0,
    outline: 'none',
  },
  disabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
    boxShadow: tokens.shadow.innerHighlight,
  },

  // ── Pill toggle (segmented control, glass) ────────────────
  // Outer container reads as a glass "tray" — slightly translucent
  // surface with a faint top-down gradient. Active inner segment is a
  // solid pale-blue pill with a luminous outer glow that bleeds beyond
  // the gutter (matching the "Create Project" button in the reference).
  pillToggle: {
    display: 'flex', gap: 4,
    padding: 5,
    background: tokens.glass.surfaceStrong,
    backdropFilter: tokens.backdrop,
    WebkitBackdropFilter: tokens.backdrop,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
  },
  pillToggleSeg: {
    flex: 1,
    display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 2,
    padding: '11px 16px',
    background: 'transparent',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: tokens.radius.pill,
    cursor: 'pointer',
    color: tokens.color.textMute,
    fontFamily: tokens.font.family,
    textAlign: 'left' as const,
    // Suppress the browser default focus outline — the pill recipe already
    // has its own ring (the active state's accent border + inner light
    // ring); a black focus rectangle on top of that is just visual noise.
    outline: 'none',
    transition: `background ${tokens.transition}, box-shadow ${tokens.transition}, color ${tokens.transition}, border-color ${tokens.transition}`,
  },
  pillToggleSegActive: {
    background: tokens.gradient.accent,
    borderColor: tokens.color.accentBorder,
    color: tokens.color.text,
    boxShadow: tokens.shadow.glassAccent,
  },
  pillToggleSegDisabled: {
    opacity: 0.42,
    cursor: 'not-allowed' as const,
    boxShadow: 'none',
    color: tokens.color.textMute,
  },
  pillToggleTitle: { fontSize: 13.5, fontWeight: 700, letterSpacing: 0.3 },
  pillToggleSub: { fontSize: 10.5, color: tokens.color.textFaint, fontWeight: 500 },
  modeLockHint: {
    fontSize: 11,
    color: tokens.color.textMute,
    marginTop: 8,
    lineHeight: 1.55,
  },

  // ── Dialog ───────────────────────────────────────────────
  dialogBackdrop: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(45, 49, 66, 0.28)',
    backdropFilter: 'blur(14px) saturate(140%)',
    WebkitBackdropFilter: 'blur(14px) saturate(140%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100,
    padding: 20,
  },
  // Dialog stays mostly opaque (text needs to be readable) but uses the
  // same translucent glass recipe — surfaceStrong is ~72 % opacity, with
  // the colour blooms behind still tinting through.
  dialog: {
    width: 480, maxWidth: '100%',
    background: tokens.gradient.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: 28,
    overflow: 'hidden' as const,
    boxShadow: `${tokens.shadow.innerHighlight}, ${tokens.shadow.dialog}`,
    display: 'flex', flexDirection: 'column' as const,
  },
  dialogHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 24px 8px',
  },
  dialogTitle: { fontSize: 16, fontWeight: 700, letterSpacing: 0.3, color: tokens.color.text },
  dialogClose: {
    width: 32, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: tokens.gradient.surface,
    border: `1px solid ${tokens.color.border}`,
    color: tokens.color.textMute,
    borderRadius: tokens.radius.pill,
    boxShadow: tokens.shadow.glass,
    fontSize: 18, cursor: 'pointer', fontFamily: tokens.font.family,
    transition: `background ${tokens.transition}`,
  },
  dialogBody: {
    padding: '14px 24px 22px',
    display: 'flex', flexDirection: 'column' as const, gap: 18,
  },
  dialogFooter: {
    display: 'flex', justifyContent: 'flex-end', gap: 10,
    padding: '16px 24px 24px',
  },
  fieldLabel: {
    fontSize: 11, fontWeight: 700 as const, letterSpacing: 0.6,
    color: tokens.color.textMute, textTransform: 'uppercase' as const,
  },
  required: { color: tokens.color.warn },
  // Sunken pill input — track gradient + inset shadow gives the
  // pressed-into-the-surface look. Border catches a hint of light too.
  input: {
    width: '100%', padding: '12px 16px',
    background: tokens.gradient.track,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.pill,
    color: tokens.color.text, fontSize: 13,
    outline: 'none', fontFamily: tokens.font.family,
    boxSizing: 'border-box' as const,
    boxShadow: tokens.shadow.inset,
    transition: `border-color ${tokens.transition}, box-shadow ${tokens.transition}`,
  },
};
