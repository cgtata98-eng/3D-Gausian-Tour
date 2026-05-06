import { useState } from 'react';
import { verifyCredentials, markAuthenticated, isAuthenticated } from '../utils/auth';
import { tokens, PillButton, PillInput, Card } from './components';

/**
 * Wraps admin / debug routes. If not authenticated, renders a centred login
 * form instead of the children. Public viewer routes don't go through this.
 *
 * Visual: glass-pill aesthetic via the shared component primitives — same
 * palette / shadow scale as `ProjectScreen`.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => isAuthenticated());
  if (authed) return <>{children}</>;
  return <LoginForm onSuccess={() => setAuthed(true)} />;
}

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setTimeout(() => {
      if (verifyCredentials(username.trim(), password)) {
        markAuthenticated();
        onSuccess();
      } else {
        setError('ID またはパスワードが違います');
        setSubmitting(false);
      }
    }, 200);
  };

  const canSubmit = !submitting && !!username.trim() && !!password;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.color.bg,
        fontFamily: tokens.font.family,
      }}
    >
      <form onSubmit={submit} style={{ width: 380, maxWidth: 'calc(100vw - 32px)' }}>
        <Card tone="surface" style={{ padding: '32px 28px' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: tokens.color.text, marginBottom: 4, letterSpacing: 0.3 }}>
            管理画面ログイン
          </div>
          <div style={{ fontSize: 12, color: tokens.color.textMute, marginBottom: 22, lineHeight: 1.5 }}>
            顧客向けビューアは下記なしでご覧いただけます。
          </div>

          <Label>ID</Label>
          <PillInput
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            disabled={submitting}
          />

          <div style={{ height: 12 }} />
          <Label>パスワード</Label>
          <PillInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={submitting}
          />

          {error && (
            <div style={{
              marginTop: 14,
              padding: '10px 14px',
              fontSize: 12,
              fontWeight: 600,
              color: tokens.color.text,
              background: tokens.gradient.danger,
              border: `1px solid ${tokens.color.dangerBorder}`,
              borderRadius: tokens.radius.pill,
              boxShadow: 'inset 0 1px 0.5px rgba(255,255,255,0.85)',
            }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 22, display: 'flex' }}>
            <PillButton
              type="submit"
              variant="accent"
              fullWidth
              disabled={!canSubmit}
              onClick={() => { /* form onSubmit handles this */ }}
            >
              {submitting ? '確認中…' : 'ログイン'}
            </PillButton>
          </div>

          <div style={{ marginTop: 14, fontSize: 10.5, color: tokens.color.textFaint, lineHeight: 1.5, textAlign: 'center' as const }}>
            7 日間ログイン状態が保持されます。
          </div>
        </Card>
      </form>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      color: tokens.color.textMute,
      textTransform: 'uppercase' as const,
      marginBottom: 6,
    }}>
      {children}
    </div>
  );
}
