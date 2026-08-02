import { useState } from 'react';
import { verifyCredentials, markAuthenticated, isAuthenticated } from '../utils/auth';
import { PillButton, PillInput, Card, surfaceClass } from './components';

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
      const role = verifyCredentials(username.trim(), password);
      if (role) {
        markAuthenticated(role);
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
      className="ds-screen"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <form onSubmit={submit} style={{ width: 380, maxWidth: 'calc(100vw - 32px)' }}>
        <Card tone="surface" style={{ padding: '32px 28px' }}>
          <div className="ds-title" style={{ marginBottom: 4 }}>
            管理画面ログイン
          </div>
          <div className="ds-sub" style={{ marginBottom: 22 }}>
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
            <div
              className={`${surfaceClass('danger')} ds-pill`}
              style={{ marginTop: 14, display: 'block', textAlign: 'center' }}
            >
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

          <div className="ds-hint" style={{ marginTop: 14, textAlign: 'center' }}>
            7 日間ログイン状態が保持されます。
          </div>
        </Card>
      </form>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="ds-label" style={{ marginBottom: 6 }}>{children}</div>;
}
