import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { tokens, softCard } from './design-tokens';
import { PillInput } from './components/Input';
import {
  getOpenAIKey, setOpenAIKey,
  getGeminiKey, setGeminiKey,
} from '../utils/api-keys';

/** Mask a key for display: `sk-abc…wxyz`. */
function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 12) return '••••';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/**
 * Floating ⚙ settings button that opens a modal for the provider API keys used by AI
 * image generation: OpenAI (gpt-image) and Google Gemini (Nano Banana). Keys are stored
 * in localStorage on this machine and sent to the `/api/ai/edit` proxy via
 * `X-OpenAI-Key` / `X-Gemini-Key`. The model/provider selection lives in the generation
 * panel (LeftPanel); this modal can be opened from there via the `open-ai-settings`
 * window event.
 *
 * The modal renders through a portal to `document.body` so a `backdrop-filter` ancestor
 * can't trap its `position: fixed` overlay.
 */
export function ApiKeySettings({ gearStyle }: { gearStyle?: React.CSSProperties } = {}) {
  const [open, setOpen] = useState(false);
  const [oaDraft, setOaDraft] = useState('');
  const [oaSaved, setOaSaved] = useState<string>(() => getOpenAIKey());
  const [showOa, setShowOa] = useState(false);
  const [gemDraft, setGemDraft] = useState('');
  const [gemSaved, setGemSaved] = useState<string>(() => getGeminiKey());
  const [showGem, setShowGem] = useState(false);

  // Load current values when opening. Done in the click handler (not an effect) to
  // avoid a synchronous setState-in-effect cascade.
  const openModal = () => {
    const oa = getOpenAIKey();
    setOaDraft(oa); setOaSaved(oa); setShowOa(false);
    const gem = getGeminiKey();
    setGemDraft(gem); setGemSaved(gem); setShowGem(false);
    setOpen(true);
  };

  // Esc closes; the generation panel can request opening via `open-ai-settings`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onOpen = () => {
      const oa = getOpenAIKey(); setOaDraft(oa); setOaSaved(oa); setShowOa(false);
      const gem = getGeminiKey(); setGemDraft(gem); setGemSaved(gem); setShowGem(false);
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('open-ai-settings', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('open-ai-settings', onOpen);
    };
  }, []);

  const save = () => {
    setOpenAIKey(oaDraft); setOaSaved(oaDraft.trim());
    setGeminiKey(gemDraft); setGemSaved(gemDraft.trim());
    setOpen(false);
  };
  const clearAll = () => {
    setOpenAIKey(''); setOaDraft(''); setOaSaved('');
    setGeminiKey(''); setGemDraft(''); setGemSaved('');
  };

  const noKeys = !oaSaved && !gemSaved && !oaDraft.trim() && !gemDraft.trim();

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        title="AI API キー設定"
        aria-label="AI API キー設定"
        style={{ ...gearBtn, ...gearStyle }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && createPortal(
        <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div style={card} onMouseDown={(e) => e.stopPropagation()}>
            <div style={titleRow}>
              <span style={{ fontSize: 15, fontWeight: 700, color: tokens.color.text }}>AI API キー設定</span>
              <button type="button" onClick={() => setOpen(false)} style={closeBtn} aria-label="閉じる">✕</button>
            </div>

            {/* Gemini key */}
            <div style={{ ...fieldLabel, marginTop: 16 }}>
              Gemini API キー
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: gemSaved ? tokens.color.success : tokens.color.textFaint }}>
                {gemSaved ? `設定済み (${maskKey(gemSaved)})` : '未設定'}
              </span>
            </div>
            <div style={{ position: 'relative' }}>
              <PillInput
                type={showGem ? 'text' : 'password'}
                value={gemDraft}
                onChange={(e) => setGemDraft(e.target.value)}
                placeholder="AIza..."
                autoComplete="off"
                spellCheck={false}
                style={{ paddingRight: 48, fontFamily: tokens.font.mono }}
              />
              <button type="button" onClick={() => setShowGem((v) => !v)} title={showGem ? '隠す' : '表示'} aria-label={showGem ? '隠す' : '表示'} style={eyeBtn}>
                {showGem ? '🙈' : '👁'}
              </button>
            </div>

            {/* OpenAI key */}
            <div style={{ ...fieldLabel, marginTop: 14 }}>
              OpenAI (ChatGPT) API キー
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: oaSaved ? tokens.color.success : tokens.color.textFaint }}>
                {oaSaved ? `設定済み (${maskKey(oaSaved)})` : '未設定'}
              </span>
            </div>
            <div style={{ position: 'relative' }}>
              <PillInput
                type={showOa ? 'text' : 'password'}
                value={oaDraft}
                onChange={(e) => setOaDraft(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
                style={{ paddingRight: 48, fontFamily: tokens.font.mono }}
              />
              <button type="button" onClick={() => setShowOa((v) => !v)} title={showOa ? '隠す' : '表示'} aria-label={showOa ? '隠す' : '表示'} style={eyeBtn}>
                {showOa ? '🙈' : '👁'}
              </button>
            </div>

            <div style={{ fontSize: 11, color: tokens.color.textMute, marginTop: 10, lineHeight: 1.7 }}>
              「カラー / 素材バリエーション」の AI 画像生成に使います。キーはこの端末の
              localStorage に保存され、生成時にプロバイダ別ヘッダで <code>/api/ai/edit</code> へ送られます。
              <br />・<b>Gemini</b>（Nano Banana）= <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: tokens.color.accent }}>Google AI Studio</a> でキー取得。課金有効なキーが必要（無料枠は画像生成が制限/不可の場合あり）。組織認証は不要。
              <br />・<b>OpenAI</b>（gpt-image）= <b>組織(Organization)の本人確認が必須</b>。未認証だと有効なキーでも 403「organization must be verified」になります。
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" onClick={save} style={primaryBtn}>保存</button>
              <button type="button" onClick={clearAll} style={ghostBtn} disabled={noKeys}>両方クリア</button>
              <button type="button" onClick={() => setOpen(false)} style={ghostBtn}>閉じる</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

const gearBtn: React.CSSProperties = {
  position: 'absolute',
  // Sit just BELOW the FPS counter (top:12 right:12, z50) so they don't overlap,
  // and above the other preview overlays (ScenePins z60/70, FPS z50).
  top: 52, right: 16,
  width: 40, height: 40,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: tokens.glass.surfaceStrong,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  backdropFilter: tokens.backdrop,
  WebkitBackdropFilter: tokens.backdrop,
  boxShadow: tokens.shadow.glass,
  color: tokens.color.text,
  cursor: 'pointer',
  zIndex: 80,
  outline: 'none',
  fontFamily: tokens.font.family,
};

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(20,24,35,0.42)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24,
  zIndex: 10000,
};

const card: React.CSSProperties = {
  ...softCard,
  width: 460, maxWidth: '100%',
  padding: 24,
  boxShadow: tokens.shadow.dialog,
  overflow: 'visible',
};

const titleRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
};

const fieldLabel: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 700, color: tokens.color.text,
  marginBottom: 6,
};

const closeBtn: React.CSSProperties = {
  width: 28, height: 28,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: tokens.radius.pill,
  color: tokens.color.textMute,
  cursor: 'pointer',
  fontSize: 14,
  outline: 'none',
  fontFamily: tokens.font.family,
};

const eyeBtn: React.CSSProperties = {
  position: 'absolute',
  top: '50%', right: 8, transform: 'translateY(-50%)',
  width: 34, height: 34,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 15,
  outline: 'none',
  lineHeight: 1,
};

const primaryBtn: React.CSSProperties = {
  flex: 1,
  padding: '11px 16px',
  fontSize: 13, fontWeight: 700,
  color: tokens.color.text,
  background: tokens.gradient.accent,
  border: `1px solid ${tokens.color.accentBorder}`,
  borderRadius: tokens.radius.pill,
  boxShadow: tokens.shadow.glassAccent,
  cursor: 'pointer',
  outline: 'none',
  fontFamily: tokens.font.family,
};

const ghostBtn: React.CSSProperties = {
  padding: '11px 16px',
  fontSize: 13, fontWeight: 700,
  color: tokens.color.text,
  background: tokens.gradient.neutral,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  boxShadow: tokens.shadow.glass,
  cursor: 'pointer',
  outline: 'none',
  fontFamily: tokens.font.family,
};
