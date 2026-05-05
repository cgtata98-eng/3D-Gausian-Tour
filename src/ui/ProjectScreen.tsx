import { useState } from 'react';
import { useProjectStore, type Project } from '../store/project-store';
import { useUIStore, type ProjectType, type ViewMode } from '../store/ui-store';
import { navigate } from '../utils/url';

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
  // Fallback (insecure; should never run on modern browsers).
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

/**
 * Top-level landing screen. Lists all projects with their per-project type / view mode,
 * lets the user create new projects (picking type + view mode at creation time)
 * and delete existing ones.
 */
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

  const handleOpen = (p: Project, mode: 'viewer' | 'debug') => {
    // Sync the global UI state from this project's metadata so the engine renders correctly.
    setUiViewMode(p.viewMode);
    setUiProjectType(p.type);
    navigate(mode === 'viewer' ? `/viewer/${p.id}` : `/scene/${p.id}`);
  };

  const handleDelete = (p: Project) => {
    if (!window.confirm(`「${p.name}」を削除しますか？\n（プロジェクトリストから外れます）`)) return;
    removeProject(p.id);
  };

  /**
   * ワンクリックでミラーリング開始: このタブを送信モードに切り替えつつ、別ウィンドウで
   * 受信専用タブを開く。受信側は URL に `?mirror=receive` を付けて起動するので、
   * App.tsx 側で URL パラメータを見て setMirrorMode を呼ぶ。再クリックで停止。
   */
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
      <div style={S.header}>
        <img src="/icon_GS.png" alt="" style={S.brandIcon} />
        <span style={S.brand}>3D Gaussian Tour</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setShowCreate(true)} style={S.btnNew}>
          + 新規プロジェクト
        </button>
      </div>

      <div style={S.body}>
        <div style={{ ...S.heading, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={S.headingTitle}>プロジェクト一覧 ({projects.length})</div>
            <div style={S.headingSub}>
              種別と表示モードはプロジェクトごとに設定されます。各カードを開いて中身を編集してください。
            </div>
          </div>
          <button
            type="button"
            onClick={startMirroring}
            style={isMirroring ? { ...S.btnMirror, ...S.btnMirrorActive } : S.btnMirror}
            title={isMirroring
              ? 'ミラーリング送信中 (クリックで停止)'
              : '自分のタブが送信モードに / 別ウィンドウで受信用ビューアが開く'}
          >
            {isMirroring ? '⏹ ミラーリング停止' : '📡 ミラーリング開始'}
          </button>
        </div>

        {projects.length === 0 ? (
          <div style={S.empty}>
            プロジェクトがまだありません。<br />
            右上の「+ 新規プロジェクト」から追加してください。
          </div>
        ) : (
          <div style={S.grid}>
            {projects.map((p) => (
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
            updateProject(editing.id, payload);
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────

function ProjectCard({ project, onOpen, onDelete, onEdit }: {
  project: Project;
  onOpen: (mode: 'viewer' | 'debug') => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const typeLabel = project.type === 'mansion' ? '住居・店舗' : 'その他';
  const modeLabel = project.viewMode === 'splat' ? '3DGS' : '360VR';
  const isMansion = project.type === 'mansion';
  const [copied, setCopied] = useState(false);

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
    <div style={S.card}>
      <div style={{ ...S.thumb, background: isMansion ? THUMB_GRAD_MANSION : THUMB_GRAD_OTHER }}>
        {project.thumbnail ? (
          <img src={project.thumbnail} alt={project.name} style={S.thumbImg} />
        ) : (
          <ThumbPlaceholder type={project.type} />
        )}
        <div style={S.thumbOverlay}>
          <button
            type="button"
            onClick={copyShareLink}
            title="閲覧用 URL をクリップボードにコピー"
            style={{ ...S.thumbAction, ...(copied ? S.thumbActionCopied : null) }}
          >
            {copied ? '✓ コピー済' : '🔗 リンク'}
          </button>
          <div style={{ display: 'flex', gap: 6, pointerEvents: 'none' }}>
            <button
              type="button"
              onClick={onEdit}
              title="プロジェクト情報を編集"
              style={S.editBtn}
            >
              ✎
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="このプロジェクトを削除"
              style={S.deleteBtn}
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      <div style={S.cardBody}>
        <div style={S.cardName}>{project.name}</div>
        {project.subtitle && <div style={S.cardSub}>{project.subtitle}</div>}
        <div style={S.tagRow}>
          <span style={{ ...S.tag, ...(isMansion ? S.tagMansion : S.tagOther) }}>{typeLabel}</span>
          <span style={{ ...S.tag, ...(project.viewMode === 'splat' ? S.tagSplat : S.tag360) }}>{modeLabel}</span>
        </div>
      </div>

      <div style={S.cardActions}>
        <button type="button" onClick={() => onOpen('debug')} style={S.btnSecondary}>編集</button>
        <button type="button" onClick={() => onOpen('viewer')} style={S.btnPrimary}>開く →</button>
      </div>
    </div>
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
            <div style={S.segment}>
              <button
                type="button"
                style={{ ...S.segBtn, ...(type === 'mansion' ? S.segBtnActive : null) }}
                onClick={() => setType('mansion')}
              >
                <span style={S.segTitle}>住居・店舗</span>
                <span style={S.segSub}>住宅 / マンション / 店舗</span>
              </button>
              <button
                type="button"
                style={{ ...S.segBtn, ...(type === 'other' ? S.segBtnActive : null) }}
                onClick={() => setType('other')}
              >
                <span style={S.segTitle}>その他</span>
                <span style={S.segSub}>展示 / 屋外 / 任意の空間</span>
              </button>
            </div>
          </Field>

          <Field label="表示モード">
            <div style={S.segment}>
              <button
                type="button"
                style={{ ...S.segBtn, ...(viewMode === 'splat' ? S.segBtnActive : null) }}
                onClick={() => setViewMode('splat')}
              >
                <span style={S.segTitle}>3DGS</span>
                <span style={S.segSub}>Gaussian Splat 回遊</span>
              </button>
              <button
                type="button"
                style={{ ...S.segBtn, ...(viewMode === '360' ? S.segBtnActive : null) }}
                onClick={() => setViewMode('360')}
              >
                <span style={S.segTitle}>360VR</span>
                <span style={S.segSub}>視点ごとのパノラマ</span>
              </button>
            </div>
          </Field>
        </div>

        <div style={S.dialogFooter}>
          <button type="button" onClick={onCancel} style={S.btnCancel}>キャンセル</button>
          <button type="button" onClick={submit} disabled={!name.trim()} style={{ ...S.btnPrimary, opacity: name.trim() ? 1 : 0.4, cursor: name.trim() ? 'pointer' : 'not-allowed' }}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={S.fieldLabel}>{label}{required && <span style={S.required}> *</span>}</span>
      {children}
    </label>
  );
}

// ── Thumbnail placeholder ────────────────────────────────────────

function ThumbPlaceholder({ type }: { type: ProjectType }) {
  if (type === 'mansion') {
    return (
      <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
        <path d="M8 32 L32 12 L56 32 V52 H40 V36 H24 V52 H8 Z" fill="none" stroke="#bfdbfe" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M28 22 H36" stroke="#bfdbfe" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" width="56" height="56" style={S.thumbIcon}>
      <rect x="10" y="14" width="44" height="40" rx="2" fill="none" stroke="#fcd34d" strokeWidth="2.5" />
      <path d="M10 24 H54" stroke="#fcd34d" strokeWidth="2" />
      <rect x="18" y="32" width="8" height="14" fill="#fcd34d" opacity="0.35" />
      <rect x="32" y="32" width="14" height="8" fill="#fcd34d" opacity="0.35" />
    </svg>
  );
}

// ── Styles ────────────────────────────────────────────────────────

const COLOR = {
  bg: '#f7f8fa',
  panel: '#ffffff',
  panel2: '#f1f3f6',
  border: '#dde1e8',
  borderSoft: '#e8ebf0',
  text: '#1f2937',
  textDim: '#374151',
  textMute: '#6b7280',
  accent: '#3b82f6',
  accentText: '#1d4ed8',
  warn: '#d97706',
  danger: '#dc2626',
};

const THUMB_GRAD_MANSION = 'linear-gradient(135deg, rgba(96,165,250,0.22), rgba(96,165,250,0.06))';
const THUMB_GRAD_OTHER = 'linear-gradient(135deg, rgba(251,191,36,0.22), rgba(251,191,36,0.06))';

const S: Record<string, React.CSSProperties> = {
  root: {
    width: '100vw', height: '100vh', background: COLOR.bg, color: COLOR.text,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    fontSize: 13, overflow: 'auto',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '20px 32px',
    borderBottom: `1px solid ${COLOR.border}`,
    background: COLOR.panel,
  },
  brandIcon: { width: 28, height: 28, display: 'block', objectFit: 'contain' },
  brand: { fontSize: 16, fontWeight: 600, letterSpacing: 0.3 },
  btnMirror: {
    padding: '8px 14px',
    background: '#ffffff',
    color: '#1d4ed8',
    border: '1px solid rgba(59,130,246,0.5)',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: 0.4,
    flexShrink: 0,
    height: 36,
  } as React.CSSProperties,
  btnMirrorActive: {
    background: 'rgba(220,38,38,0.08)',
    color: '#dc2626',
    borderColor: 'rgba(220,38,38,0.5)',
  } as React.CSSProperties,
  btnNew: {
    padding: '8px 16px',
    background: COLOR.accent, color: '#ffffff',
    border: `1px solid ${COLOR.accent}`,
    borderRadius: 7, fontSize: 13, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  body: {
    maxWidth: 1080, margin: '0 auto',
    padding: '32px 24px',
  },
  heading: { marginBottom: 20 },
  headingTitle: { fontSize: 18, fontWeight: 700, letterSpacing: 0.3, marginBottom: 6 },
  headingSub: { fontSize: 12, color: COLOR.textMute, lineHeight: 1.55 },
  empty: {
    padding: '40px 20px',
    background: COLOR.panel,
    border: `1px solid ${COLOR.borderSoft}`,
    borderRadius: 12,
    textAlign: 'center' as const,
    color: COLOR.textMute,
    fontSize: 13, lineHeight: 1.7,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16,
  },
  card: {
    display: 'flex', flexDirection: 'column' as const,
    background: COLOR.panel,
    border: `1px solid ${COLOR.borderSoft}`,
    borderRadius: 12,
    overflow: 'hidden' as const,
    transition: 'border-color 0.15s, transform 0.15s',
  },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 10' as unknown as string,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  thumbImg: { width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block' },
  thumbIcon: { opacity: 0.85 },
  thumbOverlay: {
    position: 'absolute' as const,
    top: 8, left: 8, right: 8,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 6,
    pointerEvents: 'none' as const, // children opt back in
  },
  // The thumb-overlay buttons keep a dark backdrop because they sit on top of the photo
  // thumbnail and need to stay legible regardless of the picture's content. Text stays
  // white here, not COLOR.text (which is dark for the rest of the white theme).
  thumbAction: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px',
    background: 'rgba(0,0,0,0.55)',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 6,
    color: '#ffffff',
    fontSize: 11, fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    backdropFilter: 'blur(4px)',
    pointerEvents: 'auto' as const,
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  },
  thumbActionCopied: {
    background: 'rgba(34,197,94,0.85)',
    border: '1px solid rgba(34,197,94,0.9)',
    color: '#ffffff',
  },
  editBtn: {
    width: 26, height: 26,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 6,
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: 12, fontWeight: 700,
    fontFamily: 'inherit',
    padding: 0,
    backdropFilter: 'blur(4px)',
    pointerEvents: 'auto' as const,
  },
  deleteBtn: {
    width: 26, height: 26,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)',
    border: '1px solid rgba(248,113,113,0.4)',
    borderRadius: 6,
    color: '#fca5a5',
    cursor: 'pointer',
    fontSize: 13, fontWeight: 700,
    fontFamily: 'inherit',
    padding: 0,
    backdropFilter: 'blur(4px)',
    pointerEvents: 'auto' as const,
  },
  cardBody: { padding: '14px 14px 8px 14px', flex: 1 },
  cardName: { fontSize: 15, fontWeight: 700, color: COLOR.text, marginBottom: 4, letterSpacing: 0.2 },
  cardSub: { fontSize: 11, color: COLOR.textMute, marginBottom: 10, lineHeight: 1.4 },
  tagRow: { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  tag: {
    fontSize: 9.5, fontWeight: 700 as const, letterSpacing: 1.0,
    padding: '2px 8px', borderRadius: 4,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    border: '1px solid transparent',
  },
  tagMansion: { color: COLOR.accentText, background: 'rgba(96,165,250,0.12)', borderColor: 'rgba(96,165,250,0.4)' },
  tagOther: { color: '#92400e', background: 'rgba(251,191,36,0.12)', borderColor: 'rgba(251,191,36,0.4)' },
  tagSplat: { color: '#86efac', background: 'rgba(34,197,94,0.12)', borderColor: 'rgba(34,197,94,0.4)' },
  tag360: { color: '#c4b5fd', background: 'rgba(167,139,250,0.12)', borderColor: 'rgba(167,139,250,0.4)' },
  cardActions: {
    display: 'flex', gap: 8,
    padding: '10px 14px 14px 14px',
    borderTop: `1px solid ${COLOR.borderSoft}`,
    marginTop: 8,
  },
  btnSecondary: {
    flex: 1, textAlign: 'center' as const,
    padding: '8px 14px',
    background: '#ffffff',
    border: `1px solid ${COLOR.border}`,
    color: COLOR.text, fontSize: 12, fontWeight: 500,
    borderRadius: 7, textDecoration: 'none' as const,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  btnPrimary: {
    flex: 1, textAlign: 'center' as const,
    padding: '8px 14px',
    background: COLOR.accent, color: '#ffffff',
    border: `1px solid ${COLOR.accent}`,
    fontSize: 12, fontWeight: 700,
    borderRadius: 7, textDecoration: 'none' as const,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Dialog
  dialogBackdrop: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(31, 41, 55, 0.45)',
    backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100,
    padding: 20,
  },
  dialog: {
    width: 480, maxWidth: '100%',
    background: COLOR.panel,
    border: `1px solid ${COLOR.border}`,
    borderRadius: 12,
    overflow: 'hidden' as const,
    boxShadow: '0 24px 60px rgba(31,41,55,0.18)',
    display: 'flex', flexDirection: 'column' as const,
  },
  dialogHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: `1px solid ${COLOR.borderSoft}`,
  },
  dialogTitle: { fontSize: 14, fontWeight: 700, letterSpacing: 0.3 },
  dialogClose: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: COLOR.textMute,
    border: 'none',
    fontSize: 18, cursor: 'pointer', borderRadius: 6, fontFamily: 'inherit',
  },
  dialogBody: {
    padding: 18,
    display: 'flex', flexDirection: 'column' as const, gap: 14,
  },
  dialogFooter: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '12px 18px',
    borderTop: `1px solid ${COLOR.borderSoft}`,
    background: 'rgba(0,0,0,0.03)',
  },
  btnCancel: {
    padding: '8px 14px',
    background: '#ffffff',
    border: `1px solid ${COLOR.border}`,
    color: COLOR.text, fontSize: 12, fontWeight: 500,
    borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  },
  fieldLabel: {
    fontSize: 10, fontWeight: 700 as const, letterSpacing: 0.5,
    color: COLOR.textMute, textTransform: 'uppercase' as const,
  },
  required: { color: COLOR.warn },
  input: {
    width: '100%', padding: '8px 10px',
    background: COLOR.bg, border: `1px solid ${COLOR.border}`,
    borderRadius: 6, color: COLOR.text, fontSize: 13,
    outline: 'none', fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  },
  segment: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  segBtn: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 2,
    padding: '10px 12px',
    background: COLOR.panel2, border: `1px solid ${COLOR.borderSoft}`,
    borderRadius: 8, cursor: 'pointer', color: COLOR.textDim,
    fontFamily: 'inherit', textAlign: 'left' as const,
    transition: 'background 0.15s, border-color 0.15s',
  },
  segBtnActive: {
    background: 'rgba(96,165,250,0.16)',
    borderColor: 'rgba(96,165,250,0.55)',
    color: COLOR.text,
  },
  segTitle: { fontSize: 13, fontWeight: 700, letterSpacing: 0.4 },
  segSub: { fontSize: 10, color: COLOR.textMute },
};
